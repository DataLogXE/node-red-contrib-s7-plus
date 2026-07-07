'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const {
    resolveSubscribePaths,
    pathsEqual,
    computeRuntimeAdds,
    restoreSubscribePaths,
    restoreSubscribePathsFromState,
    readRuntimeState,
    persistSubscriptionState,
    clearSubscriptionState,
    parseCloseArgs,
    _resetRuntimeStateForTests,
    CTX_RUNTIME_ADDS,
    CTX_OVERRIDE
} = require('../nodes/s7complus-subscribe');

const editorSymbols = [
    { name: 'Motor.speed', address: 'Motor.speed', datatype: 'Int' },
    { name: 'Tank.level', address: 'Tank.level', datatype: 'Real' }
];

describe('resolveSubscribePaths', () => {
    it('returns editor symbolic paths on empty message', () => {
        assert.deepEqual(
            [...resolveSubscribePaths({}, editorSymbols)].sort(),
            ['Motor.speed', 'Tank.level']
        );
    });

    it('msg.symbols replaces editor configuration', () => {
        assert.deepEqual(resolveSubscribePaths({ symbols: ['Pump.on'] }, editorSymbols), ['Pump.on']);
    });

    it('msg.symbols empty array replaces editor with empty list', () => {
        assert.deepEqual(resolveSubscribePaths({ symbols: [] }, editorSymbols), []);
    });

    it('msg.addSymbols merges with editor symbols', () => {
        assert.deepEqual(
            [...resolveSubscribePaths({ addSymbols: ['DB1.temp'] }, editorSymbols)].sort(),
            ['DB1.temp', 'Motor.speed', 'Tank.level']
        );
    });

    it('msg.symbols and msg.addSymbols combine without duplicates', () => {
        assert.deepEqual(
            [...resolveSubscribePaths({
                symbols: ['Motor.speed'],
                addSymbols: ['Motor.speed', 'Extra.tag']
            }, editorSymbols)].sort(),
            ['Extra.tag', 'Motor.speed']
        );
    });

    it('rejects invalid msg.symbols', () => {
        assert.throws(
            () => resolveSubscribePaths({ symbols: [{ name: 'Pump.on' }] }, editorSymbols),
            /array of strings/
        );
    });

    it('ignores hex-only strings in msg.symbols', () => {
        assert.deepEqual(
            resolveSubscribePaths({ symbols: ['8A0E0001.A'] }, editorSymbols),
            []
        );
    });
});

describe('pathsEqual', () => {
    it('returns true for same set in different order', () => {
        assert.equal(pathsEqual(['a', 'b'], ['b', 'a']), true);
    });

    it('returns false when lengths differ', () => {
        assert.equal(pathsEqual(['a'], ['a', 'b']), false);
    });

    it('returns false when members differ', () => {
        assert.equal(pathsEqual(['a', 'b'], ['a', 'c']), false);
    });
});

describe('subscription deploy persistence helpers', () => {
    function makeContext() {
        const store = new Map();
        return {
            get: (k) => store.get(k),
            set: (k, v) => {
                if (v === undefined) store.delete(k);
                else store.set(k, v);
            },
            delete: (k) => store.delete(k),
            store
        };
    }

    beforeEach(() => {
        _resetRuntimeStateForTests();
    });

    it('computeRuntimeAdds returns paths beyond editor config', () => {
        const full = ['Motor.speed', 'Tank.level', 'DB1.temp'];
        assert.deepEqual(computeRuntimeAdds(full, editorSymbols), ['DB1.temp']);
    });

    it('restoreSubscribePaths merges persisted adds with editor config', () => {
        const ctx = makeContext();
        ctx.set(CTX_RUNTIME_ADDS, ['DB1.temp']);
        assert.deepEqual(
            [...restoreSubscribePaths(editorSymbols, ctx)].sort(),
            ['DB1.temp', 'Motor.speed', 'Tank.level']
        );
    });

    it('restoreSubscribePaths applies override from context', () => {
        const ctx = makeContext();
        ctx.set(CTX_OVERRIDE, ['Pump.on']);
        ctx.set(CTX_RUNTIME_ADDS, ['Extra.tag']);
        assert.deepEqual(
            [...restoreSubscribePaths(editorSymbols, ctx)].sort(),
            ['Extra.tag', 'Pump.on']
        );
    });

    it('persistSubscriptionState stores runtime adds and override', () => {
        const ctx = makeContext();
        persistSubscriptionState(
            'sub1',
            ctx,
            ['Pump.on', 'Extra.tag'],
            editorSymbols,
            { overrideSymbols: ['Pump.on'] }
        );
        assert.deepEqual(readRuntimeState('sub1', ctx).runtimeAddSymbols, ['Pump.on', 'Extra.tag']);
        assert.deepEqual(readRuntimeState('sub1', ctx).overrideSymbols, ['Pump.on']);
        assert.deepEqual(ctx.get(CTX_RUNTIME_ADDS), ['Pump.on', 'Extra.tag']);
        assert.deepEqual(ctx.get(CTX_OVERRIDE), ['Pump.on']);
    });

    it('clearSubscriptionState removes persisted keys', () => {
        const ctx = makeContext();
        persistSubscriptionState('sub1', ctx, ['DB1.temp', 'Motor.speed'], editorSymbols, {});
        clearSubscriptionState('sub1', ctx);
        assert.deepEqual(readRuntimeState('sub1', ctx), {});
        assert.equal(ctx.get(CTX_RUNTIME_ADDS), undefined);
        assert.equal(ctx.get(CTX_OVERRIDE), undefined);
    });

    it('parseCloseArgs handles deploy and removal signatures', () => {
        const done = () => {};
        assert.deepEqual(parseCloseArgs([done]), { removed: false, done });
        assert.deepEqual(parseCloseArgs([false, done]), { removed: false, done });
        assert.deepEqual(parseCloseArgs([true, done]), { removed: true, done });
    });
});

describe('s7-plus subscribe input routing', () => {
    function makeContextStore() {
        return new Map();
    }

    beforeEach(() => {
        _resetRuntimeStateForTests();
    });

    function buildSubscribe(endpointMock, contextStore = makeContextStore()) {
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
                    node.send = () => {};
                    if (contextStore) {
                        node.context = () => ({
                            get: (k) => contextStore.get(k),
                            set: (k, v) => {
                                if (v === undefined) contextStore.delete(k);
                                else contextStore.set(k, v);
                            },
                            delete: (k) => contextStore.delete(k)
                        });
                    }
                },
                getNode() { return endpointMock; },
                registerType(_name, ctor) { Ctor = ctor; }
            }
        };
        require('../nodes/s7complus-subscribe')(RED);
        return Ctor;
    }

    function runInput(node, msg) {
        return new Promise((resolve) => {
            node.emit('input', msg, () => {}, (err) => resolve({ err, msg }));
        });
    }

    function makeEndpoint({ established = true, status = 'online' } = {}) {
        let callCount = 0;
        const subscribed = [];
        const unsubscribed = [];
        const optsSeen = [];
        return {
            getStatus: () => status,
            subscribe: async (ownerId, symbols, opts, cb) => {
                callCount++;
                subscribed.push([...symbols]);
                optsSeen.push(opts);
                if (cb) {
                    if (established) {
                        cb({ type: 'status', state: 'subscribed', itemCount: symbols.length, resolveErrors: {} });
                    } else {
                        cb({ type: 'status', state: 'error', text: 'establish failed' });
                    }
                }
                return {
                    ownerNodeId: ownerId,
                    symbols: [...symbols],
                    subscriptionObjectId: established ? 1 : 0
                };
            },
            unsubscribe: async (ownerId) => { unsubscribed.push(ownerId); },
            callCount: () => callCount,
            subscribed: () => subscribed,
            unsubscribed: () => unsubscribed,
            optsSeen: () => optsSeen
        };
    }

    async function waitForSubscribe(endpoint, minCalls = 1) {
        const start = Date.now();
        while (endpoint.callCount() < minCalls && Date.now() - start < 2000) {
            await new Promise((r) => setImmediate(r));
        }
    }

    it('subscribes on deploy with editor symbols', async () => {
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint);
        new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        assert.equal(endpoint.callCount(), 1);
        assert.deepEqual(
            [...endpoint.subscribed()[0]].sort(),
            ['Motor.speed', 'Tank.level']
        );
    });

    it('does not re-subscribe when input yields the same symbol list', async () => {
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        const { err } = await runInput(node, {});
        assert.equal(err, undefined);
        assert.equal(endpoint.callCount(), 1);
    });

    it('re-subscribes when input changes the symbol list', async () => {
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        const { err } = await runInput(node, { addSymbols: ['DB1.temp'] });
        assert.equal(err, undefined);
        assert.equal(endpoint.callCount(), 2);
        assert.deepEqual(
            [...endpoint.subscribed()[1]].sort(),
            ['DB1.temp', 'Motor.speed', 'Tank.level']
        );
    });

    it('rejects invalid msg.symbols on input', async () => {
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        const { err } = await runInput(node, { symbols: [{ name: 'Pump.on' }] });
        assert.ok(err instanceof Error);
        assert.match(err.message, /array of strings/);
        assert.equal(endpoint.callCount(), 1);
    });

    it('errors when no symbols are available', async () => {
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: [], cycleMs: 1000 });
        const { err } = await runInput(node, {});
        assert.ok(err instanceof Error);
        assert.match(err.message, /No symbols configured/);
        assert.equal(endpoint.callCount(), 0);
    });

    it('unsubscribes when msg.symbols is an empty array', async () => {
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        const { err } = await runInput(node, { symbols: [] });
        assert.equal(err, undefined);
        assert.equal(endpoint.callCount(), 1);
        assert.deepEqual(endpoint.unsubscribed(), ['sub1']);
        assert.match(node._status.text, /waiting for symbols/);
    });

    it('unsubscribes idempotently when not yet subscribed', async () => {
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: [], cycleMs: 1000 });
        const { err } = await runInput(node, { symbols: [] });
        assert.equal(err, undefined);
        assert.equal(endpoint.callCount(), 0);
        assert.deepEqual(endpoint.unsubscribed(), ['sub1']);
        assert.match(node._status.text, /waiting for symbols/);
    });

    it('ignores addSymbols when msg.symbols is an empty array', async () => {
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        const { err } = await runInput(node, { symbols: [], addSymbols: ['DB1.temp'] });
        assert.equal(err, undefined);
        assert.equal(endpoint.callCount(), 1);
        assert.deepEqual(endpoint.unsubscribed(), ['sub1']);
    });

    it('passes only cycleMs as subscription options (no routeMode/creditLimit)', async () => {
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint);
        new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 500 });
        await waitForSubscribe(endpoint);
        assert.deepEqual(endpoint.optsSeen()[0], { cycleMs: 500 });
    });

    it('re-inject with the same symbols retries after a failed establish', async () => {
        const endpoint = makeEndpoint({ established: false });
        const Ctor = buildSubscribe(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        assert.equal(endpoint.callCount(), 1);

        // Same symbol list, but the subscription is not established:
        // the node must NOT short-circuit and must call subscribe again.
        const { err } = await runInput(node, {});
        assert.equal(err, undefined);
        assert.equal(endpoint.callCount(), 2);
    });

    it('re-inject with the same symbols short-circuits while endpoint is offline', async () => {
        // Not established because the endpoint is offline: the reconnect
        // handler re-creates the subscription, so the symbols count as
        // active and a same-list re-inject stays a no-op.
        const endpoint = makeEndpoint({ established: false, status: 'connecting' });
        const Ctor = buildSubscribe(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        assert.equal(endpoint.callCount(), 1);

        const { err } = await runInput(node, {});
        assert.equal(err, undefined);
        assert.equal(endpoint.callCount(), 1);
    });

    it('skips input while subscribe is in flight', async () => {
        const endpoint = makeEndpoint();
        const origSubscribe = endpoint.subscribe.bind(endpoint);
        endpoint.subscribe = async (ownerId, symbols, opts, cb) => {
            await origSubscribe(ownerId, symbols, opts, cb);
            await new Promise((r) => setTimeout(r, 50));
        };
        const Ctor = buildSubscribe(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        const countAfterDeploy = endpoint.callCount();

        const p1 = runInput(node, { addSymbols: ['DB1.a'] });
        const p2 = runInput(node, { addSymbols: ['DB1.b'] });
        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1.err, undefined);
        assert.equal(r2.err, undefined);
        assert.equal(endpoint.callCount(), countAfterDeploy + 1);
        assert.match(node._status.text, /skipped \(busy\)/);
    });
});

describe('subscribe deploy persistence', () => {
    function makeContextStore() {
        return new Map();
    }

    beforeEach(() => {
        _resetRuntimeStateForTests();
    });

    function buildSubscribe(endpointMock, contextStore = makeContextStore()) {
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
                    node.send = () => {};
                    if (contextStore) {
                        node.context = () => ({
                            get: (k) => contextStore.get(k),
                            set: (k, v) => {
                                if (v === undefined) contextStore.delete(k);
                                else contextStore.set(k, v);
                            },
                            delete: (k) => contextStore.delete(k)
                        });
                    }
                },
                getNode() { return endpointMock; },
                registerType(_name, ctor) { Ctor = ctor; }
            }
        };
        require('../nodes/s7complus-subscribe')(RED);
        return Ctor;
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

    function makeEndpoint() {
        let callCount = 0;
        const subscribed = [];
        const unsubscribed = [];
        return {
            subscribe: async (_ownerId, symbols, _opts, cb) => {
                callCount++;
                subscribed.push([...symbols]);
                if (cb) {
                    cb({ type: 'status', state: 'subscribed', itemCount: symbols.length, resolveErrors: {} });
                }
            },
            unsubscribe: async (ownerId) => { unsubscribed.push(ownerId); },
            callCount: () => callCount,
            subscribed: () => subscribed,
            unsubscribed: () => unsubscribed
        };
    }

    async function waitForSubscribe(endpoint, minCalls = 1) {
        const start = Date.now();
        while (endpoint.callCount() < minCalls && Date.now() - start < 2000) {
            await new Promise((r) => setImmediate(r));
        }
    }

    it('runtime addSymbols survive deploy restart without context store', async () => {
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint, null);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        await runInput(node, { addSymbols: ['DB1.temp'] });
        assert.equal(endpoint.callCount(), 2);

        await runClose(node, false);
        assert.deepEqual(endpoint.unsubscribed(), []);

        const node2 = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint, 3);
        assert.deepEqual(
            [...endpoint.subscribed()[2]].sort(),
            ['DB1.temp', 'Motor.speed', 'Tank.level']
        );
    });

    it('runtime addSymbols survive deploy restart', async () => {
        const ctx = makeContextStore();
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint, ctx);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        await runInput(node, { addSymbols: ['DB1.temp'] });
        assert.equal(endpoint.callCount(), 2);

        await runClose(node, false);
        assert.deepEqual(endpoint.unsubscribed(), []);

        const node2 = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint, 3);
        assert.deepEqual(
            [...endpoint.subscribed()[2]].sort(),
            ['DB1.temp', 'Motor.speed', 'Tank.level']
        );
    });

    it('msg.symbols override survives deploy restart', async () => {
        const ctx = makeContextStore();
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint, ctx);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        await runInput(node, { symbols: ['Pump.on', 'Pump.speed'] });
        assert.equal(endpoint.callCount(), 2);

        await runClose(node, false);

        const node2 = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint, 3);
        assert.deepEqual(
            [...endpoint.subscribed()[2]].sort(),
            ['Pump.on', 'Pump.speed']
        );
    });

    it('editor changes apply while runtime adds persist across deploy', async () => {
        const ctx = makeContextStore();
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint, ctx);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        await runInput(node, { addSymbols: ['DB1.temp'] });
        await runClose(node, false);

        const reducedEditor = [{ name: 'Motor.speed', address: 'Motor.speed', datatype: 'Int' }];
        const node2 = new Ctor({ endpoint: 'ep', symbols: reducedEditor, cycleMs: 1000 });
        await waitForSubscribe(endpoint, 3);
        assert.deepEqual(
            [...endpoint.subscribed()[2]].sort(),
            ['DB1.temp', 'Motor.speed']
        );
    });

    it('node removal unsubscribes and clears context', async () => {
        const ctx = makeContextStore();
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint, ctx);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        await runInput(node, { addSymbols: ['DB1.temp'] });
        assert.ok(ctx.has(CTX_RUNTIME_ADDS));

        await runClose(node, true);
        assert.deepEqual(endpoint.unsubscribed(), ['sub1']);
        assert.equal(ctx.get(CTX_RUNTIME_ADDS), undefined);
        assert.equal(ctx.get(CTX_OVERRIDE), undefined);
    });

    it('deploy without runtime adds keeps editor-only behaviour', async () => {
        const ctx = makeContextStore();
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint, ctx);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        await runClose(node, false);

        const node2 = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint, 2);
        assert.deepEqual(
            [...endpoint.subscribed()[1]].sort(),
            ['Motor.speed', 'Tank.level']
        );
    });

    it('close with legacy done-only signature keeps runtime state', async () => {
        const endpoint = makeEndpoint();
        const Ctor = buildSubscribe(endpoint, null);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint);
        await runInput(node, { addSymbols: ['DB1.temp'] });

        await new Promise((resolve) => node.emit('close', resolve));

        const node2 = new Ctor({ endpoint: 'ep', symbols: editorSymbols, cycleMs: 1000 });
        await waitForSubscribe(endpoint, 3);
        assert.deepEqual(
            [...endpoint.subscribed()[2]].sort(),
            ['DB1.temp', 'Motor.speed', 'Tank.level']
        );
    });
});

describe('endpoint resubscribe', () => {
    function buildEndpoint() {
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
        return new Ctor({ id: 'ep', address: '', timeout: 5000 });
    }

    it('deletes the old PLC subscription before creating a new one', async () => {
        const deleted = [];
        const created = [];
        const node = buildEndpoint();
        node.client._connected = true;
        node.client.browseResolveSymbolicBatch = async (paths) =>
            paths.map(() => ({
                address: '8A0E0001.A',
                crcMeta: { memberName: 'Test2', softdatatype: 'DInt' },
                datatype: 'DInt'
            }));
        node.client.deleteSubscription = async (id) => { deleted.push(id); };
        node.client.createSubscription = async () => {
            const id = created.length + 1;
            created.push(id);
            return { subscriptionObjectId: id, refToName: new Map([[1, { name: 'DB1.x', datatype: 'Int' }]]) };
        };

        await node.subscribe('owner1', ['DB1.a'], { cycleMs: 500, routeMode: 0x20, creditLimit: -1 });
        assert.deepEqual(deleted, []);
        assert.deepEqual(created, [1]);

        await node.subscribe('owner1', ['DB1.b'], { cycleMs: 500, routeMode: 0x20, creditLimit: -1 });
        assert.deepEqual(deleted, [1]);
        assert.deepEqual(created, [1, 2]);
    });

    it('reuses existing PLC subscription when symbols are unchanged', async () => {
        const deleted = [];
        const created = [];
        const node = buildEndpoint();
        node.client._connected = true;
        node.client.browseResolveSymbolicBatch = async (paths) =>
            paths.map(() => ({
                address: '8A0E0001.A',
                crcMeta: { memberName: 'Test2', softdatatype: 'DInt' },
                datatype: 'DInt'
            }));
        node.client.deleteSubscription = async (id) => { deleted.push(id); };
        node.client.createSubscription = async () => {
            const id = created.length + 1;
            created.push(id);
            return { subscriptionObjectId: id, refToName: new Map([[1, { name: 'DB1.a', datatype: 'Int' }]]) };
        };

        await node.subscribe('owner1', ['DB1.a'], { cycleMs: 500, routeMode: 0x20, creditLimit: -1 });
        await node.subscribe('owner1', ['DB1.a'], { cycleMs: 500, routeMode: 0x20, creditLimit: -1 });
        assert.deepEqual(deleted, []);
        assert.deepEqual(created, [1]);
    });

    it('recreates the subscription when only the cycle time changes', async () => {
        const deleted = [];
        const created = [];
        const node = buildEndpoint();
        node.client._connected = true;
        node.client.browseResolveSymbolicBatch = async (paths) =>
            paths.map(() => ({
                address: '8A0E0001.A',
                crcMeta: { memberName: 'Test2', softdatatype: 'DInt' },
                datatype: 'DInt'
            }));
        node.client.deleteSubscription = async (id) => { deleted.push(id); };
        node.client.createSubscription = async (opts) => {
            const id = created.length + 1;
            created.push({ id, cycleMs: opts.cycleMs });
            return { subscriptionObjectId: id, refToName: new Map([[1, { name: 'DB1.a', datatype: 'Int' }]]) };
        };

        await node.subscribe('owner1', ['DB1.a'], { cycleMs: 500 });
        await node.subscribe('owner1', ['DB1.a'], { cycleMs: 250 });
        assert.deepEqual(deleted, [1]);
        assert.deepEqual(created.map((c) => c.cycleMs), [500, 250]);
    });

    it('replays a notification that raced the CreateObject response', async () => {
        const node = buildEndpoint();
        node.client._connected = true;
        node.client.browseResolveSymbolicBatch = async (paths) =>
            paths.map(() => ({
                address: '8A0E0001.A',
                crcMeta: { memberName: 'Test2', softdatatype: 'DInt' },
                datatype: 'DInt'
            }));
        node.client.createSubscription = async () => {
            // Simulate the PLC pushing the initial full-value snapshot in
            // the same TCP segment as the CreateObject response: the
            // notification is dispatched BEFORE the awaiting caller learns
            // the subscription object id.
            node.client.emit('notification', {
                subscriptionId: 42,
                seqNum: 1,
                values: new Map(),
                errors: new Map()
            });
            return { subscriptionObjectId: 42, refToName: new Map([[1, { name: 'DB1.a', datatype: 'Int' }]]) };
        };

        const events = [];
        await node.subscribe('owner1', ['DB1.a'], { cycleMs: 500 }, (e) => events.push(e));

        const dataEvents = events.filter((e) => e.type === 'data');
        assert.equal(dataEvents.length, 1);
        assert.equal(dataEvents[0].noti.subscriptionId, 42);
        assert.equal(dataEvents[0].noti.seqNum, 1);
        assert.ok(dataEvents[0].refToName instanceof Map);
    });

    it('discards buffered notifications of a deleted subscription (no stale replay on id reuse)', async () => {
        const node = buildEndpoint();
        node.client._connected = true;
        node.client.browseResolveSymbolicBatch = async (paths) =>
            paths.map(() => ({
                address: '8A0E0001.A',
                crcMeta: { memberName: 'Test2', softdatatype: 'DInt' },
                datatype: 'DInt'
            }));
        node.client.deleteSubscription = async () => {};
        let createCount = 0;
        node.client.createSubscription = async () => {
            createCount++;
            // The PLC reuses object id 42 for the second subscription.
            return { subscriptionObjectId: 42, refToName: new Map([[1, { name: `DB1.sym${createCount}`, datatype: 'Int' }]]) };
        };

        const events = [];
        await node.subscribe('owner1', ['DB1.a'], { cycleMs: 500 }, (e) => events.push(e));

        // A late notification of subscription 42 arrives while the owner
        // resubscribes (routing already removed) — it gets buffered.
        node._subsByObjId.delete(42);
        node.client.emit('notification', {
            subscriptionId: 42,
            seqNum: 777,
            values: new Map(),
            errors: new Map()
        });
        assert.equal(node._pendingNotifications.size, 1);

        // Resubscribe with different symbols: delete + recreate, and the
        // new subscription reuses id 42. The stale notification must NOT
        // be replayed into it.
        await node.subscribe('owner1', ['DB1.b'], { cycleMs: 500 }, (e) => events.push(e));

        const dataEvents = events.filter((e) => e.type === 'data');
        assert.equal(dataEvents.length, 0);
        assert.equal(node._pendingNotifications.size, 0);
    });

    it('serializes concurrent subscribes per owner (no orphaned PLC subscription)', async () => {
        const deleted = [];
        const created = [];
        const node = buildEndpoint();
        node.client._connected = true;
        node.client.browseResolveSymbolicBatch = async (paths) =>
            paths.map(() => ({
                address: '8A0E0001.A',
                crcMeta: { memberName: 'Test2', softdatatype: 'DInt' },
                datatype: 'DInt'
            }));
        node.client.deleteSubscription = async (id) => { deleted.push(id); };
        node.client.createSubscription = async () => {
            // Slow create: without per-owner serialization both concurrent
            // subscribes would reach this point and create two objects.
            await new Promise((r) => setTimeout(r, 20));
            const id = created.length + 1;
            created.push(id);
            return { subscriptionObjectId: id, refToName: new Map([[1, { name: 'DB1.a', datatype: 'Int' }]]) };
        };

        // Same owner, same symbols/options — mirrors deploy-initiated
        // subscribe racing an "inject once after startup" message.
        const [r1, r2] = await Promise.all([
            node.subscribe('owner1', ['DB1.a'], { cycleMs: 500 }),
            node.subscribe('owner1', ['DB1.a'], { cycleMs: 500 })
        ]);

        assert.deepEqual(created, [1]);
        assert.deepEqual(deleted, []);
        assert.equal(r1.subscriptionObjectId, 1);
        assert.equal(r2.subscriptionObjectId, 1);
        assert.equal(node._subsByObjId.size, 1);
    });

    it('serializes concurrent subscribes with different symbols (delete before recreate)', async () => {
        const deleted = [];
        const created = [];
        const node = buildEndpoint();
        node.client._connected = true;
        node.client.browseResolveSymbolicBatch = async (paths) =>
            paths.map(() => ({
                address: '8A0E0001.A',
                crcMeta: { memberName: 'Test2', softdatatype: 'DInt' },
                datatype: 'DInt'
            }));
        node.client.deleteSubscription = async (id) => { deleted.push(id); };
        node.client.createSubscription = async () => {
            await new Promise((r) => setTimeout(r, 20));
            const id = created.length + 1;
            created.push(id);
            return { subscriptionObjectId: id, refToName: new Map([[1, { name: 'DB1.x', datatype: 'Int' }]]) };
        };

        await Promise.all([
            node.subscribe('owner1', ['DB1.a'], { cycleMs: 500 }),
            node.subscribe('owner1', ['DB1.b'], { cycleMs: 500 })
        ]);

        // Second subscribe must run after the first completed: the first
        // object is deleted, exactly one subscription remains routed.
        assert.deepEqual(created, [1, 2]);
        assert.deepEqual(deleted, [1]);
        assert.equal(node._subsByObjId.size, 1);
        assert.ok(node._subsByObjId.has(2));
    });

    it('does not flag seqNum jumps as loss (RouteMode 0x20 skips empty cycles)', async () => {
        const node = buildEndpoint();
        node.client._connected = true;
        node.client.browseResolveSymbolicBatch = async (paths) =>
            paths.map(() => ({
                address: '8A0E0001.A',
                crcMeta: { memberName: 'Test2', softdatatype: 'DInt' },
                datatype: 'DInt'
            }));
        node.client.createSubscription = async () =>
            ({ subscriptionObjectId: 5, refToName: new Map([[1, { name: 'DB1.a', datatype: 'Int' }]]) });

        const events = [];
        await node.subscribe('owner1', ['DB1.a'], { cycleMs: 500 }, (e) => events.push(e));

        const emitNoti = (seqNum) => node.client.emit('notification', {
            subscriptionId: 5, seqNum, values: new Map(), errors: new Map()
        });
        // seqNum advances per PLC cycle, but cycles without changes send
        // no notification — jumps are normal and must not be flagged.
        emitNoti(1);
        emitNoti(3);
        emitNoti(7);

        const dataEvents = events.filter((e) => e.type === 'data');
        assert.equal(dataEvents.length, 3);
        for (const e of dataEvents) {
            assert.equal(e.gap, undefined);
            assert.equal(e.missed, undefined);
        }
    });

    it('heals a partially established subscription once the missing symbol resolves', async () => {
        const node = buildEndpoint();
        node.client._connected = true;
        let resolvable = false; // DB1.b not on the PLC yet
        node.client.browseResolveSymbolicBatch = async (paths) =>
            paths.map((p) => {
                if (p === 'DB1.b' && !resolvable) return { error: 'DB1.b not found in DB1' };
                return {
                    address: '8A0E0001.A',
                    crcMeta: { memberName: 'Test2', softdatatype: 'DInt' },
                    datatype: 'DInt'
                };
            });
        const deleted = [];
        node.client.deleteSubscription = async (id) => { deleted.push(id); };
        let created = 0;
        node.client.createSubscription = async (opts) => {
            created++;
            const refToName = new Map(opts.items.map((it, i) => [i + 1, { name: it.name, datatype: it.datatype }]));
            return { subscriptionObjectId: created, refToName };
        };

        const events = [];
        await node.subscribe('owner1', ['DB1.a', 'DB1.b'], { cycleMs: 500 }, (e) => events.push(e));

        const record = node._subscriptions.get('owner1');
        assert.equal(record.subscriptionObjectId, 1);
        assert.deepEqual(Object.keys(record.resolveErrors), ['DB1.b']);
        // Partial establish arms the heal backoff.
        assert.ok(record.nextEstablishRetryAt > Date.now());

        // Symbol still missing: heal probe must NOT touch the subscription.
        record.nextEstablishRetryAt = 0;
        await node._retryFailedSubscriptions();
        assert.equal(created, 1);
        assert.deepEqual(deleted, []);
        assert.ok(record.nextEstablishRetryAt > Date.now());

        // TIA download happened: DB1.b resolves now -> delete + recreate.
        resolvable = true;
        record.nextEstablishRetryAt = 0;
        await node._retryFailedSubscriptions();
        assert.equal(created, 2);
        assert.deepEqual(deleted, [1]);
        assert.equal(record.subscriptionObjectId, 2);
        assert.deepEqual(record.resolveErrors, {});
        assert.equal(record.refToName.size, 2);
        assert.equal(record.establishRetryCount, 0);

        const lastSubscribed = events.filter((e) => e.type === 'status' && e.state === 'subscribed').pop();
        assert.equal(lastSubscribed.itemCount, 2);
        assert.deepEqual(lastSubscribed.resolveErrors, {});
    });

    it('retries a failed establish via retryFailedSubscriptions with backoff', async () => {
        const node = buildEndpoint();
        node.client._connected = true;
        node.client.browseResolveSymbolicBatch = async (paths) =>
            paths.map(() => ({
                address: '8A0E0001.A',
                crcMeta: { memberName: 'Test2', softdatatype: 'DInt' },
                datatype: 'DInt'
            }));
        let attempts = 0;
        node.client.createSubscription = async () => {
            attempts++;
            if (attempts === 1) throw new Error('Subscription create failed (returnValue=0xab3da6ff)');
            return { subscriptionObjectId: 7, refToName: new Map([[1, { name: 'DB1.a', datatype: 'Int' }]]) };
        };

        const events = [];
        await node.subscribe('owner1', ['DB1.a'], { cycleMs: 500 }, (e) => events.push(e));
        assert.equal(attempts, 1);
        assert.ok(events.some((e) => e.type === 'status' && e.state === 'error'));

        const record = node._subscriptions.get('owner1');
        assert.equal(record.subscriptionObjectId, 0);
        assert.ok(record.nextEstablishRetryAt > Date.now());

        // Backoff still pending: retry must be a no-op.
        await node._retryFailedSubscriptions();
        assert.equal(attempts, 1);

        // Backoff elapsed: retry establishes the subscription.
        record.nextEstablishRetryAt = 0;
        await node._retryFailedSubscriptions();
        assert.equal(attempts, 2);
        assert.equal(record.subscriptionObjectId, 7);
        assert.equal(record.establishRetryCount, 0);
        assert.ok(events.some((e) => e.type === 'status' && e.state === 'subscribed'));
    });
});
