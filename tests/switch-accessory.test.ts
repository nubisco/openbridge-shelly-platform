import { describe, it, expect, vi } from 'vitest'
import { SwitchAccessory } from '../src/accessories/SwitchAccessory'

/** Exactly what HAP permits on a switch, required plus optional. */
const SWITCH_ALLOWED = new Set(['Name', 'On'])

class HapStatusError extends Error {
  constructor(readonly hapStatus: number) {
    super(`HAP status ${hapStatus}`)
  }
}

function makeHap() {
  const C: Record<string, any> = {
    On: { name: 'On' },
    StatusFault: { name: 'StatusFault', NO_FAULT: 0, GENERAL_FAULT: 1 },
    Manufacturer: { name: 'Manufacturer' },
    Model: { name: 'Model' },
    SerialNumber: { name: 'SerialNumber' },
    FirmwareRevision: { name: 'FirmwareRevision' },
  }

  const touched: string[] = []
  const updates: Array<{ characteristic: string; value: unknown }> = []
  const handlers: Record<string, { get?: () => unknown; set?: (v: unknown) => unknown }> = {}

  const service = {
    getCharacteristic(ch: any) {
      touched.push(ch.name)
      const entry = (handlers[ch.name] ??= {})
      return {
        onGet(fn: () => unknown) {
          entry.get = fn
          return this
        },
        onSet(fn: (v: unknown) => unknown) {
          entry.set = fn
          return this
        },
      }
    },
    updateCharacteristic(ch: any, value: unknown) {
      touched.push(ch.name)
      updates.push({ characteristic: ch.name, value })
      return service
    },
  }

  const info = {
    setCharacteristic() {
      return info
    },
  }

  const hap = {
    Accessory: class {
      constructor(
        public displayName: string,
        public UUID: string,
      ) {}
      getService() {
        return info
      }
      addService() {
        return service
      }
    },
    Service: { AccessoryInformation: { name: 'AccessoryInformation' }, Switch: { name: 'Switch' } },
    Characteristic: C,
    uuid: { generate: (seed: string) => `uuid-${seed}` },
    HapStatusError,
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
  }

  return { hap, touched, updates, handlers }
}

function makeSwitch(onSet = vi.fn().mockResolvedValue(undefined)) {
  const h = makeHap()
  const accessory = new SwitchAccessory(h.hap as any, 'Pool', 'shelly-abc-switch0', onSet)
  return { ...h, accessory, onSet }
}

describe('SwitchAccessory — HAP conformance', () => {
  it('never touches a characteristic the switch service forbids', () => {
    const { accessory, touched } = makeSwitch()
    accessory.update(true)
    accessory.setFault()
    accessory.clearFault()

    const illegal = [...new Set(touched)].filter((name) => !SWITCH_ALLOWED.has(name))
    expect(illegal).toEqual([])
  })

  it('never uses StatusFault, which is not in the switch spec', () => {
    const { accessory, touched } = makeSwitch()
    accessory.setFault()
    accessory.clearFault()
    expect(touched).not.toContain('StatusFault')
  })
})

describe('SwitchAccessory — unreachable', () => {
  it('fails the read with the HAP communication status', () => {
    const { accessory, handlers } = makeSwitch()
    accessory.setFault()
    expect(() => handlers.On.get?.()).toThrow(HapStatusError)
  })

  it('answers normally again once the device recovers', () => {
    const { accessory, handlers } = makeSwitch()
    accessory.update(true)
    accessory.setFault()
    accessory.clearFault()
    expect(handlers.On.get?.()).toBe(true)
  })

  it('republishes state on recovery, and not otherwise', () => {
    const { accessory, updates } = makeSwitch()
    accessory.update(true)
    updates.length = 0

    accessory.clearFault()
    expect(updates).toEqual([])

    accessory.setFault()
    accessory.clearFault()
    expect(updates.map((u) => u.characteristic)).toEqual(['On'])
  })
})

describe('SwitchAccessory — behaviour is unchanged', () => {
  it('actuates the relay and only then believes the new state', async () => {
    const onSet = vi.fn().mockResolvedValue(undefined)
    const { handlers } = makeSwitch(onSet)
    await handlers.On.set?.(true)
    expect(onSet).toHaveBeenCalledWith(true)
  })

  it('keeps the old state when the device rejects the command', async () => {
    const onSet = vi.fn().mockRejectedValue(new Error('unreachable'))
    const { handlers } = makeSwitch(onSet)
    await expect(handlers.On.set?.(true)).rejects.toThrow('unreachable')
    // The throw reaches HomeKit and the tile snaps back.
    expect(handlers.On.get?.()).toBe(false)
  })
})
