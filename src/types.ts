/** Configuration for a single Shelly energy meter. */
export interface ShellyDeviceConfig {
  /** IP address or hostname on the local network */
  ip: string
  /** Friendly name — phase devices are named "<name> - <phase>" */
  name?: string
  /** HTTP basic auth user, if the device has authentication enabled */
  username?: string
  /** HTTP basic auth password */
  password?: string
  /** Seconds between polls (default 5) */
  pollInterval?: number
  /** Request timeout in milliseconds (default 4000) */
  timeout?: number
  /** Publish HomeKit accessories for this meter (default true) */
  exposeToHomeKit?: boolean
  /** Watts above which the HomeKit alert contact sensor trips. 0 disables it (default 0) */
  alertThreshold?: number
  /** Labels for the individual phases (default Phase A / Phase B / Phase C) */
  phaseNames?: string[]
  /** Register a combined device summing every phase (default true) */
  showTotal?: boolean
  /** Register a device per phase (default true) */
  showPhases?: boolean
  /** Skip this device entirely */
  exclude?: boolean
}

export interface ShellyPlatformConfig {
  platform?: string
  name?: string
  devices?: ShellyDeviceConfig[]
}

/**
 * `/shelly` response. Present on every generation, which makes it the safe
 * endpoint to probe before deciding which API to speak.
 *
 * Gen1 returns `type`; Gen2+ returns `gen` and `model` instead.
 */
export interface ShellyDeviceInfo {
  /** Gen1 only — e.g. "SHEM-3" (3EM) or "SHEM" (EM) */
  type?: string
  /** Gen2+ only — 2, 3, ... */
  gen?: number
  /** Gen2+ only — e.g. "S3EM-003CXCEU63" */
  model?: string
  mac: string
  /** Gen1 firmware string, e.g. "20230913-114244/v1.14.0-gcb84623" */
  fw?: string
  /** Gen2+ firmware id */
  fw_id?: string
  auth?: boolean
  num_emeters?: number
  num_meters?: number
  num_outputs?: number
}

/** One channel of a Gen1 `/status` response. */
export interface ShellyEmeterStatus {
  /** Instantaneous active power in watts */
  power: number
  /** Power factor, -1..1 */
  pf: number
  /** RMS current in amperes */
  current: number
  /** RMS voltage in volts */
  voltage: number
  /** False when the device could not measure this channel */
  is_valid: boolean
  /** Cumulative consumed energy in watt-hours */
  total: number
  /** Cumulative returned (exported) energy in watt-hours */
  total_returned: number
}

/** The subset of the Gen1 `/status` response this plugin consumes. */
export interface ShellyStatus {
  emeters: ShellyEmeterStatus[]
  /** Sum of active power across all channels, in watts */
  total_power: number
  emeter_n?: {
    current: number
    ixsum: number
    mismatch: boolean
    is_valid: boolean
  }
  wifi_sta?: { connected: boolean; ip?: string; rssi?: number }
}

/** Normalised per-channel reading, in the units OpenBridge telemetry expects. */
export interface PhaseReading {
  /** Watts */
  power: number
  /** Volts */
  voltage: number
  /** Amperes */
  current: number
  /** Power factor, -1..1 */
  powerFactor: number
  /** Kilowatt-hours consumed since the meter was last reset */
  totalForwardEnergy: number
  /** Kilowatt-hours returned to the grid */
  totalReturnedEnergy: number
  /** False when the meter reported this channel as invalid */
  valid: boolean
}
