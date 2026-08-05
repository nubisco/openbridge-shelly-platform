# Contributing

Thanks for contributing to `@nubisco/openbridge-shelly-platform`.

For full contributor documentation, see `docs/contributing.md`.

## Local Setup

```bash
git clone https://github.com/nubisco/openbridge-shelly-platform.git
cd openbridge-shelly-platform
npm install
```

## Development Commands

```bash
npm run lint
npm run format:check
npm test
npm run build
npm run docs:build
```

Notes:

- Minimum supported Node.js version is `20`
- The plugin loads as a native OpenBridge plugin under `plugins[]`

## Adding Device Support

Shelly's API differs by generation, so device work starts with capturing what the hardware
actually returns rather than working from documentation:

1. Capture real payloads: `curl http://<ip>/shelly` plus the relevant status endpoint
2. Paste them verbatim into the tests — the existing tests use real captures, which is what
   makes them meaningful
3. Add a client under `src/protocol/` if the device speaks a new API generation
4. Map readings onto the normalised `PhaseReading` shape so the telemetry contract stays stable
5. Cover the unit conversions with tests. Energy units differ between generations and an error
   there is silent for months

## Branch and PR Expectations

- Create focused branches (one concern per PR)
- Keep pull requests small and reviewable
- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`)
- Run lint, test, and build before opening a PR

## Coding Style

- TypeScript project with strict linting and formatting
- 2-space indentation, LF line endings
- Keep runtime behavior changes intentional and documented

## Issue Routing

- Use **Bug report** for regressions and reproducible defects
- Use **Feature request** for new devices or capabilities
- Include redacted logs and config snippets in all technical reports

## Keep Changes Focused

- Avoid unrelated refactors in the same PR
- Update docs when behavior, configuration, or supported devices change
- Add or update tests for non-trivial logic changes

## Quality gate

Before committing or pushing, run:

```sh
npm run quality:check
```

The local Git hooks enforce the same gate automatically. Commits must not proceed unless tests,
linting, formatting, and type checks all pass.
