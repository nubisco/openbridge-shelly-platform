import { describe, it, expect, vi } from 'vitest'
import { GateAccessory } from '../src/accessories/GateAccessory'

/**
 * A stand-in for hap-nodejs, which is an optional peer dependency and is not
 * installed here. It records every characteristic the accessory touches, which
 * is the point: iOS validates a bridged accessory against the HAP spec and
 * silently drops one that carries a characteristic its service does not allow.
 */

/** Exactly what HAP permits on a garage door opener, required plus optional. */
const GARAGE_DOOR_ALLOWED = new Set([
  'Name',
  'CurrentDoorState',
  'TargetDoorState',
  'ObstructionDetected',
  'LockCurrentState',
  'LockTargetState',
])

class HapStatusError extends Error {
  constructor(readonly hapStatus: number) {
    super(`HAP status ${hapStatus}`)
  }
}

function makeHap() {
  const C: Record<string, any> = {
    CurrentDoorState: { name: 'CurrentDoorState', OPEN: 0, CLOSED: 1, OPENING: 2, CLOSING: 3, STOPPED: 4 },
    TargetDoorState: { name: 'TargetDoorState', OPEN: 0, CLOSED: 1 },
    ObstructionDetected: { name: 'ObstructionDetected' },
    StatusFault: { name: 'StatusFault', NO_FAULT: 0, GENERAL_FAULT: 1 },
    Manufacturer: { name: 'Manufacturer' },
    Model: { name: 'Model' },
    SerialNumber: { name: 'SerialNumber' },
    FirmwareRevision: { name: 'FirmwareRevision' },
  }

  /** Every characteristic the gate service was read, written or wired for. */
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
    Service: { AccessoryInformation: { name: 'AccessoryInformation' }, GarageDoorOpener: { name: 'GarageDoorOpener' } },
    Characteristic: C,
    uuid: { generate: (seed: string) => `uuid-${seed}` },
    HapStatusError,
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
  }

  return { hap, touched, updates, handlers }
}

function makeGate(onSet = vi.fn().mockResolvedValue(undefined)) {
  const h = makeHap()
  const accessory = new GateAccessory(h.hap as any, 'Gate', 'shelly-abc-gate', onSet)
  return { ...h, accessory, onSet }
}

describe('GateAccessory — HAP conformance', () => {
  it('never touches a characteristic the garage door service forbids', () => {
    const { accessory, touched } = makeGate()
    accessory.update('opening', 'open')
    accessory.setObstructed(true)
    accessory.setFault()
    accessory.clearFault()

    const illegal = [...new Set(touched)].filter((name) => !GARAGE_DOOR_ALLOWED.has(name))
    // iOS drops an accessory that carries one of these, so it shows up once and
    // is gone by the next refresh.
    expect(illegal).toEqual([])
  })

  it('specifically never uses StatusFault, which is not in the garage door spec', () => {
    const { accessory, touched, updates } = makeGate()
    accessory.setFault()
    accessory.clearFault()

    expect(touched).not.toContain('StatusFault')
    expect(updates.map((u) => u.characteristic)).not.toContain('StatusFault')
  })
})

describe('GateAccessory — unreachable', () => {
  it('fails reads with the HAP communication status so Home shows No Response', () => {
    const { accessory, handlers } = makeGate()
    accessory.setFault()

    for (const name of ['CurrentDoorState', 'TargetDoorState', 'ObstructionDetected']) {
      expect(() => handlers[name].get?.()).toThrow(HapStatusError)
    }
  })

  it('answers reads normally again once the device recovers', () => {
    const { accessory, handlers } = makeGate()
    accessory.update('open', 'open')
    accessory.setFault()
    accessory.clearFault()

    expect(handlers.CurrentDoorState.get?.()).toBe(0) // OPEN
    expect(handlers.TargetDoorState.get?.()).toBe(0)
  })

  it('pushes the real state back out on recovery, since HomeKit cached nothing', () => {
    const { accessory, updates } = makeGate()
    accessory.update('closed', 'closed')
    accessory.setFault()
    updates.length = 0

    accessory.clearFault()
    expect(updates.map((u) => u.characteristic).sort()).toEqual([
      'CurrentDoorState',
      'ObstructionDetected',
      'TargetDoorState',
    ])
  })

  it('does not republish when it was never unreachable', () => {
    const { accessory, updates } = makeGate()
    accessory.update('open', 'open')
    updates.length = 0

    accessory.clearFault()
    expect(updates).toEqual([])
  })
})

describe('GateAccessory — state mapping', () => {
  it('maps every gate state onto the matching door state', () => {
    const { accessory, handlers } = makeGate()
    const cases: Array<[any, number]> = [
      ['open', 0],
      ['closed', 1],
      ['opening', 2],
      ['closing', 3],
      ['stopped', 4],
    ]
    for (const [state, expected] of cases) {
      accessory.update(state, 'open')
      expect(handlers.CurrentDoorState.get?.()).toBe(expected)
    }
  })

  it('drives the gate when HomeKit sets a target', async () => {
    const { handlers, onSet } = makeGate()
    await handlers.TargetDoorState.set?.(0) // OPEN
    expect(onSet).toHaveBeenCalledWith('open')

    await handlers.TargetDoorState.set?.(1) // CLOSED
    expect(onSet).toHaveBeenCalledWith('closed')
  })
})
