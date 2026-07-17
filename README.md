# node-red-contrib-s7-plus

**npm:** [node-red-contrib-s7-plus](https://www.npmjs.com/package/node-red-contrib-s7-plus) · **Node-RED:** [flows.nodered.org](https://flows.nodered.org/node/node-red-contrib-s7-plus) · **GitHub:** [DataLogXE/node-red-contrib-s7-plus](https://github.com/DataLogXE/node-red-contrib-s7-plus)

Node-RED nodes for symbolic read, write, and subscribe access to Siemens S7-1200/1500 PLCs over the native **S7CommPlus** protocol without using PUT/GET.

## Why this package

Read, write, and subscribe to S7-1200/1500 tags in Node-RED by symbol name. Optimized data blocks need no layout changes. Addresses and datatypes are resolved from the live PLC. Requires TIA Portal ≥ V17 and secure communication (TLS) — see [Requirements](#requirements).

Built on **S7CommPlus**, the symbolic protocol that TIA Portal uses to talk to the CPU. Pure JavaScript. Runs on a standard PC (x64), Raspberry Pi, Siemens IoT2050, and any platform where Node.js runs out of the box.

- **Optimized and standard-access blocks** — no need to disable *Optimized block access* or alter DB layout for external read/write.
- **No PUT/GET** — external access uses the symbolic protocol stack of current TIA projects; only normal secure-communication settings apply.
- **Symbolic access** — browse the live PLC tree (*Pick from PLC*) or pass names from *S7+ Explore*. SymbolCRC mismatch after a PLC program change is detected and tags are re-resolved.
- **Native subscriptions** — S7CommPlus push notifications; value changes are pushed from the PLC.
- **Batched multi-tag I/O** — one request for many symbols; per-symbol status in `msg.payload` (a single invalid tag does not fail the entire batch). Reads/writes are chunked to the PLC's `tagsPerReadMax` / `tagsPerWriteMax` limits.
- **Shared endpoint** — one TCP/TLS session per PLC; reconnect, watchdog, subscription re-establishment after disconnect, and overload protection.
- **Any CPU architecture** — pure JavaScript end to end. No compiler or platform-specific binary to ship with your flow.



## Quick start

Install from the Node-RED palette manager (**Manage palette → Install →** `node-red-contrib-s7-plus`), or from the command line in your Node-RED user directory:

```bash
npm install node-red-contrib-s7-plus
```

Then build a minimal read flow:

```
[inject] → [S7+ Read] → [debug]
```

1. Add an **S7+ Read** node and create the **S7+ Endpoint** config in its settings (PLC IP address).
2. In the **S7+ Read** node, click **Pick from PLC** and select your tags from the tree.
3. Wire an **inject** in front and **deploy** — every incoming message triggers one read.

The result lands in `msg.payload` (object format):

```json
{
  "Motor.speed": { "value": 1450, "status": "ok", "error": "" },
  "Tank.level":  { "value": 73.2, "status": "ok", "error": "" }
}
```

Writing works the same way: pick the tags, then send the value(s) in `msg.payload` (a single value for one tag, or an object keyed by tag name for several).

## Nodes


| Node             | Description                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| **S7+ Endpoint** | Shared connection (IP, port 102, timeout, reconnect/watchdog).                                                    |
| **S7+ Read**     | Read symbol(s) on input; results in `msg.payload`. Override with `msg.symbols`, add extras with `msg.addSymbols`. |
| **S7+ Write**    | Write values via `msg.payload`; override symbols with `msg.symbols`. Result replaces `msg.payload`.               |
| **S7+ Subs**     | Native subscription: the PLC pushes value changes (no polling). Emits changed symbols in `msg.payload` per cycle. |
| **S7+ Explore**  | Full symbol catalog: flat names in `msg.payload`, optional `msg.infos`, browse summary in `msg.meta`.             |
| **S7+ Info**     | Session and PLC diagnostics in `msg.payload` (firmware, PAOM, limits, protection level, connection status).       |




## Data type mapping

**S7 datatype → JavaScript type**


| S7 Datatype                              | JavaScript Type | Note                                                                 |
| ---------------------------------------- | --------------- | -------------------------------------------------------------------- |
| Bool                                     | `boolean`       |                                                                      |
| Byte, Word, DWord                        | `number`        |                                                                      |
| LWord                                    | `BigInt`        | 64-bit, exceeds JS number                                            |
| Char, WChar                              | `string`        | single character                                                     |
| String, WString                          | `string`        |                                                                      |
| SInt, Int, DInt, USInt, UInt, UDInt      | `number`        |                                                                      |
| LInt, ULInt                              | `BigInt`        |                                                                      |
| Real, LReal                              | `number`        |                                                                      |
| Time, S5Time                             | `number`        | milliseconds                                                         |
| LTime                                    | `BigInt`        | nanoseconds                                                          |
| TOD (Time_Of_Day)                        | `number`        | milliseconds since midnight                                          |
| LTOD                                     | `BigInt`        | nanoseconds since midnight                                           |
| Date                                     | `Date`          |                                                                      |
| LDT, DTL                                 | `Date`          | ms resolution; sub-ms nanoseconds are not represented in a JS `Date` |
| Hardware datatypes (HW_IO, HW_DEVICE, …) | `number`        |                                                                      |




## Requirements

- Node.js >= 20
- Node-RED >= 3.0
- S7-1200/1500 with secure communication (TLS) enabled; symbolic access for optimized and non-optimized blocks
- Project engineered with TIA Portal ≥ V17



## Examples

Example flows live in `[examples/](examples/)`. They target the test data blocks in `[plc/s7-1500/](plc/s7-1500/)` (S7-1500, optimized access).

**PLC setup:** import the `DB_*.db` sources and `FB_TestSignalGenerator.scl` from `plc/s7-1500/` into your TIA Portal project. Call `FB_TestSignalGenerator` in the main cycle OB (e.g. OB1) so `DB_TestSignals` is filled with animated test values, then compile and download to the PLC.

**Node-RED setup:** **Import** one or more JSON files from `examples/`, **Deploy**, then open the shared **S7+ Endpoint** config node (`PLC`) and set the PLC IP address. All example flows reuse the same endpoint id (`example_plc_ep`), so importing multiple flows creates only one config node.


| File                                                                                | Purpose                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[explore-symbols-flow.json](examples/explore-symbols-flow.json)`                   | Symbol catalog browse — full PLC tree, scoped DB/area browse (static + `msg.exploreScope`), `msg.infos` formats, output limit demo, and Explore → Read pipeline for `DB_TestSignals`.                             |
| `[read-multiple-values-flow.json](examples/read-multiple-values-flow.json)`         | Read multiple values in one request — static symbol list in the read node, plus a second path with the same symbols via runtime `msg.symbols`.                                                                    |
| `[read-write-single-values-flow.json](examples/read-write-single-values-flow.json)` | Manual write tests — one inject per scalar constant writes to the matching `*_write` tag; each datatype group includes a read-back row. Covers Binary through Timers; hardware and system datatypes are excluded. |
| `[verify-read-write-values-flow.json](examples/verify-read-write-values-flow.json)` | Automated verification — one inject runs write → read-back → compare for every scalar constant across all datatypes. Emits one result per datatype and a final summary.                                           |
| `[subscribe-values-flow.json](examples/subscribe-values-flow.json)`                 | Native subscription — static `DB_TestSignals` symbols on deploy (object format) with per-symbol extraction; dynamic `msg.symbols` via inject (array format).                                                      |




## Status

- Open-source software (LGPL-3.0-or-later), provided as-is without warranty
- Development stage — not approved for production use
- You are responsible for how and where you use it
- Not affiliated with or supported by Siemens



## License

Copyright (C) 2026 Robert Mederer - [DataLogXE](https://github.com/DataLogXE). Licensed under LGPL-3.0-or-later. See [LICENSE](LICENSE).

This project builds on the following work:

- **S7CommPlus protocol portions** — derived from [S7CommPlusDriver](https://github.com/thomas-v2/S7CommPlusDriver) (Thomas Wiens, LGPL-3.0-or-later).
- **ISO-on-TCP/COTP transport patterns** — informed by [Snap7](https://github.com/davenardella/snap7) (Davide Nardella, LGPL-3.0) and the C# reference driver above.
- **S7CommPlus SymbolCRC (CRC32 polynomial and algorithm)** — informed by [HarpoS7](https://github.com/bonk-dev/HarpoS7) (bonk, MIT); see [LICENSE](LICENSE) for the full MIT notice.

