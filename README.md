# node-red-contrib-s7-plus

Node-RED nodes for symbolic read/write access to Siemens S7-1200/1500 PLCs over the native **S7CommPlus** protocol.

Maintained by [DataLogXE](https://github.com/DataLogXE).

## Why this package

Most S7 drivers make you translate every tag into a byte/offset address (`DB1.DBX0.0`) and pick the right data type by hand. This package talks the PLC's **own symbolic protocol** instead — you browse the live symbol tree and click the tag you want. The driver resolves the address and data type for you, at runtime.

- **Full symbolic access** — browse the live PLC tree (DBs, structs, arrays) and add tags with one click via **Pick from PLC**. No address math.
- **Optimized *and* non-optimized blocks** — works with modern optimized data blocks out of the box, not just legacy layouts.
- **Automatic data types** — types are resolved symbolically at runtime; you never set them manually. If the PLC program changes, the mismatch is detected and tags are re-resolved automatically.
- **Secure by design** — native S7CommPlus over **TLS 1.3**.
- **Multi-symbol read/write** — read or write many tags in a single request, each with its own per-symbol status (a single bad tag doesn't fail the whole batch).
- **Resilient connection** — shared endpoint with reconnect/watchdog handling and overload protection (`skipped (busy)`).
- **Batteries included** — ready-to-import example flows and PLC test data blocks to get you running fast.

## Quick start

Install from the Node-RED palette manager (**Manage palette → Install → `node-red-contrib-s7-plus`**), or from the command line in your Node-RED user directory:

```bash
npm install node-red-contrib-s7-plus
```

Then build a minimal read flow:

```
[inject] → [S7+ Read] → [debug]
```

1. Add an **S7+ Endpoint** and enter the PLC IP address.
2. On the **S7+ Read** node, click **Pick from PLC** and select your tags from the tree.
3. Wire an **inject** in front and **deploy** — every incoming message triggers one read.

The result lands in `msg.payload` (object format):

```json
{
  "Motor.speed": { "value": 1450, "status": "ok", "error": "" },
  "Tank.level":  { "value": 73.2, "status": "ok", "error": "" }
}
```

Writing works the same way: pick the tags, then send the value(s) in `msg.payload` (a scalar for one tag, or an object keyed by tag name for several).

## Nodes


| Node             | Description                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| **S7+ Endpoint** | Shared connection (IP, port 102, timeout, reconnect/watchdog).                                                    |
| **S7+ Read**     | Read symbol(s) on input; results in `msg.payload`. Override with `msg.symbols`, add extras with `msg.addSymbols`. |
| **S7+ Write**    | Write values via `msg.payload`; override symbols with `msg.symbols`. Result replaces `msg.payload`.               |
| **S7+ Explore**  | Full symbol catalog: flat names in `msg.payload`, optional `msg.infos`, browse summary in `msg.meta`.             |


## Symbolic addressing

1. Add an **S7+ Endpoint** with the PLC IP address.
2. In **S7+ Read** / **S7+ Write**, use **Pick from PLC** to browse the tree (DBs, structs, arrays) and add each symbol you need (e.g. `Motor.speed`, `Tank.level`).

The node stores `name` → internal **access string** (hex, e.g. `8A0E0001.A`). You normally never deal with hex: every tag is re-resolved symbolically at runtime, so the correct data type is always determined automatically.

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
- Project engineered with TIA Portal >= V17

> **TLS 1.3 required.** Minimum PLC firmware: **S7-1200 >= V4.5**, **S7-1500 >= V2.9** — this driver negotiates **TLS 1.3 only**. Firmware versions that offer only TLS 1.2 (e.g. S7-1200 V4.3/V4.4) are **not** supported, even though the upstream [S7CommPlusDriver](https://github.com/thomas-v2/S7CommPlusDriver) lists them.

## Examples

Example flows live in `[examples/](examples/)`. They target the test data blocks in `[plc/s7-1500/](plc/s7-1500/)` (S7-1500, optimized access).

**PLC setup:** import the `DB_*.db` sources from `plc/s7-1500/` into your TIA Portal project, compile, download, and ensure secure communication (TLS) and symbolic access are enabled.

**Node-RED setup:** **Import** one or more JSON files from `examples/`, **Deploy**, then open the shared **S7+ Endpoint** config node (`PLC`) and set the PLC IP address. All example flows reuse the same endpoint id (`example_plc_ep`), so importing multiple flows creates only one config node.

Suggested order: **read multiple** → **write single** → **R/W verification**.


| File                                                                        | Purpose                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[read-multiple-values-flow.json](examples/read-multiple-values-flow.json)` | Read many symbols in one request — static symbol list in the read node, plus a second path with runtime `msg.symbols`.                                                                                                     |
| `[write-single-values-flow.json](examples/write-single-values-flow.json)`   | Manual write tests — one inject per scalar constant writes to the matching `*_write` tag; each datatype group includes a read-back row. Covers Binary through Timers; hardware and system datatypes are excluded.          |
| `[read-write-test-flow.json](examples/read-write-test-flow.json)`           | Automated verification — one inject runs write → read-back → compare for every scalar constant across all datatypes. Emits one result per datatype and a final summary; the run completes even when individual cases fail. |


Flows are generated from the PLC DB sources. To regenerate after changing `plc/s7-1500/`:

```bash
node scripts/generate-read-multiple-flow.js
node scripts/generate-write-flow.js
node scripts/generate-rw-test-flow.js
```

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

