# AGENTS.md — AI Coding Agent Guide

This file helps AI coding agents understand the structure, conventions, and workflows of this project.

## Project Overview

**openbridge-shelly-platform** is an OpenBridge plugin that reads Shelly devices over the local
network. It currently supports the Gen1 energy meters (Shelly 3EM, Shelly EM) and reports
per-phase electrical telemetry to OpenBridge.

- **Plugin name**: `@nubisco/openbridge-shelly-platform`
- **Platform alias**: `ShellyPlatform`
- **License**: MIT

The plugin loads as a **native** OpenBridge plugin (`plugins[]`). Native mode is what allows
`registerDevice()` and `reportTelemetry()`, which is the entire reason this plugin exists: a
Homebridge-compat plugin can only publish HAP accessories, and HomeKit has no characteristic for
electrical power.

## Tech Stack

- **Language**: TypeScript (strict mode, `strictNullChecks` and `strictFunctionTypes` off)
- **Module system**: CommonJS (output to `dist/`)
- **Target**: ES2022
- **Runtime**: Node.js >= 20
- **Config validation**: Zod (validates device config at plugin startup)
- **Tests**: Vitest, in `tests/`

## Directory Structure

```text
src/
  index.ts                          → Plugin entry, ShellyEnergyDevice runner, native plugin export
  types.ts                          → Shared type definitions
  protocol/
    ShellyGen1Client.ts             → Gen1 REST client, generation detection, reading normalisation
  accessories/
    EnergyAccessory.ts              → Optional HomeKit exposure (light sensor carrying watts)
tests/
  readings.test.ts                  → Unit conversion and generation detection, using real captures
  client.test.ts                    → HTTP client behaviour against a local stand-in server
  device.test.ts                    → Device runner: registration, telemetry, error suppression
docs/                               → VitePress documentation site
config.schema.json                  → OpenBridge config UI schema
```

## Architecture

### Generation detection comes first

Every Shelly answers `/shelly`, regardless of generation. Gen1 returns `type` (e.g. `SHEM-3`);
Gen2+ returns `gen` and `model`. `assertGen1()` uses this to refuse unsupported hardware **before**
any poll loop starts.

This is load-bearing. The plugin this replaces assumed Gen3, polled `/rpc/` against a Gen1 meter,
and logged `404 Not Found` four times every ten seconds indefinitely without ever explaining why.
Do not weaken this check into a silent fallback.

### Normalised readings

Both `toPhaseReading()` and `toTotalReading()` return the same `PhaseReading` shape. Any future
Gen2 client must map onto that same shape so the telemetry contract stays stable across
generations.

Key invariants, all covered by tests:

- Cumulative energy is converted **Wh → kWh**. Gen1 reports watt-hours; OpenBridge history is
  kilowatt-hours.
- Total voltage is the **mean** of valid channels, never a sum.
- Total power prefers the device's own `total_power` and only falls back to summing.
- Non-finite values coerce to `0` rather than reaching telemetry as `NaN`.

### Device IDs

`shelly-<mac>-total` and `shelly-<mac>-p<n>`, derived from the MAC rather than the IP so that a
DHCP lease change does not orphan a device's accumulated energy history.

### Error suppression

`ShellyEnergyDevice` logs an identical consecutive error once, counts the repeats, and reports
the count on recovery. Preserve this when adding device types.

## Build & Run

```bash
npm install
npm run build          # Clean + compile to dist/
npm run dev            # Watch mode
npm test
npm run quality:check  # test + lint + format:check + types:check
```

## Verifying against real hardware

Unit tests use captured payloads, but device work should also be checked against a real meter.
Build, then drive `ShellyEnergyDevice` directly with a stub context that records
`registerDevice`/`reportTelemetry` calls, and confirm the numbers match what
`curl http://<ip>/status` returns at the same moment.

## Release Process

Semantic Release on push to `master`, from Conventional Commits. CI runs lint, build and test on
Node 20 and 22 before the release job publishes to npm and GitHub.

## Conventions

- Conventional Commits
- No em dashes in source, comments, docs or commit messages
- Comments explain _why_, not _what_
- Real captured payloads in tests, not invented ones
