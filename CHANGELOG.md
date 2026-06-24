# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/DataLogXE/node-red-contrib-s7-plus/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/DataLogXE/node-red-contrib-s7-plus/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DataLogXE/node-red-contrib-s7-plus/releases/tag/v0.1.0
