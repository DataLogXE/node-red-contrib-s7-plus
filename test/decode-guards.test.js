'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const BufferStream = require('../lib/s7plus/buffer-stream');
const pvalue = require('../lib/s7plus/pvalue');
const PObject = require('../lib/s7plus/pobject');
const { parseNotification } = require('../lib/s7plus/subscription');

/** VLQ-encode an unsigned int (same wire format S7p.decodeUInt32Vlq reads). */
function vlq(n) {
    const out = [];
    do { out.unshift(n & 0x7f); n >>>= 7; } while (n > 0);
    for (let i = 0; i < out.length - 1; i++) out[i] |= 0x80;
    return out;
}

const FLAGS_ARRAY = 0x10;
const DT_BOOL = 0x01;
const DT_BLOB = 0x14;
const DT_WSTRING = 0x15;
const DT_STRUCT = 0x17;

describe('decode guards against corrupt PDUs', () => {
    it('rejects an array whose claimed length exceeds the buffer (fast, no sync loop)', () => {
        // Claimed 100 million Bool elements, but the buffer ends right
        // after the length field. The old decoder looped the full count
        // synchronously (seconds to minutes of frozen event loop).
        const bytes = Buffer.from([FLAGS_ARRAY, DT_BOOL, ...vlq(100000000)]);
        const t0 = Date.now();
        assert.throws(
            () => pvalue.deserialize(new BufferStream(bytes)),
            /decode overrun/
        );
        assert.ok(Date.now() - t0 < 50, 'must fail immediately, not loop');
    });

    it('rejects a 32-bit garbage array length immediately', () => {
        const bytes = Buffer.from([FLAGS_ARRAY, DT_BOOL, ...vlq(0xffffffff)]);
        const t0 = Date.now();
        assert.throws(
            () => pvalue.deserialize(new BufferStream(bytes)),
            /decode overrun/
        );
        assert.ok(Date.now() - t0 < 50);
    });

    it('rejects a blob whose size exceeds the remaining bytes', () => {
        const bytes = Buffer.from([0x00, DT_BLOB, ...vlq(0x7fffffff), 0x01, 0x02]);
        assert.throws(
            () => pvalue.deserialize(new BufferStream(bytes)),
            /decode overrun/
        );
    });

    it('rejects a wstring whose size exceeds the remaining bytes', () => {
        const bytes = Buffer.from([0x00, DT_WSTRING, ...vlq(1 << 30)]);
        assert.throws(
            () => pvalue.deserialize(new BufferStream(bytes)),
            /decode overrun/
        );
    });

    it('rejects a truncated struct instead of spinning', () => {
        // Struct id + first element key, then the buffer ends.
        const bytes = Buffer.from([
            0x00, DT_STRUCT,
            0x00, 0x00, 0x00, 0x01, // struct id (UInt32)
            ...vlq(5)               // element key > 0, but no value follows
        ]);
        assert.throws(
            () => pvalue.deserialize(new BufferStream(bytes)),
            /decode overrun/
        );
    });

    it('still decodes a valid small array', () => {
        const bytes = Buffer.from([FLAGS_ARRAY, DT_BOOL, ...vlq(3), 1, 0, 1]);
        const v = pvalue.deserialize(new BufferStream(bytes));
        assert.deepEqual(v.toJs(), [true, false, true]);
    });

    it('parseNotification on a corrupt PDU fails fast instead of freezing', () => {
        // A garbage "notification" whose value area claims a huge array.
        const head = Buffer.from([
            0x02, 0x33,             // protoVersion, opcode Notification
            0x00, 0x00, 0x00, 0x07, // subscriptionId
            0, 0, 0, 0, 0, 0,       // unknown2..4
            0x01,                   // creditTick
            ...vlq(1),              // seqNum
            0x05                    // changeCounter (non-zero)
        ]);
        const item = Buffer.from([
            0x92,                   // item with value
            0x00, 0x00, 0x00, 0x01, // itemRef
            FLAGS_ARRAY, DT_BOOL, ...vlq(50000000) // huge claimed array, no data
        ]);
        const t0 = Date.now();
        assert.throws(
            () => parseNotification(new BufferStream(Buffer.concat([head, item]))),
            /decode overrun/
        );
        assert.ok(Date.now() - t0 < 50, 'receive path must fail fast');
    });

    it('decodeObjectList on a stalling buffer throws instead of spinning', () => {
        // StartOfObject tag, then nothing — decodeObject consumes the
        // header bytes; a second iteration must not stall.
        const { ElementID } = require('../lib/s7plus/constants');
        const bytes = Buffer.from([ElementID.StartOfObject, 0, 0, 0, 1]);
        // Must terminate quickly (either empty-ish object or throw).
        const t0 = Date.now();
        try {
            PObject.decodeObjectList(new BufferStream(bytes));
        } catch (e) {
            assert.match(e.message, /decode (stalled|overrun)/);
        }
        assert.ok(Date.now() - t0 < 50);
    });
});
