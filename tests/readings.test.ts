import { describe, it, expect } from 'vitest'
import { assertGen1, toPhaseReading, toTotalReading, ShellyProtocolError } from '../src/protocol/ShellyGen1Client'
import type { ShellyStatus } from '../src/types'

// Captured verbatim from a real Shelly 3EM (192.168.1.122, fw v1.14.0).
const REAL_3EM_INFO = {
  type: 'SHEM-3',
  mac: 'C8C9A33E65D6',
  auth: false,
  fw: '20230913-114244/v1.14.0-gcb84623',
  discoverable: false,
  longid: 1,
  num_outputs: 1,
  num_meters: 0,
  num_emeters: 3,
}

// Captured verbatim from a real Shelly Pro 2PM (192.168.1.178, fw 2.0.0).
const REAL_PRO2PM_INFO = {
  name: null,
  id: 'shellypro2pm-ec6260887f18',
  mac: 'EC6260887F18',
  model: 'SPSW-202PE16EU',
  gen: 2,
  fw_id: '20260710-101218/2.0.0-g87fbfa4',
  ver: '2.0.0',
  app: 'Pro2PM',
}

// Captured verbatim from the same 3EM's /status response.
const REAL_3EM_STATUS: ShellyStatus = {
  emeters: [
    { power: 4.15, pf: 0.33, current: 0.1, voltage: 242.85, is_valid: true, total: 224585.1, total_returned: 0.0 },
    {
      power: 221.66,
      pf: 0.17,
      current: 5.45,
      voltage: 242.77,
      is_valid: true,
      total: 1152277.5,
      total_returned: 45062.3,
    },
    { power: 68.46, pf: 0.81, current: 0.35, voltage: 242.77, is_valid: true, total: 999175.0, total_returned: 830.1 },
  ],
  total_power: 294.27,
  emeter_n: { current: 0.0, ixsum: 10.87, mismatch: false, is_valid: false },
}

describe('toPhaseReading', () => {
  it('converts cumulative energy from watt-hours to kilowatt-hours', () => {
    const reading = toPhaseReading(REAL_3EM_STATUS.emeters[0])
    // The device reports 224585.1 Wh; OpenBridge history is kept in kWh.
    expect(reading.totalForwardEnergy).toBe(224.5851)
  })

  it('passes instantaneous values through unchanged', () => {
    const reading = toPhaseReading(REAL_3EM_STATUS.emeters[1])
    expect(reading.power).toBe(221.66)
    expect(reading.voltage).toBe(242.77)
    expect(reading.current).toBe(5.45)
    expect(reading.powerFactor).toBe(0.17)
  })

  it('converts returned energy too', () => {
    const reading = toPhaseReading(REAL_3EM_STATUS.emeters[1])
    expect(reading.totalReturnedEnergy).toBe(45.0623)
  })

  it('marks a channel the meter could not read as invalid', () => {
    const reading = toPhaseReading({ ...REAL_3EM_STATUS.emeters[0], is_valid: false })
    expect(reading.valid).toBe(false)
  })

  it('coerces non-finite values to zero rather than emitting NaN telemetry', () => {
    const reading = toPhaseReading({
      power: NaN,
      pf: 0,
      current: Infinity,
      voltage: 230,
      is_valid: true,
      total: 1000,
      total_returned: 0,
    })
    expect(reading.power).toBe(0)
    expect(reading.current).toBe(0)
    expect(reading.voltage).toBe(230)
  })
})

describe('toTotalReading', () => {
  it('prefers the device-reported aggregate power', () => {
    expect(toTotalReading(REAL_3EM_STATUS).power).toBe(294.27)
  })

  it('sums current across phases', () => {
    // 0.10 + 5.45 + 0.35
    expect(toTotalReading(REAL_3EM_STATUS).current).toBe(5.9)
  })

  it('sums energy across phases and converts to kWh', () => {
    const total = toTotalReading(REAL_3EM_STATUS)
    // (224585.1 + 1152277.5 + 999175.0) Wh
    expect(total.totalForwardEnergy).toBeCloseTo(2376.0376, 4)
    expect(total.totalReturnedEnergy).toBeCloseTo(45.8924, 4)
  })

  it('averages voltage instead of summing it', () => {
    const total = toTotalReading(REAL_3EM_STATUS)
    // Three ~243 V phases must not add up to ~728 V.
    expect(total.voltage).toBeGreaterThan(240)
    expect(total.voltage).toBeLessThan(245)
  })

  it('falls back to summing when the device omits total_power', () => {
    const status = { ...REAL_3EM_STATUS, total_power: undefined as unknown as number }
    expect(toTotalReading(status).power).toBeCloseTo(294.27, 2)
  })

  it('ignores invalid channels when averaging voltage', () => {
    const status: ShellyStatus = {
      ...REAL_3EM_STATUS,
      emeters: [REAL_3EM_STATUS.emeters[0], { ...REAL_3EM_STATUS.emeters[1], is_valid: false, voltage: 0 }],
    }
    expect(toTotalReading(status).voltage).toBe(242.85)
  })

  it('reports invalid when no channel is readable', () => {
    const status: ShellyStatus = { emeters: [], total_power: 0 }
    const total = toTotalReading(status)
    expect(total.valid).toBe(false)
    expect(total.power).toBe(0)
  })
})

describe('assertGen1', () => {
  it('accepts a real Shelly 3EM', () => {
    expect(() => assertGen1(REAL_3EM_INFO, '192.168.1.122')).not.toThrow()
  })

  it('rejects a Gen2 device with an explanation instead of letting it 404-loop', () => {
    // This is the failure mode that motivated the plugin: a Gen3-only client
    // pointed at the wrong generation retries /rpc/ forever and never says why.
    expect(() => assertGen1(REAL_PRO2PM_INFO, '192.168.1.178')).toThrow(ShellyProtocolError)
    expect(() => assertGen1(REAL_PRO2PM_INFO, '192.168.1.178')).toThrow(/Gen2 device/)
    expect(() => assertGen1(REAL_PRO2PM_INFO, '192.168.1.178')).toThrow(/SPSW-202PE16EU/)
  })

  it('rejects a device that reports no Gen1 type', () => {
    expect(() => assertGen1({ mac: 'AABBCCDDEEFF' }, '10.0.0.1')).toThrow(/unrecognised/)
  })

  it('rejects a Gen1 device with no energy meter channels', () => {
    expect(() => assertGen1({ type: 'SHSW-1', mac: 'AABBCCDDEEFF', num_emeters: 0 }, '10.0.0.2')).toThrow(
      /not an energy meter/,
    )
  })
})
