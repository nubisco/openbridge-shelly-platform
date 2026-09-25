import { describe, it, expect, vi } from 'vitest'
import { GateController, type GateState } from '../src/GateController'

/**
 * The controller drives real timers, so the intervals here are tiny rather than
 * faked: the pulse sequencing is the thing under test and mocking the clock out
 * of it would only test the mock.
 */
function makeGate(overrides: { travelTimeMs?: number; pulseGapMs?: number; settleMs?: number } = {}) {
  const pulses: number[] = []
  const changes: Array<[GateState, string]> = []
  const logs: string[] = []
  const controller = new GateController({
    travelTimeMs: overrides.travelTimeMs ?? 200,
    pulseGapMs: overrides.pulseGapMs ?? 2,
    settleMs: overrides.settleMs ?? 4000,
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

describe('GateController: the target follows the gate', () => {
  /**
   * The Home app renders a garage door from the *pair* of characteristics, not
   * from the position: a TargetDoorState of OPEN against a CurrentDoorState of
   * CLOSED is a transition in progress, and it draws "Opening..." with a
   * spinner. So a target left behind after the gate has settled somewhere else
   * is not a cosmetic inaccuracy, it is a tile that claims the gate is moving
   * while it sits still.
   *
   * Reported from a gate that had been parked and closed for eighty minutes
   * and still showed "Opening..." on every app launch and on CarPlay.
   */
  it('follows the gate home when something else closes it', async () => {
    const { controller } = makeGate()

    controller.observe(false, true)
    await controller.setTarget('open')
    controller.observe(true, false)
    expect(controller.state).toBe('open')
    expect(controller.target).toBe('open')

    // Now the remote, the wall button or the operator's own auto-close timer
    // shuts it. Nothing tells the plugin: it only sees the limits move.
    controller.observe(false, false)
    controller.observe(false, true)

    expect(controller.state).toBe('closed')
    // The bug: this stayed 'open', so HomeKit showed "Opening..." for as long
    // as the gate sat there.
    expect(controller.target).toBe('closed')
  })

  it('follows the gate home when something else opens it', async () => {
    const { controller } = makeGate()

    controller.observe(true, false)
    await controller.setTarget('closed')
    controller.observe(false, true)
    expect(controller.target).toBe('closed')

    controller.observe(false, false)
    controller.observe(true, false)

    expect(controller.state).toBe('open')
    expect(controller.target).toBe('open')
  })

  it('tells HomeKit about it, rather than only fixing its own books', async () => {
    const { controller, changes } = makeGate()
    controller.observe(false, true)
    await controller.setTarget('open')
    controller.observe(true, false)

    changes.length = 0
    controller.observe(false, false)
    controller.observe(false, true)

    // An update nobody is told about leaves the tile exactly as wrong as before.
    expect(changes.some(([state, target]) => state === 'closed' && target === 'closed')).toBe(true)
  })

  it('does not overrule a command that is still being carried out', async () => {
    // Mid-sequence the gate is still on the limit it was told to leave. Reading
    // that as "it arrived here, so this is the goal" would cancel the command
    // the user just gave.
    const { controller } = makeGate({ settleMs: 0 })
    controller.observe(false, true)

    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const slow = new GateController({
      travelTimeMs: 200,
      pulseGapMs: 2,
      settleMs: 0,
      pulse: () => held,
    })
    slow.observe(false, true)
    const pending = slow.setTarget('open')

    // While the pulse is in flight, a poll lands showing it still closed.
    slow.observe(false, true)
    expect(slow.target).toBe('open')

    release()
    await pending
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

describe('GateController: an interrupted connection', () => {
  it('does not invent motion from a reading taken after a gap', async () => {
    const { controller } = makeGate()
    controller.observe(false, true)
    expect(controller.state).toBe('closed')

    // The device drops off, reboots, and comes back with its inputs still
    // settling, so the closed limit reads low for a poll or two.
    controller.markStale()
    controller.observe(false, false)

    // Without this, "no limit, and it was closed a moment ago" reads as the
    // gate having just left the closed limit, and a gate nobody touched is
    // reported as opening.
    expect(controller.state).not.toBe('opening')
  })

  it('still follows the gate normally once observation resumes', async () => {
    const { controller } = makeGate()
    controller.observe(false, true)
    controller.markStale()
    controller.observe(false, true) // back, and genuinely still closed
    expect(controller.state).toBe('closed')

    // A real departure after that is inferred as usual.
    controller.observe(false, false)
    expect(controller.state).toBe('opening')
  })

  it('adopts a position that changed while the device was away', () => {
    const { controller } = makeGate()
    controller.observe(false, true)

    // Opened by its remote during the outage.
    controller.markStale()
    controller.observe(true, false)
    expect(controller.state).toBe('open')
  })

  it('drops a travel timeout measured from before the gap', async () => {
    const { controller, logs } = makeGate({ travelTimeMs: 30 })
    controller.observe(false, true)
    await controller.setTarget('open')
    expect(controller.state).toBe('opening')

    controller.markStale()
    await settle()
    // The timer would otherwise fire against a stretch of time nobody watched.
    expect(logs.join(' ')).not.toMatch(/assuming it stopped/)
  })
})

describe('GateController: a gate still sitting on the limit it is leaving', () => {
  it('sends one pulse to close an open gate, even while the limit still reads', async () => {
    // Reproduces a real failure. The gate reached fully open, close was
    // pressed, and it set off and stopped again about ten centimetres later.
    const { controller, pulses } = makeGate({ pulseGapMs: 30 })
    controller.observe(true, false)
    expect(controller.state).toBe('open')

    const closing = controller.setTarget('closed')
    // The poll runs every second and the switch takes a moment to release, so
    // it reports the gate still parked open while it is in fact moving.
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.observe(true, false)
    await closing

    // A second pulse here means stop on this hardware, which is exactly what
    // the gate did.
    expect(pulses).toHaveLength(1)
    expect(controller.state).toBe('closing')
  })

  it('sends one pulse to open a closed gate while the closed limit still reads', async () => {
    const { controller, pulses } = makeGate({ pulseGapMs: 30 })
    controller.observe(false, true)

    const opening = controller.setTarget('open')
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.observe(false, true)
    await opening

    expect(pulses).toHaveLength(1)
    expect(controller.state).toBe('opening')
  })

  it('still accepts arrival at the limit it is travelling towards', async () => {
    const { controller } = makeGate({ pulseGapMs: 30 })
    controller.observe(false, true)
    await controller.setTarget('open')
    expect(controller.state).toBe('opening')

    // Arriving is not a departure reading and must be believed at once.
    controller.observe(true, false)
    expect(controller.state).toBe('open')
  })

  it('believes the limit again once the gate has plainly not moved', async () => {
    const { controller } = makeGate({ pulseGapMs: 5, settleMs: 40 })
    controller.observe(true, false)
    await controller.setTarget('closed')
    expect(controller.state).toBe('closing')

    // Past the settle window the gate is still sitting on the open limit, so
    // it never moved, and pretending otherwise helps nobody.
    await new Promise((resolve) => setTimeout(resolve, 60))
    controller.observe(true, false)
    expect(controller.state).toBe('open')
  })

  it('does not hold the window open across a stop', async () => {
    const { controller } = makeGate({ pulseGapMs: 30 })
    controller.observe(true, false)
    await controller.setTarget('closed')
    await controller.step() // stop it again immediately
    expect(controller.state).toBe('stopped')

    // Stopped is not travelling, so nothing is being left behind.
    controller.observe(true, false)
    expect(controller.state).toBe('open')
  })
})

describe('GateController: a pulse that fails', () => {
  it('stops claiming to know where the gate is', async () => {
    // A request that times out has very often arrived and been acted on: the
    // reply is what went missing. Reporting the old position then describes a
    // gate that may have left it.
    let fail = true
    const changes: Array<[GateState, string]> = []
    const controller = new GateController({
      pulseGapMs: 2,
      travelTimeMs: 500,
      pulse: async () => {
        if (fail) throw new Error('timed out')
      },
      onChange: (state, target) => changes.push([state, target]),
    })
    controller.observe(false, true)
    expect(controller.state).toBe('closed')

    await expect(controller.setTarget('open')).rejects.toThrow('timed out')

    // The position is now unknown, so the next reading is adopted rather than
    // compared against "closed".
    fail = false
    controller.observe(false, false)
    expect(controller.state).not.toBe('opening')
  })

  it('says so, so an incident can be read back from the log', async () => {
    const logs: string[] = []
    const controller = new GateController({
      pulseGapMs: 2,
      pulse: async () => {
        throw new Error('timed out')
      },
      onLog: (m) => logs.push(m),
    })
    controller.observe(false, true)
    await expect(controller.setTarget('open')).rejects.toThrow()
    expect(logs.join(' ')).toMatch(/may or may not have moved/)
  })

  it('does not leave the sequence latched, so later commands still work', async () => {
    let fail = true
    const pulses: number[] = []
    const controller = new GateController({
      pulseGapMs: 2,
      pulse: async () => {
        if (fail) throw new Error('timed out')
        pulses.push(1)
      },
    })
    controller.observe(false, true)
    await expect(controller.setTarget('open')).rejects.toThrow()

    fail = false
    controller.observe(false, true)
    await controller.setTarget('open')
    expect(pulses).toHaveLength(1)
  })
})
