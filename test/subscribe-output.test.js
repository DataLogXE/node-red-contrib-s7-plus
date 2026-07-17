'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { _resetRuntimeStateForTests } = require('../nodes/s7complus-subscribe');

const editorSymbols = [
    { name: 'Motor.speed', address: 'Motor.speed', datatype: 'Real' }
];

async function flushDeferred(rounds = 8) {
    for (let i = 0; i < rounds; i++) {
        await new Promise((r) => setImmediate(r));
    }
}

function captureSend(node) {
    node._sendCalls = [];
    node._sent = [];
    node.send = (arg) => {
        node._sendCalls.push(arg);
        if (Array.isArray(arg)) {
            for (const m of arg) node._sent.push(m);
        } else {
            node._sent.push(arg);
        }
    };
}

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
                node._statusCalls = 0;
                node.status = (s) => {
                    node._statusCalls++;
                    node._status = s;
                };
                node.error = (e) => { node._error = e; };
                node.warn = () => {};
                captureSend(node);
            },
            getNode() { return endpointMock; },
            registerType(_name, ctor) { Ctor = ctor; }
        }
    };
    require('../nodes/s7complus-subscribe')(RED);
    return Ctor;
}

function makeEndpoint() {
    const callbacks = [];
    return {
        getStatus: () => 'online',
        subscribe: async (ownerId, symbols, _opts, cb) => {
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
        lastCallback: () => callbacks[callbacks.length - 1]
    };
}

async function waitForSubscribe(endpoint) {
    for (let i = 0; i < 200 && !endpoint.lastCallback(); i++) {
        await new Promise((r) => setImmediate(r));
    }
}

const REF_TO_NAME = new Map([
    [1, { name: 'Motor.speed', datatype: 'Real' }]
]);

function pval(v) {
    return { toJs: () => v };
}

function emitData(endpoint, { seqNum = 1, values = { 1: 1.5 } } = {}) {
    const valueMap = new Map();
    for (const [ref, v] of Object.entries(values)) valueMap.set(Number(ref), pval(v));
    endpoint.lastCallback()({
        type: 'data',
        noti: { seqNum, values: valueMap, errors: new Map(), plcTimestamp: null },
        refToName: REF_TO_NAME
    });
}

describe('subscribe output batch path', () => {
    beforeEach(() => {
        _resetRuntimeStateForTests();
    });

    it('sends multiple notifications in one node.send array call', async () => {
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 100 });
        await waitForSubscribe(endpoint);
        await flushDeferred();

        const statusAfterSub = node._statusCalls;
        emitData(endpoint, { seqNum: 1, values: { 1: 1 } });
        emitData(endpoint, { seqNum: 2, values: { 1: 2 } });
        emitData(endpoint, { seqNum: 3, values: { 1: 3 } });

        await flushDeferred();

        assert.equal(node._sendCalls.length, 1);
        assert.ok(Array.isArray(node._sendCalls[0]));
        assert.equal(node._sendCalls[0].length, 3);
        assert.equal(node._sent.length, 3);
        assert.equal(node._sent[2].payload['Motor.speed'].value, 3);
        assert.equal(node._statusCalls, statusAfterSub + 1);
    });

    it('updates subscribed status immediately without waiting for flush', async () => {
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 100 });
        await waitForSubscribe(endpoint);
        await flushDeferred(2);
        assert.match(node._status.text, /subscribed 1/);
    });

    it('routes resend through the output queue', async (t) => {
        t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint);
        const node = new Ctor({
            endpoint: 'ep',
            symbols: editorSymbols,
            cycleMs: 1000,
            resendEnabled: true,
            resendIntervalS: 60
        });
        await waitForSubscribe(endpoint);
        await flushDeferred();

        emitData(endpoint, { values: { 1: 10 } });
        await flushDeferred();
        assert.equal(node._sent.length, 1);

        t.mock.timers.tick(61_000);
        await flushDeferred();

        assert.ok(node._sendCalls.length >= 2);
        const lastCall = node._sendCalls[node._sendCalls.length - 1];
        assert.ok(Array.isArray(lastCall));
        assert.equal(lastCall[0].payload['Motor.speed'].source, 'cache');
    });
});
