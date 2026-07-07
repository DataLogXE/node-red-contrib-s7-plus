'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    parsePaom,
    protectionLevelLabel,
    formatSessionIdHex,
    buildSessionInfoPayload,
    buildConnectionStatePayload
} = require('../lib/s7plus/session-info');

describe('session-info parsePaom', () => {
    it('parses S7-1200 example from Thomas reference', () => {
        const r = parsePaom('1;6ES7 214-1AG40-0XB0 ;V4.5');
        assert.equal(r.orderNumber, '6ES7 214-1AG40-0XB0');
        assert.equal(r.deviceCode, '214');
        assert.equal(r.firmware, 'V4.5');
        assert.equal(r.deviceFamily, 'S7-1200');
    });

    it('parses S7-1500 example', () => {
        const r = parsePaom('1;6ES7 510-1DJ01-0AB0;V2.9');
        assert.equal(r.deviceCode, '510');
        assert.equal(r.firmware, 'V2.9');
        assert.equal(r.deviceFamily, 'S7-1500');
    });

    it('parses software controller example', () => {
        const r = parsePaom('1;6ES7 672-7FC01-0YA0;V21.9');
        assert.equal(r.deviceCode, '672');
        assert.equal(r.firmware, 'V21.9');
        assert.equal(r.deviceFamily, 'S7-1500 Software');
    });

    it('returns null fields for unparseable PAOM', () => {
        const r = parsePaom('invalid');
        assert.equal(r.paom, 'invalid');
        assert.equal(r.orderNumber, null);
        assert.equal(r.deviceCode, null);
    });

    it('returns null for empty input', () => {
        assert.equal(parsePaom(''), null);
        assert.equal(parsePaom(null), null);
    });
});

describe('session-info protectionLevelLabel', () => {
    it('maps known levels', () => {
        assert.equal(protectionLevelLabel(1), 'fullAccess');
        assert.equal(protectionLevelLabel(2), 'readAccess');
    });

    it('falls back for unknown levels', () => {
        assert.equal(protectionLevelLabel(99), 'level99');
        assert.equal(protectionLevelLabel(null), null);
    });
});

describe('session-info buildSessionInfoPayload', () => {
    it('builds expected top-level shape', () => {
        const payload = buildSessionInfoPayload(
            {
                paom: '1;6ES7 214-1AG40-0XB0;V4.5',
                parsedPaom: parsePaom('1;6ES7 214-1AG40-0XB0;V4.5'),
                sessionId: 0x12345678,
                sessionId2: 0x87654321,
                limits: {
                    tagsPerReadMax: 20,
                    tagsPerWriteMax: 20,
                    subscriptionsMax: 100,
                    attributesMax: 200,
                    subscriptionMemoryMax: 300
                },
                freeItems: {
                    subscriptionsFree: 90,
                    attributesFree: 180,
                    subscriptionMemoryFree: 250
                },
                connected: true,
                lastResponseAt: 1_700_000_000_000
            },
            {
                address: '192.168.0.10',
                port: 102,
                timeoutMs: 10000,
                endpointState: 'online'
            },
            { fetchedAt: '2026-06-24T12:00:00.000Z', elapsedMs: 42 }
        );

        assert.equal(payload.plc.orderNumber, '6ES7 214-1AG40-0XB0');
        assert.equal(payload.plc.protectionLevel, undefined);
        assert.equal(payload.session.sessionId, formatSessionIdHex(0x12345678));
        assert.equal(payload.session.protocol, undefined);
        assert.equal(payload.session.tls, undefined);
        assert.equal(payload.limits.tagsPerReadMax, 20);
        assert.equal(payload.limits.subscriptionsFree, 90);
        assert.equal(payload.connection.address, '192.168.0.10');
        assert.equal(payload.connection.endpointState, 'online');
        assert.equal(payload.connection.userLockBusy, undefined);
        assert.equal(payload.connection.userOpInFlight, undefined);
        assert.equal(payload.meta.elapsedMs, 42);
    });
});

describe('session-info buildConnectionStatePayload', () => {
    it('returns only connection and meta', () => {
        const payload = buildConnectionStatePayload(
            {
                address: '192.168.0.10',
                port: 102,
                timeoutMs: 10000,
                connected: false,
                endpointState: 'connecting'
            },
            { event: 'stateChange', previousState: 'online' }
        );

        assert.deepEqual(Object.keys(payload).sort(), ['connection', 'meta']);
        assert.deepEqual(Object.keys(payload.connection).sort(), [
            'address', 'connected', 'endpointState', 'port', 'timeoutMs'
        ]);
        assert.equal(payload.connection.address, '192.168.0.10');
        assert.equal(payload.connection.port, 102);
        assert.equal(payload.connection.timeoutMs, 10000);
        assert.equal(payload.connection.connected, false);
        assert.equal(payload.connection.endpointState, 'connecting');
        assert.equal(payload.meta.event, 'stateChange');
        assert.equal(payload.meta.previousState, 'online');
    });
});
