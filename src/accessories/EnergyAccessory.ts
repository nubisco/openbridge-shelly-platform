import type { PhaseReading } from '../types'

/**
 * HomeKit has no characteristic for electrical power, so energy meters are
 * conventionally surfaced as a light sensor whose "lux" reading carries watts.
 * It reads oddly in the Home app, but it is the only way to get a live number
 * on screen, and it keeps parity with the Homebridge plugins people migrate from.
 *
 * The richer per-phase data (volts, amps, power factor) has no HomeKit
 * representation at all — that lives in OpenBridge telemetry instead.
 */

/** HAP clamps CurrentAmbientLightLevel to this range; 0 W would be rejected. */
const LUX_MIN = 0.0001
const LUX_MAX = 100000

export interface EnergyAccessoryOptions {
  /** Watts above which the alert contact sensor trips. 0 disables the sensor. */
  alertThreshold?: number
  manufacturer?: string
  model?: string
  serialNumber?: string
  firmwareRevision?: string
}

/**
 * Wraps a hap-nodejs Accessory exposing a single meter channel.
 *
 * The hap module is injected rather than imported so the plugin works against
 * whichever hap-nodejs instance the OpenBridge host already has loaded.
 */
export class EnergyAccessory {
  readonly accessory: any
  private readonly lightSensor: any
  private readonly alertSensor: any | null

  constructor(
    hap: any,
    readonly displayName: string,
    readonly uuidSeed: string,
    options: EnergyAccessoryOptions = {},
  ) {
    this.accessory = new hap.Accessory(displayName, hap.uuid.generate(uuidSeed))

    this.accessory
      .getService(hap.Service.AccessoryInformation)
      .setCharacteristic(hap.Characteristic.Manufacturer, options.manufacturer ?? 'Shelly')
      .setCharacteristic(hap.Characteristic.Model, options.model ?? 'Energy Meter')
      .setCharacteristic(hap.Characteristic.SerialNumber, options.serialNumber ?? uuidSeed)
      .setCharacteristic(hap.Characteristic.FirmwareRevision, options.firmwareRevision ?? '1.0.0')

    this.lightSensor = this.accessory.addService(hap.Service.LightSensor, displayName)
    this.hapCharacteristic = hap.Characteristic

    const threshold = options.alertThreshold ?? 0
    this.alertSensor =
      threshold > 0 ? this.accessory.addService(hap.Service.ContactSensor, `${displayName} Alert`, 'alert') : null
    this.alertThreshold = threshold
  }

  private readonly hapCharacteristic: any
  private readonly alertThreshold: number

  /** Push a new reading to HomeKit. */
  update(reading: PhaseReading): void {
    const watts = Math.min(LUX_MAX, Math.max(LUX_MIN, reading.power))
    this.lightSensor.updateCharacteristic(this.hapCharacteristic.CurrentAmbientLightLevel, watts)

    if (this.alertSensor) {
      // CONTACT_NOT_DETECTED (1) reads as "open" in the Home app, which is the
      // attention-grabbing state — so that is the one used for over-threshold.
      const tripped = reading.power > this.alertThreshold
      this.alertSensor.updateCharacteristic(
        this.hapCharacteristic.ContactSensorState,
        tripped
          ? this.hapCharacteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.hapCharacteristic.ContactSensorState.CONTACT_DETECTED,
      )
    }
  }

  /** Mark the accessory unreachable so the Home app shows "No Response". */
  setFault(): void {
    this.lightSensor.updateCharacteristic(
      this.hapCharacteristic.StatusFault,
      this.hapCharacteristic.StatusFault.GENERAL_FAULT,
    )
  }

  clearFault(): void {
    this.lightSensor.updateCharacteristic(
      this.hapCharacteristic.StatusFault,
      this.hapCharacteristic.StatusFault.NO_FAULT,
    )
  }
}
