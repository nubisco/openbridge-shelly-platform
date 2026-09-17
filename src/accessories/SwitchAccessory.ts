/**
 * A Shelly relay channel as a HomeKit accessory.
 *
 * Always a plain `Service.Switch`, never a Lightbulb or Outlet, even when the
 * channel drives a light. What a relay is wired to is a property of the house,
 * not of the device, and the plugin cannot know it. OpenBridge owns that
 * decision instead: its per-service type override re-presents the accessory and
 * re-applies the choice on every restart. Offering a second `type` setting here
 * would give one decision two sources of truth, which is exactly what made the
 * pool light keep reverting to a switch.
 */

export interface SwitchAccessoryOptions {
  manufacturer?: string
  model?: string
  serialNumber?: string
  firmwareRevision?: string
}

/**
 * Wraps a hap-nodejs Accessory exposing one relay channel.
 *
 * The hap module is injected rather than imported so the plugin binds to
 * whichever hap-nodejs instance the OpenBridge host already has loaded, the
 * same convention {@link EnergyAccessory} follows.
 */
export class SwitchAccessory {
  readonly accessory: any
  private readonly switchService: any
  private readonly hapCharacteristic: any
  private readonly hap: any
  /** Last state read from the device, served to HomeKit between polls. */
  private state = false
  /** Set while the device cannot be reached, so reads answer with a HAP error. */
  private unreachable = false

  constructor(
    hap: any,
    readonly displayName: string,
    readonly uuidSeed: string,
    /** Actuates the physical relay. Rejections propagate to HomeKit as a failure. */
    private readonly onSet: (on: boolean) => Promise<void>,
    options: SwitchAccessoryOptions = {},
  ) {
    this.accessory = new hap.Accessory(displayName, hap.uuid.generate(uuidSeed))
    this.hapCharacteristic = hap.Characteristic
    this.hap = hap

    this.accessory
      .getService(hap.Service.AccessoryInformation)
      .setCharacteristic(hap.Characteristic.Manufacturer, options.manufacturer ?? 'Shelly')
      .setCharacteristic(hap.Characteristic.Model, options.model ?? 'Switch')
      .setCharacteristic(hap.Characteristic.SerialNumber, options.serialNumber ?? uuidSeed)
      .setCharacteristic(hap.Characteristic.FirmwareRevision, options.firmwareRevision ?? '1.0.0')

    this.switchService = this.accessory.addService(hap.Service.Switch, displayName)

    const on = this.switchService.getCharacteristic(hap.Characteristic.On)
    // Served from cache rather than by hitting the device: HomeKit reads this
    // far more often than the relay changes, and the poll loop keeps it fresh.
    on.onGet(() => {
      this.assertReachable()
      return this.state
    })
    on.onSet(async (value: unknown) => {
      const next = Boolean(value)
      await this.onSet(next)
      // Only believe it once the device accepted the call; on failure the throw
      // reaches HomeKit and the tile snaps back.
      this.state = next
    })
  }

  /** Push relay state from a poll. No-op when nothing changed. */
  update(on: boolean): void {
    if (on === this.state) return
    this.state = on
    this.switchService.updateCharacteristic(this.hapCharacteristic.On, on)
  }

  /**
   * Mark the accessory unreachable so the Home app shows "No Response".
   *
   * Signalled by failing the read rather than with a StatusFault
   * characteristic. StatusFault is not in the switch service's required or
   * optional set: hap-nodejs attaches it with a warning, and iOS validates a
   * bridged accessory against the spec. HomeKit has tolerated it here for as
   * long as this plugin has existed, but the identical violation on a garage
   * door service got the whole accessory dropped, so this is not a guarantee
   * worth relying on.
   */
  setFault(): void {
    this.unreachable = true
  }

  clearFault(): void {
    if (!this.unreachable) return
    this.unreachable = false
    // Push the state back out: HomeKit has been refused reads and has nothing
    // current cached.
    this.switchService.updateCharacteristic(this.hapCharacteristic.On, this.state)
  }

  /** Throw the HAP "cannot reach it" status, which reads as No Response. */
  private assertReachable(): void {
    if (!this.unreachable) return
    const { HapStatusError, HAPStatus } = this.hap
    if (typeof HapStatusError === 'function' && HAPStatus) {
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
    throw new Error('Switch is unreachable')
  }
}
