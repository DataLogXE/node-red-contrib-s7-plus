'use strict';

const crypto = require('crypto');
const { S7CommPlusClient } = require('../lib/s7plus/client');
const ItemAddress = require('../lib/s7plus/item-address');
const { decodeReadValue, encodeWriteValue } = require('../lib/s7plus/pvalue-codec');
const { buildReadPayload, buildWritePayload } = require('../lib/s7plus/read-result');
const { computeCrcFromMeta } = require('../lib/s7plus/crc');
const { scoped } = require('../lib/s7plus/debug');
const log = scoped('endpoint');

const BROWSE_SESSION_TTL_MS = 15 * 60 * 1000;
const RECONNECT_MAX_MS = 30000;
const WATCHDOG_MS = 10000;
// If the user lock is held but the transport produced NO inbound bytes
// for at least this long, the watchdog assumes a real hang and tears
// the transport down so the endpoint reconnects. With per-frame
// liveness in client._onDataReceived, even a slowly-arriving multi-MB
// browse response keeps this counter from advancing. 120 s is a
// conservative reserve for PLCs that take noticeably long to start
// answering big requests (e.g. manual browseFull via Explore node).
const WATCHDOG_HANG_NO_RESPONSE_MS = 120000;
const ephemeralBrowseSessions = new Map();

// DTL is the only datatype that needs the packed-struct interface
// timestamp echoed back on write. Accept both the canonical name and the
// numeric softdatatype id (67).
function isDtlDatatype(datatype) {
    return datatype === 67 || (typeof datatype === 'string' && datatype.toLowerCase() === 'dtl');
}

function statusShape(state, text) {
    switch (state) {
        case 'online': return { fill: 'green', shape: 'dot', text: text || 'online' };
        case 'connecting': return { fill: 'yellow', shape: 'dot', text: text || 'connecting' };
        case 'offline': return { fill: 'red', shape: 'dot', text: text || 'offline' };
        default: return { fill: 'grey', shape: 'ring', text: text || '' };
    }
}

function epAddress(config) {
    const a = (config.address || '').trim();
    return a ? `${a}:102` : '';
}

function logConnectionEvent(node, RED, config, event, extra = {}) {
    if (RED.settings.s7PlusEndpointLogConnection === false) return;
    const address = epAddress(config);
    if (!address) return;
    switch (event) {
        case 'connected':
            node.log(`connected to ${address}`);
            break;
        case 'disconnected':
            node.log(`disconnected from ${address} (${extra.reason || 'unknown'})`);
            break;
        case 'connection-lost':
            node.log(`connection lost ${address} (${extra.reason || 'unknown'})`);
            break;
        case 'connect-failed':
            node.warn(`connect failed ${address}: ${extra.message || ''}`);
            break;
    }
}

function browseBody(req) {
    return req.body || {};
}

function browseCredentials(body) {
    return {
        address: (body.address || '').trim(),
        password: '',
        username: '',
        timeoutMs: parseInt(body.timeout, 10) || 10000,
        port: 102
    };
}

function pruneEphemeralSessions() {
    const now = Date.now();
    for (const [id, sess] of ephemeralBrowseSessions) {
        if (sess.expires < now || sess.dead) {
            log('ephemeral prune', { sessionId: id, dead: !!sess.dead, expired: sess.expires < now });
            try { sess.client.forceDisconnect('prune'); } catch { /* ignore */ }
            ephemeralBrowseSessions.delete(id);
        }
    }
}

async function createEphemeralBrowseSession(creds) {
    pruneEphemeralSessions();
    log('ephemeral create', { address: creds.address, port: creds.port });
    const client = new S7CommPlusClient();
    await client.connect(creds.address, creds.password, creds.username, creds.timeoutMs, creds.port);
    const sessionId = crypto.randomBytes(16).toString('hex');
    const sess = {
        client,
        expires: Date.now() + BROWSE_SESSION_TTL_MS,
        dead: false
    };
    client.on('disconnect', (info) => {
        sess.dead = true;
        log('ephemeral disconnect', { sessionId, reason: info && info.reason });
    });
    ephemeralBrowseSessions.set(sessionId, sess);
    return sessionId;
}

function getEphemeralSession(sessionId) {
    pruneEphemeralSessions();
    const sess = ephemeralBrowseSessions.get(sessionId);
    if (!sess) throw new Error('Browse session expired — open Browse PLC again');
    if (sess.dead || !sess.client.connected) {
        ephemeralBrowseSessions.delete(sessionId);
        throw new Error('Browse session stale — open Browse PLC again');
    }
    sess.expires = Date.now() + BROWSE_SESSION_TTL_MS;
    return sess.client;
}

function endpointNodeFromBody(RED, body) {
    const id = body.id || body.endpointId;
    return id ? RED.nodes.getNode(id) : null;
}

/**
 * "Stale connection" errors are exactly the ones the new client raises
 * when the transport is dead and the operation cannot complete. They are
 * all safe to retry after a fresh reconnect; non-stale errors (protocol
 * decode, access denied, invalid argument, lock-acquire timeout) must
 * propagate as-is.
 *
 * Lock-acquire timeout is intentionally NOT treated as stale: the
 * transport is fine; only the previous operation took too long. Treating
 * it as stale would force an unnecessary reconnect that wipes a healthy
 * session and aborts the still-running predecessor.
 */
function isStaleConnectionError(err) {
    if (!err || !err.message) return false;
    const m = err.message;
    return m.includes('Data receive Timeout')      // _waitForResponse timeout
        || m.includes('Client not connected')       // _onTransportClosed reject
        || m.includes('Send failed')                 // transport.send throw
        || m.includes('socket-close')
        || m.includes('socket-end')
        || m.includes('socket-error');
}

/**
 * True when a symbol-resolution error signals a STALE BROWSE TREE rather
 * than a genuinely bad input. These messages are thrown by
 * lib/s7plus/browse/resolve-symbolic.js while walking the cached tree:
 * after a PLC program change (rename/delete/move of a DB member) the
 * cached structure no longer matches the PLC, so a segment/root that
 * used to exist is reported as missing. Treating these like the
 * address-stale PLC codes lets the endpoint self-heal: clear the browse
 * cache, re-resolve against the fresh PLC layout, and retry once.
 *
 * 'Invalid symbolic path:' is intentionally excluded — that is a real
 * user input error (e.g. "DB1" without a member) and must not trigger
 * a cache flush + lazy re-resolve retry.
 */
function isStaleTreeError(err) {
    if (!err || !err.message) return false;
    const m = err.message;
    return m.includes('not found in')                 // segment missing (renamed/deleted)
        || m.includes('not found among PLC roots')     // DB root renamed/removed
        || m.includes('not reachable')                 // structure changed
        || m.includes('does not resolve to a readable leaf'); // member type changed
}

async function withBrowseClient(RED, body, fn) {
    const sessionId = body.browseSessionId;
    if (sessionId) {
        log('browse via ephemeral session', { sessionId });
        try {
            const client = getEphemeralSession(sessionId);
            return await fn(client, sessionId);
        } catch (e) {
            if (!isStaleConnectionError(e) && !/session (expired|stale)/i.test(e.message || '')) throw e;
            log('ephemeral retry: reconnecting', { sessionId, reason: e.message });
            const stale = ephemeralBrowseSessions.get(sessionId);
            if (stale) {
                try { stale.client.forceDisconnect('retry'); } catch { /* ignore */ }
                ephemeralBrowseSessions.delete(sessionId);
            }
            const creds = browseCredentials(body);
            if (!creds.address) throw e;
            const newSessionId = await createEphemeralBrowseSession(creds);
            const client = getEphemeralSession(newSessionId);
            return fn(client, newSessionId);
        }
    }
    const ep = endpointNodeFromBody(RED, body);
    if (ep) {
        log('browse via deployed endpoint', { endpointId: body.id });
        await ep.ensureConnected();
        return fn(ep.client, null);
    }
    const creds = browseCredentials(body);
    if (!creds.address) {
        const id = body.id;
        throw new Error(id
            ? 'Endpoint not deployed yet — enter address and use Browse PLC (works before Deploy).'
            : 'PLC address is required');
    }
    log('browse via fresh ephemeral session', { address: creds.address, port: creds.port });
    const newSessionId = await createEphemeralBrowseSession(creds);
    const client = getEphemeralSession(newSessionId);
    return fn(client, newSessionId);
}

module.exports = function (RED) {
    function S7ComPlusEndpoint(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.client = new S7CommPlusClient();
        // Live DTL packed-struct interface timestamp captured from the PLC.
        // Required to write DTL; null until the first DTL read/resolve sees it.
        node._dtlInterfaceTs = null;
        node._state = 'offline';
        node._connectPromise = null;
        node._closing = false;
        node._reconnectTimer = null;
        node._reconnectAttempt = 0;
        node._watchdogTimer = null;

        node.getStatus = () => node._state;

        node._setStatus = (state, text) => {
            node._state = state;
            node.status(statusShape(state, text));
        };

        node.client.on('disconnect', (info) => {
            const reason = info && info.reason ? info.reason : 'unknown';
            log('endpoint disconnect', { id: node.id, reason, state: node._state });
            if (node._closing) return;
            if (node._state === 'online') {
                logConnectionEvent(node, RED, config, 'connection-lost', { reason });
                node._reconnectAttempt = 0;
                node._setStatus('connecting', 'reconnecting\u2026');
                scheduleReconnect();
            }
        });

        const doConnect = async () => {
            node._setStatus('connecting');
            const timeout = parseInt(config.timeout, 10) || 10000;
            log('endpoint connect', { id: node.id, address: config.address, port: 102, timeout });
            try {
                await node.client.connect(
                    config.address,
                    '',
                    '',
                    timeout,
                    102
                );
                log('endpoint connect ok', { id: node.id });
                logConnectionEvent(node, RED, config, 'connected');
                node._setStatus('online');
                return null;
            } catch (e) {
                node._setStatus('offline', e.message);
                log('endpoint connect failed', { id: node.id, msg: e.message });
                logConnectionEvent(node, RED, config, 'connect-failed', { message: e.message });
                return e;
            }
        };

        node.ensureConnected = async (forceReconnect = false) => {
            // Only forceDisconnect when there is no in-flight connect.
            // Otherwise two callers racing into ensureConnected(true)
            // would tear down each other's reconnect mid-handshake and
            // could ping-pong forever. With a connect in flight, joining
            // it is correct: if it succeeds, we're fine; if it fails,
            // each caller handles the error normally.
            if (forceReconnect && !node._connectPromise) {
                try { node.client.forceDisconnect('endpoint-force-reconnect'); } catch { /* ignore */ }
            }
            if (!forceReconnect && node.client.connected && !node.client.socketAlive) {
                log('ensureConnected: socket dead but client flag stale — forcing reconnect', { id: node.id });
                try { node.client.forceDisconnect('socket-dead'); } catch { /* ignore */ }
            }
            if (node.client.connected) return;
            if (!node._connectPromise) {
                node._connectPromise = doConnect().finally(() => {
                    node._connectPromise = null;
                });
            }
            const err = await node._connectPromise;
            if (err) throw err;
        };

        const scheduleReconnect = () => {
            if (node._closing || node._reconnectTimer || node._connectPromise) return;
            const delay = node._reconnectAttempt === 0
                ? 500
                : Math.min(1000 * Math.pow(2, node._reconnectAttempt - 1), RECONNECT_MAX_MS);
            log('scheduleReconnect', { id: node.id, attempt: node._reconnectAttempt, delayMs: delay });
            if (node._reconnectAttempt > 0) {
                node._setStatus('connecting', `reconnect #${node._reconnectAttempt} in ${Math.round(delay / 1000)}s\u2026`);
            }
            node._reconnectTimer = setTimeout(async () => {
                node._reconnectTimer = null;
                if (node._closing) return;
                try {
                    await node.ensureConnected();
                    node._reconnectAttempt = 0;
                } catch {
                    node._reconnectAttempt++;
                    scheduleReconnect();
                }
            }, delay);
        };

        /**
         * Run an operation, transparently recovering from a single stale-
         * connection failure. The client itself guarantees the underlying
         * call is bounded in time (lock-acquire + response timeouts), so
         * the retry adds at most one reconnect + one operation duration.
         * Used uniformly for browse, read, write — no operation-specific
         * wrapper stacking.
         */
        const withReconnect = async (fn, tag) => {
            log('endpoint op', { id: node.id, tag, connected: node.client.connected });
            await node.ensureConnected();
            try {
                return await fn();
            } catch (e) {
                if (!isStaleConnectionError(e)) {
                    log('endpoint op failed (non-recoverable)', { id: node.id, tag, msg: e.message });
                    throw e;
                }
                log('endpoint op retry (stale connection)', { id: node.id, tag, reason: e.message });
                await node.ensureConnected(true);
                try {
                    return await fn();
                } catch (e2) {
                    log('endpoint op retry failed', { id: node.id, tag, msg: e2.message });
                    throw e2;
                }
            }
        };

        node.browseRoots = () => withReconnect(() => {
            node.client.clearBrowseState();
            return node.client.browseRoots();
        }, 'browseRoots');

        node.browseChildren = (nodeId) => withReconnect(
            () => node.client.browseChildren(nodeId),
            `browseChildren:${nodeId}`
        );

        node.browseResolve = (nodeId) => withReconnect(
            () => node.client.browseResolve(nodeId),
            `browseResolve:${nodeId}`
        );

        node.explorePlcProgram = () => withReconnect(
            () => node.client.explorePlcProgram(),
            'explorePlcProgram'
        );

        node.browseFull = (options) => withReconnect(
            () => node.client.browseFull(options),
            'browseFull'
        );

        /**
         * Read one or more tags. Each tag is `{ name?, address, datatype? }`.
         * `address` must be a resolved hex access string (e.g. "8A0E0001.A").
         * Symbol resolution is the caller's responsibility — the endpoint
         * no longer keeps a shared symbol table.
         */
        node.readTags = (tags) => withReconnect(async () => {
            const prepared = tags.map((t, i) => {
                if (!t || !t.address) throw new Error(`Tag #${i} has no address`);
                const addr = new ItemAddress(t.address);
                if (t.symbolCrc) addr.symbolCrc = t.symbolCrc >>> 0;
                return { tag: t, addr };
            });
            const { values, errors } = await node.client.readValues(prepared.map(a => a.addr));
            captureDtlTimestamp(prepared.map(p => p.tag), values);
            return buildReadPayload(prepared, values, errors, decodeReadValue);
        }, 'readTags');

        // Remember the packed-struct interface timestamp from any DTL value
        // the PLC sent us, so a later DTL write can echo it back unchanged
        // (a mismatch is rejected as InvalidTimestampInTypeSafeBlob).
        function captureDtlTimestamp(tags, values) {
            for (let i = 0; i < tags.length; i++) {
                if (!isDtlDatatype(tags[i] && tags[i].datatype)) continue;
                const v = values[i];
                if (v && typeof v.packedInterfaceTimestamp === 'bigint' && v.packedInterfaceTimestamp !== 0n) {
                    node._dtlInterfaceTs = v.packedInterfaceTimestamp;
                }
            }
        }

        // --- CRC resolution cache ---
        const CRC_CACHE_TTL_MS = 5 * 60 * 1000;
        // Address/symbol-related PLC errors that mean the cached address is
        // stale: the symbol was deleted or moved to a new address (PLC
        // program changed). Both warrant the same self-heal: clear the
        // browse-state + CRC cache, re-resolve against the fresh PLC tree,
        // and retry once. 0x...12cbffef = CRC mismatch, 0x...0ebeffef =
        // address/object no longer valid.
        const ADDR_STALE_HEX = ['8009890012cbffef', '800989000ebeffef'];
        const _crcCache = new Map();

        function crcCacheGet(symbolPath) {
            const entry = _crcCache.get(symbolPath);
            if (!entry) return null;
            if (Date.now() - entry.resolvedAt > CRC_CACHE_TTL_MS) {
                _crcCache.delete(symbolPath);
                return null;
            }
            return entry;
        }

        function crcCacheSet(symbolPath, address, symbolCrc, datatype) {
            _crcCache.set(symbolPath, { address, symbolCrc, datatype, resolvedAt: Date.now() });
        }

        function crcCacheInvalidate(symbolPath) {
            _crcCache.delete(symbolPath);
        }

        function crcCacheInvalidateAll() {
            _crcCache.clear();
        }

        /**
         * True when an error signals that a cached address is stale (symbol
         * deleted or moved to a new address). Checks both the raw per-item
         * PLC codes (err.writeErrorCodes, BigInt) and the error message so
         * it works for read errors (message-only) and write errors (codes).
         */
        function isAddressStaleError(err) {
            if (!err) return false;
            const codes = err.writeErrorCodes;
            if (Array.isArray(codes)) {
                for (const c of codes) {
                    if (!c) continue;
                    const hex = c.toString(16);
                    if (ADDR_STALE_HEX.some(h => hex.includes(h))) return true;
                }
            }
            const msg = err.message || '';
            return ADDR_STALE_HEX.some(h => msg.includes(h));
        }

        /**
         * Resolve a batch of symbols, using the CRC cache for hits and
         * browseResolveSymbolicBatch for all misses in a single pass.
         * Returns one entry per symbol (same order as input).
         */
        async function resolveSymbolsBatch(symbols) {
            const entries = new Array(symbols.length);
            const uncachedIndices = [];

            for (let i = 0; i < symbols.length; i++) {
                const cached = crcCacheGet(symbols[i]);
                if (cached) {
                    entries[i] = cached;
                } else {
                    uncachedIndices.push(i);
                }
            }

            if (uncachedIndices.length > 0) {
                const uncachedPaths = uncachedIndices.map(i => symbols[i]);
                const resolved = await node.client.browseResolveSymbolicBatch(uncachedPaths);

                for (let j = 0; j < uncachedIndices.length; j++) {
                    const idx = uncachedIndices[j];
                    const r = resolved[j];
                    if (r.error) {
                        entries[idx] = { address: null, symbolCrc: 0, error: r.error };
                    } else {
                        const symbolCrc = r.crcMeta ? computeCrcFromMeta(r.crcMeta) : 0;
                        const entry = { address: r.address, symbolCrc, datatype: r.datatype, resolvedAt: Date.now() };
                        crcCacheSet(symbols[idx], r.address, symbolCrc, r.datatype);
                        entries[idx] = entry;
                    }
                }
            }

            return entries;
        }

        /**
         * Resolve symbolic paths, compute CRC, perform a CRC-secured read.
         * Uses batch resolution: one browseRootsCached + shared type-info
         * cache for all uncached symbols.
         * On CRC-Mismatch error: invalidate cache, re-resolve, retry once.
         * @param {string[]} symbols - symbolic paths like "DB1.readings[0]"
         * @returns {object} keyed by symbol path
         */
        node.resolveAndRead = async (symbols) => {
            const doRead = async (entries) => {
                const readable = [];
                const readableSymbols = [];
                const resolveErrors = {};

                for (let i = 0; i < entries.length; i++) {
                    if (entries[i].error) {
                        resolveErrors[symbols[i]] = {
                            value: null,
                            status: 'error',
                            error: entries[i].error
                        };
                    } else {
                        readable.push({
                            name: symbols[i],
                            address: entries[i].address,
                            symbolCrc: entries[i].symbolCrc,
                            datatype: entries[i].datatype
                        });
                        readableSymbols.push(symbols[i]);
                    }
                }

                if (readable.length === 0) return resolveErrors;

                const readResult = await node.readTags(readable);
                return Object.assign(resolveErrors, readResult);
            };

            let entries = await resolveSymbolsBatch(symbols);
            const result = await doRead(entries);

            const mismatchIndices = [];
            for (let i = 0; i < symbols.length; i++) {
                const r = result[symbols[i]];
                if (r && r.status === 'error' && r.error
                    && (isAddressStaleError({ message: r.error }) || isStaleTreeError({ message: r.error }))) {
                    mismatchIndices.push(i);
                }
            }

            if (mismatchIndices.length === 0) return result;

            const mismatchSymbols = mismatchIndices.map(i => symbols[i]);
            node.warn(`Stale address on ${mismatchSymbols.length} symbol(s) — symbol may have moved or PLC program changed. Clearing cache and re-resolving. Affected: ${mismatchSymbols.slice(0, 5).join(', ')}${mismatchSymbols.length > 5 ? ' ...' : ''}`);
            log('resolveAndRead stale address, retrying', { symbols: mismatchSymbols });

            // Clear the cached browse tree so re-resolution walks the
            // fresh PLC layout and picks up any moved symbol addresses.
            node.client.clearBrowseState();
            crcCacheInvalidateAll();

            entries = await resolveSymbolsBatch(symbols);
            return doRead(entries);
        };


        /**
         * Write one or more tags. Each tag is
         * `{ name?, address, value, datatype, symbolCrc? }`.
         * `address` must be a resolved hex access string. When the tag
         * carries a `symbolCrc` (browsed/resolved symbol) it is applied
         * to the ItemAddress so the PLC verifies the symbol table has not
         * changed — same CRC protection as readTags.
         *
         * Per-item PLC errors (bad address, CRC mismatch, access denied)
         * are no longer swallowed: writeValues now returns real per-item
         * codes, and any non-zero code is raised as an Error so the write
         * node turns red and reports via done(err) instead of falsely
         * showing success.
         */
        node.writeTags = (tags) => withReconnect(async () => {
            const addresses = tags.map((t, i) => {
                if (!t || !t.address) throw new Error(`Tag #${i} has no address`);
                const addr = new ItemAddress(t.address);
                if (t.symbolCrc) addr.symbolCrc = t.symbolCrc >>> 0;
                return addr;
            });

            // DTL writes need the PLC's packed-struct interface timestamp.
            // If no DTL has been read on this endpoint yet, read the DTL
            // target(s) once to capture it before encoding the write.
            const hasDtl = tags.some(t => isDtlDatatype(t && t.datatype));
            if (hasDtl && node._dtlInterfaceTs == null) {
                const dtlIdx = tags
                    .map((t, i) => (isDtlDatatype(t && t.datatype) ? i : -1))
                    .filter(i => i >= 0);
                const { values } = await node.client.readValues(dtlIdx.map(i => addresses[i]));
                captureDtlTimestamp(dtlIdx.map(i => tags[i]), values);
            }

            const opts = { dtlInterfaceTimestamp: node._dtlInterfaceTs };
            const vals = tags.map(t => encodeWriteValue(t.value, t.datatype, opts));
            const { errors } = await node.client.writeValues(addresses, vals);

            // Per-item PLC errors are no longer thrown: writeTags now mirrors
            // readTags and returns a per-tag result keyed by name with
            // { value, status, error }. Stale-address self-heal in
            // resolveAndWrite inspects these statuses instead of catching.
            return buildWritePayload(tags, errors);
        }, 'writeTags');

        /**
         * Resolve symbolic tags to hex address + CRC, then perform a
         * CRC-secured write. Mirror of resolveAndRead so the write path
         * gets the same symbol resolution and self-healing behaviour.
         * On CRC mismatch: invalidate the cache, re-resolve, retry once.
         * @param {Array} tags - `{ name?, address (symbolic), value, datatype? }`
         */
        node.resolveAndWrite = async (tags) => {
            const symbols = tags.map(t => t.address);
            const keyOf = (t) => t.name || t.address;

            const doWrite = async (entries) => {
                const writable = [];
                const resolveErrors = {};

                for (let i = 0; i < entries.length; i++) {
                    if (entries[i].error) {
                        resolveErrors[keyOf(tags[i])] = {
                            value: null,
                            status: 'error',
                            error: entries[i].error
                        };
                    } else {
                        writable.push({
                            name: keyOf(tags[i]),
                            address: entries[i].address,
                            symbolCrc: entries[i].symbolCrc,
                            datatype: tags[i].datatype || entries[i].datatype,
                            value: tags[i].value
                        });
                    }
                }

                if (writable.length === 0) return resolveErrors;

                const writeResult = await node.writeTags(writable);
                return Object.assign(resolveErrors, writeResult);
            };

            let entries = await resolveSymbolsBatch(symbols);
            const result = await doWrite(entries);

            const mismatchIndices = [];
            for (let i = 0; i < tags.length; i++) {
                const r = result[keyOf(tags[i])];
                if (r && r.status === 'error' && r.error
                    && (isAddressStaleError({ message: r.error }) || isStaleTreeError({ message: r.error }))) {
                    mismatchIndices.push(i);
                }
            }

            if (mismatchIndices.length === 0) return result;

            const mismatchSymbols = mismatchIndices.map(i => symbols[i]);
            node.warn(`Stale address on ${mismatchSymbols.length} write symbol(s) — symbol may have moved or PLC program changed. Clearing cache and re-resolving. Affected: ${mismatchSymbols.slice(0, 5).join(', ')}${mismatchSymbols.length > 5 ? ' ...' : ''}`);
            log('resolveAndWrite stale address, retrying', { symbols: mismatchSymbols });

            // A stale cached address may have been resolved through the
            // cached browse tree; clear it so re-resolution walks the
            // fresh PLC layout and picks up the symbol's new address.
            node.client.clearBrowseState();
            crcCacheInvalidateAll();

            entries = await resolveSymbolsBatch(symbols);
            return doWrite(entries);
        };

        node.on('close', (_removed, done) => {
            node._closing = true;
            if (node._reconnectTimer) {
                clearTimeout(node._reconnectTimer);
                node._reconnectTimer = null;
            }
            if (node._watchdogTimer) {
                clearInterval(node._watchdogTimer);
                node._watchdogTimer = null;
            }
            node.client.forceDisconnect('node-close');
            done();
        });

        if (config.address) {
            node._connectPromise = doConnect().finally(() => {
                node._connectPromise = null;
            });
            node._connectPromise.then((err) => {
                if (err) {
                    node._reconnectAttempt = 1;
                    scheduleReconnect();
                }
            });
            let watchdogBusy = false;
            node._watchdogTimer = setInterval(async () => {
                if (node._closing || watchdogBusy) return;
                watchdogBusy = true;
                try {
                    if (!node.client.connected) {
                        if (!node._connectPromise && !node._reconnectTimer) {
                            log('watchdog: offline without pending reconnect', { id: node.id });
                            scheduleReconnect();
                        }
                        return;
                    }
                    if (!node.client.socketAlive) {
                        log('watchdog: socket dead', { id: node.id });
                        try { node.client.forceDisconnect('watchdog'); } catch { /* ignore */ }
                        return;
                    }
                    // Skip ping if a legitimate long-running user op
                    // (browseFull, big read/write) is in progress. A running
                    // op is itself proof of liveness. If the lock has been
                    // held without ANY inbound PDU for more than the hang
                    // threshold, treat it as a real hang and force reconnect.
                    if (node.client.userLockBusy) {
                        const sinceLastResponse = Date.now() - node.client.lastResponseAt;
                        if (sinceLastResponse > WATCHDOG_HANG_NO_RESPONSE_MS) {
                            const opLabel = node.client.userOpInFlight || 'unknown';
                            const seconds = Math.round(sinceLastResponse / 1000);
                            node.warn(`watchdog: forcing reconnect — operation '${opLabel}' produced no PDU for ${seconds}s`);
                            log('watchdog: lock busy and no response — forcing reconnect', {
                                id: node.id,
                                op: opLabel,
                                sinceLastResponseMs: sinceLastResponse,
                                thresholdMs: WATCHDOG_HANG_NO_RESPONSE_MS
                            });
                            try { node.client.forceDisconnect('watchdog-stuck'); } catch { /* ignore */ }
                        } else {
                            log('watchdog: skip (lock busy, traffic flowing)', () => [{
                                id: node.id,
                                op: node.client.userOpInFlight,
                                sinceLastResponseMs: sinceLastResponse
                            }]);
                        }
                        return;
                    }
                    try {
                        await node.client.ping();
                    } catch {
                        if (node._closing) return;
                        log('watchdog: ping failed, forcing reconnect', { id: node.id });
                        try { node.client.forceDisconnect('watchdog-ping'); } catch { /* ignore */ }
                    }
                } finally {
                    watchdogBusy = false;
                }
            }, WATCHDOG_MS);
        } else {
            node._setStatus('offline', 'no address');
        }
    }

    RED.nodes.registerType('s7-plus endpoint', S7ComPlusEndpoint, {
        settings: {
            s7PlusEndpointLogConnection: {
                value: true,
                exportable: false
            }
        }
    });

    // Wraps a browse HTTP handler so a transient stale-connection failure
    // from either the deployed-endpoint path or the ephemeral-session
    // path triggers a single reconnect+retry before bubbling up. The
    // client and withBrowseClient each have their own recovery; this is
    // the outermost net.
    async function handleBrowseRequest(req, res, opName, runFn) {
        const body = browseBody(req);
        const t0 = Date.now();
        log('http browse', { op: opName, id: body.id, sessionId: body.browseSessionId, nodeId: body.nodeId });
        const attempt = async () => withBrowseClient(RED, body, runFn);
        try {
            let payload;
            try {
                payload = await attempt();
            } catch (e1) {
                if (!isStaleConnectionError(e1) && !/session (expired|stale)/i.test(e1.message || '')) throw e1;
                log('http browse retry', { op: opName, reason: e1.message });
                if (body.browseSessionId) {
                    const stale = ephemeralBrowseSessions.get(body.browseSessionId);
                    if (stale) {
                        try { stale.client.forceDisconnect('http-retry'); } catch { /* ignore */ }
                        ephemeralBrowseSessions.delete(body.browseSessionId);
                    }
                    body.browseSessionId = null;
                }
                payload = await attempt();
            }
            log('http browse ok', { op: opName, ms: Date.now() - t0 });
            res.json(payload);
        } catch (e) {
            log('http browse fail', { op: opName, ms: Date.now() - t0, msg: e.message });
            res.status(500).json({ error: e.message });
        }
    }

    function handleBrowseRoots(req, res) {
        return handleBrowseRequest(req, res, 'roots', async (client, sessionId) => {
            client.clearBrowseState();
            const result = await client.browseRoots();
            return { nodes: result.nodes, browseSessionId: sessionId };
        });
    }

    function handleBrowseChildren(req, res) {
        const body = browseBody(req);
        if (!body.nodeId) { res.status(400).json({ error: 'nodeId is required' }); return; }
        return handleBrowseRequest(req, res, 'children', (client) => client.browseChildren(body.nodeId));
    }

    function handleBrowseResolve(req, res) {
        const body = browseBody(req);
        if (!body.nodeId) { res.status(400).json({ error: 'nodeId is required' }); return; }
        return handleBrowseRequest(req, res, 'resolve', (client) => client.browseResolve(body.nodeId));
    }

    const browsePerm = RED.auth.needsPermission('flows.read');
    RED.httpAdmin.post('/s7complus/browse/roots', browsePerm, handleBrowseRoots);
    RED.httpAdmin.post('/s7complus/browse/children', browsePerm, handleBrowseChildren);
    RED.httpAdmin.post('/s7complus/browse/resolve', browsePerm, handleBrowseResolve);
};
