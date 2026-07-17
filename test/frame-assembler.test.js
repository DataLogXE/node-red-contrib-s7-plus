'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FrameAssembler } = require('../lib/s7plus/frame-assembler');

const V2 = 0x02;
const SYSTEM_EVENT = 0xfe;

function header(ver, dataLen) {
    return Buffer.from([0x72, ver, (dataLen >> 8) & 0xff, dataLen & 0xff]);
}

function endMarker(ver = V2) {
    return header(ver, 0);
}

/** One complete single-fragment PDU on the wire: header + data + end marker. */
function wireFrame(data, ver = V2) {
    return Buffer.concat([header(ver, data.length), data, endMarker(ver)]);
}

function collect() {
    const pdus = [];
    const asm = new FrameAssembler({
        onPdu: (pdu) => pdus.push(pdu),
        systemEventVersion: SYSTEM_EVENT
    });
    return { asm, pdus };
}

describe('FrameAssembler', () => {
    it('dispatches one complete frame per chunk (previous happy path)', () => {
        const { asm, pdus } = collect();
        const a = Buffer.from([0x32, 0x03, 0x01]);
        const b = Buffer.from([0x32, 0x03, 0x02]);
        asm.push(wireFrame(a));
        asm.push(wireFrame(b));
        assert.equal(pdus.length, 2);
        assert.deepEqual(pdus[0], Buffer.concat([Buffer.from([V2]), a]));
        assert.deepEqual(pdus[1], Buffer.concat([Buffer.from([V2]), b]));
        assert.equal(asm.hasPartial, false);
    });

    it('dispatches BOTH frames when two frames arrive coalesced in one chunk', () => {
        // This exact case corrupted the old receive logic (both PDUs
        // lost, next PDU glued together from stale bytes).
        const { asm, pdus } = collect();
        const a = Buffer.from([0x32, 0x03, 0x00, 0x00, 0x05, 0x01, 0xaa, 0xbb]);
        const b = Buffer.from([0x32, 0x03, 0x00, 0x00, 0x05, 0x02, 0xcc, 0xdd]);
        asm.push(Buffer.concat([wireFrame(a), wireFrame(b)]));
        assert.equal(pdus.length, 2);
        assert.deepEqual(pdus[0].subarray(1), a);
        assert.deepEqual(pdus[1].subarray(1), b);
        assert.equal(asm.hasPartial, false);
    });

    it('does not contaminate the next PDU after a coalesced chunk', () => {
        const { asm, pdus } = collect();
        const a = Buffer.from([0x32, 0x03, 0x01]);
        const b = Buffer.from([0x32, 0x03, 0x02]);
        const c = Buffer.from([0x32, 0x03, 0x03]);
        asm.push(Buffer.concat([wireFrame(a), wireFrame(b)]));
        asm.push(wireFrame(c));
        assert.equal(pdus.length, 3);
        assert.deepEqual(pdus[2].subarray(1), c, 'third PDU must contain ONLY its own bytes');
    });

    it('reassembles a frame split mid-header', () => {
        const { asm, pdus } = collect();
        const data = Buffer.from([0x32, 0x03, 0x11, 0x22, 0x33]);
        const frame = wireFrame(data);
        asm.push(frame.subarray(0, 2)); // half the header
        assert.equal(pdus.length, 0);
        assert.equal(asm.hasPartial, true);
        asm.push(frame.subarray(2));
        assert.equal(pdus.length, 1);
        assert.deepEqual(pdus[0].subarray(1), data);
    });

    it('reassembles a frame split mid-body', () => {
        const { asm, pdus } = collect();
        const data = Buffer.alloc(64, 0x5a);
        const frame = wireFrame(data);
        asm.push(frame.subarray(0, 10)); // header + 6 data bytes
        assert.equal(pdus.length, 0);
        asm.push(frame.subarray(10));
        assert.equal(pdus.length, 1);
        assert.deepEqual(pdus[0].subarray(1), data);
    });

    it('reassembles a frame split mid-end-marker', () => {
        const { asm, pdus } = collect();
        const data = Buffer.from([1, 2, 3, 4]);
        const frame = wireFrame(data);
        asm.push(frame.subarray(0, frame.length - 2)); // end marker half-delivered
        assert.equal(pdus.length, 0);
        asm.push(frame.subarray(frame.length - 2));
        assert.equal(pdus.length, 1);
        assert.deepEqual(pdus[0].subarray(1), data);
    });

    it('reassembles multi-fragment PDUs (several data frames, one end marker)', () => {
        const { asm, pdus } = collect();
        const part1 = Buffer.alloc(100, 0x01);
        const part2 = Buffer.alloc(50, 0x02);
        asm.push(Buffer.concat([header(V2, part1.length), part1]));
        assert.equal(pdus.length, 0, 'no end marker yet');
        asm.push(Buffer.concat([header(V2, part2.length), part2, endMarker()]));
        assert.equal(pdus.length, 1);
        assert.equal(pdus[0].length, 1 + part1.length + part2.length);
        assert.deepEqual(pdus[0].subarray(1, 1 + part1.length), part1);
        assert.deepEqual(pdus[0].subarray(1 + part1.length), part2);
    });

    it('one byte at a time still produces a correct PDU', () => {
        const { asm, pdus } = collect();
        const data = Buffer.from([0x32, 0x03, 0x00, 0x01, 0x02]);
        const frame = wireFrame(data);
        for (const byte of frame) asm.push(Buffer.from([byte]));
        assert.equal(pdus.length, 1);
        assert.deepEqual(pdus[0].subarray(1), data);
    });

    it('resyncs after garbage bytes and drops the corrupt partial PDU', () => {
        const { asm, pdus } = collect();
        // Partial PDU in flight ...
        asm.push(Buffer.concat([header(V2, 4), Buffer.from([1, 2, 3, 4])]));
        // ... then garbage (lost sync), then a fresh valid frame.
        const fresh = Buffer.from([0x32, 0x03, 0x09]);
        asm.push(Buffer.concat([Buffer.from([0xde, 0xad, 0xbe, 0xef]), wireFrame(fresh)]));
        assert.equal(pdus.length, 1, 'only the fresh frame is dispatched');
        assert.deepEqual(pdus[0].subarray(1), fresh, 'no stale bytes glued in');
        assert.ok(asm.resyncSkippedBytes >= 4);
    });

    it('ignores a stray end marker without pending PDU', () => {
        const { asm, pdus } = collect();
        asm.push(endMarker());
        assert.equal(pdus.length, 0);
        assert.equal(asm.hasPartial, false);
    });

    it('system event frames are consumed and drop a partial PDU', () => {
        const { asm, pdus } = collect();
        asm.push(Buffer.concat([header(V2, 3), Buffer.from([1, 2, 3])])); // partial PDU
        asm.push(Buffer.concat([header(SYSTEM_EVENT, 2), Buffer.from([0x99, 0x88])]));
        asm.push(endMarker());
        assert.equal(pdus.length, 0, 'partial PDU was invalidated by the system event');
        const fresh = Buffer.from([7, 7, 7]);
        asm.push(wireFrame(fresh));
        assert.equal(pdus.length, 1);
        assert.deepEqual(pdus[0].subarray(1), fresh);
    });

    it('drops oversized PDUs instead of accumulating forever', () => {
        const pdus = [];
        const asm = new FrameAssembler({
            onPdu: (pdu) => pdus.push(pdu),
            maxPduBytes: 1024
        });
        const bigChunk = Buffer.alloc(600, 0xaa);
        asm.push(Buffer.concat([header(V2, bigChunk.length), bigChunk]));
        asm.push(Buffer.concat([header(V2, bigChunk.length), bigChunk]));
        asm.push(endMarker());
        assert.equal(pdus.length, 0, 'oversized PDU must be dropped');
        assert.equal(asm.oversizedDropped, 1);
        // Assembler stays usable.
        const fresh = Buffer.from([1]);
        asm.push(wireFrame(fresh));
        assert.equal(pdus.length, 1);
    });

    it('reset() clears buffered state', () => {
        const { asm } = collect();
        asm.push(Buffer.concat([header(V2, 10), Buffer.from([1, 2, 3])]));
        assert.equal(asm.hasPartial, true);
        asm.reset();
        assert.equal(asm.hasPartial, false);
    });

    it('handles a realistic notification burst: 50 frames sliced into random chunks', () => {
        const { asm, pdus } = collect();
        const frames = [];
        const expected = [];
        for (let i = 0; i < 50; i++) {
            const data = Buffer.alloc(20 + (i % 7));
            data.fill(i + 1);
            data[0] = 0x33; // notification-ish opcode marker
            expected.push(data);
            frames.push(wireFrame(data));
        }
        const stream = Buffer.concat(frames);
        // Deterministic pseudo-random chunking.
        let seed = 42;
        const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
        let pos = 0;
        while (pos < stream.length) {
            const n = 1 + (rand() % 37);
            asm.push(stream.subarray(pos, Math.min(pos + n, stream.length)));
            pos += n;
        }
        assert.equal(pdus.length, 50);
        for (let i = 0; i < 50; i++) {
            assert.deepEqual(pdus[i].subarray(1), expected[i], `PDU ${i} intact`);
        }
        assert.equal(asm.hasPartial, false);
    });
});
