# Telemetry

Each registered device reports the following keys on every poll.

| Key                   | Unit    | Meaning                                                                              |
| --------------------- | ------- | ------------------------------------------------------------------------------------ |
| `power`               | W       | Instantaneous active power                                                           |
| `voltage`             | V       | RMS voltage                                                                          |
| `current`             | A       | RMS current                                                                          |
| `powerFactor`         | -1..1   | Power factor. Always `0` on the combined total, which has no single meaningful value |
| `totalForwardEnergy`  | kWh     | Cumulative energy consumed since the meter was last reset                            |
| `totalReturnedEnergy` | kWh     | Cumulative energy exported to the grid                                               |
| `valid`               | boolean | `false` when the meter could not read the channel                                    |

## Relay channels

A `switch:N` channel reports the same fields as a meter, plus its relay state:

| Field                | Unit | Notes                                                     |
| -------------------- | ---- | --------------------------------------------------------- |
| `active`             | bool | Relay state. This is what the OpenBridge toggle controls. |
| `power`              | W    | Zero on non-metering relays.                              |
| `voltage`            | V    | Zero on non-metering relays.                              |
| `current`            | A    | Zero on non-metering relays.                              |
| `totalForwardEnergy` | kWh  | Cumulative, counted by the device itself.                 |

Non-metering relays report zeros rather than omitting the fields, so a channel's telemetry keys
stay stable and history charts do not develop gaps if you swap hardware.

## Units

Gen1 devices report cumulative energy in **watt-hours**. OpenBridge energy history is kept in
**kilowatt-hours**, so the plugin divides by 1000 before reporting. A raw device value of
`224585.1` becomes `224.5851` kWh.

Getting this wrong is silent and expensive: the history chart would read 1000x high and the
error would only be obvious months later.

## How the total is computed

The combined device is not simply a fourth channel:

- **Power** uses the device's own `total_power` when present, falling back to summing channels.
- **Current** and **energy** are summed across channels.
- **Voltage** is the _mean_ of the valid channels. Summing three 240 V phases into 720 V would
  be meaningless.
- **Power factor** is reported as `0`, since a single figure across phases with different loads
  would be misleading.

## Energy history

OpenBridge samples `totalForwardEnergy` periodically into `~/.openbridge/energy-history/<deviceId>.json`
and serves day, month and year buckets from it. Because each phase is its own device, each gets
its own history file and its own chart.
