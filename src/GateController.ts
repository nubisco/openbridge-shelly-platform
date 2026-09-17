/**
 * The state machine behind a step-by-step gate operator.
 *
 * Gate control boards of this kind expose exactly one input: a dry contact that
 * steps the motor through a fixed cycle (open, stop, close, stop, ...). There is
 * no "open" command and no "close" command, only "next". HomeKit, on the other
 * hand, asks for an absolute target: open or closed. Bridging the two is the
 * whole job of this class, and it is worth having on its own, away from
 * hap-nodejs and away from HTTP, because it is the part that can be reasoned
 * about and tested exhaustively.
 *
 * Position comes from the board's own limit switches, tapped as two inputs:
 * one reads high at the fully-open limit, the other at the fully-closed limit.
 * Neither high means the gate is somewhere in between, which is ambiguous on
 * its own: it could be travelling either way, or standing still. The direction
 * is recovered from *which limit it just left*, which is always observable,
 * because leaving a limit is the only way to get there.
 */

/** Where the gate is, in the vocabulary HomeKit and the UI both understand. */
export type GateState = 'open' | 'closed' | 'opening' | 'closing' | 'stopped'

/** What HomeKit can ask for. The hardware has no "stop" target. */
export type GateTarget = 'open' | 'closed'

/** What the next pulse on the step input will do, given where the board is. */
export type PulseEffect = 'open' | 'close' | 'stop'

export interface GateControllerOptions {
  /**
   * How long a full travel may take before the gate is assumed to have stopped,
   * in milliseconds. This is the only way to notice that a remote pressed stop
   * mid-travel: the limits say nothing, they are simply both open.
   */
  travelTimeMs?: number
  /** Pause between the pulses of a multi-pulse sequence, in milliseconds. */
  pulseGapMs?: number
  /** Fires one step pulse. Rejections abort the sequence and propagate. */
  pulse: () => Promise<void>
  /** Called whenever the observable state changes. */
  onChange?: (state: GateState, target: GateTarget) => void
  onLog?: (message: string) => void
}

/**
 * Reaching a target can cost at most three pulses: stopped mid-travel with the
 * next step going the wrong way needs one to start it wrong, one to stop it and
 * one to reverse. Anything beyond that means the gate is not responding, and
 * pulsing on would drive it back and forth forever.
 */
const MAX_PULSES = 3

export class GateController {
  private stateValue: GateState = 'stopped'
  private targetValue: GateTarget = 'closed'
  /**
   * The direction of the last travel, which is what decides where the board
   * resumes from a mid-travel stop: the next pulse always reverses it.
   * Null until the gate has been seen moving at least once.
   */
  private lastDirection: GateTarget | null = null
  /** True while a pulse sequence is running, so polls cannot start a second one. */
  private sequenceRunning = false
  private travelTimer: ReturnType<typeof setTimeout> | null = null
  /** Both limits high at once: physically impossible, so the wiring is wrong. */
  private faultValue = false
  private seenFirstReading = false
  /**
   * Set when observation has been interrupted, so the next reading is adopted
   * rather than compared against a stale one.
   */
  private stale = false

  private readonly travelTimeMs: number
  private readonly pulseGapMs: number

  constructor(private readonly options: GateControllerOptions) {
    this.travelTimeMs = options.travelTimeMs ?? 30_000
    this.pulseGapMs = options.pulseGapMs ?? 1000
  }

  get state(): GateState {
    return this.stateValue
  }

  get target(): GateTarget {
    return this.targetValue
  }

  /** True when both limit inputs read high, which can only be a wiring fault. */
  get fault(): boolean {
    return this.faultValue
  }

  /**
   * Feed one reading of the two limit inputs.
   *
   * Called from the poll loop, so it runs far more often than anything changes
   * and must be cheap and idempotent. It is also the only source of truth about
   * gates driven by a remote or the wall button, which move without this plugin
   * ever being told.
   */
  observe(openLimit: boolean, closedLimit: boolean): void {
    if (openLimit && closedLimit) {
      // Do not touch the state: a shorted or miswired common says nothing about
      // where the gate actually is, and guessing would be worse than holding.
      if (!this.faultValue) {
        this.faultValue = true
        this.options.onLog?.('both limit inputs are high at once, which should be impossible. Check the wiring')
      }
      return
    }
    if (this.faultValue) {
      this.faultValue = false
      this.options.onLog?.('limit inputs are consistent again')
    }

    // A reading taken after a gap says where the gate is, not what it did. The
    // difference matters: the inference below reads "no limit, and it was at
    // one a moment ago" as the gate having just left it. Across a gap that is
    // not a moment ago, and a device that dropped off and came back with its
    // inputs still settling gets reported as a gate that started moving on its
    // own. That is how a gate sitting closed came to show "Opening" in the
    // Home app with nobody having touched it.
    const previous = this.stale ? null : this.stateValue
    this.stale = false

    if (openLimit) {
      this.clearTravelTimer()
      this.lastDirection = 'open'
      this.transition('open')
    } else if (closedLimit) {
      this.clearTravelTimer()
      this.lastDirection = 'closed'
      this.transition('closed')
    } else if (previous === 'open' || previous === 'closed') {
      // It just left a limit. Nothing else can put it here, so the direction is
      // certain even though no command was issued: a gate that leaves the open
      // limit is closing.
      const direction: GateTarget = previous === 'open' ? 'closed' : 'open'
      this.lastDirection = direction
      this.startTravelTimer()
      this.transition(direction === 'open' ? 'opening' : 'closing')
    }
    // Otherwise it is still between the limits and already recorded as opening,
    // closing or stopped. Leave it alone: the limits cannot tell these apart.

    if (!this.seenFirstReading) {
      this.seenFirstReading = true
      // Adopt whatever the gate was doing as the target, so a bridge restart
      // does not immediately present HomeKit with an unmet goal it will try to
      // satisfy by moving a gate nobody asked to move.
      this.targetValue = this.stateValue === 'open' || this.stateValue === 'opening' ? 'open' : 'closed'
      this.options.onChange?.(this.stateValue, this.targetValue)
    }
  }

  /**
   * Drive the gate towards a target, pulsing as many times as the board's cycle
   * requires.
   *
   * Resolves once the gate is moving the right way (or already there), not once
   * it has arrived: HomeKit wants the OPENING state promptly, and the poll loop
   * reports the arrival.
   */
  async setTarget(target: GateTarget): Promise<void> {
    this.targetValue = target
    this.options.onChange?.(this.stateValue, this.targetValue)

    // A sequence already in flight re-reads `targetValue` between pulses, so a
    // change of mind mid-sequence is honoured without stacking two senders onto
    // the same relay.
    if (this.sequenceRunning) return

    this.sequenceRunning = true
    try {
      let pursuing = this.targetValue
      let sent = 0
      for (;;) {
        if (sent > 0) await delay(this.pulseGapMs)

        // Re-read the target after the gap rather than before it. A poll or a
        // second command lands in that window, and pulsing on the strength of a
        // reading taken a second ago is how a gate ends up driven the wrong way.
        if (this.targetValue !== pursuing) {
          // A new goal restarts the budget: the pulses already spent were
          // steps towards somewhere else and must not count against this one.
          pursuing = this.targetValue
          sent = 0
        }
        if (this.satisfied()) return
        if (sent >= MAX_PULSES) {
          this.options.onLog?.(
            `gate did not reach "${pursuing}" after ${MAX_PULSES} pulses, so stopping rather than cycling it`,
          )
          return
        }

        await this.options.pulse()
        this.applyPredictedPulse()
        sent++
      }
    } finally {
      this.sequenceRunning = false
    }
  }

  /**
   * Fire a single raw step pulse, bypassing the target logic.
   *
   * The physical button, in other words. HomeKit's garage door service has no
   * stop, so this is the only way to halt a gate mid-travel from software.
   */
  async step(): Promise<void> {
    await this.options.pulse()
    this.applyPredictedPulse()
  }

  /**
   * Note that observation has lapsed, so the next reading is taken as the truth
   * rather than as the next frame of a sequence.
   *
   * Called when the device stops answering. A gate does not stop being a gate
   * while its controller is offline, but what happened during the gap is
   * unknowable, and guessing produces motion that never happened.
   */
  markStale(): void {
    this.stale = true
    // Whatever it was doing, it is not being watched any more, so a travel
    // timeout measured from before the gap means nothing.
    this.clearTravelTimer()
  }

  /** Stop the travel timer. Call when the device runner shuts down. */
  dispose(): void {
    this.clearTravelTimer()
  }

  /** What the next pulse will do, following the board's step cycle. */
  private predictedPulse(): PulseEffect {
    switch (this.stateValue) {
      case 'closed':
        return 'open'
      case 'open':
        return 'close'
      case 'opening':
      case 'closing':
        return 'stop'
      case 'stopped':
        // A mid-travel stop always reverses. With no history to reverse (the
        // bridge started with the gate already parked in between), assume it
        // was opening, which makes the next pulse close it, the safer guess
        // for a gate, and corrected by the next poll either way.
        return this.lastDirection === 'open' ? 'close' : 'open'
    }
  }

  /**
   * Advance the state as if the pulse just sent had its predicted effect.
   *
   * Optimistic on purpose: the limit inputs take up to a poll interval to
   * confirm, and HomeKit showing "Opening" the instant the relay clicks is the
   * difference between a responsive tile and one that looks broken. Every
   * prediction is overwritten by the next {@link observe}.
   */
  private applyPredictedPulse(): void {
    switch (this.predictedPulse()) {
      case 'open':
        this.lastDirection = 'open'
        this.startTravelTimer()
        this.transition('opening')
        return
      case 'close':
        this.lastDirection = 'closed'
        this.startTravelTimer()
        this.transition('closing')
        return
      case 'stop':
        this.clearTravelTimer()
        this.transition('stopped')
    }
  }

  /** True when the gate is where it was asked to be, or on its way there. */
  private satisfied(): boolean {
    return this.targetValue === 'open'
      ? this.stateValue === 'open' || this.stateValue === 'opening'
      : this.stateValue === 'closed' || this.stateValue === 'closing'
  }

  private transition(next: GateState): void {
    if (next === this.stateValue) return
    this.stateValue = next
    this.options.onChange?.(next, this.targetValue)
  }

  private startTravelTimer(): void {
    this.clearTravelTimer()
    this.travelTimer = setTimeout(() => {
      this.travelTimer = null
      // Still between the limits long after a full travel should have finished:
      // something stopped it. The board is now parked mid-cycle, so the next
      // pulse reverses, which is exactly what the 'stopped' state encodes.
      if (this.stateValue === 'opening' || this.stateValue === 'closing') {
        this.options.onLog?.(
          `gate did not reach a limit within ${Math.round(this.travelTimeMs / 1000)}s, so assuming it stopped`,
        )
        this.transition('stopped')
      }
    }, this.travelTimeMs)
    // Never hold the process open for a gate that is simply sitting still.
    this.travelTimer.unref?.()
  }

  private clearTravelTimer(): void {
    if (this.travelTimer) {
      clearTimeout(this.travelTimer)
      this.travelTimer = null
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
