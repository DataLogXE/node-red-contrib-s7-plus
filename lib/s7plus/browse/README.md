# Lazy PLC browse

## Protocol

Mirrors the C# `S7CommPlusDriver` reference (`GetTypeInformation`, `GetCommentsXml`):

1. **Roots**: `Explore { exploreId = NativeObjects_thePLCProgram_Rid, exploreRequestId = None, recursive = 1 }`
   with `addressList = [ObjectVariableTypeName]` (DB number from `relationId`; comment not needed),
   then read LID=1 on every DB to get `db_block_ti_relid`.
2. **Children** (on demand for one block/struct):
   `Explore { exploreId = tiRelId, exploreRequestId = None, recursive = 1 }`.
   Returned objects are cached by `relationId` so nested structs reuse the same subtree.
3. **Arrays** are virtual: page nodes (`[0..31]`, `[32..63]`, …) are generated client-side
   from the array length; struct-array elements lazy-explore via the relation id.

## Editor

- `POST /s7complus/browse/roots` → `{ nodes, browseSessionId? }`
- `POST /s7complus/browse/children` → `{ nodes }` (body: `nodeId`, session/endpoint context)
- `POST /s7complus/browse/resolve` → `{ name, address, datatype }`
- `POST /s7complus/browse` → **410 deprecated**

Ephemeral browse (before deploy) uses `browseSessionId` from roots on subsequent calls.

## Stale-connection recovery

A "live" S7+ TCP connection often dies silently between two browse calls
(NAT idle expiry, PLC reboot, cable, …). The recovery rules are:

1. `S7CommPlusClient._waitForPdu` fires its read timeout (default 5s).
   The handler **proactively tears the transport down** and calls
   `_onTransportClosed({ reason: 'pdu-read-timeout' })`. The client emits
   `disconnect` once and flips `connected` to `false` — so the very next
   request does NOT pay another full read-timeout window.
2. `forceDisconnect(reason)` (new) tears the transport down **without**
   sending `DeleteObject`. Use this whenever the socket is already known
   stale; the graceful `disconnect()` is reserved for the live path.
3. `nodes/s7complus-endpoint.js` uses `forceDisconnect` in its reconnect
   path (`ensureConnected(true)`) and applies a single retry both at the
   endpoint level (`withReconnect`) and at the HTTP handler level
   (`handleBrowseRequest`) for ephemeral browse sessions.
4. Ephemeral browse sessions listen to the client's `disconnect` event
   and mark themselves `dead`; the next `getEphemeralSession` lookup
   discards them and the HTTP handler reconnects automatically.

## Debug logging

Set `S7P_DEBUG=*` (all scopes) or `S7P_DEBUG=client,endpoint,transport`
(comma list) before starting Node-RED to surface every connect,
disconnect, PDU send/receive and browse retry on stderr. Output is
prefixed with `[s7p:<scope>] HH:MM:SS.mmm`.

## Live tests

All scripts require an explicit PLC host (no built-in default). Optional env vars:
`S7_HOST`, `S7_PORT`, `S7_PASSWORD`, `S7_SYMBOL`, `S7_SYMBOLS` (comma-separated),
`S7_DB_PREFIX`, `S7_WRITE_MARKER`.

- `node test/scripts/live-browse.js <host> [port] [password]` — full browse chain
- `node test/scripts/live-reconnect.js <host> [port] [password] [timeoutMs]` —
  stale-socket / idle reconnect scenario; verifies pass 2 finishes in
  `~timeout + connect time` (not `2 × timeout`)
- `node test/scripts/live-crc-verify.js <host> [port] [password] <symbol> [...]` —
  read symbolic symbols with computed CRC
- `node test/scripts/live-crc-test.js <host> [port] [password] <arraySymbol>` —
  compare PLC vte.symbolCrc with locally computed CRC variants
- `node test/scripts/live-array-crc-diagnose.js <host> [port] [password] <symbol> [...]` —
  diagnose CRC/address variants for array elements
- `node test/scripts/live-datatype-rw.js <host> [port] [password]` —
  read/type-check and write/readback sweep over DB blocks

Example: `node test/scripts/live-browse.js 192.168.0.1 102`
