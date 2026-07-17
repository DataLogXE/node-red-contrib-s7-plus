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

// ── client.writeValues: large multi-chunk writes ──────────────────────
describe('client.writeValues large batch chunking', () => {
    function makeClient() {
        const client = new S7CommPlusClient();
        client._connected = true;
        client._tagsPerWriteMax = 100;
        client._requestResponse = async () => ({ errorValues: new Map() });
        return client;
    }

    function makeAddrs(n) {
        return Array.from({ length: n }, () => new ItemAddress('8A0E0001.A'));
    }

    it('sends 5 PDU chunks for 250 tags when lock batch is capped at 50', async () => {
        const client = makeClient();
        let pduCalls = 0;
        let lockCalls = 0;
        const origLock = client._withUserLock.bind(client);
        client._withUserLock = async (label, fn, ...rest) => {
            if (label === 'writeValues') lockCalls++;
            return origLock(label, fn, ...rest);
        };
        client._requestResponse = async () => {
            pduCalls++;
            return { errorValues: new Map() };
        };
        const addrs = makeAddrs(250);
        const { errors } = await client.writeValues(addrs, addrs.map(() => ({})));
        assert.equal(pduCalls, 5);
        assert.equal(lockCalls, 5);
        assert.equal(errors.length, 250);
        assert.ok(errors.every((e) => e === 0n));
    });

    it('uses 12 lock batches and 12 PDU chunks for 600 tags', async () => {
        const client = makeClient();
        let pduCalls = 0;
        let lockCalls = 0;
        const origLock = client._withUserLock.bind(client);
        client._withUserLock = async (label, fn, ...rest) => {
            if (label === 'writeValues') lockCalls++;
            return origLock(label, fn, ...rest);
        };
        client._requestResponse = async () => {
            pduCalls++;
            return { errorValues: new Map() };
        };
        const addrs = makeAddrs(600);
        const { errors } = await client.writeValues(addrs, addrs.map(() => ({})));
        assert.equal(lockCalls, 12, '600 tags / lockBatch=50 -> twelve batches');
        assert.equal(pduCalls, 12);
        assert.equal(errors.length, 600);
    });

    it('maps per-item errors across lock-batch boundaries', async () => {
        const client = makeClient();
        let pduCalls = 0;
        client._requestResponse = async () => {
            pduCalls++;
            // Fail first item of the batch at global index 500 (PDU 11).
            if (pduCalls === 11) {
                return { errorValues: new Map([[1, 0xBEEFn]]) };
            }
            return { errorValues: new Map() };
        };
        const addrs = makeAddrs(600);
        const { errors } = await client.writeValues(addrs, addrs.map(() => ({})));
        assert.equal(errors[499], 0n);
        assert.equal(errors[500], 0xBEEFn);
        assert.equal(errors[599], 0n);
    });

    it('includes chunk context on transport reset during write', async () => {
        const client = makeClient();
        client._tagsPerWriteMax = 100;
        let pduCalls = 0;
        client._requestResponse = async () => {
            pduCalls++;
            if (pduCalls === 2) {
                throw new Error('CLI: Client not connected (socket-error: read ECONNRESET)');
            }
            return { errorValues: new Map() };
        };
        const addrs = makeAddrs(150);
        await assert.rejects(
            client.writeValues(addrs, addrs.map(() => ({}))),
            /SetMultiVars chunk failed at offset 50\/150 \(chunkSize=50, tagsPerWriteMax=100\).*ECONNRESET/
        );
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

    function flatExploreSymbol(name, accessSequence, computedCrc = 0x1234) {
        return {
            name,
            accessSequence,
            computedCrc,
            softdatatypeName: 'Bool'
        };
    }

    function makeMockClient({ exploreCatalogs, writeErrorSequence }) {
        const state = {
            clearBrowseStateCalls: 0,
            browseFullCalls: 0,
            browseFullScopes: [],
            lazyResolveCalls: 0,
            writeAddresses: []
        };
        let exploreIdx = 0;
        const client = {
            connected: true,
            socketAlive: true,
            clearBrowseState() { state.clearBrowseStateCalls++; },
            async browseResolveSymbolicBatch() {
                state.lazyResolveCalls++;
                throw new Error('browseResolveSymbolicBatch must not be called');
            },
            async browseFull(options) {
                state.browseFullCalls++;
                state.browseFullScopes.push(JSON.parse(JSON.stringify(options.scope)));
                const catalog = exploreCatalogs[
                    Math.min(exploreIdx++, exploreCatalogs.length - 1)
                ];
                const root = options.scope.dbs[0] || options.scope.areas[0];
                const symbols = catalog[root] || [];
                return { symbols, meta: {} };
            },
            async writeValues(addresses) {
                const idx = state.writeAddresses.length;
                state.writeAddresses.push(addresses.map(a => a.getAccessString()));
                const code = writeErrorSequence[Math.min(idx, writeErrorSequence.length - 1)];
                return { errors: [code] };
            }
        };
        return { client, state };
    }

    it('re-explores and retries once on a moved-address PLC error (0x...0ebeffef)', async () => {
        const node = buildEndpoint({});
        const { client, state } = makeMockClient({
            exploreCatalogs: [
                {
                    DB_Binary: [
                        flatExploreSymbol('DB_Binary.Bool_write', '8A0E0001.A', 0x1)
                    ]
                },
                {
                    DB_Binary: [
                        flatExploreSymbol('DB_Binary.Bool_write', '8A0E0002.A', 0x2)
                    ]
                }
            ],
            writeErrorSequence: [0x800989000ebeffefn, 0n]
        });
        node.client = client;

        await node.resolveAndWrite([
            { name: 'DB_Binary.Bool_write', address: 'DB_Binary.Bool_write', datatype: 'Bool', value: true }
        ]);

        assert.equal(state.clearBrowseStateCalls, 1, 'browse state cleared before re-explore');
        assert.equal(state.browseFullCalls, 2, 'scoped explore runs once per resolve pass');
        assert.equal(state.lazyResolveCalls, 0);
        assert.equal(state.writeAddresses.length, 2, 'write retried exactly once');
        assert.equal(state.writeAddresses[0][0], '8A0E0001.A', 'first write used the stale address');
        assert.equal(state.writeAddresses[1][0], '8A0E0002.A', 'retry used the re-explored address');
    });

    it('self-heals after a failed write by re-exploring the DB', async () => {
        const node = buildEndpoint({});
        const state = { clearBrowseStateCalls: 0, browseFullCalls: 0, writeAddresses: [], lazyResolveCalls: 0 };
        let exploreIdx = 0;
        node.client = {
            connected: true,
            socketAlive: true,
            clearBrowseState() { state.clearBrowseStateCalls++; },
            async browseResolveSymbolicBatch() {
                state.lazyResolveCalls++;
                throw new Error('browseResolveSymbolicBatch must not be called');
            },
            async browseFull(options) {
                state.browseFullCalls++;
                const address = exploreIdx === 0 ? '8A0E0001.A' : '8A0E0002.A';
                exploreIdx++;
                return {
                    symbols: [
                        flatExploreSymbol('DB_Binary.Bool_write', address, exploreIdx)
                    ]
                };
            },
            async writeValues(addresses) {
                state.writeAddresses.push(addresses.map(a => a.getAccessString()));
                const stale = state.writeAddresses.length === 1;
                return { errors: [stale ? 0x800989000ebeffefn : 0n] };
            }
        };

        const result = await node.resolveAndWrite([
            { name: 'DB_Binary.Bool_write', address: 'DB_Binary.Bool_write', datatype: 'Bool', value: true }
        ]);

        assert.equal(state.clearBrowseStateCalls, 1, 'browse state cleared on stale write');
        assert.equal(state.browseFullCalls, 2, 'initial explore plus heal explore');
        assert.equal(state.writeAddresses.length, 2, 'write retried after re-explore');
        assert.equal(state.writeAddresses[1][0], '8A0E0002.A');
        assert.equal(result['DB_Binary.Bool_write'].status, 'ok');
    });

    it('resolveAndRead self-heals on a stale read error', async () => {
        const node = buildEndpoint({});
        const state = { clearBrowseStateCalls: 0, browseFullCalls: 0, readCalls: 0, lazyResolveCalls: 0 };
        let exploreIdx = 0;
        node.client = {
            connected: true,
            socketAlive: true,
            clearBrowseState() { state.clearBrowseStateCalls++; },
            async browseResolveSymbolicBatch() {
                state.lazyResolveCalls++;
                throw new Error('browseResolveSymbolicBatch must not be called');
            },
            async browseFull() {
                state.browseFullCalls++;
                const address = exploreIdx === 0 ? '8A0E0001.A' : '8A0E0002.A';
                exploreIdx++;
                return {
                    symbols: [
                        flatExploreSymbol('DB_Binary.Bool_write', address, exploreIdx)
                    ]
                };
            },
            async readValues(addresses) {
                state.readCalls++;
                if (state.readCalls === 1) {
                    return {
                        values: addresses.map(() => null),
                        errors: addresses.map(() => 0x800989000ebeffefn)
                    };
                }
                return {
                    values: addresses.map(() => true),
                    errors: addresses.map(() => 0n)
                };
            }
        };

        const result = await node.resolveAndRead(['DB_Binary.Bool_write']);

        assert.equal(state.clearBrowseStateCalls, 1);
        assert.equal(state.browseFullCalls, 2);
        assert.equal(state.readCalls, 2);
        assert.equal(result['DB_Binary.Bool_write'].status, 'ok');
    });

    it('also self-heals on the CRC mismatch code (0x...12cbffef)', async () => {
        const node = buildEndpoint({});
        const { client, state } = makeMockClient({
            exploreCatalogs: [
                { DB1: [flatExploreSymbol('DB1.x', '8A0E0001.A', 0x1)] },
                { DB1: [flatExploreSymbol('DB1.x', '8A0E0002.A', 0x2)] }
            ],
            writeErrorSequence: [0x8009890012cbffefn, 0n]
        });
        node.client = client;

        await node.resolveAndWrite([
            { name: 'DB1.x', address: 'DB1.x', datatype: 'Bool', value: true }
        ]);

        assert.equal(state.clearBrowseStateCalls, 1);
        assert.equal(state.writeAddresses.length, 2);
        assert.equal(state.browseFullCalls, 2, 'self-heal must re-explore the DB');
        assert.equal(state.lazyResolveCalls, 0);
    });

    it('does NOT retry or clear browse state on a non-address error', async () => {
        const node = buildEndpoint({});
        const { client, state } = makeMockClient({
            exploreCatalogs: [
                { DB1: [flatExploreSymbol('DB1.x', '8A0E0001.A')] }
            ],
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
        assert.equal(state.browseFullCalls, 1, 'only the initial explore');
    });

    it('returns an ok per-tag result on a successful write', async () => {
        const node = buildEndpoint({});
        const { client } = makeMockClient({
            exploreCatalogs: [
                { DB1: [flatExploreSymbol('DB1.x', '8A0E0001.A')] }
            ],
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

    it('shows writing status while the operation is in flight', async () => {
        const statuses = [];
        let finishWrite;
        const endpoint = {
            resolveAndWrite: () => new Promise((resolve) => { finishWrite = resolve; }),
            writeTags: async () => ({})
        };
        const Ctor = buildOut(endpoint);
        const node = new Ctor({
            endpoint: 'ep',
            symbols: [{ name: 'DB_Binary.Bool_write', address: 'DB_Binary.Bool_write', datatype: 'Bool' }]
        });
        const origStatus = node.status.bind(node);
        node.status = (s) => { statuses.push(s); origStatus(s); };

        const msg = { payload: true };
        const done = runInput(node, msg);
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(statuses[0], { fill: 'blue', shape: 'ring', text: 'writing' });
        finishWrite({ 'DB_Binary.Bool_write': { value: true, status: 'ok', error: '' } });
        await done;
    });

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

    it('rejects hex-only address', async () => {
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
        assert.ok(err instanceof Error);
        assert.match(err.message, /hex access string requires a symbolic name or symbolCrc/);
        assert.equal(calls.writeTags.length, 0);
        assert.equal(calls.resolveAndWrite.length, 0);
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
