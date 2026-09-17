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
  /** Present this device as a gate rather than as bare relays and inputs */
  gate?: ShellyGateConfig
}

/**
 * Wiring description for a step-by-step gate operator driven by a Shelly.
 *
 * The plugin cannot discover any of this: which relay is wired to the board's
 * step input, and which input reads which limit switch, are facts about the
 * installation. Everything has a default matching the most obvious wiring
 * (relay 0 steps, input 0 is the open limit, input 1 the closed limit).
 */
export interface ShellyGateConfig {
  /** Friendly name for the gate accessory (default "<device> - Gate") */
  name?: string
  /** Relay index wired to the control board's step input (default 0) */
  switch?: number
  /** Input index reading high at the fully-open limit (default 0) */
  openInput?: number
  /** Input index reading high at the fully-closed limit (default 1) */
  closedInput?: number
  /** Seconds a full travel may take before the gate is assumed stopped (default 30) */
  travelTime?: number
  /** Milliseconds between the pulses of a multi-pulse sequence (default 1000) */
  pulseGap?: number
  /** Treat a low input as "at the limit", for normally-closed sensing (default false) */
  invertInputs?: boolean
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

// ─── Gen2+ (RPC API) ─────────────────────────────────────────────────────────
//
// Gen2 devices serve everything under `/rpc/`. `Shelly.GetStatus` returns one
// object keyed by component id ("switch:0", "em:0", "cover:0") rather than
// the fixed arrays Gen1 uses, so components are discovered from the keys.

/** A component id parsed out of a `Shelly.GetStatus` key. */
export interface ShellyComponentId {
  /** "switch" | "em" | "emdata" | "cover" | anything else the device reports */
  type: string
  /** Channel index: the N in "switch:N" */
  index: number
  /** The original key, e.g. "switch:0" */
  key: string
}

/** One `switch:N` component. Power fields are absent on non-metering relays. */
export interface ShellySwitchStatus {
  id: number
  /** Relay state */
  output: boolean
  /** Instantaneous active power in watts (PM models only) */
  apower?: number
  voltage?: number
  current?: number
  /** Cumulative energy; `total` is in watt-hours */
  aenergy?: { total: number }
  /** Present when the device has shut the channel down, e.g. "overpower" */
  errors?: string[]
}

/** One `input:N` component. `state` is the debounced level of a switch input. */
export interface ShellyInputStatus {
  id: number
  /** Null while the input is unconfigured or its type reports no level */
  state?: boolean | null
  errors?: string[]
}

/** The subset of `Switch.GetConfig` the gate wiring cares about. */
export interface ShellySwitchConfig {
  id: number
  /** True when the relay drops out on its own after `auto_off_delay` seconds */
  auto_off?: boolean
  auto_off_delay?: number
}

/** One `em:N` component: a Gen2 energy meter channel (Pro 3EM and friends). */
export interface ShellyEmStatus {
  id: number
  a_act_power?: number
  a_voltage?: number
  a_current?: number
  b_act_power?: number
  b_voltage?: number
  b_current?: number
  c_act_power?: number
  c_voltage?: number
  c_current?: number
  total_act_power?: number
  total_current?: number
}

/** One `emdata:N` component: cumulative counters for the matching `em:N`. */
export interface ShellyEmDataStatus {
  id: number
  /** Watt-hours consumed, per phase */
  a_total_act_energy?: number
  b_total_act_energy?: number
  c_total_act_energy?: number
  /** Watt-hours returned to the grid, per phase */
  a_total_act_ret_energy?: number
  b_total_act_ret_energy?: number
  c_total_act_ret_energy?: number
  total_act?: number
  total_act_ret?: number
}

/** `Shelly.GetStatus`: an open map, since the components vary by model. */
export type ShellyGen2Status = Record<string, unknown>

/** Per-channel overrides, keyed by component id ("switch:0"). */
export interface ShellyChannelConfig {
  /** Overrides the generated "<device> - Switch N" name */
  name?: string
  /** Skip this channel entirely */
  exclude?: boolean
}
