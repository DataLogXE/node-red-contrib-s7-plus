'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { normalizeExploreScope } = require('../lib/s7plus/browse/areas');

describe('s7-plus explore symbol limit', () => {
    function buildExplore(endpointMock, config = {}) {
        let Ctor;
        const RED = {
            nodes: {
                createNode(node) {
                    const ee = new EventEmitter();
                    node.on = ee.on.bind(ee);
                    node.emit = ee.emit.bind(ee);
                    node.status = (s) => { node._status = s; };
                    node.error = (e) => { node._error = e; };
                    node.warn = () => {};
                    node.send = () => { node._sent = true; };
                },
                getNode() { return endpointMock; },
                registerType(_name, ctor) { Ctor = ctor; }
            }
        };
        require('../nodes/s7complus-explore')(RED);
        return Ctor;
    }

    function runInput(node, msg) {
        return new Promise((resolve) => {
            node._sent = false;
            node._status = null;
            node._payload = null;
            const send = () => { node._sent = true; };
            node.emit('input', msg, send, (err) => resolve({
                err,
                sent: node._sent,
                status: node._status,
                payload: msg.payload,
                infos: msg.infos,
                meta: msg.meta
            }));
        });
    }

    it('passes maxSymbols from node config to endpoint.browseFull', async () => {
        const calls = [];
        const endpoint = {
            browseFull: async (options) => {
                calls.push(options);
                return { symbols: [{ name: 'DB1.x' }], meta: { symbolCount: 1, dbCount: 1, durationMs: 1 } };
            }
        };
        const Ctor = buildExplore(endpoint);
        const node = new Ctor({ endpoint: 'ep', maxSymbols: 5000 });
        const { err } = await runInput(node, { payload: '' });
        assert.equal(err, undefined);
        assert.deepEqual(calls[0], {
            maxSymbols: 5000,
            scope: { everything: true, dbs: [], areas: [] }
        });
    });

    it('msg.maxSymbols overrides node config', async () => {
        const calls = [];
        const endpoint = {
            browseFull: async (options) => {
                calls.push(options);
                return { symbols: [], meta: { symbolCount: 0, dbCount: 0, durationMs: 0 } };
            }
        };
        const Ctor = buildExplore(endpoint);
        const node = new Ctor({ endpoint: 'ep', maxSymbols: 5000 });
        await runInput(node, { payload: '', maxSymbols: 42 });
        assert.deepEqual(calls[0], {
            maxSymbols: 42,
            scope: { everything: true, dbs: [], areas: [] }
        });
    });

    it('outputs partial symbols with yellow status when limit is exceeded', async () => {
        const endpoint = {
            browseFull: async () => ({
                symbols: [{ name: 'DB1.a' }, { name: 'DB1.b' }, { name: 'DB1.c' }],
                meta: {
                    symbolCount: 3,
                    maxSymbols: 3,
                    dbCount: 1,
                    durationMs: 5,
                    limitExceeded: true,
                    limitMessage: 'Symbol limit exceeded (3 exported, max 3)'
                }
            })
        };
        const Ctor = buildExplore(endpoint);
        const node = new Ctor({ endpoint: 'ep', maxSymbols: 3 });
        const { err, sent, status, payload, meta } = await runInput(node, { payload: '' });
        assert.equal(err, undefined);
        assert.equal(sent, true);
        assert.equal(status.fill, 'yellow');
        assert.match(status.text, /3\/3 symbols \(limit\)/);
        assert.deepEqual(payload, ['DB1.a', 'DB1.b', 'DB1.c']);
        assert.equal(meta.limitExceeded, true);
        assert.equal(meta.limitMessage, 'Symbol limit exceeded (3 exported, max 3)');
    });

    it('outputs symbol infos as object when symbolInfos is object', async () => {
        const endpoint = {
            browseFull: async () => ({
                symbols: [{
                    name: 'DB1.a',
                    accessSequence: '8A0E0001.A',
                    softdatatype: 8,
                    softdatatypeName: 'Real',
                    optAddress: 0,
                    nonOptAddress: 0,
                    optBitoffset: 0,
                    nonOptBitoffset: 0
                }],
                meta: { symbolCount: 1, dbCount: 1, durationMs: 1 }
            })
        };
        const Ctor = buildExplore(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbolInfos: 'object' });
        const { payload, infos } = await runInput(node, { payload: '' });
        assert.deepEqual(payload, ['DB1.a']);
        assert.equal(infos['DB1.a'].softdatatypeName, 'Real');
        assert.equal(infos['DB1.a'].name, undefined);
    });

    it('msg.symbolInfos overrides node config', async () => {
        const endpoint = {
            browseFull: async () => ({
                symbols: [{ name: 'DB1.x', accessSequence: '1', softdatatype: 1, softdatatypeName: 'Bool' }],
                meta: { symbolCount: 1, dbCount: 1, durationMs: 1 }
            })
        };
        const Ctor = buildExplore(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbolInfos: 'none' });
        const { payload, infos } = await runInput(node, { payload: '', symbolInfos: 'array' });
        assert.deepEqual(payload, ['DB1.x']);
        assert.equal(infos.length, 1);
        assert.equal(infos[0].symbol, 'DB1.x');
    });

    it('passes exploreScope from node config to endpoint.browseFull', async () => {
        const calls = [];
        const endpoint = {
            browseFull: async (options) => {
                calls.push(options);
                return { symbols: [], meta: { symbolCount: 0, dbCount: 0, durationMs: 0 } };
            }
        };
        const scope = { everything: false, dbs: ['DB1'], areas: ['IArea'] };
        const Ctor = buildExplore(endpoint);
        const node = new Ctor({ endpoint: 'ep', exploreScope: scope });
        await runInput(node, { payload: '' });
        assert.deepEqual(calls[0].scope, scope);
    });

    it('msg.exploreScope overrides node config scope', async () => {
        const calls = [];
        const endpoint = {
            browseFull: async (options) => {
                calls.push(options);
                return { symbols: [], meta: { symbolCount: 0, dbCount: 0, durationMs: 0 } };
            }
        };
        const Ctor = buildExplore(endpoint);
        const node = new Ctor({
            endpoint: 'ep',
            exploreScope: { everything: false, dbs: ['DB1'], areas: [] }
        });
        await runInput(node, {
            payload: '',
            exploreScope: { everything: false, dbs: [], areas: ['QArea'] }
        });
        assert.deepEqual(calls[0].scope, { everything: false, dbs: [], areas: ['QArea'] });
    });

    it('falls back to everything when partial scope has no selection', async () => {
        const calls = [];
        const endpoint = {
            browseFull: async (options) => {
                calls.push(options);
                return { symbols: [], meta: { symbolCount: 0, dbCount: 0, durationMs: 0 } };
            }
        };
        const Ctor = buildExplore(endpoint);
        const node = new Ctor({
            endpoint: 'ep',
            exploreScope: { everything: false, dbs: [], areas: [] }
        });
        await runInput(node, { payload: '' });
        assert.deepEqual(calls[0].scope, { everything: true, dbs: [], areas: [] });
    });
});

describe('normalizeExploreScope', () => {
    it('returns everything for empty partial selection', () => {
        assert.deepEqual(
            normalizeExploreScope({ everything: false, dbs: [], areas: [] }),
            { everything: true, dbs: [], areas: [] }
        );
    });
});
