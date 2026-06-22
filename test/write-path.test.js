'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

const { S7CommPlusClient } = require('../lib/s7plus/client');
const ItemAddress = require('../lib/s7plus/item-address');
const { isHexAddress, isSymbolicName } = require('../lib/s7plus/tag-routing');
const { writeTagErrorText } = require('../lib/s7plus/read-result');
const { S7Consts } = require('../lib/s7plus/constants');

// ── client.writeValues: per-item error reporting ─────────────────────
describe('client.writeValues error reporting', () => {
    function makeClient() {
        const client = new S7CommPlusClient();
        client._connected = true;
        return client;
    }

    it('returns all-zero errors when the PLC reports no item errors', async () => {
        const client = makeClient();
        client._requestResponse = async () => ({ errorValues: new Map() });
        const { errors } = await client.writeValues(
            [new ItemAddress('8A0E0001.A'), new ItemAddress('8A0E0001.B')],
            [{}, {}]
        );
        assert.deepEqual(errors, [0n, 0n]);
    });

    it('maps a per-item error code from errorValues (1-based key)', async () => {
        const client = makeClient();
        client._requestResponse = async () => ({ errorValues: new Map([[2, 0x123n]]) });
        const { errors } = await client.writeValues(
            [new ItemAddress('8A0E0001.A'), new ItemAddress('8A0E0001.B')],
            [{}, {}]
        );
        assert.equal(errors[0], 0n);
        assert.equal(errors[1], 0x123n);
    });

    it('applies the chunkStart offset when chunking', async () => {
        const client = makeClient();
        client._tagsPerWriteMax = 2;
        let call = 0;
        client._requestResponse = async () => {
            call++;
            // Error only on the FIRST item of the SECOND chunk -> global index 2.
            return call === 2
                ? { errorValues: new Map([[1, 0xAAn]]) }
                : { errorValues: new Map() };
        };
        const addrs = ['A', 'B', 'C', 'D', 'E'].map(() => new ItemAddress('8A0E0001.A'));
        const { errors } = await client.writeValues(addrs, addrs.map(() => ({})));
        assert.equal(call, 3, 'five tags with max 2 per chunk -> three requests');
        assert.deepEqual(errors, [0n, 0n, 0xAAn, 0n, 0n]);
    });

    it('throws when the response cannot be deserialized', async () => {
        const client = makeClient();
        client._requestResponse = async () => null;
        await assert.rejects(
            client.writeValues([new ItemAddress('8A0E0001.A')], [{}]),
            /.+/
        );
    });

    it('does NOT mask a real error as success (regression for silent writes)', async () => {
        const client = makeClient();
        client._requestResponse = async () => ({
            errorValues: new Map([[1, 0x8009890012cbffefn]])
        });
        const { errors } = await client.writeValues([new ItemAddress('8A0E0001.A')], [{}]);
        assert.notEqual(errors[0], 0n);
        assert.equal(errors[0], 0x8009890012cbffefn);
    });
});

// ── resolveAndWrite: self-heal on stale/moved address ────────────────
describe('resolveAndWrite stale-address self-heal', () => {
    function buildEndpoint(config) {
        let Ctor;
        const RED = {
            settings: {},
            nodes: {
                createNode(node) {
                    node._warnings = [];
                    node.status = () => {};
                    node.warn = (m) => { node._warnings.push(m); };
                    node.log = () => {};
                    node.error = () => {};
                    node.on = () => {};
                },
                registerType(_name, ctor) { Ctor = ctor; }
            },
            auth: { needsPermission: () => (_req, _res, next) => next && next() },
            httpAdmin: { post: () => {} }
        };
        require('../nodes/s7complus-endpoint')(RED);
        return new Ctor(config || {});
    }

    function makeMockClient({ resolveAddresses, writeErrorSequence }) {
        const state = {
            clearBrowseStateCalls: 0,
            resolveCalls: 0,
            writeAddresses: [],
            browseFullCalls: 0
        };
        const client = {
            connected: true,
            socketAlive: true,
            clearBrowseState() { state.clearBrowseStateCalls++; },
            async browseResolveSymbolicBatch(paths) {
                const address = resolveAddresses[Math.min(state.resolveCalls, resolveAddresses.length - 1)];
                state.resolveCalls++;
                return paths.map(() => ({ address, crcMeta: null, datatype: 'Bool' }));
            },
            async writeValues(addresses) {
                const idx = state.writeAddresses.length;
                state.writeAddresses.push(addresses.map(a => a.getAccessString()));
                const code = writeErrorSequence[Math.min(idx, writeErrorSequence.length - 1)];
                return { errors: [code] };
            },
            async browseFull() { state.browseFullCalls++; return { symbols: [] }; }
        };
        return { client, state };
    }

    it('re-resolves and retries once on a moved-address PLC error (0x...0ebeffef)', async () => {
        const node = buildEndpoint({});
        const { client, state } = makeMockClient({
            resolveAddresses: ['8A0E0001.A', '8A0E0002.A'],
            writeErrorSequence: [0x800989000ebeffefn, 0n]
        });
        node.client = client;

        await node.resolveAndWrite([
            { name: 'DB_Binary.Bool_write', address: 'DB_Binary.Bool_write', datatype: 'Bool', value: true }
        ]);

        assert.equal(state.clearBrowseStateCalls, 1, 'browse state cleared before re-resolve');
        assert.equal(state.resolveCalls, 2, 'symbol re-resolved once');
        assert.equal(state.writeAddresses.length, 2, 'write retried exactly once');
        assert.equal(state.writeAddresses[0][0], '8A0E0001.A', 'first write used the stale address');
        assert.equal(state.writeAddresses[1][0], '8A0E0002.A', 'retry used the re-resolved new address');
        assert.equal(state.browseFullCalls, 0, 'self-heal must not trigger browseFull');
    });

    it('self-heals on a stale-tree resolution error ("not found in")', async () => {
        const node = buildEndpoint({});
        const state = { clearBrowseStateCalls: 0, resolveCalls: 0, writeAddresses: [], browseFullCalls: 0 };
        node.client = {
            connected: true,
            socketAlive: true,
            clearBrowseState() { state.clearBrowseStateCalls++; },
            async browseResolveSymbolicBatch(paths) {
                // First walk hits the stale cached tree -> segment "not
                // found"; after clearBrowseState the fresh walk resolves.
                const stale = state.resolveCalls === 0;
                state.resolveCalls++;
                return paths.map(() => stale
                    ? { error: "Symbol segment 'Bool_write' not found in 'DB_Binary'" }
                    : { address: '8A0E0002.A', crcMeta: null, datatype: 'Bool' });
            },
            async writeValues(addresses) {
                state.writeAddresses.push(addresses.map(a => a.getAccessString()));
                return { errors: [0n] };
            },
            async browseFull() { state.browseFullCalls++; return { symbols: [] }; }
        };

        const result = await node.resolveAndWrite([
            { name: 'DB_Binary.Bool_write', address: 'DB_Binary.Bool_write', datatype: 'Bool', value: true }
        ]);

        assert.equal(state.clearBrowseStateCalls, 1, 'browse state cleared on stale-tree error');
        assert.equal(state.resolveCalls, 2, 'symbol re-resolved against fresh tree');
        assert.equal(state.writeAddresses.length, 1, 'write happened only after successful re-resolve');
        assert.equal(state.writeAddresses[0][0], '8A0E0002.A', 'write used the re-resolved address');
        assert.equal(result['DB_Binary.Bool_write'].status, 'ok', 'write succeeds after self-heal');
        assert.equal(state.browseFullCalls, 0, 'self-heal must not trigger browseFull');
    });

    it('resolveAndRead self-heals on a stale-tree resolution error', async () => {
        const node = buildEndpoint({});
        const state = { clearBrowseStateCalls: 0, resolveCalls: 0, readCalls: 0 };
        node.client = {
            connected: true,
            socketAlive: true,
            clearBrowseState() { state.clearBrowseStateCalls++; },
            async browseResolveSymbolicBatch(paths) {
                const stale = state.resolveCalls === 0;
                state.resolveCalls++;
                return paths.map(() => stale
                    ? { error: "Symbol segment 'Bool_write' not found in 'DB_Binary'" }
                    : { address: '8A0E0002.A', crcMeta: null, datatype: 'Bool' });
            },
            async readValues(addresses) {
                state.readCalls++;
                return { values: addresses.map(() => null), errors: addresses.map(() => 0n) };
            },
            async browseFull() { return { symbols: [] }; }
        };

        const result = await node.resolveAndRead(['DB_Binary.Bool_write']);

        assert.equal(state.clearBrowseStateCalls, 1, 'browse state cleared on stale-tree error');
        assert.equal(state.resolveCalls, 2, 'symbol re-resolved against fresh tree');
        assert.equal(state.readCalls, 1, 'read happened only after successful re-resolve');
        assert.equal(result['DB_Binary.Bool_write'].status, 'ok', 'read succeeds after self-heal');
    });

    it('also self-heals on the CRC mismatch code (0x...12cbffef)', async () => {
        const node = buildEndpoint({});
        const { client, state } = makeMockClient({
            resolveAddresses: ['8A0E0001.A', '8A0E0002.A'],
            writeErrorSequence: [0x8009890012cbffefn, 0n]
        });
        node.client = client;

        await node.resolveAndWrite([
            { name: 'DB1.x', address: 'DB1.x', datatype: 'Bool', value: true }
        ]);

        assert.equal(state.clearBrowseStateCalls, 1);
        assert.equal(state.writeAddresses.length, 2);
        assert.equal(state.browseFullCalls, 0, 'self-heal must not trigger browseFull');
    });

    it('does NOT retry or clear browse state on a non-address error', async () => {
        const node = buildEndpoint({});
        const { client, state } = makeMockClient({
            resolveAddresses: ['8A0E0001.A'],
            writeErrorSequence: [0x123n]
        });
        node.client = client;

        const result = await node.resolveAndWrite([
            { name: 'DB1.x', address: 'DB1.x', datatype: 'Bool', value: true }
        ]);

        assert.equal(result['DB1.x'].status, 'error', 'non-address error surfaced per tag');
        assert.equal(result['DB1.x'].value, null);
        assert.ok(result['DB1.x'].error.includes('0x123'));
        assert.equal(state.clearBrowseStateCalls, 0, 'browse state untouched for non-address errors');
        assert.equal(state.writeAddresses.length, 1, 'no retry on non-address errors');
    });

    it('returns an ok per-tag result on a successful write', async () => {
        const node = buildEndpoint({});
        const { client } = makeMockClient({
            resolveAddresses: ['8A0E0001.A'],
            writeErrorSequence: [0n]
        });
        node.client = client;

        const result = await node.resolveAndWrite([
            { name: 'DB1.x', address: 'DB1.x', datatype: 'Bool', value: true }
        ]);

        assert.equal(result['DB1.x'].status, 'ok');
        assert.equal(result['DB1.x'].value, true);
        assert.equal(result['DB1.x'].error, '');
    });
});

// ── endpoint connect: no pre-browse ─────────────────────────────────
describe('endpoint connect', () => {
    function buildEndpoint(config) {
        let Ctor;
        const RED = {
            settings: {},
            nodes: {
                createNode(node) {
                    node._warnings = [];
                    node.status = () => {};
                    node.warn = (m) => { node._warnings.push(m); };
                    node.log = () => {};
                    node.error = () => {};
                    node.on = () => {};
                },
                registerType(_name, ctor) { Ctor = ctor; }
            },
            auth: { needsPermission: () => (_req, _res, next) => next && next() },
            httpAdmin: { post: () => {} }
        };
        require('../nodes/s7complus-endpoint')(RED);
        return new Ctor(config || {});
    }

    function stopEndpointTimers(node) {
        if (node._watchdogTimer) {
            clearInterval(node._watchdogTimer);
            node._watchdogTimer = null;
        }
        if (node._reconnectTimer) {
            clearTimeout(node._reconnectTimer);
            node._reconnectTimer = null;
        }
    }

    const origConnect = S7CommPlusClient.prototype.connect;
    const origBrowseFull = S7CommPlusClient.prototype.browseFull;
    let lastNode = null;

    afterEach(() => {
        S7CommPlusClient.prototype.connect = origConnect;
        S7CommPlusClient.prototype.browseFull = origBrowseFull;
        if (lastNode) {
            stopEndpointTimers(lastNode);
            lastNode = null;
        }
    });

    it('ensureConnected does not call browseFull', async () => {
        let browseFullCalls = 0;
        S7CommPlusClient.prototype.connect = async function () {
            this._connected = true;
        };
        S7CommPlusClient.prototype.browseFull = async function () {
            browseFullCalls++;
            return { symbols: [], meta: {} };
        };

        const node = buildEndpoint({ address: '127.0.0.1', timeout: 5000 });
        lastNode = node;
        Object.defineProperty(node.client, 'socketAlive', { get: () => true });

        if (node._connectPromise) {
            await node._connectPromise;
        }

        assert.equal(browseFullCalls, 0, 'connect must not pre-browse the PLC');
        assert.equal(node.getStatus(), 'online');
    });
});

// ── writeTagErrorText ────────────────────────────────────────────────
describe('writeTagErrorText', () => {
    it('returns OK for zero/null', () => {
        assert.equal(writeTagErrorText(0n), 'OK');
        assert.equal(writeTagErrorText(null), 'OK');
    });

    it('maps a known S7Consts code', () => {
        assert.equal(writeTagErrorText(BigInt(S7Consts.errCliAccessDenied)), 'CPU: Access denied');
    });

    it('keeps full hex for large PLC error codes', () => {
        const text = writeTagErrorText(0x8009890012cbffefn);
        assert.ok(text.includes('0x8009890012cbffef'));
    });
});

// ── shared tag-routing module ────────────────────────────────────────
describe('tag-routing', () => {
    it('isHexAddress recognizes hex access strings', () => {
        assert.equal(isHexAddress('8A0E0001.A.0'), true);
        assert.equal(isHexAddress('FF'), true);
        assert.equal(isHexAddress('DB_Binary.Bool_write'), false);
        assert.equal(isHexAddress('DB1.x'), false);
    });

    it('isSymbolicName recognizes symbolic paths', () => {
        assert.equal(isSymbolicName('DB1.readings[0]'), true);
        assert.equal(isSymbolicName('DB_Binary.Bool_write'), true);
        assert.equal(isSymbolicName('8A0E0001'), false);
        assert.equal(isSymbolicName('tag0'), false);
        assert.equal(isSymbolicName(null), false);
    });
});

// ── s7complus-out node: routing + error propagation ──────────────────
describe('s7complus-out routing', () => {
    function buildOut(endpointMock) {
        let Ctor;
        const RED = {
            nodes: {
                createNode(node) {
                    const ee = new EventEmitter();
                    node.on = ee.on.bind(ee);
                    node.emit = ee.emit.bind(ee);
                    node.status = (s) => { node._status = s; };
                    node.error = (e) => { node._error = e; };
                    node.send = () => { node._sent = true; };
                },
                getNode() { return endpointMock; },
                registerType(_name, ctor) { Ctor = ctor; }
            }
        };
        require('../nodes/s7complus-out')(RED);
        return Ctor;
    }

    function runInput(node, msg) {
        return new Promise((resolve) => {
            node._sent = false;
            const send = () => { node._sent = true; };
            node.emit('input', msg, send, (err) => resolve(err));
        });
    }

    it('routes a symbolic address through resolveAndWrite and sets read-shaped payload', async () => {
        const calls = { resolveAndWrite: [], writeTags: [] };
        const endpoint = {
            resolveAndWrite: async (t) => {
                calls.resolveAndWrite.push(t);
                return { [t[0].name]: { value: t[0].value, status: 'ok', error: '' } };
            },
            writeTags: async (t) => { calls.writeTags.push(t); return {}; }
        };
        const Ctor = buildOut(endpoint);
        const node = new Ctor({
            endpoint: 'ep',
            symbols: [{ name: 'DB_Binary.Bool_write', address: 'DB_Binary.Bool_write', datatype: 'Bool' }]
        });

        const msg = { payload: true };
        const err = await runInput(node, msg);
        assert.equal(err, undefined);
        assert.equal(calls.resolveAndWrite.length, 1);
        assert.equal(calls.writeTags.length, 0);
        assert.equal(calls.resolveAndWrite[0][0].address, 'DB_Binary.Bool_write');
        assert.equal(calls.resolveAndWrite[0][0].value, true);
        assert.deepEqual(msg.payload, {
            'DB_Binary.Bool_write': { value: true, status: 'ok', error: '' }
        });
        assert.equal(node._status.fill, 'green');
        assert.equal(node._sent, true);
    });

    it('routes a hex address through writeTags', async () => {
        const calls = { resolveAndWrite: [], writeTags: [] };
        const endpoint = {
            resolveAndWrite: async (t) => { calls.resolveAndWrite.push(t); return {}; },
            writeTags: async (t) => {
                calls.writeTags.push(t);
                return { [t[0].name]: { value: t[0].value, status: 'ok', error: '' } };
            }
        };
        const Ctor = buildOut(endpoint);
        const node = new Ctor({
            endpoint: 'ep',
            symbols: [{ name: '8A0E0001.A', address: '8A0E0001.A', datatype: 'Bool' }]
        });

        const msg = { payload: false };
        const err = await runInput(node, msg);
        assert.equal(err, undefined);
        assert.equal(calls.writeTags.length, 1);
        assert.equal(calls.resolveAndWrite.length, 0);
        assert.equal(calls.writeTags[0][0].address, '8A0E0001.A');
        assert.equal(msg.payload['8A0E0001.A'].status, 'ok');
    });

    it('surfaces a per-tag write failure in payload, yellow status, message still sent', async () => {
        const endpoint = {
            resolveAndWrite: async (t) => ({
                [t[0].name]: { value: null, status: 'error', error: 'CPU: Access denied' }
            }),
            writeTags: async () => ({})
        };
        const Ctor = buildOut(endpoint);
        const node = new Ctor({
            endpoint: 'ep',
            symbols: [{ name: 'DB1.x', address: 'DB1.x', datatype: 'Bool' }]
        });

        const msg = { payload: true };
        const err = await runInput(node, msg);
        assert.equal(err, undefined, 'per-tag write error is not fatal');
        assert.equal(msg.payload['DB1.x'].status, 'error');
        assert.equal(msg.payload['DB1.x'].value, null);
        assert.equal(msg.payload['DB1.x'].error, 'CPU: Access denied');
        assert.equal(node._status.fill, 'yellow');
        assert.equal(node._sent, true);
    });

    it('aborts on a connection/protocol exception (red status, done(err), not sent)', async () => {
        const endpoint = {
            resolveAndWrite: async () => { throw new Error('not connected'); },
            writeTags: async () => ({})
        };
        const Ctor = buildOut(endpoint);
        const node = new Ctor({
            endpoint: 'ep',
            symbols: [{ name: 'DB1.x', address: 'DB1.x', datatype: 'Bool' }]
        });

        const err = await runInput(node, { payload: true });
        assert.ok(err instanceof Error);
        assert.match(err.message, /not connected/);
        assert.equal(node._status.fill, 'red');
        assert.notEqual(node._sent, true);
    });
});
