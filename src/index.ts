import { z } from 'zod'
import {
  ShellyGen1Client,
  ShellyProtocolError,
  assertGen1,
  toPhaseReading,
  toTotalReading,
} from './protocol/ShellyGen1Client'
import {
  ShellyGen2Client,
  assertGen2,
  isCoverMode,
  parseComponents,
  readInputState,
  toEmPhaseReading,
  toEmTotalReading,
  toSwitchReading,
} from './protocol/ShellyGen2Client'
import { EnergyAccessory } from './accessories/EnergyAccessory'
import { SwitchAccessory } from './accessories/SwitchAccessory'
import { GateAccessory } from './accessories/GateAccessory'
import { GateController, type GateTarget } from './GateController'
import type {
  PhaseReading,
  ShellyChannelConfig,
  ShellyDeviceConfig,
  ShellyDeviceInfo,
  ShellyEmDataStatus,
  ShellyEmStatus,
  ShellyGateConfig,
  ShellyInputConfig,
  ShellySwitchStatus,
} from './types'

const PLUGIN_NAME = '@nubisco/openbridge-shelly-platform'

let PLUGIN_VERSION = '1.0.0'
try {
  PLUGIN_VERSION = require('../package.json').version
} catch {
  /* use default */
}

// ---- OpenBridge native plugin types (inlined to preserve CommonJS build compat) ----
// @nubisco/openbridge-sdk is ESM-only, so types are defined locally instead of imported.
interface PluginLogger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

interface PluginContext {
  config: Record<string, unknown>
  log: PluginLogger
  reportTelemetry(deviceId: string, data: Record<string, unknown>): void
  registerDevice(device: {
    id: string
    name: string
    widgetType: string
    manufacturer?: string
    model?: string
    /**
     * One-shot commands OpenBridge should offer as buttons. Optional: an older
     * host ignores the field, which costs nothing but the button.
     */
    actions?: Array<{ id: string; label: string; confirm?: string; danger?: boolean }>
  }): void
  registerControl(deviceId: string, controlId: string, handler: (value: unknown) => void | Promise<void>): void
  /**
   * Record something that happened, for the device's timeline in OpenBridge.
   * Optional: an older host will not have it, so every call is guarded.
   */
  recordEvent?(
    deviceId: string,
    event: { type: string; message: string; source?: string; data?: Record<string, unknown> },
  ): void
  getHapBridge?(): { bridge: unknown; hap: unknown } | null
}

function definePlugin<T extends { manifest: { name: string; version: string } }>(plugin: T): T {
  return plugin
}

// ---- Reboot ----

/**
 * Every Shelly can restart itself, so every device this plugin registers
 * offers it.
 *
 * The confirmation is worth the interruption for one reason that is easy to
 * get wrong from the button alone: a Shelly is one box with several channels,
 * and OpenBridge shows those channels as separate devices. Rebooting from
 * "Pool Filter" also takes "Pool Light" away, and a gate mid-travel stays
 * where it stopped. That reaches further than the control implies, which is
 * the test for whether to confirm at all.
 */
const REBOOT_ACTION = {
  id: 'reboot',
  label: 'Reboot',
  confirm:
    'The whole Shelly restarts, not just this channel, so every channel on it stops answering for about 30 seconds. ' +
    'Relays come back in their configured initial state, and anything mid-travel is left where it stopped.',
} as const

/**
 * Wire the reboot control for one device id.
 *
 * The device acknowledges and then goes away, so the polls that follow will
 * fail for a while. That is the expected shape of a reboot and not a fault, so
 * it is recorded on the timeline before the call rather than reported as an
 * error afterwards.
 */
function registerReboot(ctx: PluginContext, deviceId: string, reboot: () => Promise<void>): void {
  ctx.registerControl(deviceId, 'reboot', async () => {
    ctx.log.info(`${deviceId}: rebooting on request`)
    ctx.recordEvent?.(deviceId, {
      type: 'reboot',
      message: 'Reboot requested from OpenBridge. The device will be unreachable for a few seconds.',
      source: 'openbridge',
    })
    await reboot()
  })
}

// ---- Config schema ----

const DEFAULT_PHASE_NAMES = ['Phase A', 'Phase B', 'Phase C']

const ShellyGateConfigSchema = z.object({
  name: z.string().optional(),
  switch: z.number().int().min(0).max(7).optional(),
  openInput: z.number().int().min(0).max(7).optional(),
  closedInput: z.number().int().min(0).max(7).optional(),
  travelTime: z.number().min(1).max(300).optional(),
  pulseGap: z.number().min(100).max(10000).optional(),
  departureSettle: z.number().min(0).max(30000).optional(),
  invertInputs: z.boolean().optional(),
})

const ShellyDeviceConfigSchema = z
  .object({
    ip: z.string().min(1, 'Device IP or hostname is required'),
    name: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    pollInterval: z.number().min(1, 'Poll interval must be at least 1 second').max(3600).optional(),
    timeout: z.number().min(500).max(60000).optional(),
    exposeToHomeKit: z.boolean().optional(),
    alertThreshold: z.number().min(0).optional(),
    phaseNames: z.array(z.string()).optional(),
    showTotal: z.boolean().optional(),
    showPhases: z.boolean().optional(),
    exclude: z.boolean().optional(),
    gate: ShellyGateConfigSchema.optional(),
  })
  // Per-channel overrides keyed by Gen2 component id: "switch:0", "switch:1".
  // Catchall rather than named keys because the channel count varies by model
  // (1PM through 4PM), and the same shape is already familiar from ShellyDS9.
  .catchall(
    z
      .object({
        name: z.string().optional(),
        exclude: z.boolean().optional(),
      })
      .optional(),
  )

const NativePluginConfigSchema = z.object({
  devices: z.array(ShellyDeviceConfigSchema).default([]),
})

// ---- Device runner ----

/** Names for the Shelly Gen1 device types this plugin understands. */
const GEN1_MODEL_NAMES: Record<string, string> = {
  'SHEM-3': 'Shelly 3EM',
  SHEM: 'Shelly EM',
}

interface ChannelBinding {
  deviceId: string
  displayName: string
  /** Index into `status.emeters`, or null for the combined total */
  channel: number | null
  accessory: EnergyAccessory | null
}

/**
 * Shared lifecycle for a polled Shelly device.
 *
 * The poll timer, the re-entrancy guard and the error suppression are identical
 * for Gen1 and Gen2 and are worth having in exactly one place: a device that is
 * simply unplugged must log once and then stay quiet, and a slow device must
 * not pile up overlapping requests.
 */
abstract class PolledShellyDevice {
  protected timer: ReturnType<typeof setInterval> | null = null
  protected polling = false
  protected info: ShellyDeviceInfo | null = null

  /** Suppresses identical repeating errors so a failing device cannot flood the log. */
  private lastErrorMessage: string | null = null
  private suppressedErrors = 0

  constructor(
    protected readonly config: ShellyDeviceConfig,
    protected readonly log: PluginLogger,
  ) {}

  get pollIntervalMs(): number {
    return (this.config.pollInterval ?? 5) * 1000
  }

  start(ctx: PluginContext): void {
    if (this.timer) return
    void this.poll(ctx)
    this.timer = setInterval(() => void this.poll(ctx), this.pollIntervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** One poll cycle. Never throws, so a failing device cannot take the plugin down. */
  async poll(ctx: PluginContext): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      await this.readOnce(ctx)
      this.onSuccess()
    } catch (err) {
      this.onError(err)
      this.onFailure()
    } finally {
      this.polling = false
    }
  }

  /** Probe the device and register its OpenBridge devices. */
  abstract setup(ctx: PluginContext, hap: any, bridge: any): Promise<void>

  /** Read the device and report telemetry. Throwing marks the cycle failed. */
  protected abstract readOnce(ctx: PluginContext): Promise<void>

  /** Flag the device's accessories unreachable after a failed read. */
  protected abstract onFailure(): void

  abstract get deviceIds(): string[]

  get deviceInfo(): ShellyDeviceInfo | null {
    return this.info
  }

  protected onSuccess(): void {
    if (this.lastErrorMessage) {
      const suffix = this.suppressedErrors > 0 ? ` (${this.suppressedErrors} repeat(s) suppressed)` : ''
      this.log.info(`${this.config.ip}: recovered${suffix}`)
      this.lastErrorMessage = null
      this.suppressedErrors = 0
    }
  }

  protected onError(err: unknown): void {
    const message = err instanceof ShellyProtocolError ? err.message : String((err as Error)?.message ?? err)

    // Log a given failure once, then count repeats silently. A device that is
    // simply unplugged should not produce an error line every poll forever.
    if (message === this.lastErrorMessage) {
      this.suppressedErrors++
      return
    }
    this.lastErrorMessage = message
    this.suppressedErrors = 0
    this.log.error(`${this.config.ip}: ${message}`)
  }
}

/**
 * Polls one physical meter and fans its channels out to OpenBridge devices.
 *
 * Each phase becomes its own OpenBridge device so it gets an independent
 * telemetry stream and energy history file, which is what makes per-phase
 * charting possible at all.
 */
export class ShellyEnergyDevice extends PolledShellyDevice {
  private readonly client: ShellyGen1Client
  private readonly bindings: ChannelBinding[] = []

  constructor(config: ShellyDeviceConfig, log: PluginLogger) {
    super(config, log)
    this.client = new ShellyGen1Client(config.ip, {
      username: config.username,
      password: config.password,
      timeout: config.timeout,
    })
  }

  /**
   * Probe the device, then register one OpenBridge device per channel.
   *
   * Probing first means an unsupported device fails once with an explanatory
   * message instead of erroring on every poll forever.
   */
  async setup(ctx: PluginContext, hap: any, bridge: any): Promise<void> {
    const info = await this.client.getDeviceInfo()
    assertGen1(info, this.config.ip)
    this.info = info

    const mac = (info.mac ?? this.config.ip).toLowerCase()
    const baseName = this.config.name ?? GEN1_MODEL_NAMES[info.type] ?? 'Shelly Meter'
    const modelName = GEN1_MODEL_NAMES[info.type] ?? info.type
    const channelCount = info.num_emeters ?? 0
    const phaseNames = this.config.phaseNames ?? DEFAULT_PHASE_NAMES

    this.log.info(`${this.config.ip}: found ${modelName} (fw ${info.fw ?? 'unknown'}) with ${channelCount} channel(s)`)

    const wanted: Array<{ channel: number | null; suffix: string }> = []
    if (this.config.showTotal !== false) wanted.push({ channel: null, suffix: 'Total' })
    if (this.config.showPhases !== false) {
      for (let i = 0; i < channelCount; i++) {
        wanted.push({ channel: i, suffix: phaseNames[i] ?? `Phase ${i + 1}` })
      }
    }

    const exposeToHomeKit = this.config.exposeToHomeKit !== false && Boolean(hap && bridge)

    for (const { channel, suffix } of wanted) {
      const deviceId = `shelly-${mac}-${channel === null ? 'total' : `p${channel}`}`
      const displayName = `${baseName} - ${suffix}`

      ctx.registerDevice({
        id: deviceId,
        name: displayName,
        widgetType: 'energy_meter',
        manufacturer: 'Shelly',
        model: modelName,
        actions: [REBOOT_ACTION],
      })
      registerReboot(ctx, deviceId, () => this.client.reboot())

      let accessory: EnergyAccessory | null = null
      if (exposeToHomeKit) {
        accessory = new EnergyAccessory(hap, displayName, deviceId, {
          alertThreshold: this.config.alertThreshold ?? 0,
          manufacturer: 'Shelly',
          model: modelName,
          serialNumber: `${mac}-${channel === null ? 'total' : channel}`,
          firmwareRevision: info.fw ?? '1.0.0',
        })
        try {
          bridge.addBridgedAccessory(accessory.accessory)
        } catch (err) {
          this.log.warn(`Could not add "${displayName}" to the HomeKit bridge: ${err}`)
          accessory = null
        }
      }

      this.bindings.push({ deviceId, displayName, channel, accessory })
    }

    this.log.info(
      `${this.config.ip}: registered ${this.bindings.length} device(s), polling every ${this.pollIntervalMs / 1000}s`,
    )
  }

  protected async readOnce(ctx: PluginContext): Promise<void> {
    const status = await this.client.getStatus()
    const total = toTotalReading(status)

    for (const binding of this.bindings) {
      const reading: PhaseReading = binding.channel === null ? total : toPhaseReading(status.emeters[binding.channel])
      if (!reading) continue

      ctx.reportTelemetry(binding.deviceId, {
        power: reading.power,
        voltage: reading.voltage,
        current: reading.current,
        powerFactor: reading.powerFactor,
        totalForwardEnergy: reading.totalForwardEnergy,
        totalReturnedEnergy: reading.totalReturnedEnergy,
        valid: reading.valid,
      })

      binding.accessory?.update(reading)
      binding.accessory?.clearFault()
    }
  }

  protected onFailure(): void {
    for (const binding of this.bindings) binding.accessory?.setFault()
  }

  get deviceIds(): string[] {
    return this.bindings.map((b) => b.deviceId)
  }
}

/** One Gen2 component wired to an OpenBridge device. */
interface Gen2Binding {
  deviceId: string
  displayName: string
  /** The component key it came from, e.g. "switch:0" or "em:0" */
  key: string
  kind: 'switch' | 'energy'
  /** Relay index for Switch.Set (switches only) */
  index: number
  switchAccessory: SwitchAccessory | null
  energyAccessory: EnergyAccessory | null
}

/** The gate built on top of one relay and two limit inputs. */
interface GateBinding {
  deviceId: string
  displayName: string
  controller: GateController
  accessory: GateAccessory | null
  openInput: number
  closedInput: number
  invert: boolean
  /** Last limit levels read, so a command can report the same shape a poll does. */
  openLimitState: boolean | null
  closedLimitState: boolean | null
  /** Set while the device is not answering, so we do not pulse into the dark. */
  unreachable: boolean
  /** Relay index, for the latch check. */
  relay: number
  /** Consecutive polls that have seen the step relay closed. */
  relayHeldPolls: number
}

/** Defaults for the most obvious gate wiring: relay 0 steps, inputs 0 and 1 sense. */
const GATE_DEFAULTS = { switch: 0, openInput: 0, closedInput: 1, travelTime: 30, pulseGap: 1000 }

/**
 * Polls one Gen2+ device and fans its components out to OpenBridge devices.
 *
 * Unlike Gen1, the component list is not implied by the model: `Shelly.GetStatus`
 * names what the device actually has, so a 1PM, 2PM, 4PM and Pro 3EM all come
 * through here without a per-model table.
 */
export class ShellyGen2Device extends PolledShellyDevice {
  private readonly client: ShellyGen2Client
  private readonly bindings: Gen2Binding[] = []
  private gate: GateBinding | null = null
  /** Bound at setup, so the poll path can record without carrying ctx around. */
  private gateEventSink: PluginContext['recordEvent'] | null = null
  /** Last state written to the timeline, so a poll does not record every second. */
  private lastRecordedState: string | null = null
  /** When we last pulsed, to tell our own commands from the remote's. */
  private lastPulseAt = 0

  constructor(config: ShellyDeviceConfig, log: PluginLogger) {
    super(config, log)
    this.client = new ShellyGen2Client(config.ip, {
      username: config.username,
      password: config.password,
      timeout: config.timeout,
    })
  }

  /**
   * A gate is polled every second unless told otherwise.
   *
   * Position is the one reading a person actually watches change, and the
   * five-second default would make the Home app tile lag a gate by most of its
   * travel. Two extra requests a second to a device on the LAN is a fair price
   * for a tile that tracks the gate.
   */
  get pollIntervalMs(): number {
    if (this.config.gate && this.config.pollInterval === undefined) return 1000
    return super.pollIntervalMs
  }

  /**
   * Probe the device, then register one OpenBridge device per component.
   *
   * Probing first means an unsupported device fails once with an explanatory
   * message instead of erroring on every poll forever.
   */
  async setup(ctx: PluginContext, hap: any, bridge: any): Promise<void> {
    const info = await this.client.getDeviceInfo()
    assertGen2(info, this.config.ip)
    this.info = info

    const status = await this.client.getStatus()

    // A roller cover pairs the two relays into one motor, so exposing them as
    // independent switches would let the user drive the motor both ways at
    // once. Declining is the honest option until covers are modelled properly.
    if (isCoverMode(status)) {
      this.log.warn(
        `${this.config.ip}: configured as a roller cover, which is not supported yet. ` +
          `Switch the device to relay mode to expose its channels.`,
      )
      return
    }

    const mac = (info.mac ?? this.config.ip).toLowerCase()
    const baseName = this.config.name ?? info.model ?? 'Shelly'
    const modelName = info.model ?? `Gen${info.gen}`
    const exposeToHomeKit = this.config.exposeToHomeKit !== false && Boolean(hap && bridge)

    const accessoryOptions = {
      manufacturer: 'Shelly',
      model: modelName,
      firmwareRevision: info.fw_id ?? info.fw ?? '1.0.0',
    }

    if (this.config.gate) {
      await this.setupGate(ctx, hap, bridge, status, mac, baseName, exposeToHomeKit, accessoryOptions)
    }

    for (const component of parseComponents(status)) {
      const channel = this.channelConfig(component.key)
      if (channel?.exclude) {
        this.log.info(`${this.config.ip}: skipping ${component.key} (excluded in config)`)
        continue
      }

      // The gate owns its step relay. Exposing it as a switch as well would put
      // a toggle in HomeKit that pulses the gate behind the gate accessory's
      // back, leaving the two disagreeing about where it is.
      if (
        this.gate &&
        component.type === 'switch' &&
        component.index === (this.config.gate?.switch ?? GATE_DEFAULTS.switch)
      ) {
        continue
      }

      if (component.type === 'switch') {
        const deviceId = `shelly-${mac}-switch${component.index}`
        const displayName = channel?.name ?? `${baseName} - Switch ${component.index}`

        ctx.registerDevice({
          id: deviceId,
          name: displayName,
          widgetType: 'switch',
          manufacturer: 'Shelly',
          model: modelName,
          actions: [REBOOT_ACTION],
        })
        registerReboot(ctx, deviceId, () => this.client.reboot())

        // This is what makes the toggle in the OpenBridge devices view work.
        ctx.registerControl(deviceId, 'active', async (value: unknown) => {
          await this.client.setSwitch(component.index, Boolean(value))
        })

        let accessory: SwitchAccessory | null = null
        if (exposeToHomeKit) {
          accessory = new SwitchAccessory(
            hap,
            displayName,
            deviceId,
            (on) => this.client.setSwitch(component.index, on),
            { ...accessoryOptions, serialNumber: `${mac}-switch${component.index}` },
          )
          try {
            bridge.addBridgedAccessory(accessory.accessory)
          } catch (err) {
            this.log.warn(`Could not add "${displayName}" to the HomeKit bridge: ${err}`)
            accessory = null
          }
        }

        this.bindings.push({
          deviceId,
          displayName,
          key: component.key,
          kind: 'switch',
          index: component.index,
          switchAccessory: accessory,
          energyAccessory: null,
        })
        continue
      }

      if (component.type === 'em') {
        // One device per live phase plus a combined total, matching how the
        // Gen1 meters are laid out so both generations chart identically.
        const em = status[component.key] as ShellyEmStatus
        const phases: Array<'a' | 'b' | 'c'> = ['a', 'b', 'c']
        const present = phases.filter((ph) => typeof em?.[`${ph}_act_power`] === 'number')
        const phaseNames = this.config.phaseNames ?? DEFAULT_PHASE_NAMES

        const wanted: Array<{ phase: 'a' | 'b' | 'c' | null; suffix: string }> = []
        if (this.config.showTotal !== false) wanted.push({ phase: null, suffix: 'Total' })
        if (this.config.showPhases !== false) {
          present.forEach((ph, i) => wanted.push({ phase: ph, suffix: phaseNames[i] ?? `Phase ${ph.toUpperCase()}` }))
        }

        for (const { phase, suffix } of wanted) {
          const deviceId = `shelly-${mac}-${phase === null ? 'total' : `p${phase}`}`
          const displayName = `${baseName} - ${suffix}`

          ctx.registerDevice({
            id: deviceId,
            name: displayName,
            widgetType: 'energy_meter',
            manufacturer: 'Shelly',
            model: modelName,
            actions: [REBOOT_ACTION],
          })
          registerReboot(ctx, deviceId, () => this.client.reboot())

          let accessory: EnergyAccessory | null = null
          if (exposeToHomeKit) {
            accessory = new EnergyAccessory(hap, displayName, deviceId, {
              alertThreshold: this.config.alertThreshold ?? 0,
              ...accessoryOptions,
              serialNumber: `${mac}-${phase ?? 'total'}`,
            })
            try {
              bridge.addBridgedAccessory(accessory.accessory)
            } catch (err) {
              this.log.warn(`Could not add "${displayName}" to the HomeKit bridge: ${err}`)
              accessory = null
            }
          }

          this.bindings.push({
            deviceId,
            displayName,
            key: component.key,
            kind: 'energy',
            index: phase === null ? -1 : present.indexOf(phase),
            switchAccessory: null,
            energyAccessory: accessory,
          })
        }
      }
      // Anything else (input:N, wifi, sys, ...) carries no device-level meaning
      // for OpenBridge and is deliberately ignored rather than surfaced.
    }

    this.log.info(
      `${this.config.ip}: found ${modelName} (Gen${info.gen}, fw ${info.fw_id ?? 'unknown'}), ` +
        `registered ${this.bindings.length} device(s), polling every ${this.pollIntervalMs / 1000}s`,
    )
  }

  /**
   * Build the gate on top of one relay and two limit inputs.
   *
   * Everything is validated against the status payload the device just
   * returned, because the wiring is declared by hand and a typo here is a
   * gate that reports a position it is not in. A missing component is fatal
   * for the gate only: the rest of the device still comes up.
   */
  private async setupGate(
    ctx: PluginContext,
    hap: any,
    bridge: any,
    status: Record<string, unknown>,
    mac: string,
    baseName: string,
    exposeToHomeKit: boolean,
    accessoryOptions: { manufacturer: string; model: string; firmwareRevision: string },
  ): Promise<void> {
    const gate = this.config.gate as ShellyGateConfig
    const relay = gate.switch ?? GATE_DEFAULTS.switch
    const openInput = gate.openInput ?? GATE_DEFAULTS.openInput
    const closedInput = gate.closedInput ?? GATE_DEFAULTS.closedInput

    if (openInput === closedInput) {
      this.log.error(
        `${this.config.ip}: gate openInput and closedInput are both ${openInput}: ` +
          `they must be different inputs. Skipping the gate.`,
      )
      return
    }

    const missing = [`switch:${relay}`, `input:${openInput}`, `input:${closedInput}`].filter((key) => !status[key])
    if (missing.length > 0) {
      this.log.error(
        `${this.config.ip}: gate needs ${missing.join(', ')}, which this device does not report. ` +
          `Check the switch/openInput/closedInput indexes. Skipping the gate.`,
      )
      return
    }

    // A pulse is one `Switch.Set on=true` and nothing else, so it is the
    // device's auto-off that ends it. Without that the relay stays closed
    // across the board's step input, which on most operators means the gate
    // stops answering its own remote. Worth one extra call at startup to say
    // so, rather than letting it be discovered from the driveway.
    try {
      const switchConfig = await this.client.getSwitchConfig(relay)
      if (!switchConfig?.auto_off) {
        this.log.warn(
          `${this.config.ip}: switch:${relay} has no auto-off timer. The gate needs one ` +
            `(around 500 ms) so each command is a clean pulse. Set it in the Shelly app.`,
        )
      } else if ((switchConfig.auto_off_delay ?? 0) > 2) {
        this.log.warn(
          `${this.config.ip}: switch:${relay} auto-off is ${switchConfig.auto_off_delay}s, which is long ` +
            `for a step pulse. Around 0.5s is usual.`,
        )
      }
    } catch (err) {
      // Not fatal: an older firmware or a locked-down device can refuse this
      // without the pulse itself being any less valid.
      this.log.debug(`${this.config.ip}: could not read switch:${relay} config: ${err}`)
    }

    // The two limit switches are one matched pair on a shared common, so the
    // device must read them the same way round. It is perfectly happy not to:
    // `invert` is per input, and getting it wrong on one of them is silent.
    //
    // The result is a gate that reports the opposite of the truth on half its
    // travel: at rest it looks mid-travel, arriving at one limit looks like
    // arriving at the other, and both limits read high together at full open,
    // which this plugin then reports as a wiring fault. Every symptom points
    // at the gate rather than at a checkbox in the Shelly app, so it is worth
    // saying plainly at startup.
    try {
      const [openConfig, closedConfig] = await Promise.all([
        this.client.getInputConfig(openInput),
        this.client.getInputConfig(closedInput),
      ])
      if (Boolean(openConfig?.invert) !== Boolean(closedConfig?.invert)) {
        this.log.warn(
          `${this.config.ip}: input:${openInput} and input:${closedInput} disagree on "invert" ` +
            `(${openConfig?.invert} vs ${closedConfig?.invert}). Both limit switches are the same ` +
            `kind, so both inputs need the same setting, or the gate will report a position it is ` +
            `not in. Normally-closed limit switches, the usual kind, need invert on.`,
        )
      }
      for (const [index, cfg] of [
        [openInput, openConfig],
        [closedInput, closedConfig],
      ] as Array<[number, ShellyInputConfig | undefined]>) {
        if (cfg?.type && cfg.type !== 'switch') {
          this.log.warn(
            `${this.config.ip}: input:${index} is in "${cfg.type}" mode. A limit switch needs ` +
              `"switch" mode to report a level rather than an event.`,
          )
        }
      }
    } catch (err) {
      this.log.debug(`${this.config.ip}: could not read input config: ${err}`)
    }

    const deviceId = `shelly-${mac}-gate`
    const displayName = gate.name ?? `${baseName} - Gate`

    const controller = new GateController({
      travelTimeMs: (gate.travelTime ?? GATE_DEFAULTS.travelTime) * 1000,
      pulseGapMs: gate.pulseGap ?? GATE_DEFAULTS.pulseGap,
      settleMs: gate.departureSettle,
      pulse: async () => {
        // A pulse moves a heavy gate, so refusing one is safer than sending it
        // hopefully. A request to an unresponsive device is not a no-op: it can
        // arrive and be acted on while the reply is lost, which moves the gate
        // with nobody able to see that it did.
        if (this.gate?.unreachable) {
          throw new ShellyProtocolError(
            `${this.config.ip} is not answering, so the gate was not pulsed. ` +
              `Commanding a gate that cannot be read risks moving it unseen.`,
          )
        }
        // Always logged. This is the one thing in the plugin that moves
        // something physical, and without a record of it an incident cannot be
        // told apart from someone using the remote.
        this.log.info(`${displayName}: pulsing switch:${relay}`)
        this.lastPulseAt = Date.now()
        ctx.recordEvent?.(deviceId, {
          type: 'pulse',
          message: `Pulsed the step input on switch:${relay}`,
          source: 'openbridge',
        })
        await this.client.pulseSwitch(relay)
      },
      onLog: (message) => this.log.info(`${displayName}: ${message}`),
      onChange: (state, target) => {
        // A command must publish exactly what a poll publishes. Reporting a
        // narrower object here would make the telemetry shape depend on who
        // moved the gate, and anything reading it would have to cope with both.
        this.publishGate(ctx)

        // Only real transitions, and only the ones worth a line months later.
        // The poll runs once a second, so recording every call would bury the
        // four events that matter under eighty-six thousand a day.
        if (state === this.lastRecordedState) return
        const previous = this.lastRecordedState
        this.lastRecordedState = state

        // A gate that starts moving without us having pulsed it was driven by
        // its remote, its keypad, or the board's own timer. Saying which is
        // beyond us, but saying that it was not us is not.
        const commanded = Date.now() - this.lastPulseAt < 5000
        const events: Record<string, string> = {
          open: 'Reached the open limit',
          closed: 'Reached the closed limit',
          opening: 'Started opening',
          closing: 'Started closing',
          stopped: 'Stopped between the limits',
        }
        ctx.recordEvent?.(deviceId, {
          type: state,
          message: events[state] ?? `Now ${state}`,
          source: commanded ? 'openbridge' : 'device',
          data: { from: previous, target },
        })
      },
    })

    ctx.registerDevice({
      id: deviceId,
      name: displayName,
      widgetType: 'gate',
      manufacturer: 'Shelly',
      model: accessoryOptions.model,
      actions: [REBOOT_ACTION],
    })
    registerReboot(ctx, deviceId, () => this.client.reboot())

    // `target` is the absolute command, the same one HomeKit issues. `step` is
    // the physical button: the only way to halt a gate mid-travel, which the
    // HomeKit garage door service has no vocabulary for.
    ctx.registerControl(deviceId, 'target', async (value: unknown) => {
      await controller.setTarget(toGateTarget(value))
    })
    ctx.registerControl(deviceId, 'step', async () => {
      await controller.step()
    })

    let accessory: GateAccessory | null = null
    if (exposeToHomeKit) {
      accessory = new GateAccessory(hap, displayName, deviceId, (target) => controller.setTarget(target), {
        ...accessoryOptions,
        serialNumber: `${mac}-gate`,
      })
      try {
        bridge.addBridgedAccessory(accessory.accessory)
      } catch (err) {
        this.log.warn(`Could not add "${displayName}" to the HomeKit bridge: ${err}`)
        accessory = null
      }
    }

    this.gateEventSink = ctx.recordEvent?.bind(ctx)
    this.gate = {
      deviceId,
      displayName,
      controller,
      accessory,
      openInput,
      closedInput,
      invert: gate.invertInputs === true,
      openLimitState: null,
      closedLimitState: null,
      unreachable: false,
      relay,
      relayHeldPolls: 0,
    }

    this.log.info(
      `${this.config.ip}: gate "${displayName}" on switch:${relay}, ` +
        `open limit input:${openInput}, closed limit input:${closedInput}`,
    )
  }

  /** Feed the limit inputs to the gate state machine and report where it is. */
  private readGate(ctx: PluginContext, status: Record<string, unknown>): void {
    const gate = this.gate
    if (!gate) return

    const openLimit = readInputState(status, gate.openInput, gate.invert)
    const closedLimit = readInputState(status, gate.closedInput, gate.invert)
    if (openLimit === null || closedLimit === null) {
      // The inputs vanished from the payload, which means the device was
      // reconfigured under us. Say nothing about the position rather than
      // inventing one.
      gate.accessory?.setFault()
      return
    }

    gate.unreachable = false
    // Recorded before observing, so the change this reading causes is published
    // against the reading that caused it.
    gate.openLimitState = openLimit
    gate.closedLimitState = closedLimit

    gate.controller.observe(openLimit, closedLimit)
    gate.accessory?.setObstructed(gate.controller.fault)
    gate.accessory?.clearFault()
    this.publishGate(ctx)
    this.releaseLatchedRelay(status, gate)
  }

  /**
   * Open the step relay if it has stayed closed.
   *
   * A pulse is half a second and the device's own auto-off ends it, so the
   * relay should never be closed on two polls a second apart. When it is, that
   * timer did not run, and the relay is now holding the operator's step input
   * down. An operator with a held step input ignores its own handset, so this
   * is the state where nobody can open the gate, by app or by remote.
   *
   * It is worth trying to clear even though the usual cause also tends to take
   * the device offline: the sag that stops the timer may leave the device just
   * responsive enough to answer this, and clearing it here saves someone
   * walking out to cut the power. When the device has already gone, this
   * simply cannot run, which is why the real fix is a supply of its own.
   */
  private releaseLatchedRelay(status: Record<string, unknown>, gate: GateBinding): void {
    const relay = status[`switch:${gate.relay}`] as ShellySwitchStatus | undefined
    if (relay?.output !== true) {
      gate.relayHeldPolls = 0
      return
    }

    // One poll can legitimately land inside a pulse. Two cannot: the polls are
    // a second apart and the pulse is half of one.
    gate.relayHeldPolls++
    if (gate.relayHeldPolls < 2) return

    this.gateEventSink?.(gate.deviceId, {
      type: 'fault',
      message: `The step relay stayed closed across ${gate.relayHeldPolls} polls and was opened`,
      source: 'openbridge',
    })
    this.log.error(
      `${this.config.ip}: switch:${gate.relay} has stayed closed across ${gate.relayHeldPolls} polls. ` +
        `Its auto-off did not fire, so it is holding the gate's step input down and the operator will ` +
        `be ignoring its remote. Opening it.`,
    )
    void this.client
      .setSwitch(gate.relay, false)
      .then(() => this.log.info(`${this.config.ip}: released switch:${gate.relay}`))
      .catch((err) =>
        this.log.error(
          `${this.config.ip}: could not release switch:${gate.relay}: ${err}. ` +
            `Cutting power to the operator is the only way out of this.`,
        ),
      )
  }

  /** Report the gate's full state, whoever caused the change. */
  private publishGate(ctx: PluginContext): void {
    const gate = this.gate
    if (!gate) return

    gate.accessory?.update(gate.controller.state, gate.controller.target)
    ctx.reportTelemetry(gate.deviceId, {
      state: gate.controller.state,
      target: gate.controller.target,
      openLimit: gate.openLimitState,
      closedLimit: gate.closedLimitState,
      wiringFault: gate.controller.fault,
    })
  }

  private channelConfig(key: string): ShellyChannelConfig | undefined {
    return (this.config as unknown as Record<string, ShellyChannelConfig | undefined>)[key]
  }

  protected async readOnce(ctx: PluginContext): Promise<void> {
    const status = await this.client.getStatus()
    this.readGate(ctx, status)

    for (const binding of this.bindings) {
      if (binding.kind === 'switch') {
        const sw = status[binding.key] as ShellySwitchStatus | undefined
        if (!sw) continue

        const reading = toSwitchReading(sw)
        ctx.reportTelemetry(binding.deviceId, {
          active: sw.output,
          power: reading.power,
          voltage: reading.voltage,
          current: reading.current,
          totalForwardEnergy: reading.totalForwardEnergy,
          valid: reading.valid,
        })

        binding.switchAccessory?.update(sw.output)
        binding.switchAccessory?.clearFault()
        continue
      }

      const em = status[binding.key] as ShellyEmStatus | undefined
      if (!em) continue
      // Gen2 splits live readings from cumulative counters, so the matching
      // emdata component is pulled in to rebuild a whole PhaseReading.
      const data = status[binding.key.replace('em:', 'emdata:')] as ShellyEmDataStatus | undefined
      const phases: Array<'a' | 'b' | 'c'> = ['a', 'b', 'c']
      const present = phases.filter((ph) => typeof em[`${ph}_act_power`] === 'number')

      const reading =
        binding.index < 0 ? toEmTotalReading(em, data) : toEmPhaseReading(em, present[binding.index], data)

      ctx.reportTelemetry(binding.deviceId, {
        power: reading.power,
        voltage: reading.voltage,
        current: reading.current,
        powerFactor: reading.powerFactor,
        totalForwardEnergy: reading.totalForwardEnergy,
        totalReturnedEnergy: reading.totalReturnedEnergy,
        valid: reading.valid,
      })

      binding.energyAccessory?.update(reading)
      binding.energyAccessory?.clearFault()
    }
  }

  protected onFailure(): void {
    for (const binding of this.bindings) {
      binding.switchAccessory?.setFault()
      binding.energyAccessory?.setFault()
    }
    this.gate?.accessory?.setFault()
    if (this.gate) this.gate.unreachable = true
    // Reading resumes from whatever the gate reports next, rather than being
    // compared against a state from before the device went away.
    this.gate?.controller.markStale()
  }

  /** Also drop the gate's travel timer, which outlives the poll loop otherwise. */
  stop(): void {
    super.stop()
    this.gate?.controller.dispose()
  }

  get deviceIds(): string[] {
    const ids = this.bindings.map((b) => b.deviceId)
    if (this.gate) ids.push(this.gate.deviceId)
    return ids
  }
}

/**
 * Read a gate target off a control value.
 *
 * The UI and the HTTP API both send this, and neither agrees on a shape: a
 * toggle sends a boolean, a select sends a string. Anything unrecognised means
 * closed, which is the safe direction to fall back to for a gate.
 */
function toGateTarget(value: unknown): GateTarget {
  if (typeof value === 'string') return value.toLowerCase() === 'open' ? 'open' : 'closed'
  return value === true ? 'open' : 'closed'
}

// ---- Native OpenBridge plugin ----
//
// Configured under `plugins[]` in the OpenBridge config:
//
//   {
//     "name": "@nubisco/openbridge-shelly-platform",
//     "config": {
//       "devices": [ { "ip": "192.168.1.122", "name": "Home" } ]
//     }
//   }

const runners: PolledShellyDevice[] = []

const nativePlugin = definePlugin({
  manifest: {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description: 'Shelly devices over the local network, with per-phase energy telemetry and history',
    author: 'José Silva',
  },

  async setup(ctx: PluginContext) {
    ctx.log.info('Validating configuration...')
    const result = NativePluginConfigSchema.safeParse(ctx.config)
    if (!result.success) {
      const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
      ctx.log.error(`Configuration is invalid:\n${issues}`)
      throw new Error('Invalid plugin configuration — check the errors above and restart')
    }
    const devices = result.data.devices.filter((d) => !d.exclude)
    if (devices.length === 0) {
      ctx.log.warn('No devices configured — plugin started in unconfigured state. Add devices via the UI.')
    } else {
      ctx.log.info(`Configuration valid — ${devices.length} device(s) configured`)
    }
  },

  async start(ctx: PluginContext) {
    const parsed = NativePluginConfigSchema.safeParse(ctx.config)
    // The schema guarantees `ip`, but zod's inference widens it to optional
    // under this project's `strictNullChecks: false`, so narrow it back here.
    const devices = ((parsed.success ? parsed.data.devices : []) as ShellyDeviceConfig[]).filter((d) => !d.exclude)

    const mainBridge = ctx.getHapBridge?.()
    const hap = mainBridge?.hap ?? null
    const bridge = mainBridge?.bridge ?? null
    if (mainBridge) {
      ctx.log.info('Using main OpenBridge HAP bridge (single pairing)')
    } else {
      ctx.log.info('No HAP bridge available — running with OpenBridge telemetry only')
    }

    for (const config of devices) {
      try {
        // Probe once with the generation-agnostic endpoint before committing to
        // a client: `/shelly` answers on every generation, and only Gen2+
        // reports `gen`. Guessing wrong means 404 on every call forever.
        const probe = new ShellyGen1Client(config.ip, {
          username: config.username,
          password: config.password,
          timeout: config.timeout,
        })
        const info = await probe.getDeviceInfo()
        const runner: PolledShellyDevice =
          info.gen !== undefined && info.gen >= 2
            ? new ShellyGen2Device(config, ctx.log)
            : new ShellyEnergyDevice(config, ctx.log)

        await runner.setup(ctx, hap, bridge)
        runner.start(ctx)
        runners.push(runner)
      } catch (err) {
        const message = err instanceof ShellyProtocolError ? err.message : String((err as Error)?.message ?? err)
        // Do not start a poll loop for a device we could not identify — that is
        // how you end up with an error every few seconds and no data.
        ctx.log.error(`Skipping ${config.ip}: ${message}`)
      }
    }

    if (runners.length === 0 && devices.length > 0) {
      ctx.log.warn('No Shelly devices could be started — check the errors above')
    }
  },

  async stop(ctx: PluginContext) {
    for (const runner of runners) runner.stop()
    runners.length = 0
    ctx.log.info('Stopped polling all devices')
  },
})

// The OpenBridge native loader does: (await import(path)).default ?? mod
// For CJS modules, dynamic import() wraps module.exports as `default`.
module.exports = nativePlugin
module.exports.ShellyEnergyDevice = ShellyEnergyDevice
module.exports.ShellyGen2Device = ShellyGen2Device
