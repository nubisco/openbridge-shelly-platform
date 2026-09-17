# OpenBridge Shelly Platform

[![CI](https://github.com/nubisco/openbridge-shelly-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/nubisco/openbridge-shelly-platform/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@nubisco/openbridge-shelly-platform.svg)](https://www.npmjs.com/package/@nubisco/openbridge-shelly-platform)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

Shelly devices in [OpenBridge](https://github.com/nubisco/openbridge), read locally over your own
network. Per-phase power, voltage, current and cumulative energy, with history charting.

> **Supported today:** Shelly 3EM and Shelly EM (Gen1), plus Gen2+ devices built from `switch`
> or `em` components: Plus/Pro relays and Pro 3EM meters. Relay channels are controllable from
> OpenBridge and HomeKit, and a relay wired to a gate operator can be exposed as a
> [gate](https://docs.nubisco.io/openbridge-shelly-platform/gates). Roller-cover mode is detected
> and declined. See
> [Supported Devices](https://docs.nubisco.io/openbridge-shelly-platform/supported-devices).

## Why

OpenBridge can load Homebridge plugins, and several Shelly plugins exist for Homebridge. They
share one structural limit: a Homebridge plugin can only express itself as HomeKit accessories,
and **HomeKit has no characteristic for electrical power**. The standard workaround is a light
sensor with watts hidden in the lux field. You get one number in the Home app and lose
everything else the meter measures.

A native OpenBridge plugin calls `registerDevice()` and `reportTelemetry()` directly, so the
real measurements reach the OpenBridge devices view with their real units.

## Install

```bash
npm install -g @nubisco/openbridge-shelly-platform
```

Or install **Shelly Platform** from the OpenBridge marketplace.

## Configure

```json
{
  "name": "@nubisco/openbridge-shelly-platform",
  "config": {
    "devices": [{ "ip": "192.168.1.122", "name": "Home" }]
  }
}
```

That is the whole minimum configuration. Full options in the
[configuration guide](https://docs.nubisco.io/openbridge-shelly-platform/configuration).

## What you get

A three-phase meter named `Home` registers four OpenBridge devices:

```text
shelly-<mac>-total    Home - Total     energy_meter
shelly-<mac>-p0       Home - Phase A   energy_meter
shelly-<mac>-p1       Home - Phase B   energy_meter
shelly-<mac>-p2       Home - Phase C   energy_meter
```

Each reports:

| Metric                | Unit  |
| --------------------- | ----- |
| `power`               | W     |
| `voltage`             | V     |
| `current`             | A     |
| `powerFactor`         | -1..1 |
| `totalForwardEnergy`  | kWh   |
| `totalReturnedEnergy` | kWh   |

Device IDs derive from the meter's MAC, so they survive a DHCP lease change. Each phase is an
independent device with its own telemetry stream and its own energy history file.

## Gates

A Gen2+ device with a relay on a gate operator's step input and the operator's limit switches on
two inputs becomes one gate device, in OpenBridge and in HomeKit:

```json
{
  "ip": "192.168.1.201",
  "name": "Driveway",
  "gate": { "switch": 0, "openInput": 0, "closedInput": 1, "travelTime": 25 }
}
```

These operators have no "open" and no "close": one input steps the board through a fixed cycle
(open, stop, close, stop, ...), so the plugin tracks where in that cycle the board is and sends
however many pulses a target needs. It also follows a gate driven by its own remote, inferring
direction from which limit switch just released. See
[Gates](https://docs.nubisco.io/openbridge-shelly-platform/gates).

## Design notes

**It probes before it polls.** Every Shelly answers `/shelly` regardless of generation. The
plugin reads it, confirms the generation, and refuses a device it cannot speak to with a message
naming what it found. Pointing a Gen1 client at a Gen2 device (or the reverse) otherwise yields
`404 Not Found` on every call, forever, with nothing in the log explaining why.

**It logs a repeating failure once.** Identical consecutive errors are counted, not repeated,
and recovery reports how many were suppressed. An unplugged meter should not produce an error
line every few seconds indefinitely.

**The device times its own gate pulse.** A step is one `Switch.Set on=true`, relying on the
Shelly's auto-off rather than the plugin sending `on=false` afterwards. If the plugin owned both
halves, a crash between them would leave the relay latched across the operator's step input, and
a gate that no longer answers its remote is a worse failure than a missed command.

**Units are converted at the boundary.** Gen1 reports cumulative energy in watt-hours;
OpenBridge history is kilowatt-hours. The conversion happens in one place and is covered by
tests, because getting it wrong is silent and only becomes obvious months of data later.

## Development

```bash
npm install
npm run build
npm test
npm run quality:check
```

Tests use payloads captured verbatim from real hardware (a Shelly 3EM on firmware `v1.14.0` and
a Shelly Pro 2PM on `2.0.0`), so unit conversions and generation detection are checked against
what the devices actually send. The gate state machine lives in `src/GateController.ts`, away
from HTTP and hap-nodejs, so every step of the board's cycle can be tested directly.

## Documentation

<https://docs.nubisco.io/openbridge-shelly-platform/>

## License

MIT © [Nubisco](https://nubisco.io)
