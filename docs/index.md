---
layout: nubisco
title: 'OpenBridge Shelly'
intro: 'Per-phase power, voltage, current and energy from your Shelly meters, read locally over your own network.'
---

## Where to start

- [Get Started](./installation)
- [Introduction](./introduction)
- [GitHub](https://github.com/nubisco/openbridge-shelly-platform)

## OpenBridge Native

Reports real measurements with real units straight to OpenBridge, instead of smuggling watts through a HomeKit light sensor.

## 100% Local LAN

Talks directly to the device on your network. No cloud account, no Shelly servers, no internet dependency.

## Per-Phase Telemetry

Every phase becomes its own device, with power, voltage, current, power factor and cumulative energy.

## Energy History

Readings are recorded to OpenBridge history, giving charts per phase from ten-second detail out to five years.

## Generation Aware

Probes the device before polling and says exactly what it found, instead of retrying the wrong API forever.

## HomeKit Optional

Expose a meter to the Home app or hide it. OpenBridge telemetry and history are unaffected either way.

## Honest Units

Cumulative energy is converted from watt-hours to kilowatt-hours at a single boundary, covered by tests.

## Shelly 3EM and EM

Gen1 energy meters supported today, verified against firmware v1.14.0. Gen2+ devices are detected and reported clearly.
