'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { SerialQueue } = require('../lib/s7plus/serial-queue');

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe('SerialQueue', () => {
    it('runs operations with the same key strictly in order', async () => {
        const q = new SerialQueue();
        const events = [];
        const gate = deferred();

        const p1 = q.run('a', async () => {
            events.push('start1');
            await gate.promise;
            events.push('end1');
            return 1;
        });
        const p2 = q.run('a', async () => {
            events.push('start2');
            return 2;
        });

        // Op 2 must not start while op 1 is still pending.
        await new Promise((res) => setImmediate(res));
        assert.deepEqual(events, ['start1']);

        gate.resolve();
        assert.equal(await p1, 1);
        assert.equal(await p2, 2);
        assert.deepEqual(events, ['start1', 'end1', 'start2']);
    });

    it('a rejected operation does not block successors', async () => {
        const q = new SerialQueue();
        const p1 = q.run('a', async () => { throw new Error('boom'); });
        const p2 = q.run('a', async () => 'ok');

        await assert.rejects(p1, /boom/);
        assert.equal(await p2, 'ok');
    });

    it('different keys run independently', async () => {
        const q = new SerialQueue();
        const gate = deferred();
        const events = [];

        const pa = q.run('a', async () => {
            events.push('a-start');
            await gate.promise;
            events.push('a-end');
        });
        const pb = q.run('b', async () => {
            events.push('b');
        });

        await pb;
        assert.deepEqual(events, ['a-start', 'b']);
        gate.resolve();
        await pa;
        assert.deepEqual(events, ['a-start', 'b', 'a-end']);
    });

    it('supports synchronous functions and propagates return values', async () => {
        const q = new SerialQueue();
        assert.equal(await q.run('k', () => 42), 42);
    });

    it('cleans up idle chains', async () => {
        const q = new SerialQueue();
        await q.run('a', async () => {});
        await q.run('b', async () => { throw new Error('x'); }).catch(() => {});
        // Cleanup happens in a finally on the tail; give the microtask
        // queue one turn to run it.
        await new Promise((res) => setImmediate(res));
        assert.equal(q.size, 0);
    });
});
