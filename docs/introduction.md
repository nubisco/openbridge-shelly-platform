# Introduction

`@nubisco/openbridge-shelly-platform` connects [Shelly](https://www.shelly.com/) devices to
[OpenBridge](https://github.com/nubisco/openbridge) over your local network.

Today it supports the **Gen1 energy meters**: the Shelly 3EM and the Shelly EM. Support for
Gen2+ devices (Pro 3EM, Pro 2PM, and other relays) is planned; see [Supported Devices](/supported-devices).

## Why a native plugin

OpenBridge can load Homebridge plugins through its compatibility layer, and several Shelly
plugins exist for Homebridge. They all share one limitation: a Homebridge plugin can only
express itself as HomeKit accessories.

HomeKit has no characteristic for electrical power. The usual workaround is to publish a light
sensor and put watts in the lux field. That gets you a number in the Home app, but it throws
away everything else the meter measures, and it never reaches the OpenBridge devices view.

A native plugin calls `registerDevice()` and `reportTelemetry()` directly, so OpenBridge sees
real values with real units:

| Metric                | Unit  | Source field (Gen1)                             |
| --------------------- | ----- | ----------------------------------------------- |
| `power`               | W     | `emeters[n].power`                              |
| `voltage`             | V     | `emeters[n].voltage`                            |
| `current`             | A     | `emeters[n].current`                            |
| `powerFactor`         | -1..1 | `emeters[n].pf`                                 |
| `totalForwardEnergy`  | kWh   | `emeters[n].total` (converted from Wh)          |
| `totalReturnedEnergy` | kWh   | `emeters[n].total_returned` (converted from Wh) |

## What it creates

A three-phase meter configured with the name `Home` registers four OpenBridge devices:

```text
shelly-<mac>-total    Home - Total     energy_meter
shelly-<mac>-p0       Home - Phase A   energy_meter
shelly-<mac>-p1       Home - Phase B   energy_meter
shelly-<mac>-p2       Home - Phase C   energy_meter
```

Device IDs are derived from the meter's MAC address, so they survive a DHCP lease change.
Each is an independent device with its own telemetry stream and its own energy history.
