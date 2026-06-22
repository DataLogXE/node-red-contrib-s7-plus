'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatExplorePayload, normalizeSymbolInfos } = require('../lib/s7plus/explore-result');

const sampleEntry = {
    name: 'Data.speed',
    accessSequence: '8A0E0001.A',
    softdatatype: 8,
    softdatatypeName: 'Real',
    optAddress: 0,
    nonOptAddress: 4,
    optBitoffset: 0,
    nonOptBitoffset: 0
};

describe('normalizeSymbolInfos', () => {
    it('accepts none, object, and array', () => {
        assert.equal(normalizeSymbolInfos('none'), 'none');
        assert.equal(normalizeSymbolInfos('object'), 'object');
        assert.equal(normalizeSymbolInfos('array'), 'array');
    });

    it('falls back to none for invalid values', () => {
        assert.equal(normalizeSymbolInfos(undefined), 'none');
        assert.equal(normalizeSymbolInfos('invalid'), 'none');
        assert.equal(normalizeSymbolInfos(null), 'none');
    });
});

describe('formatExplorePayload', () => {
    it('outputs symbol names only when mode is none', () => {
        const out = formatExplorePayload([sampleEntry], 'none');
        assert.deepEqual(out, { symbols: ['Data.speed'] });
        assert.equal(out.infos, undefined);
    });

    it('outputs infos as object keyed by symbol name', () => {
        const out = formatExplorePayload([sampleEntry], 'object');
        assert.deepEqual(out.symbols, ['Data.speed']);
        assert.deepEqual(out.infos['Data.speed'], {
            accessSequence: '8A0E0001.A',
            softdatatype: 8,
            softdatatypeName: 'Real',
            optAddress: 0,
            nonOptAddress: 4,
            optBitoffset: 0,
            nonOptBitoffset: 0
        });
        assert.equal(out.infos['Data.speed'].name, undefined);
    });

    it('outputs infos as array with symbol field in browse order', () => {
        const second = { ...sampleEntry, name: 'Data.level', accessSequence: '8A0E0001.B' };
        const out = formatExplorePayload([sampleEntry, second], 'array');
        assert.deepEqual(out.symbols, ['Data.speed', 'Data.level']);
        assert.equal(out.infos.length, 2);
        assert.equal(out.infos[0].symbol, 'Data.speed');
        assert.equal(out.infos[0].softdatatypeName, 'Real');
        assert.equal(out.infos[1].symbol, 'Data.level');
        assert.equal(out.infos[1].name, undefined);
    });

    it('preserves optional crc fields in infos', () => {
        const entry = { ...sampleEntry, symbolCrc: 123, computedCrc: 456 };
        const out = formatExplorePayload([entry], 'object');
        assert.equal(out.infos['Data.speed'].symbolCrc, 123);
        assert.equal(out.infos['Data.speed'].computedCrc, 456);
    });
});
