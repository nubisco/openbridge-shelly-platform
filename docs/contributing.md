# Contributing

Contributions are welcome. See [CONTRIBUTING.md](https://github.com/nubisco/openbridge-shelly-platform/blob/master/CONTRIBUTING.md)
for the full guide.

## Local setup

```bash
git clone https://github.com/nubisco/openbridge-shelly-platform.git
cd openbridge-shelly-platform
npm install
npm run quality:check
```

## Adding support for a device

1. Capture what the device actually returns. `curl http://<ip>/shelly` and the relevant status
   endpoint, and paste the real payload into the tests. The existing tests use verbatim captures
   from real hardware, which is what makes them worth having.
2. Add a client under `src/protocol/` if it speaks a new API generation.
3. Map its readings to the normalised `PhaseReading` shape so the telemetry contract stays stable.
4. Add tests covering the unit conversions. Energy units in particular differ between
   generations and are easy to get wrong in a way no one notices for months.

## Quality gate

```bash
npm run quality:check
```

Git hooks enforce the same gate. Commits do not proceed unless tests, linting, formatting and
type checks all pass.
