'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    S7CRC32,
    TypeCode,
    computeItemCrc,
    computeNestedItemCrc,
    memberInnerCrc,
    finalizeItemCrc,
    softdatatypeToTypeCode
} = require('../lib/s7plus/crc');

describe('S7CRC32', () => {
    it('produces correct table entry [1]', () => {
        const crc = new S7CRC32();
        crc.updateByte(1);
        assert.equal(crc.result, 4104977171);
    });

    it('HarpoS7 gist: "Test2" + DInt', () => {
        const crc = new S7CRC32();
        crc.update('Test2');
        crc.updateByte(0x07);
        assert.equal(crc.result, 0x9E858004);
    });

    it('updateUInt32LE feeds 4 LE bytes', () => {
        const crc = new S7CRC32();
        crc.updateUInt32LE(0x9E858004);
        assert.equal(crc.result, 0x4CA70840);
    });

    it('hashes strings as UTF-8 bytes (umlaut)', () => {
        const viaString = new S7CRC32();
        viaString.update('wärt');

        const viaUtf8 = new S7CRC32();
        viaUtf8.update(Buffer.from('wärt', 'utf8'));
        assert.equal(viaString.result, viaUtf8.result);

        // latin1 would feed a single 0xE4 byte instead of 0xC3 0xA4 and
        // therefore yield a different (wrong) CRC.
        const viaLatin1 = new S7CRC32();
        viaLatin1.update(Buffer.from('wärt', 'latin1'));
        assert.notEqual(viaString.result, viaLatin1.result);
    });
});

describe('computeItemCrc', () => {
    it('HarpoS7 gist: Test2 DInt', () => {
        assert.equal(computeItemCrc('Test2', TypeCode.DInt), 0x4CA70840);
    });

    it('HarpoS7 gist: TEST 3 Array[0..6] of Bool', () => {
        const crc = computeItemCrc('TEST 3', TypeCode.Array, {
            elementTypeCode: TypeCode.Bool,
            lowerBound: 0
        });
        assert.equal(crc, 0x0CC865FB);
    });

    it('known CRC for Real array (lowerBound=0)', () => {
        const crc = computeItemCrc('readings', TypeCode.Array, {
            elementTypeCode: TypeCode.Real,
            lowerBound: 0
        });
        assert.equal(crc, 0x6580D02C);
    });

    it('known CRC for Bool scalar', () => {
        const crc = computeItemCrc('flag', TypeCode.Bool);
        assert.equal(crc, 0xFC8BA389);
    });

    it('computes CRC over UTF-8 member name with umlaut', () => {
        // The member name "mein erster wärt" must be hashed over its UTF-8
        // bytes (ä = 0xC3 0xA4), matching the PLC. The latin1 variant would
        // diverge and the PLC rejects the read with a CRC-mismatch error.
        const name = 'mein erster wärt';
        const expectedInner = new S7CRC32();
        expectedInner.update(Buffer.from(name, 'utf8'));
        expectedInner.updateByte(TypeCode.Real);
        const expected = finalizeItemCrc(expectedInner.result);

        assert.equal(computeItemCrc(name, TypeCode.Real), expected);

        const latin1Inner = new S7CRC32();
        latin1Inner.update(Buffer.from(name, 'latin1'));
        latin1Inner.updateByte(TypeCode.Real);
        assert.notEqual(computeItemCrc(name, TypeCode.Real), finalizeItemCrc(latin1Inner.result));
    });
});

describe('computeNestedItemCrc', () => {
    it('HarpoS7 gist: "TEST 4".T4ChildBool', () => {
        const crc = computeNestedItemCrc([
            { name: 'TEST 4', typeCode: TypeCode.Struct },
            { name: 'T4ChildBool', typeCode: TypeCode.Bool }
        ]);
        assert.equal(crc, 0x1AC12998);
    });

    it('single segment equals computeItemCrc', () => {
        const nested = computeNestedItemCrc([
            { name: 'readings', typeCode: TypeCode.Array, arrayInfo: { elementTypeCode: TypeCode.Real, lowerBound: 0 } }
        ]);
        const direct = computeItemCrc('readings', TypeCode.Array, { elementTypeCode: TypeCode.Real, lowerBound: 0 });
        assert.equal(nested, direct);
    });
});

describe('softdatatypeToTypeCode', () => {
    it('maps Real (8) -> 0x08', () => {
        assert.equal(softdatatypeToTypeCode(8), TypeCode.Real);
    });

    it('maps Bool (1) -> 0x01', () => {
        assert.equal(softdatatypeToTypeCode(1), TypeCode.Bool);
    });

    it('maps BBool (40) -> Bool 0x01', () => {
        assert.equal(softdatatypeToTypeCode(40), TypeCode.Bool);
    });

    it('maps Struct (17) -> 0x11', () => {
        assert.equal(softdatatypeToTypeCode(17), TypeCode.Struct);
    });

    it('passes through unknown values unchanged', () => {
        assert.equal(softdatatypeToTypeCode(99), 99);
    });
});
