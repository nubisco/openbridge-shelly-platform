import type { GateState, GateTarget } from '../GateController'

/**
 * A step-by-step gate operator as a HomeKit accessory.
 *
 * `Service.GarageDoorOpener` rather than `Service.Door` or a pair of switches,
 * even for a sliding gate: it is the only HomeKit service that models an
 * opener with limit switches instead of a position percentage, which is
 * exactly what the hardware reports. The Home app labels it a garage door, and
 * that is cosmetic, and the user renames it.
 *
 * Note the service has no stop: HomeKit only ever asks for open or closed. The
 * plugin exposes a separate step control for halting a gate mid-travel, since
 * the physical button is the only thing that can do it.
 */

export interface GateAccessoryOptions {
  manufacturer?: string
  model?: string
  serialNumber?: string
  firmwareRevision?: string
}

/**
 * Wraps a hap-nodejs Accessory exposing one gate.
 *
 * The hap module is injected rather than imported so the plugin binds to
 * whichever hap-nodejs instance the OpenBridge host already has loaded, the
 * same convention {@link SwitchAccessory} and {@link EnergyAccessory} follow.
 */
export class GateAccessory {
  readonly accessory: any
  private readonly service: any
  private readonly hapCharacteristic: any

  private currentState: GateState = 'closed'
  private targetState: GateTarget = 'closed'
  private obstructed = false
  /** Set while the device cannot be reached, so reads answer with a HAP error. */
  private unreachable = false
  private readonly hap: any

  constructor(
    hap: any,
    readonly displayName: string,
    readonly uuidSeed: string,
    /** Drives the gate towards a target. Rejections propagate to HomeKit. */
    private readonly onSet: (target: GateTarget) => Promise<void>,
    options: GateAccessoryOptions = {},
  ) {
    this.accessory = new hap.Accessory(displayName, hap.uuid.generate(uuidSeed))
    this.hapCharacteristic = hap.Characteristic
    this.hap = hap

    this.accessory
      .getService(hap.Service.AccessoryInformation)
      .setCharacteristic(hap.Characteristic.Manufacturer, options.manufacturer ?? 'Shelly')
      .setCharacteristic(hap.Characteristic.Model, options.model ?? 'Gate')
      .setCharacteristic(hap.Characteristic.SerialNumber, options.serialNumber ?? uuidSeed)
      .setCharacteristic(hap.Characteristic.FirmwareRevision, options.firmwareRevision ?? '1.0.0')

    this.service = this.accessory.addService(hap.Service.GarageDoorOpener, displayName)

    // Served from cache rather than by hitting the device: HomeKit reads these
    // constantly, and the poll loop keeps them fresh.
    this.service.getCharacteristic(hap.Characteristic.CurrentDoorState).onGet(() => {
      this.assertReachable()
      return this.currentDoorState()
    })
    this.service.getCharacteristic(hap.Characteristic.ObstructionDetected).onGet(() => {
      this.assertReachable()
      return this.obstructed
    })

    const target = this.service.getCharacteristic(hap.Characteristic.TargetDoorState)
    target.onGet(() => {
      this.assertReachable()
      return this.targetDoorState()
    })
    target.onSet(async (value: unknown) => {
      const next: GateTarget = Number(value) === this.hapCharacteristic.TargetDoorState.OPEN ? 'open' : 'closed'
      await this.onSet(next)
    })
  }

  /** Push gate state from a poll or a command. No-op when nothing changed. */
  update(state: GateState, target: GateTarget): void {
    if (state !== this.currentState) {
      this.currentState = state
      this.service.updateCharacteristic(this.hapCharacteristic.CurrentDoorState, this.currentDoorState())
    }
    if (target !== this.targetState) {
      this.targetState = target
      this.service.updateCharacteristic(this.hapCharacteristic.TargetDoorState, this.targetDoorState())
    }
  }

  /**
   * Report the wiring fault as an obstruction.
   *
   * Both limits reading high at once means the sensing is broken, and HomeKit
   * has no way to say that. Obstruction is the closest honest signal: it shows
   * a warning on the tile and stops the user trusting the reported position.
   */
  setObstructed(obstructed: boolean): void {
    if (obstructed === this.obstructed) return
    this.obstructed = obstructed
    this.service.updateCharacteristic(this.hapCharacteristic.ObstructionDetected, obstructed)
  }

  /**
   * Mark the accessory unreachable so the Home app shows "No Response".
   *
   * Signalled by failing the reads rather than by a StatusFault characteristic,
   * which is what the switch and meter accessories use. StatusFault is not in
   * the garage door service's required or optional set, and iOS validates a
   * bridged accessory against the spec: hap-nodejs adds the characteristic with
   * a warning, and the Home app then drops the whole accessory. It appears once
   * and is gone by the next refresh, which is a far worse failure than having
   * no fault channel at all.
   */
  setFault(): void {
    this.unreachable = true
  }

  clearFault(): void {
    if (!this.unreachable) return
    this.unreachable = false
    // Push the real state back out, since HomeKit has been refusing reads and
    // has nothing current cached.
    this.service.updateCharacteristic(this.hapCharacteristic.CurrentDoorState, this.currentDoorState())
    this.service.updateCharacteristic(this.hapCharacteristic.TargetDoorState, this.targetDoorState())
    this.service.updateCharacteristic(this.hapCharacteristic.ObstructionDetected, this.obstructed)
  }

  /** Throw the HAP "cannot reach it" status, which reads as No Response. */
  private assertReachable(): void {
    if (!this.unreachable) return
    const { HapStatusError, HAPStatus } = this.hap
    // Older hosts may not expose the typed error; a plain throw still surfaces
    // as a failed read rather than a wrong position, which is the point.
    if (typeof HapStatusError === 'function' && HAPStatus) {
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
    throw new Error('Gate is unreachable')
  }

  private currentDoorState(): number {
    const c = this.hapCharacteristic.CurrentDoorState
    switch (this.currentState) {
      case 'open':
        return c.OPEN
      case 'closed':
        return c.CLOSED
      case 'opening':
        return c.OPENING
      case 'closing':
        return c.CLOSING
      case 'stopped':
        return c.STOPPED
    }
  }

  private targetDoorState(): number {
    const t = this.hapCharacteristic.TargetDoorState
    return this.targetState === 'open' ? t.OPEN : t.CLOSED
  }
}
