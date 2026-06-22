'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { resolveLeaf } = require('../lib/s7plus/browse/lazy');
const { computeCrcFromMeta, computeItemCrc, TypeCode } = require('../lib/s7plus/crc');
const { parseSymbolSegments } = require('../lib/s7plus/browse/resolve-symbolic');

// --- resolveLeaf crcMeta ---
describe('resolveLeaf crcMeta', () => {
    const eNodeType = { Root: 1, Var: 2, Array: 3, StructArray: 4 };

    it('simple scalar (Bool) provides correct crcMeta', () => {
        const desc = {
            t: 'leaf',
            path: [
                { nodeType: eNodeType.Root, name: 'DB1', accessId: 0x8A0E0001 },
                { nodeType: eNodeType.Var, name: '.flag', accessId: 0xA, softdatatype: 1, vte: { offsetInfoType: {} } }
            ]
        };
        const result = resolveLeaf(desc);
        assert.equal(result.crcMeta.memberName, 'flag');
        assert.equal(result.crcMeta.softdatatype, 1);
        assert.equal(result.crcMeta.isArray, false);
        assert.equal(result.crcMeta.elementSoftdatatype, 0);
        assert.equal(result.crcMeta.lowerBound, 0);
    });

    it('array element provides correct crcMeta', () => {
        const desc = {
            t: 'leaf',
            path: [
                { nodeType: eNodeType.Root, name: 'DB1', accessId: 0x8A0E0001 },
                {
                    nodeType: eNodeType.Var,
                    name: '.readings',
                    accessId: 0xB,
                    softdatatype: 8,
                    vte: { offsetInfoType: { getArrayLowerBounds: () => 0 } }
                },
                { nodeType: eNodeType.Array, name: '[0]', accessId: 0, softdatatype: 8, vte: {} }
            ]
        };
        const result = resolveLeaf(desc);
        assert.equal(result.crcMeta.memberName, 'readings');
        assert.equal(result.crcMeta.isArray, true);
        assert.equal(result.crcMeta.elementSoftdatatype, 8);
        assert.equal(result.crcMeta.lowerBound, 0);
    });

    it('array element with non-zero lower bound', () => {
        const desc = {
            t: 'leaf',
            path: [
                { nodeType: eNodeType.Root, name: 'DB1', accessId: 0x8A0E0001 },
                {
                    nodeType: eNodeType.Var,
                    name: '.arr',
                    accessId: 0xC,
                    softdatatype: 7,
                    vte: { offsetInfoType: { getArrayLowerBounds: () => 5 } }
                },
                { nodeType: eNodeType.Array, name: '[5]', accessId: 0, softdatatype: 7, vte: {} }
            ]
        };
        const result = resolveLeaf(desc);
        assert.equal(result.crcMeta.memberName, 'arr');
        assert.equal(result.crcMeta.isArray, true);
        assert.equal(result.crcMeta.lowerBound, 5);
    });

    it('array element survives JSON.stringify/parse roundtrip (encodeNodeId path)', () => {
        // Regression for the silent fallback to lowerBound=0 after the
        // descriptor was serialized via encodeNodeId. POffsetInfoTypeArray1Dim
        // methods are stripped by JSON.stringify; the raw arrayLowerBounds
        // property must still drive the CRC computation.
        const desc = {
            t: 'leaf',
            path: [
                { nodeType: eNodeType.Root, name: 'DB2', accessId: 0x8A0E0001 },
                {
                    nodeType: eNodeType.Var,
                    name: '.sintItems',
                    accessId: 9,
                    softdatatype: 55,
                    vte: {
                        lid: 9,
                        softdatatype: 55,
                        offsetInfoType: {
                            arrayLowerBounds: 1,
                            arrayElementCount: 10000,
                            getArrayLowerBounds: () => 1,
                            getArrayElementCount: () => 10000,
                            is1Dim: () => true
                        }
                    }
                },
                { nodeType: eNodeType.Array, name: '[1]', accessId: 0, softdatatype: 55, vte: {} }
            ]
        };
        const rehydrated = JSON.parse(JSON.stringify(desc));
        const result = resolveLeaf(rehydrated);
        assert.equal(result.crcMeta.memberName, 'sintItems');
        assert.equal(result.crcMeta.isArray, true);
        assert.equal(result.crcMeta.elementSoftdatatype, 55);
        assert.equal(result.crcMeta.lowerBound, 1, 'must read arrayLowerBounds property when methods are gone');
    });

    it('known CRC for Array[1..10000] of SInt (lowerBound=1)', () => {
        const meta = {
            memberName: 'sintItems',
            softdatatype: 55,
            isArray: true,
            elementSoftdatatype: 55,
            lowerBound: 1
        };
        assert.equal(computeCrcFromMeta(meta), 0x6E16F413);
    });

    it('known CRC for Array[1..10000] of Real (lowerBound=1)', () => {
        const meta = {
            memberName: 'realItems',
            softdatatype: 8,
            isArray: true,
            elementSoftdatatype: 8,
            lowerBound: 1
        };
        assert.equal(computeCrcFromMeta(meta), 0x007CD376);
    });

    it('throws for unsupported descriptor type', () => {
        assert.throws(() => resolveLeaf({ t: 'unsupported', path: [] }), /not supported/);
    });

    it('throws for non-leaf descriptor', () => {
        assert.throws(() => resolveLeaf({ t: 'struct', path: [] }), /not a leaf/);
    });

    it('nested struct member returns pathSegments', () => {
        const desc = {
            t: 'leaf',
            path: [
                { nodeType: eNodeType.Root, name: 'DB1', accessId: 0x8A0E0001 },
                { nodeType: eNodeType.Var, name: '.struct1', accessId: 0xC, softdatatype: 17, vte: { offsetInfoType: {} } },
                { nodeType: eNodeType.Var, name: '.member1', accessId: 0xD, softdatatype: 1, vte: { offsetInfoType: {} } }
            ]
        };
        const result = resolveLeaf(desc);
        assert.ok(result.crcMeta.pathSegments);
        assert.equal(result.crcMeta.pathSegments.length, 2);
        assert.equal(result.crcMeta.pathSegments[0].memberName, 'struct1');
        assert.equal(result.crcMeta.pathSegments[0].softdatatype, 17);
        assert.equal(result.crcMeta.pathSegments[1].memberName, 'member1');
        assert.equal(result.crcMeta.pathSegments[1].softdatatype, 1);
    });
});

// --- computeCrcFromMeta ---
describe('computeCrcFromMeta', () => {
    it('returns 0 for null/missing crcMeta', () => {
        assert.equal(computeCrcFromMeta(null), 0);
        assert.equal(computeCrcFromMeta({}), 0);
        assert.equal(computeCrcFromMeta({ memberName: '' }), 0);
    });

    it('computes correct CRC for Bool scalar', () => {
        const meta = { memberName: 'flag', softdatatype: 1, isArray: false, elementSoftdatatype: 0, lowerBound: 0 };
        assert.equal(computeCrcFromMeta(meta), 0xFC8BA389);
    });

    it('computes correct CRC for Real array', () => {
        const meta = { memberName: 'readings', softdatatype: 8, isArray: true, elementSoftdatatype: 8, lowerBound: 0 };
        assert.equal(computeCrcFromMeta(meta), 0x6580D02C);
    });

    it('matches computeItemCrc for non-array', () => {
        const meta = { memberName: 'Test2', softdatatype: 7, isArray: false, elementSoftdatatype: 0, lowerBound: 0 };
        assert.equal(computeCrcFromMeta(meta), computeItemCrc('Test2', TypeCode.DInt));
    });

    it('computes nested struct CRC via pathSegments (HarpoS7 TEST4.T4ChildBool)', () => {
        const { computeNestedItemCrc } = require('../lib/s7plus/crc');
        const meta = {
            pathSegments: [
                { memberName: 'TEST 4', softdatatype: 17, isArray: false, elementSoftdatatype: 0, lowerBound: 0 },
                { memberName: 'T4ChildBool', softdatatype: 1, isArray: false, elementSoftdatatype: 0, lowerBound: 0 }
            ]
        };
        const expected = computeNestedItemCrc([
            { name: 'TEST 4', typeCode: TypeCode.Struct },
            { name: 'T4ChildBool', typeCode: TypeCode.Bool }
        ]);
        assert.equal(computeCrcFromMeta(meta), expected);
        assert.equal(computeCrcFromMeta(meta), 0x1AC12998);
    });
});

// --- parseSymbolSegments ---
describe('parseSymbolSegments', () => {
    it('simple DB.member', () => {
        assert.deepEqual(parseSymbolSegments('DB1.flag'), ['DB1', 'flag']);
    });

    it('DB.array[index]', () => {
        assert.deepEqual(parseSymbolSegments('DB1.readings[0]'), ['DB1', 'readings', '[0]']);
    });

    it('quoted DB name', () => {
        assert.deepEqual(parseSymbolSegments('"DB Name".struct.x'), ['DB Name', 'struct', 'x']);
    });

    it('nested struct with array', () => {
        assert.deepEqual(
            parseSymbolSegments('DB1.arr[3].member'),
            ['DB1', 'arr', '[3]', 'member']
        );
    });

    it('deep nesting with multiple arrays', () => {
        assert.deepEqual(
            parseSymbolSegments('DB1.outer[1].inner[2].leaf'),
            ['DB1', 'outer', '[1]', 'inner', '[2]', 'leaf']
        );
    });

    it('quoted DB with array', () => {
        assert.deepEqual(
            parseSymbolSegments('"My DB".data[10]'),
            ['My DB', 'data', '[10]']
        );
    });
});

// --- isHexAddress / isSymbolicName routing ---
describe('s7complus-in routing logic', () => {
    const HEX_ADDRESS_RE = /^[0-9A-Fa-f]+(\.[0-9A-Fa-f]+)*$/;
    function isHexAddress(str) { return HEX_ADDRESS_RE.test(str); }
    function isSymbolicName(name) {
        if (!name || typeof name !== 'string') return false;
        if (isHexAddress(name)) return false;
        return /[.\[]/.test(name);
    }

    it('recognizes hex addresses', () => {
        assert.equal(isHexAddress('8A0E0001.A.0'), true);
        assert.equal(isHexAddress('8A0E0001.B'), true);
        assert.equal(isHexAddress('FF'), true);
    });

    it('recognizes symbolic paths', () => {
        assert.equal(isHexAddress('DB1.readings[0]'), false);
        assert.equal(isHexAddress('DB1.x'), false);
        assert.equal(isHexAddress('"My DB".var'), false);
    });

    it('edge cases: purely numeric (valid hex)', () => {
        assert.equal(isHexAddress('123.456'), true);
        assert.equal(isHexAddress('ABCDEF'), true);
    });

    it('edge case: symbolic that looks almost hex but has non-hex chars', () => {
        assert.equal(isHexAddress('DB_Test'), false);
        assert.equal(isHexAddress('test'), false);
    });

    it('isSymbolicName detects browse-resolved names', () => {
        assert.equal(isSymbolicName('DB1.readings[1]'), true);
        assert.equal(isSymbolicName('DB1.struct.member'), true);
        assert.equal(isSymbolicName('IArea.MyInput#1'), true);
    });

    it('isSymbolicName rejects hex-only or simple strings', () => {
        assert.equal(isSymbolicName('8A0E0001'), false);
        assert.equal(isSymbolicName('tag0'), false);
        assert.equal(isSymbolicName(null), false);
        assert.equal(isSymbolicName(''), false);
    });

    it('configured tag with hex address + symbolic name routes symbolic', () => {
        const tag = { name: 'DB1.readings[1]', address: '8A0E0001.B.1', datatype: 'Real' };
        const addrIsHex = isHexAddress(tag.address);
        const nameIsSymbolic = isSymbolicName(tag.name);
        assert.equal(addrIsHex, true);
        assert.equal(nameIsSymbolic, true);
    });
});
