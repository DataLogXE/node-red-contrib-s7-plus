'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const BufferStream = require('./buffer-stream');
const S7Transport = require('./transport/s7-transport');
const ItemAddress = require('./item-address');
const {
    ProtocolVersion,
    Opcode,
    Functioncode,
    Ids,
    AccessLevel,
    S7Consts,
    errorText
} = require('./constants');
const { ExploreRequest, ExploreResponse } = require('./pdu-explore');
const { decodeNodeId } = require('./browse/node-id');
const { listBlockRoots, listChildren, resolveLeaf } = require('./browse/lazy');
const { buildFlatSymbolList, collectReferencedRelIds } = require('./browse/flat-browser');
const { normalizeExploreScope, MEMORY_AREAS } = require('./browse/areas');
const { scoped } = require('./debug');
const log = scoped('client');
const {
    InitSslRequest,
    InitSslResponse,
    CreateObjectRequest,
    CreateObjectResponse,
    SetMultiVariablesRequest,
    SetMultiVariablesResponse,
    GetMultiVariablesRequest,
    GetMultiVariablesResponse,
    DeleteObjectRequest,
    GetVarSubstreamedRequest,
    GetVarSubstreamedResponse,
    SetVariableRequest,
    SetVariableResponse
} = require('./pdu-messages');
const pvalue = require('./pvalue');

const REMOTE_TSAP = Buffer.from('SIMATIC-ROOT-HMI', 'ascii');

// Hard upper bound for how long the queue may make a caller wait. If the
// previous user-operation has not released the lock in this time, the
// next caller fails fast. Lock-acquire failure is a per-operation error
// only — the transport is NOT torn down (that would unfairly punish
// legitimate long ops like browseFull on a large PLC).
const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 30000;

// Cap on the type-info cache. Each entry mirrors a TIA struct/UDT
// definition. A full browseFull on a large PLC seeds at most a few
// hundred entries; lazy browse may add more over time but should never
// approach this bound under normal use. If it does, we drop the cache
// (next browseChildren re-fetches), so the cache is bounded memory-wise.
const TYPE_INFO_CACHE_MAX = 5000;

// Hard limit on user operations in flight (running + queued). Protects
// the endpoint from self-DoS when a fast trigger (e.g. inject every
// 2 s) feeds a slow operation (e.g. resolveAndRead on thousands of
// symbols). Without this, _userLockTail grows unbounded and each
// waiter pins a Node-RED msg in memory until it eventually runs.
const MAX_USER_LOCK_INFLIGHT = 16;

/**
 * S7CommPlus client.
 *
 * Concurrency model
 * -----------------
 *
 * Two independent serialization slots:
 *   _userLockTail       — serializes user-facing operations (read, write,
 *                         browse*, ping). Acquire is bounded so a single
 *                         stuck operation cannot freeze the entire client.
 *   _lifecycleLockTail  — serializes connect/disconnect against each
 *                         other. Independent of the user lock so a
 *                         reconnect can always run.
 *
 * Request/response dispatch is sequence-number-based via a Map. Each
 * outgoing request gets a unique seq; the matching response wakes its
 * waiter directly. Unmatched PDUs (late responses, notifications, stale
 * data after reconnect) are logged and dropped — they never pollute the
 * next read.
 *
 * This design has three guarantees:
 *   - No hang can outlive `DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS` per user op.
 *   - No response ever ends up at the wrong waiter.
 *   - Reconnect starts with provably empty dispatcher state.
 */
class S7CommPlusClient extends EventEmitter {
    constructor() {
        super();
        this._transport = new S7Transport();

        // Locks
        this._userLockTail = Promise.resolve();
        this._lifecycleLockTail = Promise.resolve();

        // Sequence-number-based dispatcher.
        // Map<seq, { resolve, reject, timer, label }>
        this._pendingResponses = new Map();

        // Multi-fragment receive aggregation (one logical S7+ PDU may
        // arrive across several TPKT frames).
        this._tempPdu = null;
        this._needMoreData = false;

        // Session / protocol counters
        this._sessionId = 0;
        this._sessionId2 = 0;
        this._sequenceNumber = 0;
        this._integrityId = 0;
        this._integrityIdSet = 0;

        // Configuration
        this._readTimeout = 10000;
        this._tagsPerReadMax = 20;
        this._tagsPerWriteMax = 20;

        // Connection state
        this._connected = false;
        this.lastError = 0;

        // Liveness tracking: lets the endpoint watchdog decide between
        // "lock is busy with a legitimate long op" and "transport is
        // actually stuck" without having to take the user lock itself.
        this._userOpInFlight = null;
        this._userOpStartedAt = 0;
        this._lastResponseAt = Date.now();
        // Counts user ops currently running OR waiting on the user lock.
        this._userLockInflight = 0;

        /** @type {{ dbList: object[], typeInfoCache: Map<number, object> } | null} */
        this._browseState = null;
    }

    // ---------- BROWSE CACHE ----------

    clearBrowseState() {
        this._browseState = null;
    }

    _getBrowseState() {
        if (!this._browseState) {
            this._browseState = { dbList: [], typeInfoCache: new Map() };
        }
        return this._browseState;
    }

    // ---------- LOCKS ----------

    /**
     * Acquire a serialization slot for the lock identified by `lockProp`.
     * Returns the `release` function the caller MUST call exactly once
     * (in finally). If the previous slot does not become free within
     * `acquireTimeoutMs`, the acquire promise rejects AND the slot is
     * auto-released so the next acquire can proceed.
     *
     * The lock-acquire timeout fails ONLY the waiting operation. It does
     * NOT tear down the transport — that is the response timeout's job.
     * Killing the transport here would also kill any legitimate long-
     * running predecessor (large browseFull, big multi-tag read, etc.)
     * just because a watchdog or a sibling op got impatient.
     */
    _acquireLock(lockProp, opLabel, acquireTimeoutMs) {
        return new Promise((resolve, reject) => {
            const prev = this[lockProp];
            let release;
            const myTurn = new Promise(r => { release = r; });
            this[lockProp] = myTurn;

            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                log('lock-acquire timeout', { lock: lockProp, op: opLabel, timeoutMs: acquireTimeoutMs });
                // Release our slot so the queue does not jam permanently.
                release();
                reject(new Error(
                    `Lock-acquire timeout (${opLabel}, ${acquireTimeoutMs}ms) — ` +
                    'previous operation still holds the lock.'
                ));
            }, acquireTimeoutMs);

            const onPrev = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(release);
            };
            prev.then(onPrev, onPrev);
        });
    }

    async _withUserLock(opLabel, fn, acquireTimeoutMs = DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS) {
        // Hard cap to keep callers from piling up faster than ops can
        // drain. Reject before queuing so the rejected caller can shed
        // its msg/closure immediately instead of pinning memory.
        if (this._userLockInflight >= MAX_USER_LOCK_INFLIGHT) {
            throw new Error(
                `Endpoint queue overloaded (${this._userLockInflight} ops in flight) — ` +
                `'${opLabel}' rejected. Reduce request rate.`
            );
        }
        this._userLockInflight++;
        try {
            const release = await this._acquireLock('_userLockTail', opLabel, acquireTimeoutMs);
            this._userOpInFlight = opLabel;
            this._userOpStartedAt = Date.now();
            try {
                return await fn();
            } finally {
                this._userOpInFlight = null;
                this._userOpStartedAt = 0;
                release();
            }
        } finally {
            this._userLockInflight--;
        }
    }

    async _withLifecycleLock(opLabel, fn, acquireTimeoutMs = DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS) {
        const release = await this._acquireLock('_lifecycleLockTail', opLabel, acquireTimeoutMs);
        try {
            return await fn();
        } finally {
            release();
        }
    }

    // ---------- SEQUENCE / INTEGRITY COUNTERS ----------

    _getNextSequenceNumber() {
        if (this._sequenceNumber === 0xffff) this._sequenceNumber = 1;
        else this._sequenceNumber++;
        return this._sequenceNumber;
    }

    _getNextIntegrityId(functionCode) {
        const setFc = [
            Functioncode.SetMultiVariables,
            Functioncode.SetVariable,
            Functioncode.SetVarSubStreamed,
            Functioncode.DeleteObject,
            Functioncode.CreateObject
        ];
        if (setFc.includes(functionCode)) {
            if (this._integrityIdSet === 0xffffffff) this._integrityIdSet = 0;
            else this._integrityIdSet++;
            return this._integrityIdSet;
        }
        if (this._integrityId === 0xffffffff) this._integrityId = 0;
        else this._integrityId++;
        return this._integrityId;
    }

    // ---------- RECEIVE PIPELINE ----------

    /**
     * Reset all transient receive state: drop fragmented-PDU buffer and
     * reject every pending response with `reason`. Safe to call repeatedly.
     */
    _resetReceiveState(reason) {
        this._tempPdu = null;
        this._needMoreData = false;
        if (this._pendingResponses.size) {
            log('rejecting pending responses', { count: this._pendingResponses.size, reason });
            const err = new Error(`${errorText(S7Consts.errTCPNotConnected)} (${reason})`);
            for (const [, w] of this._pendingResponses) {
                clearTimeout(w.timer);
                try { w.reject(err); } catch { /* ignore */ }
            }
            this._pendingResponses.clear();
        }
    }

    /**
     * Reassemble one logical S7+ PDU from the (possibly fragmented)
     * TPKT/COTP frames delivered by the transport. Each call sees one
     * payload buffer. The S7+ header carries its own length, which is
     * used to decide whether the next call continues this PDU or starts
     * a new one (via `_needMoreData`).
     *
     * Once a PDU is complete, it is handed to `_dispatchPdu`.
     */
    _onDataReceived(pdu) {
        // Any inbound frame is proof the transport is alive — record it
        // BEFORE inspecting the contents, so that a slowly-arriving multi-
        // fragment PDU does not look like a dead connection to the
        // watchdog. _dispatchPdu also updates this, but only for the
        // last fragment, which can be tens of seconds after the first.
        this._lastResponseAt = Date.now();
        // _tempPdu collects Buffer chunks (the 1-byte protoVersion plus one
        // payload slice per fragment) and is finalized with Buffer.concat.
        // Spreading bytes through Array.push(...) was O(N) call-stack args
        // per fragment and could overflow the stack on multi-KB browse PDUs.
        if (!this._needMoreData) this._tempPdu = [];
        let pos = 0;
        if (pdu[pos] !== 0x72) {
            log('framing error', { firstByte: pdu[pos] });
            this.lastError = S7Consts.errIsoInvalidPDU;
            this._resetReceiveState('framing-error');
            return;
        }
        pos++;
        const protoVersion = pdu[pos];
        if (!this._needMoreData) this._tempPdu.push(Buffer.from([protoVersion]));
        pos++;
        const s7HeaderDataLen = (pdu[pos] << 8) | pdu[pos + 1];
        pos += 2;
        if (s7HeaderDataLen > 0) {
            if (protoVersion === ProtocolVersion.SystemEvent) {
                this._needMoreData = false;
                this._tempPdu = null;
                return;
            }
            this._tempPdu.push(pdu.subarray(pos, pos + s7HeaderDataLen));
            pos += s7HeaderDataLen;
            if ((pdu.length - 4 - 4) === s7HeaderDataLen) {
                this._needMoreData = false;
                const complete = Buffer.concat(this._tempPdu);
                this._tempPdu = null;
                this._dispatchPdu(complete);
            } else {
                this._needMoreData = true;
            }
        }
    }

    /**
     * Route a fully assembled response PDU to its waiter, matched by
     * sequence number. Unmatched PDUs (notifications, late responses,
     * stale data after reconnect) are logged and dropped instead of
     * being given to the next innocent reader.
     *
     * S7+ response header layout (in `_tempPdu` coordinates):
     *   [0]   protocolVersion
     *   [1]   opcode (Response = 0x32)
     *   [2-3] reserved
     *   [4-5] functionCode  (UInt16, big-endian)
     *   [6-7] reserved
     *   [8-9] sequenceNumber (UInt16, big-endian)
     */
    _dispatchPdu(pdu) {
        // Any inbound PDU (matched, late or notification) is proof that
        // the transport is still alive — record it so the watchdog can
        // distinguish a legitimately busy user lock from a real hang.
        this._lastResponseAt = Date.now();
        const opcode = pdu[1];
        if (opcode !== Opcode.Response) {
            log('non-response PDU dropped', { opcode, bytes: pdu.length });
            return;
        }
        const seq = (pdu[8] << 8) | pdu[9];
        const waiter = this._pendingResponses.get(seq);
        if (!waiter) {
            log('unmatched response dropped (stale/late/notification)', { seq, bytes: pdu.length });
            return;
        }
        this._pendingResponses.delete(seq);
        clearTimeout(waiter.timer);
        log('<- pdu dispatched', () => [{ seq, bytes: pdu.length, label: waiter.label }]);
        waiter.resolve(pdu);
    }

    // ---------- REQUEST / RESPONSE ----------

    _sendS7plusPdu(data, protoVersion) {
        const maxSize = 1024 - 4 - 3 - 5 - 17 - 4 - 4;
        let sourcePos = 0;
        let bytesToSend = data.length;
        while (bytesToSend > 0) {
            const curSize = Math.min(bytesToSend, maxSize);
            bytesToSend -= curSize;
            const packet = Buffer.alloc(4 + curSize + (bytesToSend === 0 ? 4 : 0));
            packet[0] = 0x72;
            packet[1] = protoVersion;
            packet[2] = (curSize >> 8) & 0xff;
            packet[3] = curSize & 0xff;
            data.copy(packet, 4, sourcePos, sourcePos + curSize);
            sourcePos += curSize;
            let sendLen = 4 + curSize;
            if (bytesToSend === 0) {
                packet[sendLen++] = 0x72;
                packet[sendLen++] = protoVersion;
                packet[sendLen++] = 0;
                packet[sendLen++] = 0;
            }
            this._transport.send(packet.subarray(0, sendLen));
        }
        return 0;
    }

    _sendRequest(req) {
        if (this._sessionId === 0) req.sessionId = Ids.ObjectNullServerSession;
        else req.sessionId = this._sessionId;
        req.sequenceNumber = this._getNextSequenceNumber();
        if (req.withIntegrityId) {
            req.integrityId = this._getNextIntegrityId(req.functionCode);
        }
        const body = req.serialize();
        log('-> request', () => [{
            fc: req.functionCode,
            seq: req.sequenceNumber,
            session: req.sessionId,
            integrity: req.integrityId,
            bytes: body.length
        }]);
        this._sendS7plusPdu(body, req.protocolVersion);
        return req.sequenceNumber;
    }

    /**
     * Wait for the response to a specific request, identified by its
     * sequence number. On timeout, tears down the transport — a silent
     * PLC is almost always a dead socket, and waiting longer just hides
     * the real failure.
     */
    _waitForResponse(seq, label, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this._pendingResponses.has(seq)) return;
                this._pendingResponses.delete(seq);
                log('response timeout', { seq, label, timeoutMs });
                this.lastError = S7Consts.errTCPDataReceive;
                reject(new Error(`${errorText(S7Consts.errTCPDataReceive)} (${label}, seq ${seq})`));
                if (this._connected) {
                    this._onTransportClosed({ reason: `response-timeout:${label}` });
                }
            }, timeoutMs);
            this._pendingResponses.set(seq, { resolve, reject, timer, label });
        });
    }

    async _requestResponse(req, deserializeFn, label) {
        const opLabel = label || `fc=0x${req.functionCode.toString(16)}`;
        const seq = this._sendRequest(req);
        const pdu = await this._waitForResponse(seq, opLabel, this._readTimeout);
        const stream = new BufferStream(pdu);
        return deserializeFn(stream);
    }

    // ---------- CONNECT / DISCONNECT (lifecycle lock) ----------

    async connect(address, password = '', username = '', timeoutMs = 10000, port = 102) {
        return this._withLifecycleLock('connect', async () => {
            log('connect start', { address, port, timeoutMs, hadConnection: this._connected });
            if (this._connected) {
                await this._teardownGraceful('reconnect');
            }

            // Hard reset of all transient state so nothing from the
            // previous (possibly broken) session survives.
            this._resetReceiveState('connect');
            this._sessionId = 0;
            this._sessionId2 = 0;
            this._sequenceNumber = 0;
            this._integrityId = 0;
            this._integrityIdSet = 0;
            this._readTimeout = timeoutMs > 0 ? timeoutMs : 10000;
            this.lastError = 0;
            this._browseState = null;
            this._lastResponseAt = Date.now();

            this._transport.removeAllListeners('data');
            this._transport.removeAllListeners('close');
            this._transport.on('data', (p) => this._onDataReceived(p));
            this._transport.on('close', (info) => this._onTransportClosed(info));
            this._transport.setTimeouts(this._readTimeout);
            this._transport.setConnectionParams(address, 0x0600, REMOTE_TSAP, port);

            let res = await this._transport.connect();
            if (res !== 0) {
                log('connect transport failed', { code: res, text: errorText(res) });
                throw new Error(errorText(res));
            }

            this._transport.setStopAfterNextPacket();

            // SSL init exchange uses sequence-based dispatch like any
            // other request — _dispatchPdu doesn't care that _connected
            // is still false; it routes by seq either way.
            const sslReq = new InitSslRequest(ProtocolVersion.V1, 0, 0);
            const sslSeq = this._sendRequest(sslReq);
            const sslPdu = await this._waitForResponse(sslSeq, 'InitSsl', this._readTimeout);
            const sslRes = InitSslResponse.deserializeFromPdu(new BufferStream(sslPdu));
            if (!sslRes) throw new Error(errorText(S7Consts.errIsoInvalidPDU));

            res = await this._transport.sslActivate();
            if (res !== 0) throw new Error(errorText(res));

            const createReq = new CreateObjectRequest(ProtocolVersion.V1, 0, false);
            createReq.setNullServerSessionData();
            const createRes = await this._requestResponse(createReq, CreateObjectResponse.deserializeFromPdu, 'CreateObject');
            if (!createRes || !createRes.objectIds.length) {
                throw new Error(errorText(S7Consts.errIsoInvalidPDU));
            }
            this._sessionId = createRes.objectIds[0];
            this._sessionId2 = createRes.objectIds[1];
            const serverSession = createRes.responseObject.getAttribute(Ids.ServerSessionVersion);

            const setMulti = new SetMultiVariablesRequest(ProtocolVersion.V2);
            setMulti.setSessionSetupData(this._sessionId, serverSession);
            const setMultiRes = await this._requestResponse(setMulti, SetMultiVariablesResponse.deserializeFromPdu, 'SessionSetup');
            if (!setMultiRes) throw new Error(errorText(S7Consts.errIsoInvalidPDU));

            // Mark connected BEFORE _readSystemLimits/_legitimate so the
            // raw read helpers (which guard on _connected) accept calls.
            this._connected = true;
            try {
                await this._readSystemLimits();
                await this._legitimate(serverSession, password, username);
            } catch (e) {
                // Post-setup failure: revert to clean disconnected state.
                this._connected = false;
                this._resetReceiveState('connect-setup-failed');
                try { this._transport.disconnect(); } catch { /* ignore */ }
                throw e;
            }

            log('connect ok', { address, port, sessionId: this._sessionId });
            this.emit('connect');
            return 0;
        });
    }

    async disconnect() {
        return this._withLifecycleLock('disconnect', () => this._teardownGraceful('graceful'));
    }

    /**
     * Graceful teardown: send DeleteObject (if session alive), then close
     * the transport. Used by connect() (for reconnect) and disconnect().
     * Must run inside the lifecycle lock.
     */
    async _teardownGraceful(reason) {
        log('teardown graceful', { reason, connected: this._connected, sessionId: this._sessionId });
        const sock = this._transport && this._transport._socket;
        const socketAlive = !!(sock && !sock.destroyed);
        if (this._sessionId && this._connected && reason === 'graceful' && socketAlive) {
            try {
                const del = new DeleteObjectRequest(ProtocolVersion.V2);
                del.deleteObjectId = this._sessionId;
                del.withIntegrityId = false;
                await this._requestResponse(del, () => ({}), 'DeleteObject');
            } catch (e) {
                log('teardown DeleteObject failed (ignored)', { msg: e.message });
            }
        }
        this._connected = false;
        this._sessionId = 0;
        this._sessionId2 = 0;
        this._browseState = null;
        this._resetReceiveState(reason);
        try { this._transport.disconnect(); } catch { /* ignore */ }
        this.emit('disconnect', { reason });
    }

    /**
     * Forceful teardown: skip DeleteObject (socket is presumed dead).
     * Safe to call from anywhere — does NOT take the lifecycle lock,
     * because recovery paths may run while connect() holds it.
     */
    forceDisconnect(reason = 'force') {
        log('forceDisconnect', { reason, connected: this._connected, sessionId: this._sessionId });
        const wasConnected = this._connected;
        this._connected = false;
        this._sessionId = 0;
        this._sessionId2 = 0;
        this._browseState = null;
        this.lastError = S7Consts.errTCPNotConnected;
        this._resetReceiveState(reason);
        try { this._transport.disconnect(); } catch { /* ignore */ }
        if (wasConnected) {
            try { this.emit('disconnect', { reason }); } catch { /* ignore */ }
        }
    }

    /**
     * Called when the transport's underlying socket emits close/end/error
     * or when a response timeout fires (almost certainly a dead socket).
     * Marks the client as disconnected, rejects every pending response
     * and emits 'disconnect' so the endpoint can schedule a reconnect.
     */
    _onTransportClosed(info) {
        const reason = info && info.reason ? info.reason : 'socket-close';
        if (!this._connected) {
            // Still purge stale state — a response that arrives after
            // we've already disconnected must not pollute the next read.
            this._resetReceiveState(reason);
            return;
        }
        log('transport closed', { reason, sessionId: this._sessionId, pendingCount: this._pendingResponses.size });
        this._connected = false;
        this._sessionId = 0;
        this._sessionId2 = 0;
        this._browseState = null;
        this.lastError = S7Consts.errTCPNotConnected;
        this._resetReceiveState(reason);
        try { this._transport.disconnect(); } catch { /* ignore */ }
        try { this.emit('disconnect', { reason }); } catch { /* ignore */ }
    }

    // ---------- USER OPERATIONS (user lock) ----------

    async _readSystemLimits() {
        // Runs inside connect()'s lifecycle lock, after _connected = true.
        const readlist = [
            new ItemAddress(Ids.ObjectRoot, Ids.SystemLimits),
            new ItemAddress(Ids.ObjectRoot, Ids.SystemLimits),
            new ItemAddress(Ids.ObjectRoot, Ids.SystemLimits),
            new ItemAddress(Ids.ObjectRoot, Ids.SystemLimits)
        ];
        readlist[0].lid.push(1000);
        readlist[1].lid.push(1001);
        readlist[2].lid.push(0);
        readlist[3].lid.push(1);
        const { values } = await this._readValuesRaw(readlist);
        if (values[0] != null) this._tagsPerReadMax = pvalueToNumber(values[0]) || 20;
        if (values[1] != null) this._tagsPerWriteMax = pvalueToNumber(values[1]) || 20;
    }

    async _legitimate(serverSession, password, username) {
        const paom = serverSession.getStructElement(Ids.LID_SessionVersionSystemPAOMString);
        const paomStr = paom ? paom.toJs() : '';
        const re = /^.*;.*[17]\s?([52]\d\d).+;[VS](\d\.\d)$/;
        const m = paomStr.match ? String(paomStr).match(re) : null;
        if (!m) {
            if (password) throw new Error(errorText(S7Consts.errCliFirmwareNotSupported));
            return;
        }

        const getProt = new GetVarSubstreamedRequest(ProtocolVersion.V2);
        getProt.inObjectId = this._sessionId;
        getProt.address = Ids.EffectiveProtectionLevel;
        const protRes = await this._requestResponse(getProt, GetVarSubstreamedResponse.deserializeFromPdu, 'GetProtection');
        if (!protRes || !protRes.value) throw new Error(errorText(S7Consts.errIsoInvalidPDU));
        const accessLevel = pvalueToNumber(protRes.value);
        if (accessLevel > AccessLevel.FullAccess && password) {
            await this._legitimateLegacy(password);
        } else if (accessLevel > AccessLevel.FullAccess && !password) {
            throw new Error(errorText(S7Consts.errCliNeedPassword));
        }
    }

    async _legitimateLegacy(password) {
        const getCh = new GetVarSubstreamedRequest(ProtocolVersion.V2);
        getCh.inObjectId = this._sessionId;
        getCh.address = Ids.ServerSessionRequest;
        const chRes = await this._requestResponse(getCh, GetVarSubstreamedResponse.deserializeFromPdu, 'GetChallenge');
        const challenge = chRes.value.toJs();
        if (!Array.isArray(challenge) || challenge.length === 0) {
            throw new Error(errorText(S7Consts.errIsoInvalidPDU));
        }
        let response = crypto.createHash('sha1').update(password, 'utf8').digest();
        if (response.length !== challenge.length) {
            throw new Error(errorText(S7Consts.errIsoInvalidPDU));
        }
        response = Buffer.from(response.map((b, i) => b ^ challenge[i]));
        const setReq = new SetVariableRequest(ProtocolVersion.V2);
        setReq.inObjectId = this._sessionId;
        setReq.address = Ids.ServerSessionResponse;
        setReq.value = new pvalue.ValueUSIntArray([...response]);
        const setRes = await this._requestResponse(setReq, SetVariableResponse.deserializeFromPdu, 'SetSessionResponse');
        if (!setRes || Number(setRes.returnValue) < 0) {
            throw new Error(errorText(S7Consts.errCliAccessDenied));
        }
    }

    /**
     * Low-level read — does NOT take the user lock. Used by callers that
     * are already inside a lock (connect, browseRoots, ping, public
     * readValues).
     */
    async _readValuesRaw(addressList) {
        if (!this._connected) throw new Error(errorText(S7Consts.errTCPNotConnected));
        const values = addressList.map(() => null);
        const errors = addressList.map(() => BigInt('18446744073709551615'));
        let chunkStart = 0;
        while (chunkStart < addressList.length) {
            const req = new GetMultiVariablesRequest(ProtocolVersion.V2);
            let count = 0;
            while (count < this._tagsPerReadMax && chunkStart + count < addressList.length) {
                req.addressList.push(addressList[chunkStart + count]);
                count++;
            }
            const res = await this._requestResponse(req, GetMultiVariablesResponse.deserializeFromPdu, 'GetMultiVars');
            if (!res) throw new Error(errorText(S7Consts.errIsoInvalidPDU));
            for (const [key, val] of res.values) {
                const idx = chunkStart + Number(key) - 1;
                values[idx] = val;
                errors[idx] = 0n;
            }
            for (const [key, err] of res.errorValues) {
                errors[chunkStart + Number(key) - 1] = err;
            }
            chunkStart += count;
            // Yield to the event loop after every chunk. setImmediate is not
            // a delay — it just lets pending I/O, TLS encryption, watchdog
            // pings and other timers run between back-to-back GetMultiVariables
            // requests. Without this yield, a chain of awaits resolves on the
            // microtask queue without ever returning to the event loop, so
            // TLS write buffers and PLC inbox both see a tight ~250 frames/s
            // burst — which some S7+ PLCs answer with a TCP RST after 14-30s.
            if (chunkStart < addressList.length) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }
        return { values, errors };
    }

    async readValues(addressList) {
        // Pacing for very large reads: split into batches of MAX_TAGS_PER_LOCK
        // tags so that the user lock is released between batches. This lets
        // the watchdog ping run, gives other nodes a chance, and breaks up
        // sustained PDU bursts that some PLCs answer with TCP RST.
        const MAX_TAGS_PER_LOCK = 500;
        if (addressList.length <= MAX_TAGS_PER_LOCK) {
            return this._withUserLock('readValues', () => this._readValuesRaw(addressList));
        }
        const allValues = new Array(addressList.length);
        const allErrors = new Array(addressList.length);
        for (let offset = 0; offset < addressList.length; offset += MAX_TAGS_PER_LOCK) {
            const slice = addressList.slice(offset, offset + MAX_TAGS_PER_LOCK);
            const { values, errors } = await this._withUserLock(
                'readValues',
                () => this._readValuesRaw(slice)
            );
            for (let i = 0; i < slice.length; i++) {
                allValues[offset + i] = values[i];
                allErrors[offset + i] = errors[i];
            }
        }
        return { values: allValues, errors: allErrors };
    }

    async writeValues(addressList, writeValues) {
        return this._withUserLock('writeValues', async () => {
            if (!this._connected) throw new Error(errorText(S7Consts.errTCPNotConnected));
            // Per-item write status. Initialised to 0n (success); the PLC
            // only reports the items it REJECTED, via a 1-based item
            // number -> error code map in res.errorValues (bad address,
            // CRC mismatch 0x8009890012cbffef, access denied, ...). Items
            // absent from that map were written successfully. This is the
            // exact same per-item contract as _readValuesRaw.
            const errors = addressList.map(() => 0n);
            let chunkStart = 0;
            while (chunkStart < addressList.length) {
                const req = new SetMultiVariablesRequest(ProtocolVersion.V2);
                req.inObjectId = 0;
                let count = 0;
                while (count < this._tagsPerWriteMax && chunkStart + count < addressList.length) {
                    req.addressListVar.push(addressList[chunkStart + count]);
                    req.valueList.push(writeValues[chunkStart + count]);
                    count++;
                }
                const res = await this._requestResponse(req, SetMultiVariablesResponse.deserializeFromPdu, 'SetMultiVars');
                if (!res) throw new Error(errorText(S7Consts.errIsoInvalidPDU));
                // The global res.returnValue is intentionally NOT used as
                // an error gate: a successful SetMultiVariables response
                // also carries a non-zero returnValue (same as a
                // successful GetMultiVariables), so treating it as an
                // error would fail every healthy write. errorValues is
                // the authoritative per-item source.
                if (res.errorValues) {
                    for (const [key, err] of res.errorValues) {
                        errors[chunkStart + Number(key) - 1] = err;
                    }
                }
                chunkStart += count;
                // Yield to the event loop between chunks for the same
                // reasons as _readValuesRaw (let TLS, watchdog and other
                // timers run; avoid a tight PDU burst).
                if (chunkStart < addressList.length) {
                    await new Promise(resolve => setImmediate(resolve));
                }
            }
            return { errors };
        });
    }

    async browseRoots() {
        return this._withUserLock('browseRoots', async () => {
            log('browseRoots', { connected: this._connected });
            if (!this._connected) throw new Error(errorText(S7Consts.errTCPNotConnected));
            const state = this._getBrowseState();
            state.dbList = await this._fetchDbListFromPlc();
            log('browseRoots done', { dbCount: state.dbList.length });
            return { nodes: listBlockRoots(state.dbList) };
        });
    }

    /**
     * Return cached roots without clearing browse state. Only fetches
     * from the PLC when the cache is empty or older than maxAgeMs.
     * Used by batch symbolic resolution to avoid redundant PLC requests.
     */
    async browseRootsCached(maxAgeMs = 300000) {
        return this._withUserLock('browseRootsCached', async () => {
            log('browseRootsCached', { connected: this._connected });
            if (!this._connected) throw new Error(errorText(S7Consts.errTCPNotConnected));
            const state = this._getBrowseState();
            if (state.dbList.length > 0 && state._rootsFetchedAt
                && (Date.now() - state._rootsFetchedAt) < maxAgeMs) {
                log('browseRootsCached hit', { dbCount: state.dbList.length });
                return { nodes: listBlockRoots(state.dbList) };
            }
            state.dbList = await this._fetchDbListFromPlc();
            state._rootsFetchedAt = Date.now();
            log('browseRootsCached fetched', { dbCount: state.dbList.length });
            return { nodes: listBlockRoots(state.dbList) };
        });
    }

    async browseChildren(nodeId) {
        return this._withUserLock('browseChildren', async () => {
            log('browseChildren', { nodeId, connected: this._connected });
            if (!this._connected) throw new Error(errorText(S7Consts.errTCPNotConnected));
            const desc = decodeNodeId(nodeId);
            if (desc.t === 'block' || desc.t === 'struct') {
                await this._ensureTypeInfoLoaded(desc.tiRelId);
            }
            const state = this._getBrowseState();
            const result = { nodes: listChildren(desc, state.typeInfoCache) };
            log('browseChildren done', { nodeId, type: desc.t, count: result.nodes.length });
            return result;
        });
    }

    async browseResolve(nodeId) {
        return this._withUserLock('browseResolve', async () => {
            log('browseResolve', { nodeId, connected: this._connected });
            if (!this._connected) throw new Error(errorText(S7Consts.errTCPNotConnected));
            const desc = decodeNodeId(nodeId);
            return resolveLeaf(desc);
        });
    }

    /**
     * Resolve a symbolic PLC path (e.g. "DB1.readings[0]") to
     * { name, address, datatype, crcMeta } by walking the browse tree.
     * Handles arrays with index notation and quoted DB names.
     */
    async browseResolveSymbolic(symbolPath) {
        if (!this._connected) throw new Error(errorText(S7Consts.errTCPNotConnected));
        const { resolveSymbolicPath } = require('./browse/resolve-symbolic');
        return resolveSymbolicPath(this, symbolPath);
    }

    /**
     * Batch-resolve multiple symbolic PLC paths in one pass, sharing a
     * single browseRootsCached() call and the accumulated type-info
     * cache. Each symbol is resolved independently; failures produce
     * { error } entries instead of throwing.
     * @param {string[]} symbolPaths
     * @returns {Promise<Array<{name, address, datatype, crcMeta} | {error: string}>>}
     */
    async browseResolveSymbolicBatch(symbolPaths) {
        if (!this._connected) throw new Error(errorText(S7Consts.errTCPNotConnected));
        const { resolveSymbolicBatch } = require('./browse/resolve-symbolic');
        return resolveSymbolicBatch(this, symbolPaths);
    }

    /**
     * Full symbol browse (C# Browse): PLC program Explore, LID=1 reads, type-info
     * container Explore, then flat symbol list. Seeds browse cache for lazy browse.
     * @param {object} [options]
     * @param {number} [options.maxSymbols] - cap flat symbol count; partial result when exceeded
     * @returns {Promise<{ symbols: object[], meta: object }>}
     */
    async browseFull(options = {}) {
        return this._withUserLock('browseFull', async () => {
            log('browseFull', { connected: this._connected });
            if (!this._connected) throw new Error(errorText(S7Consts.errTCPNotConnected));
            const scope = normalizeExploreScope(options.scope);
            const maxSymbols = Number(options.maxSymbols);
            const flatOptions = Number.isFinite(maxSymbols) && maxSymbols > 0
                ? { maxSymbols: Math.floor(maxSymbols), scope }
                : { scope };
            const t0 = Date.now();
            const exploreRes1 = await this._explorePlcProgramRequest();
            let exploreData = this._parseDbListFromPlcExplore(exploreRes1);
            if (!scope.everything) {
                const dbSet = new Set(scope.dbs);
                exploreData = exploreData.filter(d => dbSet.has(d.db_name));
            }
            exploreData = await this._readTiRelIdsForDbs(exploreData);

            // Type-info acquisition. A full browse downloads the entire PLC
            // type catalog (OMSTypeInfoContainer) once. A scoped browse must
            // NOT pay that cost: it fetches only the type subtrees referenced
            // by the scoped DBs (+ selected memory areas) via transitive relId
            // resolution — orders of magnitude less data on large PLCs.
            let typeInfoObjects;
            if (scope.everything) {
                const { containerChildren, allObjects } = await this._fetchTypeInfoContainerChildren();
                this._seedBrowseStateFromFullBrowse(exploreData, containerChildren, allObjects);
                typeInfoObjects = containerChildren;
            } else {
                const rootTiRelIds = [];
                for (const d of exploreData) {
                    if (d.db_block_ti_relid) rootTiRelIds.push(d.db_block_ti_relid);
                }
                for (const area of MEMORY_AREAS) {
                    if (scope.areas.includes(area.name)) rootTiRelIds.push(area.tiRelId);
                }
                typeInfoObjects = await this._fetchTypeInfoForRoots(rootTiRelIds);
                this._seedBrowseStateFromScopedBrowse(exploreData, typeInfoObjects);
            }
            const flat = buildFlatSymbolList(exploreData, typeInfoObjects, flatOptions);
            const meta = {
                dbCount: exploreData.length,
                symbolCount: flat.symbols.length,
                durationMs: Date.now() - t0,
                limitExceeded: !!flat.limitExceeded,
                maxSymbols: flat.maxSymbols ?? null,
                scope
            };
            if (flat.limitExceeded && flat.maxSymbols != null) {
                meta.limitMessage = `Symbol limit exceeded (${flat.symbols.length} exported, max ${flat.maxSymbols})`;
            }
            log('browseFull done', meta);
            return { symbols: flat.symbols, meta };
        });
    }

    /**
     * Single Explore on NativeObjects_thePLCProgram_Rid (browse step 1 only).
     * Does not read LID=1 or mutate browse state.
     * @returns {Promise<{protocolVersion: number, sequenceNumber: number, objects: object[]}>}
     */
    async explorePlcProgram() {
        return this._withUserLock('explorePlcProgram', async () => {
            log('explorePlcProgram', { connected: this._connected });
            if (!this._connected) throw new Error(errorText(S7Consts.errTCPNotConnected));
            const res = await this._explorePlcProgramRequest();
            log('explorePlcProgram done', { objectCount: (res.objects || []).length });
            return res;
        });
    }

    async _explorePlcProgramRequest() {
        const exploreReq = new ExploreRequest(ProtocolVersion.V2);
        exploreReq.exploreId = Ids.NativeObjects_thePLCProgram_Rid;
        exploreReq.exploreRequestId = Ids.None;
        exploreReq.exploreChildsRecursive = 1;
        exploreReq.exploreParents = 0;
        // DB number comes from relationId; comment is unused in browse — name only.
        exploreReq.addressList.push(Ids.ObjectVariableTypeName);

        const exploreRes = await this._requestResponse(
            exploreReq,
            (pdu) => ExploreResponse.deserializeFromPdu(pdu, true),
            'Explore-PLCProgram'
        );
        if (!exploreRes) throw new Error(errorText(S7Consts.errIsoInvalidPDU));
        return exploreRes;
    }

    _parseDbListFromPlcExplore(exploreRes1) {
        const plcProg = exploreRes1.objects.find(o => o.classId === Ids.PLCProgram_Class_Rid);
        if (!plcProg) throw new Error(errorText(S7Consts.errCliAccessDenied));

        const exploreData = [];
        for (const ob of plcProg.getObjects()) {
            if (ob.classId !== Ids.DB_Class_Rid) continue;
            const relid = ob.relationId;
            const area = relid >>> 16;
            const num = relid & 0xffff;
            if (area !== 0x8a0e) continue;
            const nameAttr = ob.getAttribute(Ids.ObjectVariableTypeName);
            const dbName = nameAttr ? String(nameAttr.toJs()) : `DB${num}`;
            exploreData.push({
                db_block_relid: relid,
                db_name: dbName,
                db_number: num,
                db_block_ti_relid: 0
            });
        }
        return exploreData;
    }

    async _readTiRelIdsForDbs(exploreData) {
        const readlist = [];
        const indices = [];
        for (let i = 0; i < exploreData.length; i++) {
            const data = exploreData[i];
            if (data.db_number > 0) {
                const adr = new ItemAddress();
                adr.accessArea = data.db_block_relid;
                adr.accessSubArea = Ids.DB_ValueActual;
                adr.lid.push(1);
                readlist.push(adr);
                indices.push(i);
            }
        }

        if (readlist.length) {
            const { values, errors } = await this._readValuesRaw(readlist);
            for (let j = 0; j < indices.length; j++) {
                const i = indices[j];
                if (errors[j] === 0n && values[j]) {
                    exploreData[i].db_block_ti_relid = Number(values[j].toJs());
                } else {
                    exploreData[i].db_block_ti_relid = 0;
                }
            }
        }

        return exploreData.filter(d => d.db_block_ti_relid !== 0);
    }

    async _fetchTypeInfoContainerChildren() {
        const objects = await this._exploreTypeInfoRequest(Ids.ObjectOMSTypeInfoContainer, 1);
        const tiContainer = objects.find(o => o.classId === Ids.ClassOMSTypeInfoContainer);
        const containerChildren = (tiContainer && typeof tiContainer.getObjects === 'function')
            ? tiContainer.getObjects()
            : objects.filter(o => o.vartypeList);
        return { containerChildren, allObjects: objects };
    }

    /**
     * Scoped counterpart to _fetchTypeInfoContainerChildren: instead of
     * downloading the whole OMSTypeInfoContainer, fetch only the type
     * objects reachable from the given root type relIds (scoped DB type
     * relIds + selected memory-area type relIds).
     *
     * A single Explore on a type relId returns only that type's own
     * vartypeList, not the types it references. We therefore walk the
     * reference graph breadth-first: fetch a type, enqueue the relIds it
     * references (collectReferencedRelIds), repeat until closure. The
     * returned flat object list has the same shape buildFlatSymbolList
     * expects for its typeInfoObjects argument (findObjectByRelId lookups).
     *
     * @param {number[]} rootTiRelIds
     * @returns {Promise<object[]>} all reachable type objects (deduped by relationId)
     */
    async _fetchTypeInfoForRoots(rootTiRelIds) {
        const accumulator = [];
        const collected = new Set(); // relationIds already in accumulator
        const requested = new Set();  // relIds already explored (cycle guard)
        const queue = [];
        for (const r of rootTiRelIds) {
            const id = r >>> 0;
            if (id && !requested.has(id)) { requested.add(id); queue.push(id); }
        }

        let roundTrips = 0;
        while (queue.length) {
            const relId = queue.shift();
            const objects = await this._exploreTypeInfoRequest(relId, 1);
            roundTrips++;
            // Walk the returned object tree: collect every type object and
            // enqueue any newly referenced type relIds.
            const stack = [...objects];
            while (stack.length) {
                const ob = stack.pop();
                if (!ob) continue;
                if (ob.relationId && !collected.has(ob.relationId)) {
                    collected.add(ob.relationId);
                    accumulator.push(ob);
                }
                if (ob.vartypeList) {
                    for (const refId of collectReferencedRelIds(ob)) {
                        const id = refId >>> 0;
                        if (id && !requested.has(id)) { requested.add(id); queue.push(id); }
                    }
                }
                if (typeof ob.getObjects === 'function') {
                    for (const child of ob.getObjects()) stack.push(child);
                }
            }
        }

        log('typeInfoForRoots done', { roots: rootTiRelIds.length, roundTrips, objects: accumulator.length });
        return accumulator;
    }

    /**
     * Seed browse cache after a scoped browse. Mirrors
     * _seedBrowseStateFromFullBrowse but uses the scoped type-object list
     * (already the transitive closure) instead of the full container.
     */
    _seedBrowseStateFromScopedBrowse(dbList, typeInfoObjects) {
        const state = this._getBrowseState();
        state.dbList = dbList;
        state._rootsFetchedAt = Date.now();
        state.typeInfoCache.clear();
        for (const ob of typeInfoObjects) {
            if (ob.relationId) state.typeInfoCache.set(ob.relationId, ob);
        }
    }

    _seedBrowseStateFromFullBrowse(dbList, containerChildren, allObjects) {
        const state = this._getBrowseState();
        state.dbList = dbList;
        state._rootsFetchedAt = Date.now();
        // Each browseFull replaces the type-info cache wholesale —
        // otherwise it would only ever grow as PLC programs change.
        state.typeInfoCache.clear();
        this._cacheTypeInfoObjects(allObjects);
        for (const child of containerChildren) {
            if (child.relationId) state.typeInfoCache.set(child.relationId, child);
        }
    }

    async _fetchDbListFromPlc() {
        const exploreRes1 = await this._explorePlcProgramRequest();
        let exploreData = this._parseDbListFromPlcExplore(exploreRes1);
        return this._readTiRelIdsForDbs(exploreData);
    }

    async _ensureTypeInfoLoaded(tiRelId, forceFullContainer = false) {
        const state = this._getBrowseState();
        if (!forceFullContainer && tiRelId && state.typeInfoCache.has(tiRelId)) {
            const cached = state.typeInfoCache.get(tiRelId);
            if (cached && cached.vartypeList) return cached;
        }

        if (forceFullContainer) {
            const objects = await this._exploreTypeInfoRequest(Ids.ObjectOMSTypeInfoContainer, 1);
            this._cacheTypeInfoObjects(objects);
            const tiContainer = objects.find(o => o.classId === Ids.ClassOMSTypeInfoContainer)
                || [...state.typeInfoCache.values()].find(o => o.classId === Ids.ClassOMSTypeInfoContainer);
            if (tiContainer && typeof tiContainer.getObjects === 'function') {
                for (const child of tiContainer.getObjects()) {
                    if (child.relationId) state.typeInfoCache.set(child.relationId, child);
                }
            }
            return null;
        }

        const exploreId = tiRelId || Ids.ObjectOMSTypeInfoContainer;
        const objects = await this._exploreTypeInfoRequest(exploreId, 1);
        this._cacheTypeInfoObjects(objects);

        let typeOb = state.typeInfoCache.get(tiRelId) || null;
        if (!typeOb || !typeOb.vartypeList) {
            typeOb = objects.find(o => o.relationId === tiRelId)
                || objects.find(o => o.vartypeList)
                || null;
            if (typeOb && typeOb.relationId) state.typeInfoCache.set(typeOb.relationId, typeOb);
            if (typeOb && tiRelId && !state.typeInfoCache.has(tiRelId)) {
                state.typeInfoCache.set(tiRelId, typeOb);
            }
        }
        return typeOb;
    }

    async _exploreTypeInfoRequest(exploreId, recursive) {
        const exploreReq = new ExploreRequest(ProtocolVersion.V2);
        exploreReq.exploreId = exploreId >>> 0;
        exploreReq.exploreRequestId = Ids.None;
        exploreReq.exploreChildsRecursive = recursive ? 1 : 0;
        exploreReq.exploreParents = 0;

        const exploreRes = await this._requestResponse(
            exploreReq,
            (pdu) => ExploreResponse.deserializeFromPdu(pdu, true),
            'Explore-TypeInfo'
        );
        if (!exploreRes) throw new Error(errorText(S7Consts.errIsoInvalidPDU));
        return exploreRes.objects || [];
    }

    _cacheTypeInfoObjects(objects) {
        const state = this._getBrowseState();
        const walk = (list) => {
            if (!list) return;
            for (const ob of list) {
                if (ob.relationId) state.typeInfoCache.set(ob.relationId, ob);
                if (typeof ob.getObjects === 'function') walk(ob.getObjects());
            }
        };
        walk(objects);
        // If lazy-browse over a long-lived endpoint inflates the cache
        // beyond the bound, drop everything; lazy-browse will re-seed
        // on demand. This is preferable to per-entry LRU because the
        // cache is rarely the hot path and keeping it small wins.
        if (state.typeInfoCache.size > TYPE_INFO_CACHE_MAX) {
            log('typeInfoCache exceeded cap, clearing', { size: state.typeInfoCache.size, cap: TYPE_INFO_CACHE_MAX });
            state.typeInfoCache.clear();
        }
    }

    /**
     * Watchdog ping. Short acquire timeout (2s) so the watchdog can
     * detect a stuck user op instead of queueing behind it. If we
     * cannot grab the lock in 2s, the lock-acquire-timeout path tears
     * the transport down and the endpoint reconnects.
     */
    async ping(timeoutMs = 2000) {
        return this._withUserLock('ping', async () => {
            if (!this._connected) throw new Error('not connected');
            const saved = this._readTimeout;
            this._readTimeout = timeoutMs;
            try {
                const addr = new ItemAddress(Ids.ObjectRoot, Ids.SystemLimits);
                addr.lid.push(0);
                await this._readValuesRaw([addr]);
            } finally {
                this._readTimeout = saved;
            }
        }, /* acquireTimeoutMs */ 2000);
    }

    get connected() {
        return this._connected;
    }

    get socketAlive() {
        return this._connected && this._transport.connected;
    }

    /** True iff a user operation currently holds the user lock. */
    get userLockBusy() {
        return this._userOpInFlight !== null;
    }

    /** Timestamp (ms since epoch) of the last inbound PDU. */
    get lastResponseAt() {
        return this._lastResponseAt;
    }

    /** Label of the in-flight user op (or null). For diagnostics. */
    get userOpInFlight() {
        return this._userOpInFlight;
    }
}

function pvalueToNumber(v) {
    if (!v) return null;
    const j = v.toJs();
    if (typeof j === 'number') return j;
    if (typeof j === 'bigint') return Number(j);
    return null;
}

module.exports = { S7CommPlusClient, ItemAddress };
