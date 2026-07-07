'use strict';

const crypto = require('crypto');
const { S7CommPlusClient } = require('../lib/s7plus/client');
const ItemAddress = require('../lib/s7plus/item-address');
const { decodeReadValue, encodeWriteValue } = require('../lib/s7plus/pvalue-codec');
const { buildReadPayload, buildWritePayload } = require('../lib/s7plus/read-result');
const { computeCrcFromMeta } = require('../lib/s7plus/crc');
const { NotificationBuffer } = require('../lib/s7plus/notification-buffer');
const { SerialQueue } = require('../lib/s7plus/serial-queue');
const { scoped } = require('../lib/s7plus/debug');
const { buildConnectionStatePayload } = require('../lib/s7plus/session-info');
const { pathsEqual } = require('./s7complus-subscribe');
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

// Safe upper bound for items in a single subscription. The breakpoint test
// showed a single subscription stays stable up to 100 items across all tested
// CPUs; wider subscriptions made the PLC reset the TCP connection (ECONNRESET).
// Wider needs must be split across multiple subscribe nodes.
const MAX_ITEMS_PER_SUBSCRIPTION = 100;

// Map known subscription-create return-value classes (high bytes) to a
// human-readable hint. The PLC otherwise only reports an opaque 64-bit code.
// Takes the hex string as printed in the client error (low bits may be lossy
// due to Number precision, but the leading class bytes are preserved).
function describeSubscriptionError(hexStr) {
    const cls = String(hexStr).replace(/^0x/i, '').padStart(16, '0').slice(0, 6).toLowerCase();
    if (cls === 'ab3da6') return 'PLC resource/subscription limit reached';
    if (cls === 'ab3d8d') return 'invalid parameter (e.g. cycle time below PLC minimum of 100 ms)';
    return null;
}

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
        node._stateListeners = new Map();

        // Subscription registries. _subscriptions is keyed by the owning
        // subscribe-node id (stable across reconnects); _subsByObjId maps the
        // PLC's subscription object id (carried in each notification) back to
        // the same record for routing. Object ids are cleared on disconnect
        // and re-populated when subscriptions are re-created after reconnect.
        node._subscriptions = new Map();
        node._subsByObjId = new Map();
        // Notifications that arrive before their subscription object id is
        // registered (the PLC may push the initial full-value snapshot in
        // the same TCP segment as the CreateObject response). They are
        // replayed right after registration; see establishSubscription.
        node._pendingNotifications = new NotificationBuffer();
        // Serializes all record-mutating subscription operations per owner
        // node id. Without this, a deploy-initiated subscribe racing an
        // "inject once after startup" message would run two establishes on
        // the same record and orphan a PLC subscription whose notifications
        // get decoded with the wrong reference map.
        node._subOpQueue = new SerialQueue();

        // Current vs. maximum PLC subscriptions. active = subscriptions really
        // established on the PLC (object id present); max comes from the system
        // limits read at connect time (client._limitsCache.subscriptionsMax).
        node.getSubscriptionStats = () => {
            const limits = node.client && node.client._limitsCache;
            const max = limits && limits.subscriptionsMax != null ? limits.subscriptionsMax : null;
            return { active: node._subsByObjId.size, max };
        };

        node.getStatus = () => node._state;

        node.addStateListener = (ownerId, callback) => {
            if (!ownerId || typeof callback !== 'function') return;
            node._stateListeners.set(ownerId, callback);
        };

        node.removeStateListener = (ownerId) => {
            node._stateListeners.delete(ownerId);
        };

        node.getConnectionStatePayload = (event) => {
            const state = event && event.state != null ? event.state : node._state;
            return buildConnectionStatePayload(
                {
                    address: (config.address || '').trim() || node.client._connectAddress || null,
                    port: node.client._connectPort || 102,
                    timeoutMs: parseInt(config.timeout, 10) || null,
                    connected: node.client.connected,
                    endpointState: state
                },
                {
                    event: 'stateChange',
                    previousState: event && event.previousState != null ? event.previousState : null,
                    changedAt: new Date().toISOString()
                }
            );
        };

        const notifyStateListeners = (event) => {
            for (const cb of node._stateListeners.values()) {
                try { cb(event); } catch { /* ignore */ }
            }
        };

        node._setStatus = (state, text) => {
            const previousState = node._state;
            node._state = state;
            node.status(statusShape(state, text));
            if (previousState !== state) {
                notifyStateListeners({ state, previousState, text: text || null });
            }
        };

        node.client.on('disconnect', (info) => {
            const reason = info && info.reason ? info.reason : 'unknown';
            log('endpoint disconnect', { id: node.id, reason, state: node._state });
            // PLC-side subscriptions die with the session. Drop the object-id
            // routing and mark every record as not-established so the connect
            // handler re-creates them. Owners are notified so they can show
            // a "connecting" status.
            node._subsByObjId.clear();
            node._pendingNotifications.clear();
            for (const record of node._subscriptions.values()) {
                record.subscriptionObjectId = 0;
                record.refToName = null;
                if (record.callback) {
                    try { record.callback({ type: 'status', state: 'connecting' }); } catch { /* ignore */ }
                }
            }
            if (node._closing) return;
            if (node._state === 'online') {
                logConnectionEvent(node, RED, config, 'connection-lost', { reason });
                node._reconnectAttempt = 0;
                node._setStatus('connecting', 'reconnecting\u2026');
                scheduleReconnect();
            }
        });

        // Deliver one notification to the owning subscribe-node. Shared by
        // the live path and the buffered replay in establishSubscription.
        // Note: seqNum jumps are NOT loss with RouteMode 0x20 — the PLC
        // advances the sequence number per cycle but skips sending on
        // cycles without changes (see note in lib/s7plus/subscription.js).
        function deliverNotification(record, noti) {
            if (!record.callback) return;
            try {
                record.callback({ type: 'data', noti, refToName: record.refToName });
            } catch (e) {
                log('notification callback error', { id: node.id, msg: e.message });
            }
        }

        // Route each cyclic notification to the owning subscribe-node.
        node.client.on('notification', (noti) => {
            const record = node._subsByObjId.get(noti.subscriptionId);
            if (!record) {
                // Likely the initial snapshot racing the CreateObject
                // response: buffer it so establishSubscription can replay
                // it once the object id is registered.
                node._pendingNotifications.push(noti.subscriptionId, noti);
                log('notification with no matching subscription, buffered', { id: node.id, subscriptionId: noti.subscriptionId });
                return;
            }
            deliverNotification(record, noti);
        });

        // After every successful (re)connect, (re)create all registered
        // subscriptions. On the initial connect this is a no-op until a
        // subscribe-node has registered.
        node.client.on('connect', () => {
            if (node._subscriptions.size === 0) return;
            reestablishAllSubscriptions();
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

        node.getSessionInfo = (opts) => withReconnect(async () => {
            const t0 = Date.now();
            const refreshLimits = !opts || opts.refreshLimits !== false;
            const payload = await node.client.getSessionInfo({ refreshLimits });
            payload.connection.address = (config.address || '').trim() || payload.connection.address;
            payload.connection.timeoutMs = parseInt(config.timeout, 10) || payload.connection.timeoutMs;
            payload.connection.endpointState = node._state;
            payload.meta = {
                fetchedAt: new Date().toISOString(),
                elapsedMs: Date.now() - t0,
                refreshLimits
            };
            return payload;
        }, 'getSessionInfo');

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

        // ---------- SUBSCRIPTIONS ----------

        /**
         * Resolve a record's symbols to CRC-secured ItemAddresses and create
         * the PLC subscription. Populates record.subscriptionObjectId,
         * record.refToName and record.resolveErrors. Throws on failure.
         */
        async function establishSubscription(record) {
            const entries = await resolveSymbolsBatch(record.symbols);
            const items = [];
            const resolveErrors = {};
            for (let i = 0; i < record.symbols.length; i++) {
                const e = entries[i];
                if (!e || e.error) {
                    resolveErrors[record.symbols[i]] = (e && e.error) || 'resolve failed';
                    continue;
                }
                const addr = new ItemAddress(e.address);
                if (e.symbolCrc) addr.symbolCrc = e.symbolCrc >>> 0;
                items.push({ name: record.symbols[i], address: addr, datatype: e.datatype });
            }
            record.resolveErrors = resolveErrors;
            if (items.length === 0) {
                throw new Error(`No resolvable symbols to subscribe (${Object.keys(resolveErrors).join(', ')})`);
            }

            // Width guard: a single oversized subscription crashed the PLC
            // connection in the breakpoint test (> 100 items -> ECONNRESET).
            if (items.length > MAX_ITEMS_PER_SUBSCRIPTION) {
                throw new Error(`Subscription has ${items.length} items, exceeds safe maximum (${MAX_ITEMS_PER_SUBSCRIPTION}) - split across multiple subscribe nodes`);
            }

            // Count guard: refuse before the PLC rejects with an opaque code.
            const { active, max } = node.getSubscriptionStats();
            if (max != null && active >= max) {
                throw new Error(`PLC subscription limit reached (${active}/${max})`);
            }

            let result;
            try {
                result = await node.client.createSubscription({
                    items,
                    cycleMs: record.cycleMs,
                    routeMode: record.routeMode,
                    creditLimit: record.creditLimit
                });
            } catch (e) {
                const m = /returnValue=0x([0-9a-f]+)/i.exec(e.message || '');
                const hint = m ? describeSubscriptionError(m[1]) : null;
                throw hint ? new Error(`${e.message} - ${hint}`) : e;
            }
            record.subscriptionObjectId = result.subscriptionObjectId;
            record.refToName = result.refToName;
            node._subsByObjId.set(result.subscriptionObjectId, record);

            // Replay notifications that raced the CreateObject response
            // (e.g. the initial full-value snapshot pushed in the same TCP
            // segment). Without this, values that never change would be
            // lost for good (RouteMode 0x20 sends them exactly once).
            const buffered = node._pendingNotifications.drain(result.subscriptionObjectId);
            for (const noti of buffered) {
                deliverNotification(record, noti);
            }
            if (buffered.length) {
                log('replayed buffered notifications', { id: node.id, subscriptionObjectId: result.subscriptionObjectId, count: buffered.length });
            }
        }

        // Retry backoff for failed establishments: first retry after 10 s,
        // doubling up to 5 min. Driven by the watchdog tick.
        const ESTABLISH_RETRY_BASE_MS = 10000;
        const ESTABLISH_RETRY_MAX_MS = 5 * 60 * 1000;

        function resetEstablishRetry(record) {
            record.lastEstablishError = null;
            record.establishRetryCount = 0;
            record.nextEstablishRetryAt = 0;
        }

        // Advance the per-record backoff and arm the next retry slot.
        function scheduleEstablishRetry(record, errorMsg) {
            if (errorMsg) record.lastEstablishError = errorMsg;
            record.establishRetryCount = (record.establishRetryCount || 0) + 1;
            const delay = Math.min(
                ESTABLISH_RETRY_BASE_MS * Math.pow(2, record.establishRetryCount - 1),
                ESTABLISH_RETRY_MAX_MS
            );
            record.nextEstablishRetryAt = Date.now() + delay;
            return delay;
        }

        // Establish a single subscription and report the outcome to its owner
        // via the status callback. Never throws (errors surface as status).
        async function tryEstablish(record) {
            if (!node.client.connected) {
                if (record.callback) record.callback({ type: 'status', state: 'connecting' });
                return;
            }
            try {
                await establishSubscription(record);
                if (Object.keys(record.resolveErrors || {}).length === 0) {
                    resetEstablishRetry(record);
                } else {
                    // Partially established: some symbols did not resolve
                    // (e.g. not downloaded to the PLC yet). Keep the healthy
                    // subscription but arm the heal retry so the missing
                    // symbols are re-probed by the watchdog.
                    scheduleEstablishRetry(record);
                }
                if (record.callback) {
                    record.callback({
                        type: 'status',
                        state: 'subscribed',
                        itemCount: record.refToName ? record.refToName.size : 0,
                        resolveErrors: record.resolveErrors || {}
                    });
                }
            } catch (e) {
                const delay = scheduleEstablishRetry(record, e.message);
                log('establish subscription failed', {
                    id: node.id,
                    owner: record.ownerNodeId,
                    msg: e.message,
                    retryInMs: delay
                });
                if (record.callback) record.callback({ type: 'status', state: 'error', text: e.message });
            }
        }

        /**
         * Heal a partially established subscription: re-probe ONLY the
         * previously unresolvable symbols against a fresh PLC layout. The
         * healthy subscription is recreated only when at least one of them
         * became resolvable (e.g. after a TIA download) — otherwise it
         * stays untouched and the backoff advances (no subscription churn).
         */
        async function tryHealPartialResolve(record) {
            const failedPaths = Object.keys(record.resolveErrors || {});
            if (failedPaths.length === 0) return;
            try {
                // The failed symbols were resolved against the cached browse
                // tree; only a fresh walk can see a changed PLC program.
                // Bounded by the backoff (at most every 10 s .. 5 min).
                node.client.clearBrowseState();
                const entries = await resolveSymbolsBatch(failedPaths);
                const improved = entries.some((e) => e && !e.error);
                if (!improved) {
                    scheduleEstablishRetry(record);
                    return;
                }
                log('partial resolve heal: recreating subscription', {
                    id: node.id,
                    owner: record.ownerNodeId,
                    healedCandidates: failedPaths.length
                });
                node._subsByObjId.delete(record.subscriptionObjectId);
                try {
                    await node.client.deleteSubscription(record.subscriptionObjectId);
                } catch (e) {
                    log('partial heal delete failed', { id: node.id, msg: e.message });
                }
                node._pendingNotifications.discard(record.subscriptionObjectId);
                record.subscriptionObjectId = 0;
                record.refToName = null;
                await tryEstablish(record);
            } catch (e) {
                scheduleEstablishRetry(record, e.message);
                log('partial resolve heal failed', { id: node.id, owner: record.ownerNodeId, msg: e.message });
            }
        }

        // Watchdog hook: re-attempt subscriptions that failed to establish
        // while the connection itself is healthy (resolve error, PLC limit),
        // and heal partially established ones whose symbols may have
        // appeared on the PLC in the meantime (TIA download).
        // Reconnect-triggered re-creation is handled by the 'connect' event.
        // The eligibility checks run INSIDE the per-owner queue so they see
        // the consistent end state of any subscribe/unsubscribe in flight.
        async function retryFailedSubscriptions() {
            if (!node.client.connected) return;
            for (const record of [...node._subscriptions.values()]) {
                await node._subOpQueue.run(record.ownerNodeId, async () => {
                    if (!node.client.connected) return;
                    if (!node._subscriptions.has(record.ownerNodeId)) return;
                    if ((record.nextEstablishRetryAt || 0) > Date.now()) return;
                    if (!record.subscriptionObjectId) {
                        await tryEstablish(record);
                    } else {
                        await tryHealPartialResolve(record);
                    }
                });
            }
        }
        // Exposed for the watchdog tick below and for tests.
        node._retryFailedSubscriptions = retryFailedSubscriptions;

        async function reestablishAllSubscriptions() {
            for (const record of [...node._subscriptions.values()]) {
                await node._subOpQueue.run(record.ownerNodeId, async () => {
                    if (!node._subscriptions.has(record.ownerNodeId)) return;
                    // Fresh session, fresh chances: drop any backoff carried
                    // over from establish failures on the previous connection.
                    resetEstablishRetry(record);
                    await tryEstablish(record);
                });
            }
        }

        /**
         * Register a data-change subscription owned by a subscribe-node.
         * @param {string} ownerNodeId
         * @param {string[]} symbols - symbolic paths to subscribe
         * @param {object} opts - { cycleMs, routeMode, creditLimit }
         * @param {(event: object) => void} callback - receives status/data events
         */
        node.subscribe = (ownerNodeId, symbols, opts, callback) =>
            node._subOpQueue.run(ownerNodeId, () => subscribeLocked(ownerNodeId, symbols, opts, callback));

        async function subscribeLocked(ownerNodeId, symbols, opts, callback) {
            const symList = Array.isArray(symbols) ? symbols : [];
            let record = node._subscriptions.get(ownerNodeId);
            if (record) {
                // The fast path must also verify the options: a deploy that
                // only changes the cycle time keeps the symbol list identical,
                // but still requires delete + recreate on the PLC.
                const sameOpts = !opts
                    || (record.cycleMs === opts.cycleMs
                        && record.routeMode === opts.routeMode
                        && record.creditLimit === opts.creditLimit);
                if (record.subscriptionObjectId && node.client.connected
                    && pathsEqual(record.symbols, symList) && sameOpts) {
                    if (callback) record.callback = callback;
                    if (record.callback) {
                        record.callback({
                            type: 'status',
                            state: 'subscribed',
                            itemCount: record.refToName ? record.refToName.size : 0,
                            resolveErrors: record.resolveErrors || {}
                        });
                    }
                    return record;
                }
                if (record.subscriptionObjectId) {
                    node._subsByObjId.delete(record.subscriptionObjectId);
                    if (node.client.connected) {
                        try {
                            await node.client.deleteSubscription(record.subscriptionObjectId);
                        } catch (e) {
                            log('resubscribe delete failed', { id: node.id, msg: e.message });
                        }
                    }
                    // Late notifications of the deleted object may have been
                    // buffered as unmatched while the delete was in flight.
                    // Drop them so they can never be replayed into a new
                    // subscription that reuses this object id.
                    node._pendingNotifications.discard(record.subscriptionObjectId);
                    record.subscriptionObjectId = 0;
                    record.refToName = null;
                }
                record.symbols = symList;
                if (opts) {
                    record.cycleMs = opts.cycleMs;
                    record.routeMode = opts.routeMode;
                    record.creditLimit = opts.creditLimit;
                }
                if (callback) record.callback = callback;
                // New symbols/options invalidate any pending retry backoff.
                resetEstablishRetry(record);
            } else {
                record = {
                    ownerNodeId,
                    symbols: symList,
                    cycleMs: opts && opts.cycleMs,
                    routeMode: opts && opts.routeMode,
                    creditLimit: opts && opts.creditLimit,
                    callback,
                    subscriptionObjectId: 0,
                    refToName: null,
                    resolveErrors: {},
                    lastEstablishError: null,
                    establishRetryCount: 0,
                    nextEstablishRetryAt: 0
                };
                node._subscriptions.set(ownerNodeId, record);
            }
            await tryEstablish(record);
            return record;
        }

        node.unsubscribe = (ownerNodeId) =>
            node._subOpQueue.run(ownerNodeId, () => unsubscribeLocked(ownerNodeId));

        async function unsubscribeLocked(ownerNodeId) {
            const record = node._subscriptions.get(ownerNodeId);
            if (!record) return;
            node._subscriptions.delete(ownerNodeId);
            if (record.subscriptionObjectId) {
                node._subsByObjId.delete(record.subscriptionObjectId);
                if (node.client.connected) {
                    try {
                        await node.client.deleteSubscription(record.subscriptionObjectId);
                    } catch (e) {
                        log('unsubscribe delete failed', { id: node.id, msg: e.message });
                    }
                }
                // Same reasoning as in the resubscribe path: buffered
                // notifications of the deleted object are stale.
                node._pendingNotifications.discard(record.subscriptionObjectId);
                record.subscriptionObjectId = 0;
            }
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
            node._stateListeners.clear();
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
                        return;
                    }
                    // Connection is healthy: give subscriptions that failed to
                    // establish (resolve error, PLC limit) another chance,
                    // honoring their per-record backoff.
                    try {
                        await retryFailedSubscriptions();
                    } catch (e) {
                        log('watchdog: subscription retry failed', { id: node.id, msg: e.message });
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
