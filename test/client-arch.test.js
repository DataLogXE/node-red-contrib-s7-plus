'use strict';

/**
 * Behavior tests for the S7CommPlusClient architecture refactor.
 *
 * These verify the guarantees that distinguish the new design from the
 * previous FIFO/Promise-chain implementation:
 *   - Lock acquire has a hard upper bound (no permanent hang).
 *   - PDU dispatch is sequence-number based (no FIFO assumption).
 *   - Late / unknown / notification PDUs are dropped, not handed to
 *     the next innocent waiter.
 *   - Transport close rejects all pending responses cleanly.
 *   - Lock-acquire-timeout fails ONLY the waiting op — it never tears
 *     the transport down (that would punish legitimate long ops).
 *   - Liveness: client tracks userLockBusy + lastResponseAt so the
 *     endpoint watchdog can skip pings when traffic is flowing.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { S7CommPlusClient } = require('../lib/s7plus/client');
const { Opcode } = require('../lib/s7plus/constants');

/**
 * Build a minimal but valid S7+ response PDU buffer matching the format
 * that `_dispatchPdu` expects after `_onDataReceived` has reassembled it.
 *
 * Layout (in _tempPdu coordinates):
 *   [0]   protoVersion
 *   [1]   opcode (Response = 0x32)
 *   [2-3] reserved
 *   [4-5] functionCode
 *   [6-7] reserved
 *   [8-9] sequenceNumber (UInt16 big-endian)
 *   [10+] payload (optional)
 */
function makeResponsePdu(seq, opcode = Opcode.Response, extra = []) {
    return Buffer.from([
        0x02,                            // protoVersion
        opcode,                          // opcode
        0, 0,                            // reserved
        0, 0,                            // functionCode
        0, 0,                            // reserved
        (seq >> 8) & 0xff, seq & 0xff,   // sequenceNumber
        ...extra
    ]);
}

describe('S7CommPlusClient: lock', () => {
    it('serializes user operations one at a time', async () => {
        const client = new S7CommPlusClient();
        const order = [];
        const p1 = client._withUserLock('op1', async () => {
            order.push('start1');
            await new Promise(r => setTimeout(r, 20));
            order.push('end1');
            return 1;
        });
        const p2 = client._withUserLock('op2', async () => {
            order.push('start2');
            return 2;
        });
        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1, 1);
        assert.equal(r2, 2);
        assert.deepEqual(order, ['start1', 'end1', 'start2']);
    });

    it('lock-acquire timeout fires when the predecessor hangs', async () => {
        const client = new S7CommPlusClient();

        // First op never releases (simulates a hung operation).
        const stuck = client._withUserLock('stuck', () => new Promise(() => { /* never */ }));

        // Second op gets a 50ms acquire window.
        const t0 = Date.now();
        await assert.rejects(
            client._withUserLock('next', async () => 'ok', 50),
            /Lock-acquire timeout \(next, 50ms\)/
        );
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 200, `acquire timeout must fire near 50ms, got ${elapsed}ms`);

        // The stuck operation stays pending — we don't await it.
        void stuck;
    });

    it('lock-acquire timeout does NOT tear the transport down', async () => {
        // A legitimate long-running predecessor (e.g. browseFull on a
        // big PLC) must not be killed just because a sibling op got
        // impatient. The transport stays up; only the waiting op fails.
        const client = new S7CommPlusClient();
        client._connected = true;
        client._sessionId = 42;
        let disconnectEmitted = false;
        client.on('disconnect', () => { disconnectEmitted = true; });
        let disconnectCalls = 0;
        client._transport.disconnect = () => { disconnectCalls++; return 0; };

        const stuck = client._withUserLock('stuck', () => new Promise(() => { /* never */ }));

        await assert.rejects(
            client._withUserLock('next', async () => 'ok', 30),
            /Lock-acquire timeout/
        );

        assert.equal(client._connected, true, 'transport must stay up on lock-timeout');
        assert.equal(disconnectEmitted, false, "lock-timeout must NOT emit 'disconnect'");
        assert.equal(disconnectCalls, 0, 'transport.disconnect must not be called on lock-timeout');

        void stuck;
    });

    it('lock-acquire timeout releases the slot so subsequent acquires proceed', async () => {
        const client = new S7CommPlusClient();
        client._transport.disconnect = () => 0;

        const stuck = client._withUserLock('stuck', () => new Promise(() => { /* never */ }));

        // First next-op gets timed out by the stuck holder.
        await assert.rejects(
            client._withUserLock('next1', async () => 'ok', 20),
            /Lock-acquire timeout/
        );

        // Subsequent acquire must succeed almost immediately — the stuck
        // op's slot was auto-released, then 'next1' acquired and released.
        const t0 = Date.now();
        const r = await client._withUserLock('next2', async () => 'second');
        const elapsed = Date.now() - t0;
        assert.equal(r, 'second');
        assert.ok(elapsed < 100, `next acquire after auto-release should be instant, got ${elapsed}ms`);

        void stuck;
    });

    it('rejects new user ops when in-flight count exceeds MAX_USER_LOCK_INFLIGHT', async () => {
        // Direct counter simulation keeps the test free of dangling
        // never-resolving promises that would prevent node:test from
        // shutting the suite down. The behaviour we care about is the
        // immediate reject, not the queuing mechanics (those are covered
        // by the other lock tests).
        const client = new S7CommPlusClient();
        client._userLockInflight = 16;

        const t0 = Date.now();
        await assert.rejects(
            client._withUserLock('overflow', async () => 'never runs'),
            /Endpoint queue overloaded.*overflow.*rejected/
        );
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 50, `overload reject must be immediate, got ${elapsed}ms`);

        // After reject, in-flight count must NOT have grown past the cap.
        assert.equal(client._userLockInflight, 16, 'inflight count stays at cap after reject');
    });

    it('decrements in-flight count after normal user op completes', async () => {
        const client = new S7CommPlusClient();
        assert.equal(client._userLockInflight, 0);

        const result = await client._withUserLock('op', async () => 'done');
        assert.equal(result, 'done');
        assert.equal(client._userLockInflight, 0,
            'counter must drop back to 0 after the op finishes');
    });

    it('decrements in-flight count after a thrown user op', async () => {
        const client = new S7CommPlusClient();
        await assert.rejects(
            client._withUserLock('op', async () => { throw new Error('boom'); }),
            /boom/
        );
        assert.equal(client._userLockInflight, 0,
            'counter must drop back to 0 even if the op threw');
    });

    it('user lock and lifecycle lock are independent', async () => {
        const client = new S7CommPlusClient();
        const events = [];

        const userOp = client._withUserLock('user', async () => {
            events.push('user-start');
            await new Promise(r => setTimeout(r, 30));
            events.push('user-end');
        });
        // Lifecycle op must NOT wait for user op.
        const lifecycleOp = client._withLifecycleLock('lifecycle', async () => {
            events.push('lifecycle-start');
            events.push('lifecycle-end');
        });

        await Promise.all([userOp, lifecycleOp]);
        // Lifecycle should have completed before user-end.
        const userEndIdx = events.indexOf('user-end');
        const lifecycleEndIdx = events.indexOf('lifecycle-end');
        assert.ok(lifecycleEndIdx < userEndIdx, 'lifecycle lock must NOT block on user lock');
    });
});

describe('S7CommPlusClient: dispatcher', () => {
    it('routes response to the waiter with matching sequence number', async () => {
        const client = new S7CommPlusClient();
        const waiter1 = client._waitForResponse(11, 'op1', 1000);
        const waiter2 = client._waitForResponse(22, 'op2', 1000);

        // Deliver the response for seq=22 FIRST (out of order).
        client._dispatchPdu(makeResponsePdu(22));
        const r2 = await waiter2;
        assert.equal((r2[8] << 8) | r2[9], 22);

        // Then the response for seq=11.
        client._dispatchPdu(makeResponsePdu(11));
        const r1 = await waiter1;
        assert.equal((r1[8] << 8) | r1[9], 11);

        assert.equal(client._pendingResponses.size, 0);
    });

    it('drops PDU with unknown sequence number — does NOT corrupt next read', async () => {
        const client = new S7CommPlusClient();
        const waiter = client._waitForResponse(100, 'real', 1000);

        // Unsolicited PDU with seq=999 must be dropped silently.
        client._dispatchPdu(makeResponsePdu(999));
        assert.equal(client._pendingResponses.size, 1, 'real waiter must still be pending');

        // Then the real response arrives.
        client._dispatchPdu(makeResponsePdu(100));
        const r = await waiter;
        assert.equal((r[8] << 8) | r[9], 100);
    });

    it('drops non-response opcodes (notifications, garbage)', async () => {
        const client = new S7CommPlusClient();
        const waiter = client._waitForResponse(7, 'real', 200);

        // Notification opcode (0x33) with seq=7 must NOT be matched.
        client._dispatchPdu(makeResponsePdu(7, Opcode.Notification));
        assert.equal(client._pendingResponses.size, 1, 'notification must not consume the waiter');

        // The waiter still times out, proving the notification did not
        // satisfy it.
        await assert.rejects(waiter, /Data receive Timeout/);
    });

    it('response timeout removes the waiter and tears down transport', async () => {
        const client = new S7CommPlusClient();
        client._connected = true;
        client._sessionId = 42;
        let disconnects = 0;
        client._transport.disconnect = () => { disconnects++; return 0; };

        await assert.rejects(
            client._waitForResponse(5, 'op', 30),
            /Data receive Timeout \(op, seq 5\)/
        );
        assert.equal(client._pendingResponses.size, 0, 'waiter must be removed after timeout');
        assert.equal(client._connected, false, 'connection must be torn down');
        assert.ok(disconnects >= 1);
    });

    it('_onTransportClosed rejects every pending response with a clear reason', async () => {
        const client = new S7CommPlusClient();
        client._connected = true;
        client._sessionId = 42;
        client._transport.disconnect = () => 0;

        const w1 = client._waitForResponse(1, 'op1', 5000);
        const w2 = client._waitForResponse(2, 'op2', 5000);
        const w3 = client._waitForResponse(3, 'op3', 5000);

        client._onTransportClosed({ reason: 'test-tear' });

        await assert.rejects(w1, /Client not connected.*test-tear/);
        await assert.rejects(w2, /Client not connected.*test-tear/);
        await assert.rejects(w3, /Client not connected.*test-tear/);
        assert.equal(client._pendingResponses.size, 0);
    });

    it('garbage bytes resync the stream without tearing down the session', async () => {
        // The old logic treated a non-0x72 prefix as fatal and rejected
        // every pending response. With arbitrary TLS chunk boundaries a
        // desync is recoverable: skip to the next sync byte and keep the
        // session alive.
        const client = new S7CommPlusClient();
        client._connected = true;
        client._transport.disconnect = () => 0;

        let dispatched = null;
        client._dispatchPdu = (pdu) => { dispatched = pdu; };

        // Garbage first, then a complete valid frame in the same stream.
        client._onDataReceived(Buffer.from([0xff, 0, 0, 0]));
        const payload = Buffer.from([0x32, 0x03, 0x07]);
        client._onDataReceived(Buffer.concat([
            Buffer.from([0x72, 0x02, 0x00, payload.length]),
            payload,
            Buffer.from([0x72, 0x02, 0x00, 0x00])
        ]));

        assert.ok(dispatched, 'valid frame after garbage must still dispatch');
        assert.deepEqual(dispatched.subarray(1), payload, 'no garbage glued into the PDU');
        assert.ok(client._frames.resyncSkippedBytes >= 4, 'resync must be accounted');
    });

    it('connect() clears any leftover receive state from a prior broken session', async () => {
        const client = new S7CommPlusClient();
        // Simulate a half-broken state: pending response, partial frame buffered.
        client._connected = true;
        client._transport.disconnect = () => 0;
        const orphan = client._waitForResponse(99, 'orphan', 5000);
        client._frames.push(Buffer.from([0x72, 0x02, 0x00, 0x10, 1, 2, 3])); // incomplete body
        assert.equal(client._frames.hasPartial, true);

        // We can't run real connect (no PLC), but we can verify the
        // reset path independently.
        client._resetReceiveState('connect');

        assert.equal(client._pendingResponses.size, 0);
        assert.equal(client._frames.hasPartial, false);
        await assert.rejects(orphan, /Client not connected.*connect/);
    });
});

describe('S7CommPlusClient: receive reassembly (Fix 1)', () => {
    /**
     * Build a single-fragment S7+ wire frame: 0x72, protoVer, len-hi,
     * len-lo, payload..., trailing 0x72/protoVer/0x00/0x00 (4-byte tail
     * the receive logic expects when (pdu.length - 4 - 4) === payloadLen).
     */
    function makeWireFrame(protoVer, payload) {
        const len = payload.length;
        return Buffer.concat([
            Buffer.from([0x72, protoVer, (len >> 8) & 0xff, len & 0xff]),
            payload,
            Buffer.from([0x72, protoVer, 0x00, 0x00])
        ]);
    }

    it('reassembles a large single-fragment PDU without spreading bytes', () => {
        // ~60 KB payload — fits in the 16-bit S7+ header length but is
        // large enough to crash the old `_tempPdu.push(...buffer)` path
        // on V8 (Function.apply argument cap ~65 535).
        // Reassembled buffer layout: dispatched[0] = protoVer (added by
        // _onDataReceived), dispatched[1..] = payload as transmitted.
        const client = new S7CommPlusClient();
        const payloadSize = 60000;
        const payload = Buffer.alloc(payloadSize);
        for (let i = 0; i < payloadSize; i++) payload[i] = (i * 7 + 3) & 0xff;
        payload[0] = Opcode.Response;
        payload[7] = (12345 >> 8) & 0xff;
        payload[8] = 12345 & 0xff;

        let dispatched = null;
        client._dispatchPdu = (pdu) => { dispatched = pdu; };

        const frame = makeWireFrame(0x02, payload);
        client._onDataReceived(frame);

        assert.ok(dispatched, 'dispatch must have been called');
        assert.equal(dispatched.length, 1 + payloadSize, 'reassembled length = 1 protoVer + payload');
        assert.equal(dispatched[0], 0x02, 'protoVer preserved');
        assert.equal(dispatched[1], Opcode.Response, 'payload[0] becomes dispatched[1]');
        assert.equal(dispatched[1 + 100], (100 * 7 + 3) & 0xff, 'payload bytes preserved');
        assert.equal(dispatched[1 + payloadSize - 1], ((payloadSize - 1) * 7 + 3) & 0xff,
            'last payload byte preserved');
    });

    it('reassembles multi-fragment PDU correctly', () => {
        // Two fragments that together form one logical PDU.
        const client = new S7CommPlusClient();
        let dispatched = null;
        client._dispatchPdu = (pdu) => { dispatched = pdu; };

        const part1 = Buffer.alloc(100);
        for (let i = 0; i < part1.length; i++) part1[i] = (i + 1) & 0xff;
        const part2 = Buffer.alloc(50);
        for (let i = 0; i < part2.length; i++) part2[i] = (i + 200) & 0xff;

        // First fragment: 0x72 protoVer lenHi lenLo payload (NO tail
        // — signals "more data coming"). lengths must be set so the
        // (pdu.length - 4 - 4) !== s7HeaderDataLen branch fires.
        const frag1 = Buffer.concat([
            Buffer.from([0x72, 0x02, (part1.length >> 8) & 0xff, part1.length & 0xff]),
            part1
        ]);
        client._onDataReceived(frag1);
        assert.equal(dispatched, null, 'first fragment must not finalize');
        assert.equal(client._frames.hasPartial, true);

        // Second fragment: header carries 0x72 protoVer lenHi lenLo
        // for THIS slice + the trailing tail so total bytes after the
        // 4 header bytes equal s7HeaderDataLen + 4 (tail).
        const frag2 = Buffer.concat([
            Buffer.from([0x72, 0x02, (part2.length >> 8) & 0xff, part2.length & 0xff]),
            part2,
            Buffer.from([0x72, 0x02, 0x00, 0x00])
        ]);
        client._onDataReceived(frag2);

        assert.ok(dispatched, 'final fragment must finalize the PDU');
        // Final length: 1 protoVer + part1 + part2 (only ONE protoVer,
        // not one per fragment, because _needMoreData skips re-pushing).
        assert.equal(dispatched.length, 1 + part1.length + part2.length);
        assert.equal(dispatched[0], 0x02);
        assert.deepEqual(dispatched.subarray(1, 1 + part1.length), part1);
        assert.deepEqual(dispatched.subarray(1 + part1.length), part2);
    });
});

describe('S7CommPlusClient: liveness tracking (Fix 3)', () => {
    it('userLockBusy reflects whether a user op is in flight', async () => {
        const client = new S7CommPlusClient();
        assert.equal(client.userLockBusy, false, 'no op = not busy');

        let releaseInner;
        const innerDone = new Promise(r => { releaseInner = r; });
        const op = client._withUserLock('test-op', async () => {
            assert.equal(client.userLockBusy, true, 'inside op = busy');
            assert.equal(client.userOpInFlight, 'test-op');
            await innerDone;
        });

        // Yield so the op enters its body.
        await new Promise(r => setImmediate(r));
        assert.equal(client.userLockBusy, true, 'still busy after yield');

        releaseInner();
        await op;
        assert.equal(client.userLockBusy, false, 'after op = not busy');
        assert.equal(client.userOpInFlight, null);
    });

    it('lastResponseAt updates when _dispatchPdu sees any inbound PDU', () => {
        const client = new S7CommPlusClient();
        const before = client.lastResponseAt;
        // Even a non-response PDU counts as transport liveness.
        const sleep = () => new Promise(r => setTimeout(r, 5));
        return sleep().then(() => {
            client._dispatchPdu(Buffer.from([0x02, 0x33, 0, 0, 0, 0, 0, 0, 0, 1]));
            assert.ok(client.lastResponseAt > before,
                `lastResponseAt must advance (was ${before}, now ${client.lastResponseAt})`);
        });
    });

    it('lastResponseAt updates on every _onDataReceived call (per-frame liveness)', async () => {
        // A multi-fragment PDU only triggers _dispatchPdu on the LAST
        // fragment, but every incoming fragment is proof of liveness
        // and must keep the watchdog from firing. Fix 8 enforces this
        // by updating _lastResponseAt at the top of _onDataReceived.
        const client = new S7CommPlusClient();

        // Build first fragment of a multi-fragment PDU (no trailing tail
        // means _onDataReceived sets _needMoreData and does NOT call
        // _dispatchPdu).
        const firstFragmentPayload = Buffer.alloc(50, 0xaa);
        const firstFragment = Buffer.concat([
            Buffer.from([0x72, 0x02, (firstFragmentPayload.length >> 8) & 0xff, firstFragmentPayload.length & 0xff]),
            firstFragmentPayload
        ]);

        const before = client.lastResponseAt;
        await new Promise(r => setTimeout(r, 5));

        client._onDataReceived(firstFragment);

        assert.equal(client._frames.hasPartial, true,
            'first fragment must NOT finalize (so _dispatchPdu was not called)');
        assert.ok(client.lastResponseAt > before,
            `lastResponseAt must advance on every frame, even mid-PDU ` +
            `(was ${before}, now ${client.lastResponseAt})`);
    });
});

describe('S7CommPlusClient: type-info cache bounds (Fix 5)', () => {
    it('_seedBrowseStateFromFullBrowse clears cache before re-seeding', () => {
        const client = new S7CommPlusClient();
        const state = client._getBrowseState();
        // Pre-populate as if from a previous browseFull.
        for (let i = 0; i < 100; i++) state.typeInfoCache.set(1000 + i, { stale: true });
        assert.equal(state.typeInfoCache.size, 100);

        // Re-seed with fresh data — old entries must be gone.
        client._seedBrowseStateFromFullBrowse([], [
            { relationId: 9001, fresh: true },
            { relationId: 9002, fresh: true }
        ], []);

        assert.equal(state.typeInfoCache.size, 2, 'cache must not retain stale entries');
        assert.ok(state.typeInfoCache.get(9001) && state.typeInfoCache.get(9001).fresh);
        assert.equal(state.typeInfoCache.get(1000), undefined, 'stale entry must be gone');
    });

    it('_cacheTypeInfoObjects drops cache when cap exceeded', () => {
        const client = new S7CommPlusClient();
        const state = client._getBrowseState();
        // Build > TYPE_INFO_CACHE_MAX (5000) lazy cache entries to
        // simulate long-running endpoint with many type infos walked.
        const objs = [];
        for (let i = 0; i < 5100; i++) objs.push({ relationId: 1 + i });

        client._cacheTypeInfoObjects(objs);
        // Cap behaviour: cache is cleared once exceeded.
        assert.equal(state.typeInfoCache.size, 0,
            'cache must be cleared once it exceeds the cap');
    });
});
