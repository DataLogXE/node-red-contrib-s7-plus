'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    symbolRoot,
    exploreScopeForRoot,
    uniqueSymbolRoots,
    flatSymbolToCacheEntry,
    seedCrcCacheFromFlatSymbols
} = require('../lib/s7plus/explore-resolve');

function flatSymbol(name, accessSequence = '8A0E0001.A', computedCrc = 0xABCD) {
    return {
        name,
        accessSequence,
        computedCrc,
        softdatatypeName: 'Real'
    };
}

describe('symbolRoot', () => {
    it('returns the DB name for a dotted path', () => {
        assert.equal(symbolRoot('DB_Arrays.arr[0]'), 'DB_Arrays');
    });

    it('returns quoted DB names', () => {
        assert.equal(symbolRoot('"My DB".member'), 'My DB');
    });

    it('returns memory area roots', () => {
        assert.equal(symbolRoot('IArea.bit0'), 'IArea');
    });
});

describe('exploreScopeForRoot', () => {
    it('scopes a data block', () => {
        assert.deepEqual(exploreScopeForRoot('DB_Arrays'), {
            everything: false,
            dbs: ['DB_Arrays'],
            areas: []
        });
    });

    it('scopes a memory area', () => {
        assert.deepEqual(exploreScopeForRoot('IArea'), {
            everything: false,
            dbs: [],
            areas: ['IArea']
        });
    });
});

describe('uniqueSymbolRoots', () => {
    it('returns each root once', () => {
        const roots = uniqueSymbolRoots([
            'DB1.a',
            'DB1.b',
            'DB2.x',
            'DB2.y',
            'DB1.c'
        ]);
        assert.deepEqual(roots.sort(), ['DB1', 'DB2']);
    });
});

describe('flatSymbolToCacheEntry', () => {
    it('maps accessSequence and computedCrc', () => {
        const entry = flatSymbolToCacheEntry(flatSymbol('DB1.x', '8A0E0002.B', 0x9999));
        assert.equal(entry.address, '8A0E0002.B');
        assert.equal(entry.symbolCrc, 0x9999);
        assert.equal(entry.datatype, 'Real');
    });

    it('returns null when accessSequence is missing', () => {
        assert.equal(flatSymbolToCacheEntry({ name: 'DB1.x' }), null);
    });
});

describe('seedCrcCacheFromFlatSymbols', () => {
    it('writes all flat symbols through setFn', () => {
        const written = [];
        const count = seedCrcCacheFromFlatSymbols(
            [flatSymbol('DB1.a'), flatSymbol('DB1.b')],
            (name, address, symbolCrc, datatype) => {
                written.push({ name, address, symbolCrc, datatype });
            }
        );
        assert.equal(count, 2);
        assert.equal(written[0].name, 'DB1.a');
        assert.equal(written[1].symbolCrc, 0xABCD);
    });
});

describe('endpoint resolve via explore-on-miss', () => {
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

    const DB1_CATALOG = ['DB1.a', 'DB1.b', 'DB1.c'];
    const DB2_CATALOG = ['DB2.x', 'DB2.y'];

    function catalogForScope(scope) {
        const root = scope.dbs[0] || scope.areas[0];
        const names = root === 'DB1' ? DB1_CATALOG : root === 'DB2' ? DB2_CATALOG : [];
        const accessSequence = root === 'DB1' ? '8A0E0001.A' : '8A0E0002.A';
        return names.map((name) => flatSymbol(name, accessSequence));
    }

    function makeExploreClient(overrides = {}) {
        const state = {
            browseFullScopes: [],
            lazyResolveCalls: 0
        };
        const client = {
            connected: true,
            socketAlive: true,
            clearBrowseState() {},
            async browseResolveSymbolicBatch() {
                state.lazyResolveCalls++;
                throw new Error('browseResolveSymbolicBatch must not be called');
            },
            async browseFull(options) {
                state.browseFullScopes.push(JSON.parse(JSON.stringify(options.scope)));
                const symbols = overrides.symbolsForScope
                    ? overrides.symbolsForScope(options.scope)
                    : catalogForScope(options.scope);
                return { symbols, meta: {} };
            },
            async readValues(addresses) {
                return {
                    values: addresses.map(() => 42),
                    errors: addresses.map(() => 0n)
                };
            },
            ...overrides.clientExtras
        };
        return { client, state };
    }

    it('explores each DB once for five mixed cache misses', async () => {
        const node = buildEndpoint();
        const { client, state } = makeExploreClient();
        node.client = client;

        const symbols = ['DB1.a', 'DB1.b', 'DB1.c', 'DB2.x', 'DB2.y'];
        const result = await node.resolveAndRead(symbols);

        assert.equal(state.lazyResolveCalls, 0);
        assert.equal(state.browseFullScopes.length, 2);
        assert.deepEqual(state.browseFullScopes[0], {
            everything: false,
            dbs: ['DB1'],
            areas: []
        });
        assert.deepEqual(state.browseFullScopes[1], {
            everything: false,
            dbs: ['DB2'],
            areas: []
        });
        for (const s of symbols) {
            assert.equal(result[s].status, 'ok', `${s} should resolve`);
        }
    });

    it('re-explores the full DB when any symbol from that DB is missing', async () => {
        const node = buildEndpoint();
        let exploreCalls = 0;
        node.client = {
            connected: true,
            socketAlive: true,
            clearBrowseState() {},
            async browseResolveSymbolicBatch() {
                throw new Error('browseResolveSymbolicBatch must not be called');
            },
            async browseFull() {
                exploreCalls++;
                const symbols = exploreCalls === 1
                    ? [flatSymbol('DB1.a')]
                    : DB1_CATALOG.map((name) => flatSymbol(name));
                return { symbols };
            },
            async readValues(addresses) {
                return {
                    values: addresses.map(() => 1),
                    errors: addresses.map(() => 0n)
                };
            }
        };

        await node.resolveAndRead(['DB1.a']);
        exploreCalls = 0;

        await node.resolveAndRead(['DB1.a', 'DB1.b']);
        assert.equal(exploreCalls, 1, 'DB1.b miss must trigger one scoped explore');
    });

    it('reports an error when the symbol is absent from the explore result', async () => {
        const node = buildEndpoint();
        const { client } = makeExploreClient({
            symbolsForScope: () => [flatSymbol('DB1.a')]
        });
        node.client = client;

        const result = await node.resolveAndRead(['DB1.missing']);
        assert.equal(result['DB1.missing'].status, 'error');
        assert.match(result['DB1.missing'].error, /was not exported by explore of DB1/);
    });

    it('seeds _crcCache when browseFull is called manually', async () => {
        const node = buildEndpoint();
        const { client } = makeExploreClient();
        node.client = client;

        await node.browseFull({ scope: exploreScopeForRoot('DB1') });
        let exploreCalls = 0;
        node.client.browseFull = async (options) => {
            exploreCalls++;
            return { symbols: catalogForScope(options.scope) };
        };

        const result = await node.resolveAndRead(['DB1.a']);
        assert.equal(exploreCalls, 0, 'manual explore should have seeded the cache');
        assert.equal(result['DB1.a'].status, 'ok');
    });
});
