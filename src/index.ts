import { z } from 'zod'
import {
  ShellyGen1Client,
  ShellyProtocolError,
  assertGen1,
  toPhaseReading,
  toTotalReading,
} from './protocol/ShellyGen1Client'
import { EnergyAccessory } from './accessories/EnergyAccessory'
import type { PhaseReading, ShellyDeviceConfig, ShellyDeviceInfo } from './types'

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
  registerDevice(device: { id: string; name: string; widgetType: string; manufacturer?: string; model?: string }): void
  registerControl(deviceId: string, controlId: string, handler: (value: unknown) => void | Promise<void>): void
  getHapBridge?(): { bridge: unknown; hap: unknown } | null
}

function definePlugin<T extends { manifest: { name: string; version: string } }>(plugin: T): T {
  return plugin
}

// ---- Config schema ----

const DEFAULT_PHASE_NAMES = ['Phase A', 'Phase B', 'Phase C']

const ShellyDeviceConfigSchema = z.object({
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
})

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
 * Polls one physical meter and fans its channels out to OpenBridge devices.
 *
 * Each phase becomes its own OpenBridge device so it gets an independent
 * telemetry stream and energy history file, which is what makes per-phase
 * charting possible at all.
 */
export class ShellyEnergyDevice {
  private readonly client: ShellyGen1Client
  private readonly bindings: ChannelBinding[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private info: ShellyDeviceInfo | null = null

  /** Suppresses identical repeating errors so a failing device cannot flood the log. */
  private lastErrorMessage: string | null = null
  private suppressedErrors = 0

  constructor(
    private readonly config: ShellyDeviceConfig,
    private readonly log: PluginLogger,
  ) {
    this.client = new ShellyGen1Client(config.ip, {
      username: config.username,
      password: config.password,
      timeout: config.timeout,
    })
  }

  get pollIntervalMs(): number {
    return (this.config.pollInterval ?? 5) * 1000
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
      })

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

  /** One poll cycle. Never throws — a failing device must not take the plugin down. */
  async poll(ctx: PluginContext): Promise<void> {
    // Skip if the previous poll is still in flight, so a slow device cannot
    // pile up overlapping requests.
    if (this.polling) return
    this.polling = true

    try {
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

      this.onSuccess()
    } catch (err) {
      this.onError(err)
      for (const binding of this.bindings) binding.accessory?.setFault()
    } finally {
      this.polling = false
    }
  }

  private onSuccess(): void {
    if (this.lastErrorMessage) {
      const suffix = this.suppressedErrors > 0 ? ` (${this.suppressedErrors} repeat(s) suppressed)` : ''
      this.log.info(`${this.config.ip}: recovered${suffix}`)
      this.lastErrorMessage = null
      this.suppressedErrors = 0
    }
  }

  private onError(err: unknown): void {
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

  get deviceIds(): string[] {
    return this.bindings.map((b) => b.deviceId)
  }

  get deviceInfo(): ShellyDeviceInfo | null {
    return this.info
  }
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

const runners: ShellyEnergyDevice[] = []

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
      const runner = new ShellyEnergyDevice(config, ctx.log)
      try {
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
