'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const BufferStream = require('../lib/s7plus/buffer-stream');
const S7p = require('../lib/s7plus/s7p');
const ItemAddress = require('../lib/s7plus/item-address');
const { readExactly, disposeReader, interruptReader } = require('../lib/s7plus/transport/cotp-stream');
const S7Transport = require('../lib/s7plus/transport/s7-transport');
const pvalue = require('../lib/s7plus/pvalue');
const { InitSslRequest } = require('../lib/s7plus/pdu-messages');
const { ProtocolVersion, Datatype } = require('../lib/s7plus/constants');

describe('S7p VLQ', () => {
    it('round-trips uint32 vlq', () => {
        const buf = new BufferStream();
        S7p.encodeUInt32Vlq(buf, 12345);
        buf.position = 0;
        const r = S7p.decodeUInt32Vlq(buf);
        assert.strictEqual(r.v, 12345);
    });

    it('round-trips int32 vlq', () => {
        const buf = new BufferStream();
        S7p.encodeInt32Vlq(buf, -9876);
        buf.position = 0;
        const r = S7p.decodeInt32Vlq(buf);
        assert.strictEqual(r.v, -9876);
    });
});

describe('ItemAddress', () => {
    it('parses access string', () => {
        const a = new ItemAddress('8A0E0001.A');
        assert.strictEqual(a.accessArea, 0x8a0e0001);
        assert.deepStrictEqual(a.lid, [0xa]);
    });
});

function listenEphemeral(handler) {
    return new Promise((resolve) => {
        const server = net.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

describe('SocketReader / readExactly', () => {
    it('accumulates across multiple reads when data arrives in a single burst', async () => {
        const payload = Buffer.from('0123456789abcdef', 'utf8');
        const server = await listenEphemeral((sock) => {
            sock.write(payload);
        });
        try {
            const port = server.address().port;
            const sock = net.connect({ host: '127.0.0.1', port });
            await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
            const a = await readExactly(sock, 4, 2000);
            const b = await readExactly(sock, 4, 2000);
            const c = await readExactly(sock, 8, 2000);
            assert.strictEqual(a.toString(), '0123');
            assert.strictEqual(b.toString(), '4567');
            assert.strictEqual(c.toString(), '89abcdef');
            disposeReader(sock);
            sock.destroy();
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    it('waits across two separate bursts', async () => {
        const server = await listenEphemeral((sock) => {
            sock.write(Buffer.from([0x03, 0x00, 0x00, 0x24]));
            setTimeout(() => {
                sock.write(Buffer.from('rest-of-the-cc-frame-32b-padding', 'utf8'));
            }, 50);
        });
        try {
            const port = server.address().port;
            const sock = net.connect({ host: '127.0.0.1', port });
            await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
            const hdr = await readExactly(sock, 4, 2000);
            const body = await readExactly(sock, 32, 2000);
            assert.strictEqual(hdr[0], 0x03);
            assert.strictEqual(hdr[3], 0x24);
            assert.strictEqual(body.length, 32);
            disposeReader(sock);
            sock.destroy();
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    it('rejects with timeout when data never arrives', async () => {
        const server = await listenEphemeral(() => { /* stay silent */ });
        try {
            const port = server.address().port;
            const sock = net.connect({ host: '127.0.0.1', port });
            await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
            await assert.rejects(
                readExactly(sock, 1, 100),
                /COTP read timeout/
            );
            disposeReader(sock);
            sock.destroy();
        } finally {
            await new Promise((r) => server.close(r));
        }
    });
});

describe('S7Transport.connect', () => {
    function buildCcResponse(remoteTsap) {
        const total = 20 + remoteTsap.length;
        const buf = Buffer.alloc(total);
        buf[0] = 0x03;
        buf[1] = 0x00;
        buf[2] = (total >> 8) & 0xff;
        buf[3] = total & 0xff;
        buf[4] = 15 + remoteTsap.length;
        buf[5] = 0xd0;
        remoteTsap.copy(buf, 20);
        return buf;
    }

    it('returns 0 after CR/CC handshake with split CC bursts (no false timeout)', async () => {
        const remoteTsap = Buffer.from('SIMATIC-ROOT-HMI', 'ascii');
        const cc = buildCcResponse(remoteTsap);
        const server = await listenEphemeral((sock) => {
            sock.once('data', () => {
                sock.write(cc.subarray(0, 4));
                setTimeout(() => sock.write(cc.subarray(4)), 30);
            });
        });
        try {
            const port = server.address().port;
            const t = new S7Transport();
            t.setTimeouts(2000);
            t.setConnectionParams('127.0.0.1', 0x0600, remoteTsap, port);
            const res = await t.connect();
            assert.strictEqual(res, 0);
            t.disconnect();
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    it('returns errTCPConnectionTimeout when server never accepts', async () => {
        const t = new S7Transport();
        t.setTimeouts(150);
        t.setConnectionParams('10.255.255.1', 0x0600, Buffer.from('SIMATIC-ROOT-HMI', 'ascii'), 102);
        const start = Date.now();
        const res = await t.connect();
        const elapsed = Date.now() - start;
        assert.strictEqual(res, 0x00010000);
        assert.ok(elapsed < 1500, `should respect connect timeout, took ${elapsed}ms`);
        t.disconnect();
    });
});

describe('InitSslRequest serialization (regression)', () => {
    it('emits exactly 17 bytes payload (no duplicate transportFlags)', () => {
        // C# reference serializes opcode(1) + reserved(2) + fn(2) + reserved(2)
        //                      + seq(2) + sessionId(4) + transportFlags(1) + fill(4) = 18 bytes.
        // Our writeRequestHeader already includes transportFlags, so the
        // post-header body must only add the 4-byte fill (no second flag byte).
        const req = new InitSslRequest(ProtocolVersion.V1, 1, 0);
        const body = req.serialize();
        assert.strictEqual(body.length, 18, `expected 18 bytes payload, got ${body.length}`);
        // last 4 bytes are the fill UInt32 = 0
        assert.deepStrictEqual(
            body.subarray(14).toString('hex'),
            '00000000',
            'last 4 bytes must be fill UInt32 = 0'
        );
        // byte 13 must be the single transportFlags (0x30)
        assert.strictEqual(body[13], 0x30, 'transportFlags must appear exactly once at offset 13');
    });
});

describe('encodeObjectQualifier (regression)', () => {
    it('uses ValueAID datatype (0x13), not ValueRID (0x12), for CompositionAID', () => {
        const buf = new BufferStream();
        pvalue.encodeObjectQualifier(buf);
        const out = buf.toBuffer();
        // Layout: UInt32 ObjectQualifier(1256) | VLQ ParentRID(1257) | flags(00) type(RID=0x12) UInt32(0)
        //       | VLQ CompositionAID(1258)    | flags(00) type(AID=0x13) VLQ UInt32(0)
        //       | VLQ KeyQualifier(1259)      | flags(00) type(UDInt=0x04) VLQ UInt32(0)
        //       | byte 0x00
        // Find the AID datatype byte by counting:
        // 4 (UInt32 ObjectQualifier) + 2 (VLQ ParentRID) + 6 (flags+RID+UInt32) = byte 12 = flags for next
        // Actually easier: search for sequence 0x00, 0x13 (flags, AID) in the buffer
        const idx = out.indexOf(Buffer.from([0x00, 0x13]));
        assert.ok(idx > 0, 'AID datatype 0x13 must appear in encoded ObjectQualifier');
    });
});

describe('SocketReader.interrupt', () => {
    it('rejects pending read with EREADINTERRUPTED and keeps reader usable', async () => {
        const server = await listenEphemeral((sock) => {
            // stay silent first, then send 4 bytes after interrupt
            setTimeout(() => sock.write(Buffer.from([1, 2, 3, 4])), 100);
        });
        try {
            const port = server.address().port;
            const sock = net.connect({ host: '127.0.0.1', port });
            await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });

            // start a read that will hang (no data yet)
            const pendingRead = readExactly(sock, 4, 2000);
            // interrupt it
            setImmediate(() => interruptReader(sock, 'test interrupt'));
            await assert.rejects(pendingRead, (err) => err.code === 'EREADINTERRUPTED');

            // reader must still be usable for next consumer (TLS handoff scenario)
            const next = await readExactly(sock, 4, 2000);
            assert.deepStrictEqual([...next], [1, 2, 3, 4]);
            disposeReader(sock);
            sock.destroy();
        } finally {
            await new Promise((r) => server.close(r));
        }
    });
});

describe('PValue deserialization', () => {
    it('reads scalar Byte (0x0a)', () => {
        const buf = new BufferStream();
        new pvalue.ValueByte(0x7e).serialize(buf);
        buf.position = 0;
        const v = pvalue.deserialize(buf);
        assert.strictEqual(v.toJs(), 0x7e);
    });
    it('reads scalar Word (0x0b)', () => {
        const buf = new BufferStream();
        new pvalue.ValueWord(0xcafe).serialize(buf);
        buf.position = 0;
        const v = pvalue.deserialize(buf);
        assert.strictEqual(v.toJs(), 0xcafe);
    });
    it('reads scalar DWord (0x0c)', () => {
        const buf = new BufferStream();
        new pvalue.ValueDWord(0xdeadbeef).serialize(buf);
        buf.position = 0;
        const v = pvalue.deserialize(buf);
        assert.strictEqual(v.toJs(), 0xdeadbeef);
    });
    it('reads scalar LWord (0x0d)', () => {
        const buf = new BufferStream();
        new pvalue.ValueLWord(0x0123456789abcdefn).serialize(buf);
        buf.position = 0;
        const v = pvalue.deserialize(buf);
        assert.strictEqual(v.toJs(), 0x0123456789abcdefn);
    });
    it('reads scalar Timestamp (0x10)', () => {
        const buf = new BufferStream();
        new pvalue.ValueTimestamp(0x0011223344556677n).serialize(buf);
        buf.position = 0;
        const v = pvalue.deserialize(buf);
        assert.strictEqual(v.toJs(), 0x0011223344556677n);
    });
    it('reads scalar AID (0x13)', () => {
        const buf = new BufferStream();
        new pvalue.ValueAID(12345).serialize(buf);
        buf.position = 0;
        const v = pvalue.deserialize(buf);
        assert.strictEqual(v.toJs(), 12345);
    });
});
