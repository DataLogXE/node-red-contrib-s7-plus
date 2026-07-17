'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    isHexAddress,
    isRawHexAccessString,
    isSymbolicName,
    assertCrcSecuredTag
} = require('../lib/s7plus/tag-routing');
const { normalizeTag, parseAddSymbols } = require('../nodes/s7complus-in');
const { normalizeSymbol } = require('../nodes/s7complus-out');

describe('assertCrcSecuredTag', () => {
    it('allows hex address with symbolCrc', () => {
        assert.doesNotThrow(() => assertCrcSecuredTag({
            address: '8A0E0001.A',
            name: '8A0E0001.A',
            symbolCrc: 0x1234
        }, 0));
    });

    it('allows hex address with symbolic name', () => {
        assert.doesNotThrow(() => assertCrcSecuredTag({
            address: '8A0E0001.A',
            name: 'DB1.x',
            symbolCrc: undefined
        }, 0));
    });

    it('rejects hex-only without symbolCrc or symbolic name', () => {
        assert.throws(
            () => assertCrcSecuredTag({
                address: '8A0E0001.A',
                name: '8A0E0001.A',
                symbolCrc: undefined
            }, 2),
            /Symbol #2: hex access string requires a symbolic name or symbolCrc/
        );
    });
});

describe('isRawHexAccessString', () => {
    it('matches resolved PLC access strings', () => {
        assert.equal(isRawHexAccessString('8A0E0001.A'), true);
        assert.equal(isRawHexAccessString('8A0E0001.A.0'), true);
    });

    it('does not match short symbolic-looking paths', () => {
        assert.equal(isRawHexAccessString('DB1.a'), false);
        assert.equal(isRawHexAccessString('FF'), false);
    });
});

describe('normalizeTag', () => {
    it('accepts symbolic string paths', () => {
        const tag = normalizeTag('DB1.x', 0);
        assert.equal(tag.symbolic, true);
        assert.equal(tag.address, 'DB1.x');
    });

    it('treats DB1-style paths as symbolic', () => {
        const tag = normalizeTag('DB1.a', 0);
        assert.equal(tag.symbolic, true);
    });

    it('accepts hex address with symbolCrc (Path 1)', () => {
        const tag = normalizeTag({
            name: 'DB1.x',
            address: '8A0E0001.A',
            symbolCrc: 0xABCD,
            datatype: 'Bool'
        }, 0);
        assert.equal(tag.symbolic, false);
        assert.equal(tag.symbolCrc, 0xABCD);
    });

    it('routes hex address + symbolic name to resolve (Path 3)', () => {
        const tag = normalizeTag({
            name: 'DB1.readings[1]',
            address: '8A0E0001.B.1',
            datatype: 'Real'
        }, 0);
        assert.equal(tag.symbolic, true);
        assert.equal(tag.address, 'DB1.readings[1]');
    });

    it('rejects hex-only string', () => {
        assert.throws(
            () => normalizeTag('8A0E0001.A', 0),
            /hex access string requires a symbolic name or symbolCrc/
        );
    });

    it('rejects hex-only object entry', () => {
        assert.throws(
            () => normalizeTag({ name: '8A0E0001.A', address: '8A0E0001.A' }, 1),
            /Symbol #1: hex access string requires a symbolic name or symbolCrc/
        );
    });
});

describe('normalizeSymbol', () => {
    it('rejects hex-only configured symbol', () => {
        assert.throws(
            () => normalizeSymbol({ name: '8A0E0001.A', address: '8A0E0001.A' }, 0),
            /hex access string requires a symbolic name or symbolCrc/
        );
    });

    it('accepts hex address with symbolCrc', () => {
        const tag = normalizeSymbol({
            name: 'DB1.x',
            address: '8A0E0001.A',
            symbolCrc: 0x1234
        }, 0);
        assert.equal(tag.symbolic, false);
        assert.equal(tag.symbolCrc, 0x1234);
    });
});

describe('parseAddSymbols hex rejection', () => {
    it('rejects hex strings in msg.addSymbols', () => {
        assert.throws(
            () => parseAddSymbols({ addSymbols: ['8A0E0001.A'] }),
            /msg\.addSymbols\[0\]: hex access string requires a symbolic name or symbolCrc/
        );
    });

    it('accepts symbolic paths in msg.addSymbols', () => {
        assert.deepEqual(parseAddSymbols({ addSymbols: ['DB1.x'] }), ['DB1.x']);
    });
});

describe('isHexAddress / isSymbolicName', () => {
    it('recognizes hex addresses', () => {
        assert.equal(isHexAddress('8A0E0001.A.0'), true);
        assert.equal(isHexAddress('FF'), true);
    });

    it('recognizes symbolic paths', () => {
        assert.equal(isHexAddress('DB1.readings[0]'), false);
        assert.equal(isSymbolicName('DB1.readings[1]'), true);
    });
});
