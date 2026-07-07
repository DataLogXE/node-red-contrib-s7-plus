'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');

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

function buildInfo(endpointMock) {
    let Ctor;
    const RED = {
        nodes: {
            createNode(node, config) {
                node.id = (config && config.id) || 'info1';
                const ee = new EventEmitter();
                node.on = ee.on.bind(ee);
                node.emit = ee.emit.bind(ee);
                node.status = (s) => { node._status = s; };
                node.error = (e) => { node._errors = node._errors || []; node._errors.push(e); };
                node.warn = (m) => { node._warnings = node._warnings || []; node._warnings.push(m); };
                node.send = (msg) => {
                    node._sent = node._sent || [];
                    node._sent.push(msg);
                };
            },
            getNode() { return endpointMock; },
            registerType(_name, ctor) { Ctor = ctor; }
        }
    };
    require('../nodes/s7complus-info')(RED);
    return Ctor;
}

describe('endpoint state listeners', () => {
    let lastNode = null;

    afterEach(() => {
        if (lastNode) {
            if (lastNode._watchdogTimer) clearInterval(lastNode._watchdogTimer);
            if (lastNode._reconnectTimer) clearTimeout(lastNode._reconnectTimer);
            lastNode = null;
        }
    });

    it('notifies listeners only when the state value changes', () => {
        const node = buildEndpoint({});
        lastNode = node;
        const events = [];
        node.addStateListener('owner1', (event) => events.push(event));

        node._setStatus('connecting', 'connecting');
        assert.equal(events.length, 1);
        assert.equal(events[0].state, 'connecting');
        assert.equal(events[0].previousState, 'offline');

        node._setStatus('connecting', 'reconnect #1 in 2s');
        assert.equal(events.length, 1, 'same state with new text must not notify');

        node._setStatus('online');
        assert.equal(events.length, 2);
        assert.equal(events[1].state, 'online');
        assert.equal(events[1].previousState, 'connecting');
    });

    it('getConnectionStatePayload returns minimal connection payload', () => {
        // No address in the config: a real address would make the endpoint
        // constructor start an actual TCP connect plus watchdog/reconnect
        // timers, which keeps the test process alive forever. The payload
        // address falls back to client._connectAddress instead.
        const node = buildEndpoint({ address: '', timeout: 5000 });
        lastNode = node;
        node._state = 'offline';
        node.client._connectAddress = '192.168.0.10';

        const payload = node.getConnectionStatePayload({
            state: 'offline',
            previousState: 'online',
            text: 'socket closed'
        });

        assert.equal(payload.plc, undefined);
        assert.equal(payload.connection.address, '192.168.0.10');
        assert.equal(payload.connection.timeoutMs, 5000);
        assert.equal(payload.connection.endpointState, 'offline');
        assert.equal(payload.connection.lastResponseAt, undefined);
        assert.equal(payload.meta.event, 'stateChange');
        assert.equal(payload.meta.previousState, 'online');
    });
});

describe('s7-plus info state changes', () => {
    function makeMockEndpoint(initialState = 'offline') {
        const listeners = new Map();
        return {
            getStatus: () => initialState,
            addStateListener(ownerId, cb) { listeners.set(ownerId, cb); },
            removeStateListener(ownerId) { listeners.delete(ownerId); },
            getConnectionStatePayload(event) {
                return {
                    connection: {
                        address: '192.168.0.10',
                        port: 102,
                        timeoutMs: 10000,
                        connected: false,
                        endpointState: event.state
                    },
                    meta: {}
                };
            },
            getSessionInfo: async () => ({
                plc: { deviceFamily: 'S7-1500', firmware: 'V2.9', orderNumber: '6ES7 510' },
                session: { sessionId: '0x1' },
                limits: { tagsPerReadMax: 20 },
                connection: { endpointState: 'online', connected: true },
                meta: { fetchedAt: '2026-01-01T00:00:00.000Z', elapsedMs: 1, refreshLimits: false }
            }),
            _emit(state, previousState, text) {
                const cb = listeners.get('info1');
                if (cb) cb({ state, previousState, text });
            },
            _listeners: listeners
        };
    }

    it('does not register a listener when stateChanges is false', () => {
        const endpoint = makeMockEndpoint();
        const Ctor = buildInfo(endpoint);
        new Ctor({ id: 'info1', endpoint: 'ep', stateChanges: false });
        assert.equal(endpoint._listeners.size, 0);
    });

    it('emits minimal payload initially when offline', async () => {
        const endpoint = makeMockEndpoint('offline');
        const Ctor = buildInfo(endpoint);
        const node = new Ctor({ id: 'info1', endpoint: 'ep', stateChanges: true });
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(node._sent.length, 1);
        assert.equal(node._sent[0].payload.plc, undefined);
        assert.equal(node._sent[0].payload.connection.endpointState, 'offline');
        assert.equal(node._sent[0].payload.meta.event, 'stateChange');
        assert.equal(node._sent[0].payload.meta.previousState, null);
    });

    it('emits full payload initially when online', async () => {
        const endpoint = makeMockEndpoint('online');
        const Ctor = buildInfo(endpoint);
        const node = new Ctor({ id: 'info1', endpoint: 'ep', stateChanges: true });
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(node._sent.length, 1);
        assert.equal(node._sent[0].payload.plc.deviceFamily, 'S7-1500');
        assert.equal(node._sent[0].payload.meta.event, 'stateChange');
    });

    it('uses getSessionInfo when transitioning to online', async () => {
        let sessionInfoCalls = 0;
        const endpoint = makeMockEndpoint('connecting');
        const origGetSessionInfo = endpoint.getSessionInfo;
        endpoint.getSessionInfo = async (opts) => {
            sessionInfoCalls++;
            assert.equal(opts.refreshLimits, false);
            return origGetSessionInfo(opts);
        };

        const Ctor = buildInfo(endpoint);
        const node = new Ctor({ id: 'info1', endpoint: 'ep', stateChanges: true });
        await new Promise((resolve) => setImmediate(resolve));
        node._sent = [];

        endpoint._emit('online', 'connecting', 'online');
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(sessionInfoCalls, 1);
        assert.equal(node._sent[0].payload.plc.deviceFamily, 'S7-1500');
        assert.equal(node._sent[0].payload.meta.previousState, 'connecting');
    });

    it('uses minimal payload for online to connecting without getSessionInfo', async () => {
        let sessionInfoCalls = 0;
        let minimalCalls = 0;
        const endpoint = makeMockEndpoint('offline');
        endpoint.getSessionInfo = async () => {
            sessionInfoCalls++;
            return { plc: { deviceFamily: 'S7-1500' }, connection: {}, meta: {} };
        };
        const origMinimal = endpoint.getConnectionStatePayload.bind(endpoint);
        endpoint.getConnectionStatePayload = (event) => {
            minimalCalls++;
            return origMinimal(event);
        };

        const Ctor = buildInfo(endpoint);
        const node = new Ctor({ id: 'info1', endpoint: 'ep', stateChanges: true });
        await new Promise((resolve) => setImmediate(resolve));
        node._sent = [];
        sessionInfoCalls = 0;
        minimalCalls = 0;

        endpoint._emit('connecting', 'online', 'reconnecting');
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(minimalCalls, 1);
        assert.equal(sessionInfoCalls, 0);
        assert.equal(node._sent[0].payload.plc, undefined);
        assert.equal(node._sent[0].payload.connection.endpointState, 'connecting');
        assert.equal(node._sent[0].payload.connection.lastResponseAt, undefined);
        assert.equal(node._sent[0].payload.meta.previousState, 'online');
    });

    it('removes listener on close', async () => {
        const endpoint = makeMockEndpoint('offline');
        const Ctor = buildInfo(endpoint);
        const node = new Ctor({ id: 'info1', endpoint: 'ep', stateChanges: true });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(endpoint._listeners.size, 1);

        node.emit('close');
        assert.equal(endpoint._listeners.size, 0);
    });
});
