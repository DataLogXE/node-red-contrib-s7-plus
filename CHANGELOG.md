# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-07

### Added

- `s7-plus subscribe` node: native PLC data-change subscriptions — the PLC pushes value changes (no polling). Configurable cycle time (minimum 100 ms), optional periodic resend of unchanged values, object/array output format, and runtime symbol overrides via `msg.symbols` / `msg.addSymbols`.
- `s7-plus info` node: session and PLC diagnostics in `msg.payload` (device family, firmware, PAOM, system limits, protection level, connection state), with optional automatic messages on connection state changes.
- Subscription lifecycle handling in the endpoint: automatic re-establishment after reconnect, watchdog-driven retry and healing of failed or partially resolved subscriptions, buffering of notifications that arrive before the subscription is registered, and guards for PLC subscription count/width limits.
- Example flows: `explore-symbols-flow.json` (symbol catalog browse, scoped browse, Explore → Read pipeline) and `subscribe-values-flow.json` (static and dynamic subscriptions).
- PLC test signal generator `FB_TestSignalGenerator.scl` with `DB_TestSignals.db`: animated test values for the example flows.
- Unit tests for subscription encoding/decoding, notification buffering, serial queue, session info and info-node state changes.

### Changed

- Example flows renamed and retargeted to `DB_TestSignals`: `write-single-values-flow.json` → `read-write-single-values-flow.json`, `read-write-test-flow.json` → `verify-read-write-values-flow.json`.
- README reworked: nodes table including subscribe/info, updated quick start, examples section and PLC setup instructions.
- npm keywords extended (`s7-1200`, `s7-1500`, `symbolic-access`, `optimized-blocks`, `tia-portal`, `iiot`).

## [0.1.1] - 2026-06-24

### Changed

- README: add DataLogXE maintainer note and copyright attribution.

## [0.1.0] - 2026-06-22

### Added

- Initial release.
- `s7-plus endpoint` config node: shared S7CommPlus connection (ISO-on-TCP, port 102) with timeout, lazy symbol resolution and reconnect/watchdog handling.
- `s7-plus read` node: read one or more symbols per message; results in `msg.payload`, with runtime overrides via `msg.symbols` and merging via `msg.addSymbols`.
- `s7-plus write` node: write values from `msg.payload`, with runtime symbol override via `msg.symbols` and datatypes resolved automatically from the PLC.
- `s7-plus explore` node: full symbol catalog browse (flat symbol names in `msg.payload`, optional `msg.infos`, browse summary in `msg.meta`).
- Symbolic addressing with "Pick from PLC" browser (DBs, structs, arrays) and optional expert access string (hex) support.
- Data type mapping for Siemens S7 datatypes to JavaScript types (Bool, Byte/Word/DWord, LWord, Char/WChar, String/WString, integer and floating-point types, Time/S5Time/LTime, date and time-of-day types, hardware datatypes).
- Example flows in `examples/`: read multiple values, write single values and automated read/write verification.
- PLC test data block sources in `plc/s7-1500/` and generator scripts in `scripts/`.

[Unreleased]: https://github.com/DataLogXE/node-red-contrib-s7-plus/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/DataLogXE/node-red-contrib-s7-plus/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/DataLogXE/node-red-contrib-s7-plus/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DataLogXE/node-red-contrib-s7-plus/releases/tag/v0.1.0
