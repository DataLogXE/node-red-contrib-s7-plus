'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const S7p = require('../lib/s7plus/s7p');
const BufferStream = require('../lib/s7plus/buffer-stream');
const ItemAddress = require('../lib/s7plus/item-address');
const pvalue = require('../lib/s7plus/pvalue');
const { Ids, Opcode, ProtocolVersion } = require('../lib/s7plus/constants');
const {
    buildSubscriptionReferenceList,
    buildSubscriptionObject,
    parseNotification
} = require('../lib/s7plus/subscription');

describe('buildSubscriptionReferenceList', () => {
    it('encodes header and one CRC-secured item like the reference driver', () => {
        const addr = new ItemAddress('8A0E0001.A'); // DB access area + one LID (0xA)
        addr.symbolCrc = 0x1234;
        const { value, refToName } = buildSubscriptionReferenceList(
            [{ name: 'DB1.x', address: addr, datatype: 'Int' }],
            1
        );

        // Address-array flag must be 0x20.
        assert.equal(value.flags, 0x20);

        assert.deepEqual(value.arr, [
            (0x80000000 | (1 << 16)) >>> 0, // CreateNew flag + change counter
            0,                              // unsubscribe count
            1,                              // subscribe count
            (0x80040000 | 2) >>> 0,         // head: 1 (sub-area) + 1 LID
            1,                              // tag reference id
            0,                              // unknown
            0x8a0e0001,                     // access area
            0x1234,                         // symbol CRC
            Ids.DB_ValueActual,             // access sub-area (2550)
            0x0a                            // LID
        ]);

        assert.equal(refToName.get(1).name, 'DB1.x');
        assert.equal(refToName.get(1).datatype, 'Int');
    });

    it('assigns 1-based reference ids in order for multiple items', () => {
        const a = new ItemAddress('8A0E0001.A');
        const b = new ItemAddress('8A0E0002.B');
        const { refToName } = buildSubscriptionReferenceList([
            { name: 'first', address: a },
            { name: 'second', address: b }
        ], 1);
        assert.equal(refToName.get(1).name, 'first');
        assert.equal(refToName.get(2).name, 'second');
    });
});

describe('buildSubscriptionObject', () => {
    it('builds a ClassSubscription object with the expected attributes', () => {
        const addr = new ItemAddress('8A0E0001.A');
        const { object, relationId } = buildSubscriptionObject(
            [{ name: 'DB1.x', address: addr }],
            { cycleMs: 500, routeMode: 0x20, creditLimit: -1, relationId: 0x7fffc001 }
        );
        assert.equal(object.classId, Ids.ClassSubscription);
        assert.equal(relationId, 0x7fffc001);
        assert.ok(object.getAttribute(Ids.SubscriptionReferenceList));
        assert.equal(object.getAttribute(Ids.SubscriptionCycleTime).toJs(), 500);
        assert.equal(object.getAttribute(Ids.SubscriptionRouteMode).toJs(), 0x20);
        assert.equal(object.getAttribute(Ids.SubscriptionCreditLimit).toJs(), -1);
    });
});

// Build a notification PDU body the way an S7-1200 (1-byte change counter)
// or an S7-1500 (change-counter byte == 0 followed by an 8-byte UTC stamp)
// would send it, so parseNotification can be exercised without a live PLC.
function buildNotificationPdu({ subscriptionId, creditTick, seqNum, changeCounter, timestampMicros, items, errors }) {
    const buf = new BufferStream();
    S7p.encodeByte(buf, ProtocolVersion.V2);
    S7p.encodeByte(buf, Opcode.Notification);
    S7p.encodeUInt32(buf, subscriptionId);
    S7p.encodeUInt16(buf, 0x0400); // unknown2
    S7p.encodeUInt16(buf, 0);      // unknown3
    S7p.encodeUInt16(buf, 0);      // unknown4
    S7p.encodeByte(buf, creditTick);
    S7p.encodeUInt32Vlq(buf, seqNum);
    if (timestampMicros != null) {
        // 1500 path: the 8-byte timestamp whose first byte is 0 acts as the
        // (zero) change-counter trigger, then a real change counter follows.
        S7p.encodeUInt64(buf, timestampMicros);
        S7p.encodeByte(buf, changeCounter);
    } else {
        S7p.encodeByte(buf, changeCounter);
    }
    for (const it of items || []) {
        S7p.encodeByte(buf, 0x92);
        S7p.encodeUInt32(buf, it.ref);
        it.value.serialize(buf);
    }
    for (const er of errors || []) {
        S7p.encodeByte(buf, 0x13);
        S7p.encodeUInt32(buf, er.ref);
    }
    S7p.encodeByte(buf, 0x00); // terminator
    return buf.toBuffer();
}

describe('parseNotification', () => {
    it('decodes a 1200-style notification with a value and an error item', () => {
        const pdu = buildNotificationPdu({
            subscriptionId: 0x10000001,
            creditTick: 0,
            seqNum: 5,
            changeCounter: 1,
            items: [{ ref: 1, value: new pvalue.ValueDInt(1234) }],
            errors: [{ ref: 2 }]
        });

        const noti = parseNotification(new BufferStream(pdu));
        assert.equal(noti.subscriptionId, 0x10000001);
        assert.equal(noti.seqNum, 5);
        assert.equal(noti.changeCounter, 1);
        assert.equal(noti.plcTimestamp, null);
        assert.equal(noti.values.get(1).toJs(), 1234);
        assert.equal(noti.errors.get(2), 0x13);
    });

    it('decodes a 1500-style notification with PLC UTC timestamp', () => {
        const micros = 1700000000000000n; // microseconds since epoch
        const pdu = buildNotificationPdu({
            subscriptionId: 0x70000001,
            creditTick: 0,
            seqNum: 9,
            changeCounter: 3,
            timestampMicros: micros,
            items: [{ ref: 1, value: new pvalue.ValueReal(42.5) }]
        });

        const noti = parseNotification(new BufferStream(pdu));
        assert.equal(noti.subscriptionId, 0x70000001);
        assert.ok(noti.plcTimestamp instanceof Date);
        assert.equal(noti.plcTimestamp.getTime(), Number(micros / 1000n));
        assert.equal(noti.changeCounter, 3);
        assert.ok(Math.abs(noti.values.get(1).toJs() - 42.5) < 1e-6);
    });

    it('returns null for a non-notification opcode', () => {
        const buf = new BufferStream();
        S7p.encodeByte(buf, ProtocolVersion.V2);
        S7p.encodeByte(buf, Opcode.Response);
        assert.equal(parseNotification(new BufferStream(buf.toBuffer())), null);
    });
});

describe('symbolPathOf (subscribe node)', () => {
    const { symbolPathOf } = require('../nodes/s7complus-subscribe');
    it('returns the string itself for string entries', () => {
        assert.equal(symbolPathOf('DB1.x'), 'DB1.x');
    });
    it('prefers a symbolic address over a symbolic name', () => {
        assert.equal(symbolPathOf({ name: 'label', address: 'DB1.x' }), 'DB1.x');
    });
    it('uses the symbolic name when the address is hex', () => {
        assert.equal(symbolPathOf({ name: 'DB1.x', address: '8A0E0001.A' }), 'DB1.x');
    });
    it('rejects a hex-only entry (no symbolic path)', () => {
        assert.equal(symbolPathOf({ address: '8A0E0001.A' }), null);
    });
});
