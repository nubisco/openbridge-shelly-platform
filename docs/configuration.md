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

## Choosing a poll interval

The default of 5 seconds suits most installations. Consider the trade-off:

- **Energy totals** (`kWh`) accumulate on the device itself, so they are accurate regardless of
  how often you poll. A slow interval loses nothing.
- **Power** (`W`) is instantaneous. A 60-second interval will miss a heat pump that cycles on
  and off between reads.

Gen1 meters refresh their own measurements roughly once per second, so intervals below 1 second
gain nothing but network traffic.

## HomeKit exposure

`exposeToHomeKit` defaults to `true` for continuity with the Homebridge plugins people migrate
from. Because HomeKit has no power characteristic, each channel appears as a light sensor whose
lux value carries watts.

If you only care about the OpenBridge dashboard, set it to `false`. The telemetry and history
are unaffected: they do not travel through HomeKit at all.
