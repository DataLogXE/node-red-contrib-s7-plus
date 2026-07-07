'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { NotificationBuffer } = require('../lib/s7plus/notification-buffer');

describe('NotificationBuffer', () => {
    it('drains buffered notifications in arrival order', () => {
        const buf = new NotificationBuffer();
        buf.push(0x100, { seqNum: 1 }, 1000);
        buf.push(0x100, { seqNum: 2 }, 1001);
        buf.push(0x100, { seqNum: 3 }, 1002);

        const drained = buf.drain(0x100, 1003);
        assert.deepEqual(drained.map((n) => n.seqNum), [1, 2, 3]);
        assert.equal(buf.size, 0);
    });

    it('returns an empty array for unknown ids', () => {
        const buf = new NotificationBuffer();
        assert.deepEqual(buf.drain(0x999), []);
    });

    it('keeps ids separate', () => {
        const buf = new NotificationBuffer();
        buf.push(1, { seqNum: 10 }, 1000);
        buf.push(2, { seqNum: 20 }, 1000);

        assert.deepEqual(buf.drain(1, 1001).map((n) => n.seqNum), [10]);
        assert.deepEqual(buf.drain(2, 1001).map((n) => n.seqNum), [20]);
    });

    it('drain removes the entries (second drain is empty)', () => {
        const buf = new NotificationBuffer();
        buf.push(1, { seqNum: 1 }, 1000);
        assert.equal(buf.drain(1, 1001).length, 1);
        assert.deepEqual(buf.drain(1, 1002), []);
    });

    it('caps buffered notifications per id, keeping the newest', () => {
        const buf = new NotificationBuffer({ maxPerId: 3 });
        for (let i = 1; i <= 5; i++) buf.push(1, { seqNum: i }, 1000 + i);

        const drained = buf.drain(1, 1010);
        assert.deepEqual(drained.map((n) => n.seqNum), [3, 4, 5]);
    });

    it('prunes entries older than the TTL', () => {
        const buf = new NotificationBuffer({ ttlMs: 100 });
        buf.push(1, { seqNum: 1 }, 1000);
        buf.push(1, { seqNum: 2 }, 1050);

        // At t=1120 the first entry (age 120ms) is expired, the second not.
        const drained = buf.drain(1, 1120);
        assert.deepEqual(drained.map((n) => n.seqNum), [2]);
    });

    it('prune on push drops fully expired ids', () => {
        const buf = new NotificationBuffer({ ttlMs: 100 });
        buf.push(1, { seqNum: 1 }, 1000);
        buf.push(2, { seqNum: 2 }, 2000); // id 1 fully expired by now
        assert.equal(buf.size, 1);
        assert.deepEqual(buf.drain(1, 2000), []);
        assert.deepEqual(buf.drain(2, 2000).map((n) => n.seqNum), [2]);
    });

    it('discard drops buffered notifications for one id only', () => {
        const buf = new NotificationBuffer();
        buf.push(1, { seqNum: 1 }, 1000);
        buf.push(2, { seqNum: 2 }, 1000);

        buf.discard(1);
        assert.deepEqual(buf.drain(1, 1001), []);
        assert.deepEqual(buf.drain(2, 1001).map((n) => n.seqNum), [2]);
    });

    it('discard does not block later pushes for a reused id', () => {
        const buf = new NotificationBuffer();
        buf.push(1, { seqNum: 1 }, 1000); // stale, from the deleted object
        buf.discard(1);

        // The PLC reused the id for a new subscription whose initial
        // snapshot raced the CreateObject response again.
        buf.push(1, { seqNum: 99 }, 1002);
        assert.deepEqual(buf.drain(1, 1003).map((n) => n.seqNum), [99]);
    });

    it('clear drops everything', () => {
        const buf = new NotificationBuffer();
        buf.push(1, { seqNum: 1 }, 1000);
        buf.push(2, { seqNum: 2 }, 1000);
        buf.clear();
        assert.equal(buf.size, 0);
        assert.deepEqual(buf.drain(1, 1001), []);
    });
});
