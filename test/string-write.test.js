'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const pvalue = require('../lib/s7plus/pvalue');
const ItemAddress = require('../lib/s7plus/item-address');
const {
    encodeWriteValue,
    decodeReadValue,
    isStringDatatype,
    stringMaxLenFromValue,
    STRING_VALUE_ERROR
} = require('../lib/s7plus/pvalue-codec');
const { writeTagsEncoded } = require('../lib/s7plus/write-tags');

// PLC error for a string write whose header length does not match the
// declaration (live capture, CPU 1511 FW 2.9).
const ERR_LEN_MISMATCH = 0x80098d001055ffc3n;
const ERR_CRC = 0x8009890012cbffefn;

// ── encodeWriteValue: String / WString with declared length ──────────
describe('encodeWriteValue String[n] / WString[n]', () => {
    it('String defaults to max length 254 (plain String)', () => {
        const pv = encodeWriteValue('Hello', 'String');
        assert.ok(pv instanceof pvalue.ValueUSIntArray);
        const arr = pv.toJs();
        assert.equal(arr.length, 256);
        assert.equal(arr[0], 254);
        assert.equal(arr[1], 5);
        assert.equal(decodeReadValue(pv, 'String'), 'Hello');
    });

    it('String[n] uses the declared length in the header and array size', () => {
        const pv = encodeWriteValue('ab', 'String', { stringMaxLen: 4 });
        assert.deepEqual(pv.toJs(), [4, 2, 97, 98, 0, 0]);
    });

    it('String[n] accepts a text that exactly fills the declaration', () => {
        const pv = encodeWriteValue('Test', 'String', { stringMaxLen: 4 });
        assert.deepEqual(pv.toJs(), [4, 4, 84, 101, 115, 116]);
    });

    it('String keeps ISO-8859-1 characters (umlauts)', () => {
        const pv = encodeWriteValue('Mötör', 'String', { stringMaxLen: 10 });
        assert.equal(decodeReadValue(pv, 'String'), 'Mötör');
        assert.equal(pv.toJs()[2 + 1], 0xf6);
    });

    it('empty text is valid for any declared length, including String[0]', () => {
        assert.deepEqual(encodeWriteValue('', 'String', { stringMaxLen: 4 }).toJs(), [4, 0, 0, 0, 0, 0]);
        assert.deepEqual(encodeWriteValue('', 'String', { stringMaxLen: 0 }).toJs(), [0, 0]);
    });

    it('rejects a text longer than the declared String[n] instead of truncating', () => {
        assert.throws(
            () => encodeWriteValue('abcde', 'String', { stringMaxLen: 4 }),
            (e) => e.code === STRING_VALUE_ERROR && /5 characters/.test(e.message) && /String\[4\]/.test(e.message)
        );
    });

    it('rejects a text longer than 254 on a plain String', () => {
        assert.throws(
            () => encodeWriteValue('x'.repeat(255), 'String'),
            (e) => e.code === STRING_VALUE_ERROR
        );
        assert.equal(encodeWriteValue('x'.repeat(254), 'String').toJs()[1], 254);
    });

    it('rejects characters outside ISO-8859-1 on a String', () => {
        for (const text of ['5 €', 'ΣΛΔ', 'a\u{1F600}']) {
            assert.throws(
                () => encodeWriteValue(text, 'String', { stringMaxLen: 20 }),
                (e) => e.code === STRING_VALUE_ERROR && /not representable/.test(e.message),
                text
            );
        }
    });

    it('WString defaults to max length 254', () => {
        const pv = encodeWriteValue('ΣΛΔ €', 'WString');
        assert.ok(pv instanceof pvalue.ValueUIntArray);
        const arr = pv.toJs();
        assert.equal(arr.length, 256);
        assert.equal(arr[0], 254);
        assert.equal(arr[1], 5);
        assert.equal(decodeReadValue(pv, 'WString'), 'ΣΛΔ €');
    });

    it('WString[n] uses the declared length', () => {
        const pv = encodeWriteValue('Σb', 'WString', { stringMaxLen: 4 });
        assert.deepEqual(pv.toJs(), [4, 2, 0x3a3, 98, 0, 0]);
    });

    it('WString[n] supports declarations longer than 254', () => {
        const text = 'y'.repeat(300);
        const pv = encodeWriteValue(text, 'WString', { stringMaxLen: 1000 });
        const arr = pv.toJs();
        assert.equal(arr.length, 1002);
        assert.equal(arr[0], 1000);
        assert.equal(arr[1], 300);
        assert.equal(decodeReadValue(pv, 'WString'), text);
    });

    it('rejects a text longer than the declared WString[n]', () => {
        assert.throws(
            () => encodeWriteValue('abcde', 'WString', { stringMaxLen: 4 }),
            (e) => e.code === STRING_VALUE_ERROR && /WString\[4\]/.test(e.message)
        );
    });

    it('counts WString length in UTF-16 code units like the PLC', () => {
        // One emoji = 2 code units: fits WString[2], not WString[1].
        assert.equal(encodeWriteValue('\u{1F600}', 'WString', { stringMaxLen: 2 }).toJs()[1], 2);
        assert.throws(
            () => encodeWriteValue('\u{1F600}', 'WString', { stringMaxLen: 1 }),
            (e) => e.code === STRING_VALUE_ERROR
        );
    });

    it('accepts numeric softdatatype ids (19 String, 62 WString)', () => {
        assert.deepEqual(encodeWriteValue('a', 19, { stringMaxLen: 2 }).toJs(), [2, 1, 97, 0]);
        assert.deepEqual(encodeWriteValue('a', 62, { stringMaxLen: 2 }).toJs(), [2, 1, 97, 0]);
    });

    it('converts non-string values with String()', () => {
        assert.equal(decodeReadValue(encodeWriteValue(123, 'String', { stringMaxLen: 4 }), 'String'), '123');
    });

    it('throws a plain error (not a per-tag value error) on an invalid declared length', () => {
        for (const bad of [-1, 255, 1.5, 'x']) {
            assert.throws(
                () => encodeWriteValue('a', 'String', { stringMaxLen: bad }),
                (e) => e.code !== STRING_VALUE_ERROR && /Invalid declared String length/.test(e.message)
            );
        }
        assert.throws(() => encodeWriteValue('a', 'WString', { stringMaxLen: 16383 }), /Invalid declared WString length/);
    });

    it('survives a serialize / deserialize round trip', () => {
        const BufferStream = require('../lib/s7plus/buffer-stream');
        const bs = new BufferStream();
        encodeWriteValue('ab', 'String', { stringMaxLen: 4 }).serialize(bs);
        bs.position = 0;
        const rt = pvalue.deserialize(bs);
        assert.deepEqual(rt.toJs(), [4, 2, 97, 98, 0, 0]);
    });
});

describe('string helpers', () => {
    it('isStringDatatype', () => {
        assert.equal(isStringDatatype('String'), true);
        assert.equal(isStringDatatype('WString'), true);
        assert.equal(isStringDatatype(19), true);
        assert.equal(isStringDatatype(62), true);
        assert.equal(isStringDatatype('Char'), false);
        assert.equal(isStringDatatype('Int'), false);
        assert.equal(isStringDatatype(undefined), false);
    });

    it('stringMaxLenFromValue reads header element 0', () => {
        assert.equal(stringMaxLenFromValue(new pvalue.ValueUSIntArray([10, 4, 84, 101, 115, 116])), 10);
        assert.equal(stringMaxLenFromValue(new pvalue.ValueUIntArray([1000, 0])), 1000);
        assert.equal(stringMaxLenFromValue(new pvalue.ValueUSIntArray([0, 0])), 0);
        assert.equal(stringMaxLenFromValue(null), null);
        assert.equal(stringMaxLenFromValue(new pvalue.ValueUSIntArray([4])), null);
        assert.equal(stringMaxLenFromValue(new pvalue.ValueInt(5)), null);
    });
});

// ── writeTagsEncoded: length lookup, cache, per-tag errors ───────────

/**
 * Fake PLC: `decl` maps access string -> { type, maxLen } for strings.
 * Mirrors the live behaviour: a string write is accepted only when the
 * header's max length equals the declaration.
 */
function fakePlc(decl, extra = {}) {
    const plc = {
        decl,
        stored: new Map(),
        reads: [],
        writes: [],
        readErrors: extra.readErrors || {},
        writeErrors: extra.writeErrors || {},
        async readValues(addrs) {
            const keys = addrs.map(a => a.getAccessString());
            plc.reads.push(keys);
            const values = [];
            const errors = [];
            for (const k of keys) {
                if (plc.readErrors[k]) { values.push(null); errors.push(plc.readErrors[k]); continue; }
                const d = plc.decl[k];
                const cur = plc.stored.get(k) || [];
                const arr = [d.maxLen, cur.length, ...cur, ...new Array(d.maxLen - cur.length).fill(0)];
                values.push(d.type === 'String' ? new pvalue.ValueUSIntArray(arr) : new pvalue.ValueUIntArray(arr));
                errors.push(0n);
            }
            return { values, errors };
        },
        async writeValues(addrs, vals) {
            const keys = addrs.map(a => a.getAccessString());
            plc.writes.push(keys.map((k, i) => ({ key: k, value: vals[i] })));
            const errors = keys.map((k, i) => {
                if (plc.writeErrors[k]) return plc.writeErrors[k];
                const d = plc.decl[k];
                if (!d) return 0n;
                const arr = vals[i].toJs();
                if (arr[0] !== d.maxLen) return ERR_LEN_MISMATCH;
                plc.stored.set(k, arr.slice(2, 2 + arr[1]));
                return 0n;
            });
            return { errors };
        }
    };
    return plc;
}

const A = '8A0E0004.10';
const B = '8A0E0004.1A';
const C = '8A0E0004.5';

function run(plc, tags, cache = new Map()) {
    return writeTagsEncoded(plc, tags, tags.map(t => new ItemAddress(t.address)), { stringLenCache: cache });
}

describe('writeTagsEncoded', () => {
    it('reads the declared length once, then writes String[n] successfully', async () => {
        const plc = fakePlc({ [A]: { type: 'String', maxLen: 10 } });
        const cache = new Map();
        const res = await run(plc, [{ name: 's', address: A, datatype: 'String', value: 'test' }], cache);
        assert.deepEqual(res, { s: { value: 'test', status: 'ok', error: '' } });
        assert.equal(plc.reads.length, 1);
        assert.equal(plc.writes[0][0].value.toJs()[0], 10);
        assert.equal(cache.get(A), 10);

        await run(plc, [{ name: 's', address: A, datatype: 'String', value: 'again' }], cache);
        assert.equal(plc.reads.length, 1, 'second write uses the cached length');
        assert.equal(Buffer.from(plc.stored.get(A)).toString('latin1'), 'again');
    });

    it('handles WString[n] and plain String (254) in one call with one read', async () => {
        const plc = fakePlc({ [A]: { type: 'String', maxLen: 254 }, [B]: { type: 'WString', maxLen: 4 } });
        const res = await run(plc, [
            { name: 'a', address: A, datatype: 'String', value: 'hello' },
            { name: 'b', address: B, datatype: 'WString', value: 'ΣΛΔ' }
        ]);
        assert.equal(res.a.status, 'ok');
        assert.equal(res.b.status, 'ok');
        assert.equal(plc.reads.length, 1);
        assert.deepEqual(plc.reads[0], [A, B]);
        assert.equal(plc.writes.length, 1);
    });

    it('does not read anything when no string tag is written', async () => {
        const plc = fakePlc({});
        const res = await run(plc, [{ name: 'i', address: C, datatype: 'Int', value: 7 }]);
        assert.equal(res.i.status, 'ok');
        assert.equal(plc.reads.length, 0);
    });

    it('reports a too long text per tag, does not send it, still writes the others', async () => {
        const plc = fakePlc({ [A]: { type: 'String', maxLen: 4 } });
        const res = await run(plc, [
            { name: 's', address: A, datatype: 'String', value: 'toolong' },
            { name: 'i', address: C, datatype: 'Int', value: 7 }
        ]);
        assert.equal(res.s.status, 'error');
        assert.equal(res.s.value, null);
        assert.match(res.s.error, /7 characters.*String\[4\]/);
        assert.deepEqual(res.i, { value: 7, status: 'ok', error: '' });
        assert.deepEqual(plc.writes.map(w => w.map(x => x.key)), [[C]]);
        assert.equal(plc.stored.has(A), false);
    });

    it('reports a non ISO-8859-1 text on a String per tag without writing', async () => {
        const plc = fakePlc({ [A]: { type: 'String', maxLen: 20 } });
        const res = await run(plc, [{ name: 's', address: A, datatype: 'String', value: '5 €' }]);
        assert.equal(res.s.status, 'error');
        assert.match(res.s.error, /not representable/);
        assert.equal(plc.writes.length, 0);
    });

    it('refreshes a stale cached length and retries once', async () => {
        const plc = fakePlc({ [A]: { type: 'String', maxLen: 20 } });
        const cache = new Map([[A, 10]]); // declaration changed from 10 to 20
        const res = await run(plc, [
            { name: 's', address: A, datatype: 'String', value: 'changed' },
            { name: 'i', address: C, datatype: 'Int', value: 1 }
        ], cache);
        assert.equal(res.s.status, 'ok');
        assert.equal(res.i.status, 'ok');
        assert.equal(cache.get(A), 20);
        assert.equal(plc.writes.length, 2);
        assert.deepEqual(plc.writes[1].map(x => x.key), [A], 'only the string is retried');
    });

    it('after a stale-cache refresh, a text too long for the NEW length is a per-tag error', async () => {
        const plc = fakePlc({ [A]: { type: 'String', maxLen: 4 } });
        const cache = new Map([[A, 10]]);
        const res = await run(plc, [{ name: 's', address: A, datatype: 'String', value: 'sixsix' }], cache);
        assert.equal(res.s.status, 'error');
        assert.match(res.s.error, /String\[4\]/);
        assert.equal(plc.writes.length, 1);
    });

    it('does not retry when the cached length is still correct', async () => {
        const plc = fakePlc({ [A]: { type: 'String', maxLen: 10 } }, { writeErrors: { [A]: 0x123n } });
        const res = await run(plc, [{ name: 's', address: A, datatype: 'String', value: 'x' }], new Map([[A, 10]]));
        assert.equal(res.s.status, 'error');
        assert.match(res.s.error, /0x123/);
        assert.equal(plc.writes.length, 1);
        assert.equal(plc.reads.length, 1);
    });

    it('passes a PLC read error (stale address / CRC) through as the tag error and skips the write', async () => {
        const plc = fakePlc({ [A]: { type: 'String', maxLen: 10 } }, { readErrors: { [A]: ERR_CRC } });
        const cache = new Map();
        const res = await run(plc, [
            { name: 's', address: A, datatype: 'String', value: 'x' },
            { name: 'i', address: C, datatype: 'Int', value: 1 }
        ], cache);
        assert.equal(res.s.status, 'error');
        assert.ok(res.s.error.toLowerCase().includes('8009890012cbffef'), res.s.error);
        assert.equal(res.i.status, 'ok');
        assert.deepEqual(plc.writes.map(w => w.map(x => x.key)), [[C]]);
        assert.equal(cache.has(A), false);
    });

    it('still throws non-string encode errors for the whole call, before anything is written', async () => {
        const plc = fakePlc({ [A]: { type: 'String', maxLen: 10 } });
        await assert.rejects(
            run(plc, [
                { name: 's', address: A, datatype: 'String', value: 'x' },
                { name: 'd', address: C, datatype: 'Dtl', value: new Date('1900-01-01T00:00:00Z') }
            ]),
            /out of DTL range/
        );
        assert.equal(plc.writes.length, 0);
    });

    it('keeps tag order and names for mixed results', async () => {
        const plc = fakePlc({ [A]: { type: 'String', maxLen: 4 }, [B]: { type: 'WString', maxLen: 4 } });
        const res = await run(plc, [
            { name: 'i', address: C, datatype: 'Int', value: 1 },
            { name: 'a', address: A, datatype: 'String', value: 'abcdef' },
            { name: 'b', address: B, datatype: 'WString', value: 'ok' }
        ]);
        assert.deepEqual(Object.keys(res), ['i', 'a', 'b']);
        assert.equal(res.i.status, 'ok');
        assert.equal(res.a.status, 'error');
        assert.equal(res.b.status, 'ok');
        assert.deepEqual(plc.writes[0].map(x => x.key), [C, B]);
    });
});
