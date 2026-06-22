'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildReadPayload,
    buildReadTagStatus,
    buildWritePayload,
    formatOutputPayload,
    readTagErrorText
} = require('../lib/s7plus/read-result');
const { S7Consts } = require('../lib/s7plus/constants');

function mockDecode(v) {
    return v == null ? null : v.js;
}

describe('buildReadTagStatus', () => {
    it('returns ok for zero error', () => {
        assert.deepEqual(buildReadTagStatus(0n), { status: 'ok', error: '' });
        assert.deepEqual(buildReadTagStatus(null), { status: 'ok', error: '' });
    });

    it('returns error string for PLC error', () => {
        const err = 0x123n;
        const s = buildReadTagStatus(err);
        assert.equal(s.status, 'error');
        assert.ok(s.error.includes('0x123'));
    });

    it('maps known S7Consts to errorText message', () => {
        const err = BigInt(S7Consts.errCliAccessDenied);
        const s = buildReadTagStatus(err);
        assert.equal(s.status, 'error');
        assert.equal(s.error, 'CPU: Access denied');
    });

    it('stores full hex for large BigInt errors', () => {
        const err = 0x8009890012cbffefn;
        const s = buildReadTagStatus(err);
        assert.equal(s.status, 'error');
        assert.ok(s.error.includes('0x8009890012cbffef'));
    });
});

describe('buildReadPayload', () => {
    it('puts decoded value and ok status on success', () => {
        const prepared = [{ tag: { name: 'speed' } }];
        const result = buildReadPayload(
            prepared,
            [{ js: 42.5 }],
            [0n],
            mockDecode
        );
        assert.equal(result.speed.value, 42.5);
        assert.equal(result.speed.status, 'ok');
        assert.equal(result.speed.error, '');
    });

    it('puts null value and error status on failure', () => {
        const prepared = [{ tag: { name: 'bad' } }];
        const err = BigInt(S7Consts.errCliAccessDenied);
        const result = buildReadPayload(
            prepared,
            [null],
            [err],
            mockDecode
        );
        assert.equal(result.bad.value, null);
        assert.equal(result.bad.status, 'error');
        assert.equal(result.bad.error, 'CPU: Access denied');
    });

    it('never puts error objects in value field', () => {
        const prepared = [
            { tag: { name: 'a' } },
            { tag: { name: 'b' } }
        ];
        const result = buildReadPayload(
            prepared,
            [{ js: 1 }, { js: 2 }],
            [0n, 0xffn],
            mockDecode
        );
        assert.equal(result.a.value, 1);
        assert.equal(result.a.status, 'ok');
        assert.equal(result.b.value, null);
        assert.equal(result.b.status, 'error');
    });

    it('uses tag index as name when name is missing', () => {
        const prepared = [{ tag: { address: '8A0E0001.A' } }];
        const result = buildReadPayload(
            prepared,
            [{ js: 7 }],
            [0n],
            mockDecode
        );
        assert.equal(result.tag0.value, 7);
        assert.equal(result.tag0.status, 'ok');
    });

    it('treats unset sentinel error as failure', () => {
        const prepared = [{ tag: { name: 'missing' } }];
        const sentinel = BigInt('18446744073709551615');
        const result = buildReadPayload(
            prepared,
            [null],
            [sentinel],
            mockDecode
        );
        assert.equal(result.missing.value, null);
        assert.equal(result.missing.status, 'error');
        assert.ok(result.missing.error.length > 0);
    });
});

describe('buildWritePayload', () => {
    it('echoes the written value and ok status on success', () => {
        const tags = [{ name: 'speed', value: 1500 }];
        const result = buildWritePayload(tags, [0n]);
        assert.equal(result.speed.value, 1500);
        assert.equal(result.speed.status, 'ok');
        assert.equal(result.speed.error, '');
    });

    it('puts null value and error status with text on failure', () => {
        const tags = [{ name: 'bad', value: true }];
        const err = BigInt(S7Consts.errCliAccessDenied);
        const result = buildWritePayload(tags, [err]);
        assert.equal(result.bad.value, null);
        assert.equal(result.bad.status, 'error');
        assert.equal(result.bad.error, 'CPU: Access denied');
    });

    it('keeps full hex for large PLC error codes', () => {
        const tags = [{ name: 'x', value: 1 }];
        const result = buildWritePayload(tags, [0x8009890012cbffefn]);
        assert.equal(result.x.status, 'error');
        assert.ok(result.x.error.includes('0x8009890012cbffef'));
    });

    it('uses tag index as name when name is missing', () => {
        const tags = [{ address: '8A0E0001.A', value: false }];
        const result = buildWritePayload(tags, [0n]);
        assert.equal(result.tag0.value, false);
        assert.equal(result.tag0.status, 'ok');
    });

    it('mixes ok and error entries by name', () => {
        const tags = [
            { name: 'a', value: 1 },
            { name: 'b', value: 2 }
        ];
        const result = buildWritePayload(tags, [0n, 0xffn]);
        assert.equal(result.a.value, 1);
        assert.equal(result.a.status, 'ok');
        assert.equal(result.b.value, null);
        assert.equal(result.b.status, 'error');
    });
});

describe('formatOutputPayload', () => {
    const result = {
        'Motor.speed': { value: 1450, status: 'ok', error: '' },
        'Tank.level': { value: 73.2, status: 'ok', error: '' }
    };

    it('returns object unchanged for object format', () => {
        assert.deepEqual(
            formatOutputPayload(result, ['Motor.speed', 'Tank.level'], 'object'),
            result
        );
    });

    it('returns object unchanged when format is missing or unknown', () => {
        assert.deepEqual(formatOutputPayload(result, ['Motor.speed'], undefined), result);
        assert.deepEqual(formatOutputPayload(result, ['Motor.speed'], ''), result);
    });

    it('returns array with symbol property in order', () => {
        const out = formatOutputPayload(
            result,
            ['Motor.speed', 'Tank.level'],
            'array'
        );
        assert.deepEqual(out, [
            { symbol: 'Motor.speed', value: 1450, status: 'ok', error: '' },
            { symbol: 'Tank.level', value: 73.2, status: 'ok', error: '' }
        ]);
    });

    it('skips symbols in order that are missing from result', () => {
        const out = formatOutputPayload(
            result,
            ['Missing.tag', 'Motor.speed'],
            'array'
        );
        assert.equal(out.length, 1);
        assert.equal(out[0].symbol, 'Motor.speed');
    });
});
