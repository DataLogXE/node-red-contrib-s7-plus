'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    FLAT_YIELD_EVERY,
    RESOLVE_YIELD_EVERY,
    yieldToEventLoop
} = require('../lib/s7plus/cooperative');
const { resolveSymbolicBatch } = require('../lib/s7plus/browse/resolve-symbolic');

describe('cooperative helpers', () => {
    it('yieldToEventLoop returns to the event loop (setImmediate runs)', async () => {
        let tick = 0;
        setImmediate(() => { tick++; });
        assert.equal(tick, 0);
        await yieldToEventLoop();
        assert.equal(tick, 1);
    });

    it('exports positive yield intervals', () => {
        assert.ok(FLAT_YIELD_EVERY > 0);
        assert.ok(RESOLVE_YIELD_EVERY > 0);
    });
});

describe('resolveSymbolicBatch cooperative yield', () => {
    function mockClient() {
        return {
            async browseRootsCached() {
                return {
                    nodes: [{
                        id: 'root',
                        label: 'DB1',
                        hasChildren: true,
                        isLeaf: false
                    }]
                };
            },
            async browseChildren() {
                return {
                    nodes: [{
                        id: 'leaf',
                        label: 'x',
                        hasChildren: false,
                        isLeaf: true,
                        nodeKind: 'leaf'
                    }]
                };
            },
            async browseResolve() {
                return { name: 'DB1.x', address: '8A0E0001.1', datatype: 'Bool', crcMeta: null };
            }
        };
    }

    it('yields to the event loop during a large batch', async () => {
        let ticks = 0;
        const iv = setInterval(() => { ticks++; }, 1);
        try {
            const n = RESOLVE_YIELD_EVERY * 3;
            const paths = Array.from({ length: n }, () => 'DB1.x');
            await resolveSymbolicBatch(mockClient(), paths);
            assert.ok(ticks >= 1, `expected timer ticks during resolve, got ${ticks}`);
        } finally {
            clearInterval(iv);
        }
    });

    it('resolves a small batch without error', async () => {
        const paths = ['DB1.x', 'DB1.x'];
        const results = await resolveSymbolicBatch(mockClient(), paths);
        assert.equal(results.length, 2);
        assert.equal(results[0].address, '8A0E0001.1');
    });
});
