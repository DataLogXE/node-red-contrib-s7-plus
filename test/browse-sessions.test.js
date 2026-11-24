'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { BrowseSessionStore } = require('../lib/s7plus/browse-sessions');

class FakeClient extends EventEmitter {
    constructor(log) {
        super();
        this.connected = false;
        this.log = log;
    }
    async connect(address) {
        this.log.push(['connect', address]);
        await new Promise((r) => setImmediate(r));
        if (address === 'bad') throw new Error('TCP: Connection Timeout');
        this.connected = true;
    }
    async disconnect() {
        this.log.push(['disconnect']);
        this.connected = false;
    }
    forceDisconnect(reason) {
        this.log.push(['force', reason]);
        this.connected = false;
    }
    drop() {
        this.connected = false;
        this.emit('disconnect', { reason: 'socket-error' });
    }
}

function setup(opts = {}) {
    const log = [];
    const clients = [];
    let t = 1000;
    const store = new BrowseSessionStore({
        createClient: () => { const c = new FakeClient(log); clients.push(c); return c; },
        idleTtlMs: 1000,
        now: () => t,
        ...opts
    });
    return { store, log, clients, advance: (ms) => { t += ms; } };
}

const creds = (address = '10.0.0.1') => ({ address, port: 102, password: '', username: '', timeoutMs: 1000 });
const tick = () => new Promise((r) => setImmediate(r));

describe('BrowseSessionStore', () => {
    it('reuses one live connection per PLC address', async () => {
        const { store, clients } = setup();
        const a = await store.open(creds());
        const b = await store.open(creds());
        assert.equal(a, b);
        assert.equal(clients.length, 1);
        assert.equal(store.size, 1);
    });

    it('opens separate sessions for different addresses', async () => {
        const { store, clients } = setup();
        const a = await store.open(creds('10.0.0.1'));
        const b = await store.open(creds('10.0.0.2'));
        assert.notEqual(a, b);
        assert.equal(clients.length, 2);
    });

    it('shares one connect between concurrent opens', async () => {
        const { store, clients } = setup();
        const [a, b, c] = await Promise.all([store.open(creds()), store.open(creds()), store.open(creds())]);
        assert.equal(a, b);
        assert.equal(b, c);
        assert.equal(clients.length, 1);
    });

    it('get() refreshes the idle timer', async () => {
        const { store, advance } = setup();
        const id = await store.open(creds());
        advance(800);
        store.get(id);
        advance(800);
        assert.ok(store.get(id));
    });

    it('prune() closes idle sessions gracefully', async () => {
        const { store, advance, log } = setup();
        const id = await store.open(creds());
        advance(1001);
        assert.equal(store.prune(), 1);
        await tick();
        assert.equal(store.has(id), false);
        assert.deepEqual(log.at(-1), ['disconnect']);
        assert.throws(() => store.get(id), /session expired/);
    });

    it('opens a new connection after the old one expired', async () => {
        const { store, advance, clients } = setup();
        const a = await store.open(creds());
        advance(1001);
        const b = await store.open(creds());
        assert.notEqual(a, b);
        assert.equal(clients.length, 2);
        assert.equal(store.size, 1);
    });

    it('close() releases the session and its connection', async () => {
        const { store, log } = setup();
        const id = await store.open(creds());
        assert.equal(store.close(id), true);
        await tick();
        assert.equal(store.size, 0);
        assert.deepEqual(log.at(-1), ['disconnect']);
        assert.equal(store.close(id), false);
        assert.equal(store.close('unknown'), false);
    });

    it('drops a session whose connection died and does not reuse it', async () => {
        const { store, clients } = setup();
        const a = await store.open(creds());
        clients[0].drop();
        assert.throws(() => store.get(a), /session (stale|expired)/);
        const b = await store.open(creds());
        assert.notEqual(a, b);
        assert.equal(clients.length, 2);
    });

    it('propagates connect errors and keeps no session', async () => {
        const { store } = setup();
        await assert.rejects(store.open(creds('bad')), /Connection Timeout/);
        assert.equal(store.size, 0);
    });

    it('repeated opens never hold more than one connection per PLC', async () => {
        const { store, clients } = setup();
        for (let i = 0; i < 60; i++) await store.open(creds());
        assert.equal(clients.length, 1);
        assert.equal(store.size, 1);
    });

    it('sweep timer prunes without new requests', async () => {
        const { store, advance } = setup({ sweepMs: 5 });
        await store.open(creds());
        advance(1001);
        store.startSweep();
        await new Promise((r) => setTimeout(r, 30));
        store.stopSweep();
        assert.equal(store.size, 0);
    });
});
