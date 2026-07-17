'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { _resetRuntimeStateForTests } = require('../nodes/s7complus-subscribe');

const editorSymbols = [
    { name: 'Motor.speed', address: 'Motor.speed', datatype: 'Int' },
    { name: 'Tank.level', address: 'Tank.level', datatype: 'Int' }
];

function buildSubscribe(endpointMock) {
    let Ctor;
    const RED = {
        nodes: {
            createNode(node) {
                const ee = new EventEmitter();
                node.on = ee.on.bind(ee);
                node.emit = ee.emit.bind(ee);
                node.removeListener = ee.removeListener.bind(ee);
                node.id = 'sub1';
                node.status = (s) => { node._status = s; };
                node.error = (e) => { node._error = e; };
                node.warn = () => {};
                node._sent = [];
                node.send = (arg) => {
                    if (Array.isArray(arg)) {
                        for (const m of arg) node._sent.push(m);
                    } else {
                        node._sent.push(arg);
                    }
                };
            },
            getNode() { return endpointMock; },
            registerType(_name, ctor) { Ctor = ctor; }
        }
    };
    require('../nodes/s7complus-subscribe')(RED);
    return Ctor;
}

function makeEndpoint() {
    let callCount = 0;
    let status = 'online';
    const callbacks = [];
    return {
        getStatus: () => status,
        setStatus: (s) => { status = s; },
        subscribe: async (ownerId, symbols, _opts, cb) => {
            callCount++;
            callbacks.push(cb);
            if (cb) {
                cb({ type: 'status', state: 'subscribed', itemCount: symbols.length, resolveErrors: {} });
            }
            return {
                ownerNodeId: ownerId,
                symbols: [...symbols],
                subscriptionObjectId: 1
            };
        },
        unsubscribe: async () => {},
        callCount: () => callCount,
        lastCallback: () => callbacks[callbacks.length - 1]
    };
}

async function waitForSubscribe(endpoint, minCalls = 1) {
    for (let i = 0; i < 200 && endpoint.callCount() < minCalls; i++) {
        await new Promise((r) => setImmediate(r));
    }
}

function runInput(node, msg) {
    return new Promise((resolve) => {
        node.emit('input', msg, () => {}, (err) => resolve({ err, msg }));
    });
}

function runClose(node, removed) {
    return new Promise((resolve) => {
        node.emit('close', removed, resolve);
    });
}

const REF_TO_NAME = new Map([
    [1, { name: 'Motor.speed', datatype: 'Int' }],
    [2, { name: 'Tank.level', datatype: 'Int' }]
]);

function pval(v) {
    return { toJs: () => v };
}

async function flushOutput() {
    for (let i = 0; i < 8; i++) {
        await new Promise((r) => setImmediate(r));
    }
}

/** Push a fake PLC notification through the endpoint data callback. */
async function emitData(endpoint, { seqNum = 1, values = {}, errors = {}, plcTimestamp = null } = {}) {
    const valueMap = new Map();
    for (const [ref, v] of Object.entries(values)) valueMap.set(Number(ref), pval(v));
    const errorMap = new Map();
    for (const [ref, code] of Object.entries(errors)) errorMap.set(Number(ref), code);
    endpoint.lastCallback()({
        type: 'data',
        noti: { seqNum, values: valueMap, errors: errorMap, plcTimestamp },
        refToName: REF_TO_NAME
    });
    await flushOutput();
}

async function makeNode(t, endpoint, config) {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
    const Ctor = buildSubscribe(endpoint);
    const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000, ...config });
    await waitForSubscribe(endpoint);
    return node;
}

describe('subscribe resend option', () => {
    beforeEach(() => {
        _resetRuntimeStateForTests();
    });

    it('live messages carry source "plc" and msgTimestamp', async (t) => {
        const endpoint = makeEndpoint();
        const node = await makeNode(t, endpoint, {});
        const plcTs = new Date(999_000);
        await emitData(endpoint, { values: { 1: 10 }, plcTimestamp: plcTs });

        assert.equal(node._sent.length, 1);
        const entry = node._sent[0].payload['Motor.speed'];
        assert.equal(entry.value, 10);
        assert.equal(entry.source, 'plc');
        assert.ok(entry.msgTimestamp instanceof Date);
        assert.equal(entry.plcTimestamp, plcTs);
        // msg.timestamp is the send time, not the PLC change timestamp.
        assert.ok(node._sent[0].timestamp instanceof Date);
        assert.equal(node._sent[0].timestamp, entry.msgTimestamp);
    });

    it('resends only stale symbols with source "cache" and original plcTimestamp', async (t) => {
        const endpoint = makeEndpoint();
        const node = await makeNode(t, endpoint, { resendEnabled: true, resendIntervalS: 60 });
        const plcTs = new Date(999_000);
        await emitData(endpoint, { values: { 1: 10, 2: 20 }, plcTimestamp: plcTs });
        assert.equal(node._sent.length, 1);

        // 30 s later only Motor.speed changes -> its resend clock restarts.
        t.mock.timers.tick(30_000);
        await emitData(endpoint, { seqNum: 2, values: { 1: 11 }, plcTimestamp: new Date(1_029_000) });
        assert.equal(node._sent.length, 2);

        // At t=+61 s only Tank.level (unchanged since t=0) is stale.
        t.mock.timers.tick(31_000);
        await flushOutput();
        assert.equal(node._sent.length, 3);
        const msg = node._sent[2];
        assert.deepEqual(Object.keys(msg.payload), ['Tank.level']);
        const entry = msg.payload['Tank.level'];
        assert.equal(entry.value, 20);
        assert.equal(entry.status, 'ok');
        assert.equal(entry.source, 'cache');
        assert.equal(entry.plcTimestamp, plcTs);
        assert.ok(entry.msgTimestamp instanceof Date);
        assert.ok(entry.msgTimestamp.getTime() > plcTs.getTime());
        assert.ok(msg.timestamp instanceof Date);
        assert.match(node._status.text, /resent 1/);

        // 30 s later Motor.speed (last live at t=+30 s) becomes stale too.
        t.mock.timers.tick(30_000);
        await flushOutput();
        assert.equal(node._sent.length, 4);
        assert.deepEqual(Object.keys(node._sent[3].payload), ['Motor.speed']);
        assert.equal(node._sent[3].payload['Motor.speed'].source, 'cache');
    });

    it('resend clock restarts after a resend', async (t) => {
        const endpoint = makeEndpoint();
        const node = await makeNode(t, endpoint, { resendEnabled: true, resendIntervalS: 60 });
        await emitData(endpoint, { values: { 1: 10 } });

        t.mock.timers.tick(60_000);
        await flushOutput();
        assert.equal(node._sent.length, 2);
        // Not stale again until another full interval elapsed.
        t.mock.timers.tick(30_000);
        assert.equal(node._sent.length, 2);
        t.mock.timers.tick(30_000);
        await flushOutput();
        assert.equal(node._sent.length, 3);
    });

    it('resends error states with the stored error', async (t) => {
        const endpoint = makeEndpoint();
        const node = await makeNode(t, endpoint, { resendEnabled: true, resendIntervalS: 60 });
        await emitData(endpoint, { values: { 1: 10 }, errors: { 2: 0xdead } });

        t.mock.timers.tick(60_000);
        await flushOutput();
        assert.equal(node._sent.length, 2);
        const entry = node._sent[1].payload['Tank.level'];
        assert.equal(entry.status, 'error');
        assert.match(entry.error, /0xdead/);
        assert.equal(entry.value, null);
        assert.equal(entry.source, 'cache');
    });

    it('supports array output format', async (t) => {
        const endpoint = makeEndpoint();
        const node = await makeNode(t, endpoint, {
            resendEnabled: true, resendIntervalS: 60, outputFormat: 'array'
        });
        await emitData(endpoint, { values: { 1: 10, 2: 20 } });

        t.mock.timers.tick(60_000);
        await flushOutput();
        assert.equal(node._sent.length, 2);
        const payload = node._sent[1].payload;
        assert.ok(Array.isArray(payload));
        assert.deepEqual(payload.map((e) => e.symbol).sort(), ['Motor.speed', 'Tank.level']);
        assert.ok(payload.every((e) => e.source === 'cache'));
    });

    it('pauses resend while the endpoint is offline', async (t) => {
        const endpoint = makeEndpoint();
        const node = await makeNode(t, endpoint, { resendEnabled: true, resendIntervalS: 60 });
        await emitData(endpoint, { values: { 1: 10 } });

        endpoint.setStatus('connecting');
        t.mock.timers.tick(120_000);
        assert.equal(node._sent.length, 1);

        // Back online: the stale value goes out on the next scan.
        endpoint.setStatus('online');
        t.mock.timers.tick(1_000);
        await flushOutput();
        assert.equal(node._sent.length, 2);
        assert.equal(node._sent[1].payload['Motor.speed'].source, 'cache');
    });

    it('does not resend when the option is disabled', async (t) => {
        const endpoint = makeEndpoint();
        const node = await makeNode(t, endpoint, {});
        await emitData(endpoint, { values: { 1: 10 } });

        t.mock.timers.tick(600_000);
        assert.equal(node._sent.length, 1);
    });

    it('close stops the resend timer', async (t) => {
        const endpoint = makeEndpoint();
        const node = await makeNode(t, endpoint, { resendEnabled: true, resendIntervalS: 60 });
        await emitData(endpoint, { values: { 1: 10 } });

        await runClose(node, false);
        t.mock.timers.tick(120_000);
        assert.equal(node._sent.length, 1);
    });

    it('unsubscribe via empty msg.symbols clears the cache', async (t) => {
        const endpoint = makeEndpoint();
        const node = await makeNode(t, endpoint, { resendEnabled: true, resendIntervalS: 60 });
        await emitData(endpoint, { values: { 1: 10 } });

        await runInput(node, { symbols: [] });
        t.mock.timers.tick(120_000);
        assert.equal(node._sent.length, 1);
    });

    it('re-subscribe purges cached values of removed symbols', async (t) => {
        const endpoint = makeEndpoint();
        const node = await makeNode(t, endpoint, { resendEnabled: true, resendIntervalS: 60 });
        await emitData(endpoint, { values: { 1: 10, 2: 20 } });

        // Override drops Tank.level from the subscription.
        await runInput(node, { symbols: ['Motor.speed'] });
        assert.equal(endpoint.callCount(), 2);

        t.mock.timers.tick(60_000);
        await flushOutput();
        assert.equal(node._sent.length, 2);
        assert.deepEqual(Object.keys(node._sent[1].payload), ['Motor.speed']);
    });
});
