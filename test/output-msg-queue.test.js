'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { OutputMsgQueue, DEFAULT_MAX_QUEUE } = require('../lib/s7plus/output-msg-queue');

async function flushTicks(n = 8) {
    for (let i = 0; i < n; i++) {
        await new Promise((r) => setImmediate(r));
    }
}

describe('OutputMsgQueue', () => {
    it('flushes all pending messages in one batch via setImmediate', async () => {
        const batches = [];
        const q = new OutputMsgQueue((batch) => batches.push(batch));

        q.enqueue({ payload: 1, timestamp: new Date() });
        q.enqueue({ payload: 2, timestamp: new Date() });
        q.enqueue({ payload: 3, timestamp: new Date() });

        assert.equal(q.queueDepth, 3);
        assert.equal(batches.length, 0);

        await new Promise((r) => setImmediate(r));
        assert.equal(batches.length, 1);
        assert.equal(batches[0].length, 3);
        assert.deepEqual(batches[0].map((m) => m.payload), [1, 2, 3]);
        assert.equal(q.queueDepth, 0);
        assert.equal(q.totalFlushed, 3);
    });

    it('drops oldest half when queue reaches maxQueue before enqueue', async () => {
        const overflows = [];
        const q = new OutputMsgQueue(() => {}, {
            maxQueue: 100,
            onOverflow: (info) => overflows.push(info)
        });

        for (let i = 0; i < 100; i++) {
            q.enqueue({ payload: i, timestamp: new Date() });
        }
        assert.equal(q.queueDepth, 100);

        q.enqueue({ payload: 100, timestamp: new Date() });

        assert.equal(overflows.length, 1);
        assert.equal(overflows[0].dropped, 50);
        assert.equal(overflows[0].remaining, 50);
        assert.equal(q.droppedByHalf, 50);
        assert.equal(q.queueDepth, 51);
        assert.equal(q._queue[0].payload, 50);
        assert.equal(q._queue[50].payload, 100);
    });

    it('reset() clears the queue without flushing', async () => {
        const batches = [];
        const q = new OutputMsgQueue((batch) => batches.push(batch));
        q.enqueue({ payload: 1, timestamp: new Date() });
        q.reset();
        await flushTicks(4);
        assert.equal(batches.length, 0);
        assert.equal(q.queueDepth, 0);
    });

    it('schedules a second drain when enqueue runs during flush', async () => {
        const batches = [];
        const q = new OutputMsgQueue((batch) => {
            batches.push(batch);
            if (batch[0].payload === 1) {
                q.enqueue({ payload: 2, timestamp: new Date() });
            }
        });

        q.enqueue({ payload: 1, timestamp: new Date() });
        await flushTicks(4);

        assert.equal(batches.length, 2);
        assert.equal(batches[0].length, 1);
        assert.equal(batches[1].length, 1);
        assert.equal(batches[1][0].payload, 2);
    });

    it('defaults maxQueue to 100', () => {
        assert.equal(DEFAULT_MAX_QUEUE, 100);
    });
});
