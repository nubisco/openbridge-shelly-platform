# Gates

A Gen2+ Shelly with one relay and two spare inputs can drive a gate, and the plugin will present
it to OpenBridge and HomeKit as a gate rather than as a relay and two contact sensors.

```json
{
  "ip": "192.168.1.201",
  "name": "Driveway",
  "gate": {
    "switch": 0,
    "openInput": 0,
    "closedInput": 1,
    "travelTime": 25
  }
}
```

That registers one device, `Driveway - Gate`, which opens, closes and reports where it is.

## What the hardware actually offers

This is worth understanding before configuring anything, because it explains every quirk below.

A step-by-step gate operator has **one** control input. A pulse on it does not mean "open" or
"close": it means **next**, and the board walks a fixed cycle.

```text
closed ──pulse──▶ opening ──pulse──▶ stopped ──pulse──▶ closing ──pulse──▶ stopped ──pulse──▶ opening ...
                      │                                      │
                   (arrives)                              (arrives)
                      ▼                                      ▼
                    open                                   closed
```

So there is no command for "open". There is only "step", and what a step does depends entirely
on what the board did last. HomeKit, meanwhile, asks for an absolute target: open or closed.
Reconciling the two is the whole job of this feature.

Position comes from the operator's own **limit switches**, tapped as two Shelly inputs. One reads
high when the gate is fully open, the other when it is fully closed. Neither high means the gate
is somewhere in between, and that alone cannot tell you whether it is moving or standing still.

## Wiring

| Signal               | Goes to                             | Reads high when          |
| -------------------- | ----------------------------------- | ------------------------ |
| Fully-open limit     | An input (`openInput`, default 0)   | The gate is fully open   |
| Fully-closed limit   | An input (`closedInput`, default 1) | The gate is fully closed |
| Step / start command | A relay (`switch`, default 0)       | Pulsed to step the board |

Three things have to be true, and none of them can be discovered by the plugin:

1. **The relay is wired as a dry contact** across the operator's step input. The Shelly is
   switching the board's own signal, not supplying voltage to it.
2. **The relay has an auto-off timer**, around 500 ms, set in the Shelly app. The plugin sends
   one `Switch.Set on=true` and nothing else. See [Why the auto-off matters](#why-the-auto-off-matters).
3. **The two inputs are set to `Switch` mode and detached** from the relays, so a limit switch
   closing does not also fire the step relay.

### Both limit inputs must be inverted the same way

The two limit switches are one matched pair on a shared common, so the Shelly has to read
them the same way round. `invert` is a per-input setting, and getting it wrong on one of
them is silent: nothing complains, and the gate simply reports the opposite of the truth
for half its travel.

The symptoms all point at the gate rather than at a checkbox in the app. A closed gate
reads as mid-travel or open. Arriving at one limit looks like arriving at the other, so a
gate that has just started opening is reported as closed, and the Home app re-sends the
command, which steps the board again and stops the gate a foot into its travel. At full
open both limits read high together, which this plugin reports as a wiring fault and
HomeKit shows as an obstruction.

**Normally-closed limit switches, the usual kind, need `invert` turned on.** They conduct
at rest and open at the limit, so "at the limit" is electrically low. Set both inputs the
same.

The plugin compares the two at startup and says so when they disagree:

```text
192.168.1.201: input:0 and input:1 disagree on "invert" (true vs false). Both limit
switches are the same kind, so both inputs need the same setting, or the gate will
report a position it is not in.
```

The plugin checks what it can at startup and logs what it finds:

```text
192.168.1.201: gate "Driveway - Gate" on switch:0, open limit input:0, closed limit input:1
```

If the relay has no auto-off timer, or the inputs named do not exist on the device, it says so
rather than running a gate on assumptions.

## Why the auto-off matters

A pulse is **one** RPC call, `Switch.Set on=true`, and the device's own auto-off opens the relay
again. The plugin deliberately does not send `on=false` itself.

The reason is what happens when the bridge dies at the wrong moment. If the plugin owned both
halves of the pulse, a crash or a network drop between them would leave the relay **closed**,
holding the operator's step input down indefinitely. On most boards that is a gate that stops
answering its own remote, and the fix involves a ladder. Letting the device time its own pulse
means nothing the bridge does can latch that contact.

Without an auto-off timer configured, the first command closes the relay and it stays closed.
The plugin warns at startup:

```text
192.168.1.201: switch:0 has no auto-off timer. The gate needs one (around 500 ms)
so each command is a clean pulse. Set it in the Shelly app.
```

## Reaching a target

Because there is only "step", getting to a requested position can take more than one pulse. The
plugin tracks where the board is in its cycle and sends as many as the cycle needs:

| Gate is                         | Asked for | Pulses | What happens                         |
| ------------------------------- | --------- | ------ | ------------------------------------ |
| Closed                          | Open      | 1      | Starts opening                       |
| Open                            | Closed    | 1      | Starts closing                       |
| Open                            | Open      | 0      | Already there                        |
| Opening                         | Open      | 0      | Already on its way                   |
| Opening                         | Closed    | 2      | Stop, then reverse                   |
| Stopped mid-travel, was opening | Closed    | 1      | The board's next step already closes |
| Stopped mid-travel, was opening | Open      | 3      | Close, stop, open                    |

That last row is the hardware, not the plugin. A board parked mid-cycle always resumes in the
opposite direction, so asking it to carry on the way it was going costs a full reversal. The gate
visibly moves the wrong way for a moment. There is no way around it from software.

### A gate does not leave its limit switch instantly

A limit switch releases when the gate has physically moved off it, a second or two after
the motor starts. For that moment the gate is moving and the limits still report it
parked, and believing that reading turns a running gate back into a stationary one.

This matters because the sequence above re-reads the position between pulses, so it can
honour a change of mind. Without allowing for the delay the gate sets off, the next poll
reports it still sitting on the limit it just left, the sequence decides it never started
and pulses again, and on this hardware the second pulse means stop. The gate travels a
foot and halts.

So a reading that puts the gate on the limit it was told to leave is ignored for
`departureSettle` (default 4 seconds). Arrival at the limit it is travelling _towards_ is
believed at once, and once the window passes the reading is believed again, because a gate
still on its limit by then genuinely never moved.

Raise it for a slow or heavy gate.

Pulses in a sequence are separated by `pulseGap` (default one second), because a board will
ignore a second edge arriving too soon after the first. Sequences are capped at three pulses, so
a gate that is not responding gets stopped rather than cycled back and forth forever.

## Gates moved by something else

Most gate operations are not HomeKit ones: they are the remote, the keypad, or the button in the
hall. The plugin never assumes it is the only thing driving the gate.

Direction is recovered from **which limit the gate just left**, which is always observable and
needs no command to have been issued:

- The closed limit releases → the gate is opening.
- The open limit releases → the gate is closing.

So a gate opened by its remote shows as `Opening` in the Home app within a poll, then `Open`
when it arrives, with the plugin having sent nothing.

Gates are polled once per second by default rather than the usual five, since position is a
reading people watch change. Set `pollInterval` explicitly to override that.

## Stopping mid-travel

HomeKit's garage door service has no stop: it can only ask for open or closed. The physical
button is the only thing that halts a gate mid-travel, so the plugin exposes it as a `step`
control on the OpenBridge device. That fires one raw pulse and lets the board do whatever comes
next in its cycle, exactly as the wall button does.

## Travel time

`travelTime` (default 30 seconds) is how long a full open or close may take before the gate is
assumed to have stopped. It exists because the limit switches genuinely cannot distinguish a
gate that is moving from one that was stopped halfway: both read "neither limit".

Set it a few seconds longer than your gate's slowest full travel. Too short and a slow gate
briefly reports `Stopped` before arriving; too long and a gate halted by a remote keeps showing
`Opening` until the timer runs out.

## When the device cannot be reached

A gate does not stop being a gate while its controller is offline, but what happened
during the gap is unknowable. So the first reading after an interruption is taken as the
truth rather than as the next frame of a sequence: a gate that went away closed and came
back open was opened by someone, and is reported as open, not as having been observed
opening.

This matters more than it sounds. Direction is normally inferred from a limit having just
been released, and "just" stops being true across an outage. A device that reboots and
comes back with its inputs still settling would otherwise be read as a gate that started
moving on its own, and a gate sitting closed would show as `Opening` in the Home app with
nobody having touched it.

A gate whose Shelly stops answering is reported to HomeKit by failing the reads,
which the Home app shows as **No Response**. It is deliberately not reported with a
`StatusFault` characteristic, the way this plugin's switch and meter accessories do.

`StatusFault` is not in the garage door service's required or optional set. hap-nodejs
will attach it anyway with a warning, and iOS then validates the bridged accessory
against the spec and drops it: the gate appears in the Home app once and is gone by the
next refresh. A missing fault channel is a much smaller problem than a missing accessory.

## Both limits high

Both limit inputs reading high at once is physically impossible: a gate cannot be fully open and
fully closed. It means the sensing is broken, usually a shared common come loose.

The plugin holds the last known position rather than guessing, reports `wiringFault: true` in
telemetry, and raises **ObstructionDetected** in HomeKit. HomeKit has no way to say "my sensors
are lying", and an obstruction warning is the closest honest signal: it stops the position being
trusted.

## Options

| Option            | Type    | Default | Description                                                            |
| ----------------- | ------- | ------- | ---------------------------------------------------------------------- |
| `name`            | string  | derived | Replaces the generated `"<device> - Gate"` name.                       |
| `switch`          | number  | `0`     | Relay index wired to the operator's step input.                        |
| `openInput`       | number  | `0`     | Input index reading high at the fully-open limit.                      |
| `closedInput`     | number  | `1`     | Input index reading high at the fully-closed limit. Must differ.       |
| `travelTime`      | number  | `30`    | Seconds before a gate that has not reached a limit is assumed stopped. |
| `pulseGap`        | number  | `1000`  | Milliseconds between pulses in a multi-pulse sequence.                 |
| `departureSettle` | number  | `4000`  | Milliseconds the gate may still press the limit it was told to leave.  |
| `invertInputs`    | boolean | `false` | Treat a **low** input as "at the limit", for inverted sensing.         |

The relay named in `switch` is not also exposed as a switch. A toggle that pulses the gate behind
the gate accessory's back would leave the two disagreeing about where it is. Other relays on the
same device are unaffected and still appear as switches.

## Sliding gates, swing gates, garage doors

All the same to this plugin. It models "an operator with a step input and two limit switches",
which is what most of them are.

HomeKit publishes it as a **garage door opener**, because that is the only HomeKit service that
describes an opener with limit switches rather than a position percentage. The Home app will call
it a garage door until you rename it; that is cosmetic and the behaviour is unchanged.
