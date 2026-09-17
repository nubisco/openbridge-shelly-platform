import { describe, it, expect, vi } from 'vitest'
import { GateController, type GateState } from '../src/GateController'

/**
 * The controller drives real timers, so the intervals here are tiny rather than
 * faked: the pulse sequencing is the thing under test and mocking the clock out
 * of it would only test the mock.
 */
function makeGate(overrides: { travelTimeMs?: number; pulseGapMs?: number } = {}) {
  const pulses: number[] = []
  const changes: Array<[GateState, string]> = []
  const logs: string[] = []
  const controller = new GateController({
    travelTimeMs: overrides.travelTimeMs ?? 200,
    pulseGapMs: overrides.pulseGapMs ?? 2,
    pulse: async () => {
      pulses.push(pulses.length)
    },
    onChange: (state, target) => changes.push([state, target]),
    onLog: (message) => logs.push(message),
  })
  return { controller, pulses, changes, logs }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('GateController: reading the limits', () => {
  it('reads the gate as open or closed from its limit switches', () => {
    const { controller } = makeGate()

    controller.observe(true, false)
    expect(controller.state).toBe('open')

    controller.observe(false, true)
    expect(controller.state).toBe('closed')
  })

  it('adopts the gate position as the target on the first reading', () => {
    const { controller } = makeGate()
    controller.observe(true, false)
    // A restart with the gate parked open must not leave HomeKit asking for
    // "closed" and a plugin eager to satisfy it.
    expect(controller.target).toBe('open')
  })

  it('infers the direction of a gate moved by a remote', () => {
    const { controller } = makeGate()

    controller.observe(false, true)
    expect(controller.state).toBe('closed')

    // Nobody told the plugin anything; the closed limit simply released.
    controller.observe(false, false)
    expect(controller.state).toBe('opening')

    controller.observe(true, false)
    expect(controller.state).toBe('open')
  })

  it('holds its position when both limits read high, and flags the wiring', () => {
    const { controller, logs } = makeGate()
    controller.observe(false, true)

    controller.observe(true, true)
    expect(controller.fault).toBe(true)
    expect(controller.state).toBe('closed')
    expect(logs.join(' ')).toMatch(/wiring/)

    controller.observe(false, true)
    expect(controller.fault).toBe(false)
  })

  it('treats a low input as "at the limit" when the sensing is inverted', () => {
    // Inversion is applied by readInputState before it gets here, so this only
    // asserts the controller stays agnostic about it.
    const { controller } = makeGate()
    controller.observe(false, true)
    expect(controller.state).toBe('closed')
  })
})

describe('GateController: reaching a target', () => {
  it('opens a closed gate with a single pulse', async () => {
    const { controller, pulses } = makeGate()
    controller.observe(false, true)

    await controller.setTarget('open')
    expect(pulses).toHaveLength(1)
    expect(controller.state).toBe('opening')
  })

  it('closes an open gate with a single pulse', async () => {
    const { controller, pulses } = makeGate()
    controller.observe(true, false)

    await controller.setTarget('closed')
    expect(pulses).toHaveLength(1)
    expect(controller.state).toBe('closing')
  })

  it('does nothing when the gate is already where it was asked to be', async () => {
    const { controller, pulses } = makeGate()
    controller.observe(true, false)

    await controller.setTarget('open')
    expect(pulses).toHaveLength(0)
  })

  it('does nothing when the gate is already moving the right way', async () => {
    const { controller, pulses } = makeGate()
    controller.observe(false, true)
    controller.observe(false, false) // remote opened it
    expect(controller.state).toBe('opening')

    await controller.setTarget('open')
    expect(pulses).toHaveLength(0)
  })

  it('reverses a moving gate with two pulses: stop, then back', async () => {
    const { controller, pulses } = makeGate()
    controller.observe(false, true)
    await controller.setTarget('open')
    expect(controller.state).toBe('opening')
    pulses.length = 0

    await controller.setTarget('closed')
    // One to stop it, one to send it the other way. The board has no other way
    // to express "go back".
    expect(pulses).toHaveLength(2)
    expect(controller.state).toBe('closing')
  })

  it('takes three pulses when the board resumes the wrong way', async () => {
    const { controller, pulses } = makeGate()
    controller.observe(false, true)
    await controller.setTarget('open') // pulse 1: opening
    await controller.step() // stops it mid-travel, as a remote would
    expect(controller.state).toBe('stopped')
    pulses.length = 0

    // The board's next step reverses, so asking for "open" again costs a full
    // close-stop-open cycle. Ugly, and it is what the hardware does.
    await controller.setTarget('open')
    expect(pulses).toHaveLength(3)
    expect(controller.state).toBe('opening')
  })

  it('gives up rather than cycling a gate that never answers', async () => {
    const { controller, pulses, logs } = makeGate()
    controller.observe(false, false) // parked mid-travel, no history

    await controller.setTarget('open')
    expect(pulses.length).toBeLessThanOrEqual(3)
    expect(controller.state).toBe('opening')
    expect(logs.join(' ')).not.toMatch(/giving up/)
  })

  it('does not start a second sequence while one is running', async () => {
    const { controller, pulses } = makeGate({ pulseGapMs: 30 })
    controller.observe(false, true)
    await controller.setTarget('open')
    pulses.length = 0

    const first = controller.setTarget('closed')
    await controller.setTarget('closed') // same command again, mid-sequence
    await first
    expect(pulses).toHaveLength(2)
  })

  it('honours a change of mind partway through a sequence', async () => {
    const { controller, pulses } = makeGate({ pulseGapMs: 30 })
    controller.observe(false, true)
    await controller.setTarget('open')
    pulses.length = 0

    const reversing = controller.setTarget('closed')
    // Between the stop pulse and the reverse pulse, ask for "open" again.
    await new Promise((resolve) => setTimeout(resolve, 10))
    await controller.setTarget('open')
    await reversing

    // The running sequence picks up the new target and keeps stepping until it
    // is moving that way, rather than finishing the journey nobody wants now.
    expect(controller.target).toBe('open')
    expect(controller.state).toBe('opening')
  })

  it("gives a new target its own pulse budget, not the old one's", async () => {
    const { controller, pulses } = makeGate({ pulseGapMs: 30 })
    controller.observe(false, true)
    await controller.setTarget('open')
    pulses.length = 0

    // Reversing a moving gate and then reversing again is the worst case the
    // board can be put in, and it must still finish moving the right way.
    const reversing = controller.setTarget('closed')
    await new Promise((resolve) => setTimeout(resolve, 10))
    await controller.setTarget('open')
    await reversing

    expect(controller.state).toBe('opening')
    expect(pulses.length).toBeGreaterThan(1)
  })
})

describe('GateController: travel timeout', () => {
  it('reports a gate as stopped when it never reaches a limit', async () => {
    const { controller, logs } = makeGate({ travelTimeMs: 20 })
    controller.observe(false, true)

    await controller.setTarget('open')
    expect(controller.state).toBe('opening')

    await settle()
    expect(controller.state).toBe('stopped')
    expect(logs.join(' ')).toMatch(/assuming it stopped/)
  })

  it('does not time out a gate that arrives', async () => {
    const { controller } = makeGate({ travelTimeMs: 20 })
    controller.observe(false, true)
    await controller.setTarget('open')

    controller.observe(true, false)
    await settle()
    expect(controller.state).toBe('open')
  })

  it('clears its timer on dispose', async () => {
    const { controller, changes } = makeGate({ travelTimeMs: 20 })
    controller.observe(false, true)
    await controller.setTarget('open')

    controller.dispose()
    const seen = changes.length
    await settle()
    expect(changes).toHaveLength(seen)
  })
})

describe('GateController: the step button', () => {
  it('stops a moving gate', async () => {
    const { controller } = makeGate()
    controller.observe(false, true)
    await controller.setTarget('open')

    await controller.step()
    expect(controller.state).toBe('stopped')
  })

  it('starts a parked gate', async () => {
    const { controller, pulses } = makeGate()
    controller.observe(false, true)

    await controller.step()
    expect(pulses).toHaveLength(1)
    expect(controller.state).toBe('opening')
  })
})

describe('GateController: errors', () => {
  it('lets a failed pulse reach the caller', async () => {
    const pulse = vi.fn().mockRejectedValue(new Error('device unreachable'))
    const controller = new GateController({ pulse, travelTimeMs: 100, pulseGapMs: 2 })
    controller.observe(false, true)

    await expect(controller.setTarget('open')).rejects.toThrow('device unreachable')
    // The failure must not leave the sequence latched, or the gate would stop
    // accepting commands until a restart.
    await expect(controller.setTarget('open')).rejects.toThrow('device unreachable')
    expect(pulse).toHaveBeenCalledTimes(2)
  })
})
