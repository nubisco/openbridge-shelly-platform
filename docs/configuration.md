# Configuration

Add the plugin under `plugins[]` in your OpenBridge config:

```json
{
  "name": "@nubisco/openbridge-shelly-platform",
  "config": {
    "devices": [{ "ip": "192.168.1.122", "name": "Home" }]
  }
}
```

That is the whole minimum configuration. Everything else has a sensible default.

## Device options

| Option            | Type     | Default         | Description                                                        |
| ----------------- | -------- | --------------- | ------------------------------------------------------------------ |
| `ip`              | string   | required        | IP address or hostname on your LAN. May include a port.            |
| `name`            | string   | model name      | Prefix for the devices this meter creates.                         |
| `pollInterval`    | number   | `5`             | Seconds between reads. Lower gives finer power resolution.         |
| `timeout`         | number   | `4000`          | Request timeout in milliseconds.                                   |
| `showTotal`       | boolean  | `true`          | Register one device summing every phase.                           |
| `showPhases`      | boolean  | `true`          | Register one device per phase.                                     |
| `phaseNames`      | string[] | `Phase A, B, C` | Labels for each phase.                                             |
| `exposeToHomeKit` | boolean  | `true`          | Publish HomeKit accessories as well.                               |
| `alertThreshold`  | number   | `0`             | Watts above which a HomeKit contact sensor trips. `0` disables it. |
| `username`        | string   | none            | Only if the device has HTTP auth enabled.                          |
| `password`        | string   | none            | Only if the device has HTTP auth enabled.                          |
| `exclude`         | boolean  | `false`         | Skip this device entirely.                                         |
| `switch:N`        | object   | none            | Per-channel overrides on a Gen2+ relay. See below.                 |
| `gate`            | object   | none            | Present this device as a gate. See [Gates](/gates).                |

## Relay channels (Gen2+)

A Gen2+ relay exposes one `switch:N` component per channel. Each becomes a controllable
OpenBridge device, and on metering models (the PM variants) it also reports its own power.

Channels are named `"<device name> - Switch N"` by default. Override per channel:

```json
{
  "ip": "192.168.1.178",
  "name": "Pool",
  "switch:0": { "name": "Pool Light" },
  "switch:1": { "exclude": true }
}
```

| Option    | Type    | Default | Description                                          |
| --------- | ------- | ------- | ---------------------------------------------------- |
| `name`    | string  | derived | Replaces the generated `"<device> - Switch N"` name. |
| `exclude` | boolean | `false` | Do not register this channel as a device at all.     |

There is deliberately no `type` option. Relays are always published to HomeKit as switches, and
whether one should appear as a light or an outlet is set in the OpenBridge device inspector,
which re-applies the choice on every restart. Keeping that in one place is what stops the Home
app reverting the accessory to a switch.

## Gates

A Gen2+ device with a relay on a gate operator's step input and its limit switches on two inputs
can be exposed as a gate instead of as bare relays:

```json
{
  "ip": "192.168.1.201",
  "name": "Driveway",
  "gate": { "switch": 0, "openInput": 0, "closedInput": 1, "travelTime": 25 }
}
```

The wiring, the pulse behaviour and why reaching a target sometimes takes more than one pulse are
all covered in [Gates](/gates).

## Choosing a poll interval

The default of 5 seconds suits most installations. Consider the trade-off:

- **Energy totals** (`kWh`) accumulate on the device itself, so they are accurate regardless of
  how often you poll. A slow interval loses nothing.
- **Power** (`W`) is instantaneous. A 60-second interval will miss a heat pump that cycles on
  and off between reads.

Gen1 meters refresh their own measurements roughly once per second, so intervals below 1 second
gain nothing but network traffic. The same holds for Gen2+ devices.

Polling also drives how quickly a relay toggled physically at the wall is reflected in
OpenBridge and HomeKit. Changes made _through_ OpenBridge are applied immediately and do not
wait for the next poll.

## HomeKit exposure

`exposeToHomeKit` defaults to `true` for continuity with the Homebridge plugins people migrate
from. Meter channels appear as a light sensor whose lux value carries watts, because HomeKit has
no power characteristic. Relay channels appear as ordinary switches.

If you only care about the OpenBridge dashboard, set it to `false`. The telemetry and history
are unaffected: they do not travel through HomeKit at all.
