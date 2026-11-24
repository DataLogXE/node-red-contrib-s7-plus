'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const S7Transport = require('../lib/s7plus/transport/s7-transport');

// A request larger than one COTP TPDU is sent as several packets. Node.js
// merges TLS writes that are queued behind a write still in flight into ONE
// TLS record, which then exceeds the PLC's TPDU size (connection reset).
// The transport must therefore hand the next packet to TLS only after the
// previous write was flushed.
function fakeTls() {
    const sock = {
        writes: [],
        pending: [],
        write(buf, cb) {
            sock.writes.push(buf);
            sock.pending.push(cb);
            return true;
        },
        flush(err) {
            const cb = sock.pending.shift();
            if (cb) cb(err);
        }
    };
    return sock;
}

function tlsTransport() {
    const t = new S7Transport();
    const sock = fakeTls();
    t._ssl = true;
    t._io = sock;
    t._tlsSocket = sock;
    return { t, sock };
}

describe('S7Transport TLS send', () => {
    it('writes the first packet immediately', () => {
        const { t, sock } = tlsTransport();
        t.send(Buffer.from([1]));
        assert.equal(sock.writes.length, 1);
    });

    it('holds further packets until the previous write is flushed', () => {
        const { t, sock } = tlsTransport();
        const packets = [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])];
        for (const p of packets) t.send(p);
        assert.equal(sock.writes.length, 1, 'only one write in flight');

        sock.flush();
        assert.equal(sock.writes.length, 2);
        sock.flush();
        assert.equal(sock.writes.length, 3);
        sock.flush();
        assert.deepEqual(sock.writes, packets, 'order preserved, one write per packet');
        assert.equal(sock.pending.length, 0);
    });

    it('writes immediately again after the queue drained', () => {
        const { t, sock } = tlsTransport();
        t.send(Buffer.from([1]));
        sock.flush();
        t.send(Buffer.from([2]));
        assert.equal(sock.writes.length, 2);
    });

    it('drops queued packets when a write fails', () => {
        const { t, sock } = tlsTransport();
        t.send(Buffer.from([1]));
        t.send(Buffer.from([2]));
        sock.flush(new Error('EPIPE'));
        assert.equal(sock.writes.length, 1);
        // a later send (after reconnect logic) is not blocked by stale state
        t.send(Buffer.from([3]));
        assert.equal(sock.writes.length, 2);
    });

    it('drops queued packets on disconnect and ignores late write callbacks', () => {
        const { t, sock } = tlsTransport();
        t.send(Buffer.from([1]));
        t.send(Buffer.from([2]));
        t.disconnect();
        sock.flush();
        assert.equal(sock.writes.length, 1, 'queued packet is not written to the old socket');
        assert.throws(() => t.send(Buffer.from([3])), /not connected/);
    });

    it('a new connection starts with a clean queue', () => {
        const { t, sock } = tlsTransport();
        t.send(Buffer.from([1]));
        t.send(Buffer.from([2]));
        t.disconnect();

        const sock2 = fakeTls();
        t._ssl = true;
        t._io = sock2;
        t._tlsSocket = sock2;
        t.send(Buffer.from([9]));
        assert.deepEqual(sock2.writes, [Buffer.from([9])]);
        sock.flush(); // late callback of the old socket must not disturb the new one
        t.send(Buffer.from([8]));
        assert.equal(sock2.writes.length, 1, 'second packet waits for the new socket only');
        sock2.flush();
        assert.equal(sock2.writes.length, 2);
    });
});
