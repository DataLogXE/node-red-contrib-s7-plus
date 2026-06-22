'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const readModule = require('../nodes/s7complus-in');
const parseAddSymbols = readModule.parseAddSymbols;
const parseMsgSymbols = readModule.parseMsgSymbols;

describe('parseAddSymbols', () => {
    it('returns string[] from msg.addSymbols', () => {
        assert.deepEqual(parseAddSymbols({ addSymbols: ['DB1.a', 'DB1.b'] }), ['DB1.a', 'DB1.b']);
    });

    it('returns empty array when addSymbols is missing or empty', () => {
        assert.deepEqual(parseAddSymbols({}), []);
        assert.deepEqual(parseAddSymbols({ addSymbols: [] }), []);
    });

    it('ignores non-string entries', () => {
        assert.deepEqual(parseAddSymbols({ addSymbols: ['DB1.a', 42] }), []);
    });

    it('does not read msg.payload', () => {
        assert.deepEqual(parseAddSymbols({ payload: ['DB1.a'] }), []);
    });
});

describe('parseMsgSymbols', () => {
    it('returns string[] from msg.symbols', () => {
        assert.deepEqual(parseMsgSymbols({ symbols: ['Motor.speed', 'Pump.on'] }), ['Motor.speed', 'Pump.on']);
    });

    it('returns undefined when msg.symbols is not set', () => {
        assert.equal(parseMsgSymbols({}), undefined);
        assert.equal(parseMsgSymbols({ symbols: undefined }), undefined);
        assert.equal(parseMsgSymbols({ symbols: null }), undefined);
    });

    it('accepts an empty array', () => {
        assert.deepEqual(parseMsgSymbols({ symbols: [] }), []);
    });

    it('rejects object entries', () => {
        assert.throws(() => parseMsgSymbols({ symbols: [{ name: 'Motor.speed' }] }), /array of strings/);
    });

    it('rejects mixed entries', () => {
        assert.throws(() => parseMsgSymbols({ symbols: ['Motor.speed', 42] }), /array of strings/);
    });

    it('rejects a non-array value', () => {
        assert.throws(() => parseMsgSymbols({ symbols: 'Motor.speed' }), /array of strings/);
    });
});

describe('s7-plus read input routing', () => {
    function buildRead(endpointMock) {
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
        require('../nodes/s7complus-in')(RED);
        return Ctor;
    }

    function runInput(node, msg) {
        return new Promise((resolve) => {
            node._sent = false;
            const send = () => { node._sent = true; };
            node.emit('input', msg, send, (err) => resolve({ err, sent: node._sent, msg }));
        });
    }

    function makeEndpoint() {
        return {
            resolveAndRead: async (paths) => {
                const out = {};
                for (const path of paths) {
                    out[path] = { value: 1, status: 'ok', error: '' };
                }
                return out;
            },
            readTags: async () => ({})
        };
    }

    const editorSymbols = [
        { name: 'Motor.speed', address: 'Motor.speed', datatype: 'Int' },
        { name: 'Tank.level', address: 'Tank.level', datatype: 'Real' }
    ];

    it('reads configured editor symbols on empty message', async () => {
        const paths = [];
        const endpoint = makeEndpoint();
        endpoint.resolveAndRead = async (p) => {
            paths.push(...p);
            return makeEndpoint().resolveAndRead(p);
        };
        const Ctor = buildRead(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols });
        const { err } = await runInput(node, { payload: '' });
        assert.equal(err, undefined);
        assert.deepEqual([...paths].sort(), ['Motor.speed', 'Tank.level']);
    });

    it('msg.symbols replaces editor configuration', async () => {
        const paths = [];
        const endpoint = makeEndpoint();
        endpoint.resolveAndRead = async (p) => {
            paths.push(...p);
            return makeEndpoint().resolveAndRead(p);
        };
        const Ctor = buildRead(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols });
        const { err } = await runInput(node, { symbols: ['Pump.on'] });
        assert.equal(err, undefined);
        assert.deepEqual(paths, ['Pump.on']);
    });

    it('rejects msg.symbols with object entries', async () => {
        const endpoint = makeEndpoint();
        const Ctor = buildRead(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols });
        const { err, sent } = await runInput(node, { symbols: [{ name: 'Pump.on' }] });
        assert.ok(err instanceof Error);
        assert.match(err.message, /array of strings/);
        assert.equal(sent, false);
    });

    it('msg.addSymbols merges with editor symbols', async () => {
        const paths = [];
        const endpoint = makeEndpoint();
        endpoint.resolveAndRead = async (p) => {
            paths.push(...p);
            return makeEndpoint().resolveAndRead(p);
        };
        const Ctor = buildRead(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols });
        const { err } = await runInput(node, { addSymbols: ['DB1.temp'] });
        assert.equal(err, undefined);
        assert.deepEqual([...paths].sort(), ['DB1.temp', 'Motor.speed', 'Tank.level']);
    });

    it('ignores msg.payload string[] for symbol merge', async () => {
        const paths = [];
        const endpoint = makeEndpoint();
        endpoint.resolveAndRead = async (p) => {
            paths.push(...p);
            return makeEndpoint().resolveAndRead(p);
        };
        const Ctor = buildRead(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols });
        const { err } = await runInput(node, { payload: ['DB1.ignored'] });
        assert.equal(err, undefined);
        assert.deepEqual([...paths].sort(), ['Motor.speed', 'Tank.level']);
    });

    it('msg.symbols and msg.addSymbols combine without duplicates', async () => {
        const paths = [];
        const endpoint = makeEndpoint();
        endpoint.resolveAndRead = async (p) => {
            paths.push(...p);
            return makeEndpoint().resolveAndRead(p);
        };
        const Ctor = buildRead(endpoint);
        const node = new Ctor({ endpoint: 'ep', symbols: editorSymbols });
        const { err } = await runInput(node, {
            symbols: ['Motor.speed'],
            addSymbols: ['Motor.speed', 'Extra.tag']
        });
        assert.equal(err, undefined);
        assert.deepEqual([...paths].sort(), ['Extra.tag', 'Motor.speed']);
    });

    it('sets msg.payload to read results and preserves msg.addSymbols', async () => {
        const endpoint = makeEndpoint();
        const Ctor = buildRead(endpoint);
        const node = new Ctor({
            endpoint: 'ep',
            symbols: [{ name: 'DB1.x', address: 'DB1.x', datatype: 'Bool' }]
        });
        const input = { addSymbols: ['DB1.extra'] };
        const { err, sent, msg } = await runInput(node, input);
        assert.equal(err, undefined);
        assert.equal(sent, true);
        assert.deepEqual(msg.addSymbols, ['DB1.extra']);
        assert.equal(msg.payload['DB1.x'].status, 'ok');
        assert.equal(msg.payload['DB1.extra'].status, 'ok');
    });
});
