# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-11-23

### Fixed

- Subscriptions are now really deleted on the PLC: the `DeleteObject` request was missing the `0x00` byte and object qualifier after the object id, so the PLC rejected it, kept sending notifications and kept the subscription slot until disconnect. Every resubscribe/unsubscribe at runtime leaked one PLC subscription (limit 250).
- `deleteSubscription` evaluates the PLC return value and throws on failure instead of silently reporting success.
- Writing to a `String[n]` / `WString[n]` with a declared length other than 254 no longer fails with `PLC: Write error (0x80098d00…ffc3)` ([#2](https://github.com/DataLogXE/node-red-contrib-s7-plus/issues/2)). The write now carries the declared length of the target, which is read from the PLC once per address and cached.
- Large requests no longer reset the PLC connection: fragments of a request above one COTP TPDU (e.g. writing a `WString[1000]`) could be merged into a single TLS record larger than 1024 bytes, which the PLC answers with a TCP reset. Each fragment is now sent as its own TLS record.
- *Pick from PLC* / scope dialog no longer fails with `Browse failed` when the Node-RED editor runs under a sub-path (`httpAdminRoot`, reverse proxy) ([#1](https://github.com/DataLogXE/node-red-contrib-s7-plus/issues/1)). The browse requests now use a URL relative to the editor page.
- Live test scripts: `live-browse.js` loads the current `pvalue-codec` module; `live-datatype-rw.js` expects `BigInt` for LWord and compares Date by local calendar day (matches README type contract).

### Changed

- A text that does not fit the target string is no longer silently altered. A text longer than the declared length, or a `String` text with characters outside ISO-8859-1 (e.g. `€`, `Σ`), is rejected with a per-tag error and not written; other tags of the same message are still written. Previously the text was truncated at 254 characters or the characters were corrupted.
- Browse errors in the editor are more specific: instead of a bare `Browse failed` the dialog shows the HTTP status and a hint (e.g. route not found → restart Node-RED after installing or updating; no permission; no response from Node-RED). Failed browse requests are also logged as a warning in the Node-RED log with the PLC address.
- Editor browse sessions (for endpoints that are not deployed yet) hold fewer PLC connections: one connection per PLC address is shared by all open dialogs, the connection is released when the dialog closes, and an unused session is closed after 2 minutes (previously 15 minutes, and only checked when the next session was opened).

### Added

- Unit tests for `DeleteObject` request layout and response decoding.
- Unit tests for `String[n]` / `WString[n]` encoding and the write path (`test/string-write.test.js`), live tests `test/scripts/live-string-write.js` and `test/scripts/live-string-nodered.js`.
- Unit tests for TLS send ordering (`test/transport-tls-send.test.js`).
- Unit tests for editor browse sessions (`test/browse-sessions.test.js`).
- Admin endpoint `POST s7complus/browse/close` to release an editor browse session.
- PLC test blocks `plc/s7-1500/DB_StringTest.db` (optimized) and `DB_StringTestStd.db` (standard access) with all String / WString lengths, arrays and a struct.

## [0.3.0] - 2026-07-17

### Added

- Scoped CRC cache seeding after explore/browse: unresolved symbols trigger a targeted `browseFull` per DB or memory area; all flat-browser results are written into the endpoint CRC cache for subsequent read/write/subscribe.
- Streaming S7CommPlus frame reassembler for TLS transport: handles coalesced and split wire frames, stream resync, and oversized-PDU protection.
- Cooperative event-loop yielding during large flat browse and symbolic batch resolve (prevents Node-RED UI/timer starvation on big symbol catalogs).
- Bounded output message queue on the subscribe node: batched `node.send` via `setImmediate`, with overflow drop of oldest messages.
- Unit tests for frame assembly, cooperative scheduling, decode guards, explore/CRC cache seeding, tag routing, subscribe output batching, and extended write-path chunking.

### Changed

- **Breaking:** Read and Write nodes reject hex-only access strings without `symbolCrc`. Use symbolic paths (Pick from PLC / Explore names) or pass `symbolCrc` from explore results.
- Subscribe node rejects hex strings in `msg.addSymbols` (hex in `msg.symbols` continues to be ignored).
- S7CommPlus client: sequence-number-based response dispatch; bounded user-operation queue (max 16 in flight); large reads split into lock batches of up to 500 tags with event-loop yield between batches.
- Node help text updated for hex access string / `symbolCrc` rules on Read, Write, and Subscribe.

### Fixed

- Large multi-tag writes are chunked per PLC `tagsPerWriteMax` in lock batches of up to 50 tags (one PDU per batch, with pacing between batches); fixes TCP RST when writing many symbols in one Node-RED message on some S7-1500 CPUs.
- TLS/stream receive no longer mis-assembles coalesced or split frames under load (fast subscription cycles, large explores), which previously produced corrupt PDUs and froze the Node-RED event loop.
- PValue decode guards reject truncated or corrupt length fields immediately instead of looping synchronously for millions of iterations.
- SetMultiVariables write errors are taken from per-item `errorValues` only; the global response `returnValue` is no longer treated as a write failure.
- Large multi-tag reads release the user lock between batches and yield to the event loop between PDU chunks, reducing sustained PDU bursts that some PLCs answer with TCP RST.
- Subscribe notifications are sent via a deferred output queue instead of synchronous `node.send` on every PLC push.

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

[Unreleased]: https://github.com/DataLogXE/node-red-contrib-s7-plus/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/DataLogXE/node-red-contrib-s7-plus/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/DataLogXE/node-red-contrib-s7-plus/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/DataLogXE/node-red-contrib-s7-plus/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/DataLogXE/node-red-contrib-s7-plus/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/DataLogXE/node-red-contrib-s7-plus/releases/tag/v0.1.0
