'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const BufferStream = require('../lib/s7plus/buffer-stream');
const pvalue = require('../lib/s7plus/pvalue');
const { Datatype } = require('../lib/s7plus/constants');
const { encodeWriteValue, decodeReadValue } = require('../lib/s7plus/pvalue-codec');

// ---------------------------------------------------------------------------
// Helper: serialize a PValue, rewind, deserialize it back
// ---------------------------------------------------------------------------
function roundTrip(pval) {
    const buf = new BufferStream();
    pval.serialize(buf);
    buf.position = 0;
    return pvalue.deserialize(buf);
}

// ===========================================================================
//  READ path  –  PValue  →  serialize  →  deserialize  →  toJs / decodeReadValue
// ===========================================================================

describe('Datatype mapping – READ (serialize → deserialize round-trip)', () => {

    // --- Bool → boolean ---------------------------------------------------
    describe('Bool', () => {
        it('true round-trips to boolean true', () => {
            const v = roundTrip(new pvalue.ValueBool(true));
            assert.strictEqual(v.toJs(), true);
            assert.strictEqual(typeof v.toJs(), 'boolean');
        });
        it('false round-trips to boolean false', () => {
            const v = roundTrip(new pvalue.ValueBool(false));
            assert.strictEqual(v.toJs(), false);
        });
        it('decodeReadValue returns boolean', () => {
            const v = roundTrip(new pvalue.ValueBool(true));
            assert.strictEqual(decodeReadValue(v), true);
        });
    });

    // --- Byte → number ----------------------------------------------------
    describe('Byte', () => {
        for (const val of [0, 1, 127, 255]) {
            it(`${val} round-trips to number`, () => {
                const v = roundTrip(new pvalue.ValueByte(val));
                assert.strictEqual(v.toJs(), val);
                assert.strictEqual(typeof decodeReadValue(v), 'number');
            });
        }
    });

    // --- Word → number ----------------------------------------------------
    describe('Word', () => {
        for (const val of [0, 1, 0x00ff, 0xffff]) {
            it(`0x${val.toString(16)} round-trips to number`, () => {
                const v = roundTrip(new pvalue.ValueWord(val));
                assert.strictEqual(v.toJs(), val);
                assert.strictEqual(typeof decodeReadValue(v), 'number');
            });
        }
    });

    // --- DWord → number ---------------------------------------------------
    describe('DWord', () => {
        for (const val of [0, 1, 0xdeadbeef, 0xffffffff]) {
            it(`0x${val.toString(16)} round-trips to number`, () => {
                const v = roundTrip(new pvalue.ValueDWord(val));
                assert.strictEqual(v.toJs(), val >>> 0);
                assert.strictEqual(typeof decodeReadValue(v), 'number');
            });
        }
    });

    // --- LWord → BigInt (64-bit, cannot fit a JS number) ------------------
    describe('LWord', () => {
        for (const val of [0n, 1n, 0x0123456789abcdefn, 0xFFFFFFFFFFFFFFFFn]) {
            it(`${val}n round-trips to BigInt`, () => {
                const v = roundTrip(new pvalue.ValueLWord(val));
                assert.strictEqual(v.toJs(), val);
                assert.strictEqual(decodeReadValue(v, 'LWord'), val);
                assert.strictEqual(typeof decodeReadValue(v, 'LWord'), 'bigint');
            });
        }
    });

    // --- SInt → number (signed 8-bit) -------------------------------------
    describe('SInt', () => {
        for (const val of [-128, -1, 0, 1, 127]) {
            it(`${val} round-trips to number`, () => {
                const v = roundTrip(new pvalue.ValueSInt(val));
                assert.strictEqual(v.toJs(), val);
                assert.strictEqual(typeof decodeReadValue(v), 'number');
            });
        }
    });

    // --- Int → number (signed 16-bit) -------------------------------------
    describe('Int', () => {
        for (const val of [-32768, -1, 0, 1, 32767]) {
            it(`${val} round-trips to number`, () => {
                const v = roundTrip(new pvalue.ValueInt(val));
                assert.strictEqual(v.toJs(), val);
                assert.strictEqual(typeof decodeReadValue(v), 'number');
            });
        }
    });

    // --- DInt → number (signed 32-bit) ------------------------------------
    describe('DInt', () => {
        for (const val of [-2147483648, -1, 0, 1, 2147483647]) {
            it(`${val} round-trips to number`, () => {
                const v = roundTrip(new pvalue.ValueDInt(val));
                assert.strictEqual(v.toJs(), val);
                assert.strictEqual(typeof decodeReadValue(v), 'number');
            });
        }
    });

    // --- USInt → number (unsigned 8-bit) ----------------------------------
    describe('USInt', () => {
        for (const val of [0, 1, 128, 255]) {
            it(`${val} round-trips to number`, () => {
                const v = roundTrip(new pvalue.ValueUSInt(val));
                assert.strictEqual(v.toJs(), val);
                assert.strictEqual(typeof decodeReadValue(v), 'number');
            });
        }
    });

    // --- UInt → number (unsigned 16-bit) ----------------------------------
    describe('UInt', () => {
        for (const val of [0, 1, 0x8000, 0xffff]) {
            it(`${val} round-trips to number`, () => {
                const v = roundTrip(new pvalue.ValueUInt(val));
                assert.strictEqual(v.toJs(), val);
                assert.strictEqual(typeof decodeReadValue(v), 'number');
            });
        }
    });

    // --- UDInt → number (unsigned 32-bit) ---------------------------------
    describe('UDInt', () => {
        for (const val of [0, 1, 0x80000000, 0xffffffff]) {
            it(`${val} round-trips to number`, () => {
                const v = roundTrip(new pvalue.ValueUDInt(val));
                assert.strictEqual(v.toJs(), val >>> 0);
                assert.strictEqual(typeof decodeReadValue(v), 'number');
            });
        }
    });

    // --- LInt → BigInt ----------------------------------------------------
    describe('LInt', () => {
        for (const val of [-9223372036854775808n, -1n, 0n, 1n, 9223372036854775807n]) {
            it(`${val}n round-trips to BigInt`, () => {
                const v = roundTrip(new pvalue.ValueLInt(val));
                assert.strictEqual(v.toJs(), val);
                assert.strictEqual(typeof v.toJs(), 'bigint');
            });
        }
    });

    // --- ULInt → BigInt ---------------------------------------------------
    describe('ULInt', () => {
        for (const val of [0n, 1n, 0xffffffffffffffffn]) {
            it(`${val}n round-trips to BigInt`, () => {
                const v = roundTrip(new pvalue.ValueULInt(val));
                assert.strictEqual(v.toJs(), val);
                assert.strictEqual(typeof v.toJs(), 'bigint');
            });
        }
    });

    // --- Real → number (float32) ------------------------------------------
    describe('Real', () => {
        for (const val of [0, 1.5, -3.14, 1e10]) {
            it(`${val} round-trips to number (float32 precision)`, () => {
                const v = roundTrip(new pvalue.ValueReal(val));
                const js = v.toJs();
                assert.strictEqual(typeof js, 'number');
                assert.ok(Math.abs(js - val) < 1e-3 || Math.abs(js - val) / Math.abs(val) < 1e-6,
                    `expected ~${val}, got ${js}`);
                assert.strictEqual(typeof decodeReadValue(v), 'number');
            });
        }
    });

    // --- LReal → number (float64) -----------------------------------------
    describe('LReal', () => {
        for (const val of [0, 1.5, -3.141592653589793, 1e100, Number.MIN_VALUE]) {
            it(`${val} round-trips to number (float64 precision)`, () => {
                const v = roundTrip(new pvalue.ValueLReal(val));
                assert.strictEqual(v.toJs(), val);
                assert.strictEqual(typeof decodeReadValue(v), 'number');
            });
        }
    });

    // --- WString → string -------------------------------------------------
    describe('String / WString', () => {
        for (const val of ['', 'Hello', 'Ä Ö Ü ß', '日本語', 'A']) {
            it(`"${val}" round-trips to string`, () => {
                const v = roundTrip(new pvalue.ValueWString(val));
                assert.strictEqual(v.toJs(), val);
                assert.strictEqual(typeof decodeReadValue(v), 'string');
            });
        }
    });

    // --- Char / WChar → string (single character via WString) -------------
    describe('Char / WChar (single character)', () => {
        for (const val of ['A', 'Z', 'ä', '€']) {
            it(`"${val}" round-trips as single-char string`, () => {
                const v = roundTrip(new pvalue.ValueWString(val));
                assert.strictEqual(v.toJs(), val);
                assert.strictEqual(v.toJs().length <= 2, true); // single char (or surrogate pair)
            });
        }
    });

    // --- Timestamp → BigInt (used for Date, LDT, DTL) ---------------------
    describe('Timestamp (Date / LDT / DTL)', () => {
        const now100ns = BigInt(Date.now()) * 10000n + 621355968000000000n; // .NET ticks style
        for (const val of [0n, now100ns, 0x0011223344556677n]) {
            it(`${val}n round-trips to BigInt`, () => {
                const v = roundTrip(new pvalue.ValueTimestamp(val));
                assert.strictEqual(v.toJs(), val);
                assert.strictEqual(typeof v.toJs(), 'bigint');
            });
        }
    });

    // --- Timespan → BigInt (used for Time, LTime, S5Time) -----------------
    describe('Timespan (Time / LTime / S5Time)', () => {
        for (const val of [0n, 1000n, -5000n, 86400000000000n]) {
            it(`${val}n round-trips to BigInt`, () => {
                const v = roundTrip(new pvalue.ValueTimespan(val));
                assert.strictEqual(v.toJs(), val);
                assert.strictEqual(typeof v.toJs(), 'bigint');
            });
        }
    });

    // --- TOD (Time_Of_Day) → number (ms since midnight via decodeReadValue)
    describe('TOD (Time_Of_Day) → number', () => {
        it('12:00:00.000 = 43200000 ms round-trips', () => {
            const ms = 43200000;
            const v = roundTrip(new pvalue.ValueUDInt(ms));
            assert.strictEqual(decodeReadValue(v), ms);
            assert.strictEqual(typeof decodeReadValue(v), 'number');
        });
    });

    // --- LTOD → BigInt (ns since midnight) --------------------------------
    describe('LTOD → BigInt', () => {
        it('ns since midnight round-trips', () => {
            const ns = 43200000000000n;
            const v = roundTrip(new pvalue.ValueULInt(ns));
            assert.strictEqual(v.toJs(), ns);
            assert.strictEqual(typeof v.toJs(), 'bigint');
        });
    });

    // --- Hardware datatypes (HW_IO, HW_DEVICE, …) → number ---------------
    describe('Hardware datatypes → number', () => {
        it('HW_IO (UInt) round-trips to number', () => {
            const v = roundTrip(new pvalue.ValueUInt(42));
            assert.strictEqual(decodeReadValue(v), 42);
            assert.strictEqual(typeof decodeReadValue(v), 'number');
        });
    });
});

// ===========================================================================
//  WRITE path  –  JS value  →  encodeWriteValue  →  serialize  →  deserialize
// ===========================================================================

describe('Datatype mapping – WRITE (encodeWriteValue → round-trip)', () => {

    it('boolean true → ValueBool', () => {
        const pv = encodeWriteValue(true);
        assert.ok(pv instanceof pvalue.ValueBool);
        const rt = roundTrip(pv);
        assert.strictEqual(rt.toJs(), true);
    });

    it('boolean false → ValueBool', () => {
        const pv = encodeWriteValue(false);
        assert.ok(pv instanceof pvalue.ValueBool);
        const rt = roundTrip(pv);
        assert.strictEqual(rt.toJs(), false);
    });

    it('integer → ValueDInt (default)', () => {
        const pv = encodeWriteValue(42);
        assert.ok(pv instanceof pvalue.ValueDInt);
        const rt = roundTrip(pv);
        assert.strictEqual(rt.toJs(), 42);
    });

    it('negative integer → ValueDInt (default)', () => {
        const pv = encodeWriteValue(-100);
        assert.ok(pv instanceof pvalue.ValueDInt);
        const rt = roundTrip(pv);
        assert.strictEqual(rt.toJs(), -100);
    });

    it('integer with hint "sint" → ValueSInt', () => {
        const pv = encodeWriteValue(-5, 'sint');
        assert.ok(pv instanceof pvalue.ValueSInt);
        const rt = roundTrip(pv);
        assert.strictEqual(rt.toJs(), -5);
    });

    it('integer with hint "usint" → ValueUSInt', () => {
        const pv = encodeWriteValue(200, 'usint');
        assert.ok(pv instanceof pvalue.ValueUSInt);
        const rt = roundTrip(pv);
        assert.strictEqual(rt.toJs(), 200);
    });

    it('integer with hint "int" → ValueInt', () => {
        const pv = encodeWriteValue(-1000, 'int');
        assert.ok(pv instanceof pvalue.ValueInt);
        const rt = roundTrip(pv);
        assert.strictEqual(rt.toJs(), -1000);
    });

    it('integer with hint "real" → ValueReal', () => {
        const pv = encodeWriteValue(10, 'real');
        assert.ok(pv instanceof pvalue.ValueReal);
        const rt = roundTrip(pv);
        const js = rt.toJs();
        assert.strictEqual(typeof js, 'number');
        assert.ok(Math.abs(js - 10) < 1e-6);
    });

    it('integer with hint "float" → ValueReal', () => {
        const pv = encodeWriteValue(5, 'float');
        assert.ok(pv instanceof pvalue.ValueReal);
    });

    it('float → ValueReal', () => {
        const pv = encodeWriteValue(3.14);
        assert.ok(pv instanceof pvalue.ValueReal);
        const rt = roundTrip(pv);
        assert.ok(Math.abs(rt.toJs() - 3.14) < 0.01);
    });

    it('string → ValueWString', () => {
        const pv = encodeWriteValue('Hello PLC');
        assert.ok(pv instanceof pvalue.ValueWString);
        const rt = roundTrip(pv);
        assert.strictEqual(rt.toJs(), 'Hello PLC');
    });

    it('empty string → ValueWString', () => {
        const pv = encodeWriteValue('');
        assert.ok(pv instanceof pvalue.ValueWString);
        const rt = roundTrip(pv);
        assert.strictEqual(rt.toJs(), '');
    });

    it('Buffer → ValueBlob', () => {
        const data = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
        const pv = encodeWriteValue(data);
        assert.ok(pv instanceof pvalue.ValueBlob);
        const rt = roundTrip(pv);
        assert.ok(Buffer.isBuffer(rt.toJs()));
        assert.deepStrictEqual([...rt.toJs()], [0xde, 0xad, 0xbe, 0xef]);
    });

    // Regression: a JS Date for the date-only "Date" type must encode to its
    // local calendar day regardless of the time-of-day component or timezone.
    // Previously a local-midnight Date truncated to the previous day east of UTC
    // (D#2023-10-28 was written as D#2023-10-27).
    describe('Date → days since 1990-01-01 (local calendar date)', () => {
        const DAYS_2023_10_28 = 12353;
        const cases = [
            ['local midnight', new Date(2023, 9, 28)],
            ['UTC midnight ISO', new Date('2023-10-28T00:00:00.000Z')],
            ['UTC afternoon ISO', new Date('2023-10-28T18:00:00.000Z')]
        ];
        for (const [label, input] of cases) {
            it(`${label} → day ${DAYS_2023_10_28} and round-trips to 2023-10-28`, () => {
                const pv = encodeWriteValue(input, 'Date');
                assert.ok(pv instanceof pvalue.ValueUInt);
                assert.strictEqual(pv.toJs(), DAYS_2023_10_28);

                const back = decodeReadValue(roundTrip(pv), 'Date');
                assert.ok(back instanceof Date);
                assert.strictEqual(back.getFullYear(), 2023);
                assert.strictEqual(back.getMonth(), 9);
                assert.strictEqual(back.getDate(), 28);
            });
        }

        it('decoded Date re-encodes to the same day (round-trip stable)', () => {
            const decoded = decodeReadValue(new pvalue.ValueUInt(DAYS_2023_10_28), 'Date');
            const reencoded = encodeWriteValue(decoded, 'Date');
            assert.strictEqual(reencoded.toJs(), DAYS_2023_10_28);
        });
    });
});

// ===========================================================================
//  DTL (softdatatype 67) – packed-struct round-trip
//  encodeWriteValue -> serialize -> deserialize -> decodeReadValue == Date
// ===========================================================================
describe('Datatype mapping – DTL (packed struct)', () => {
    const DTL_STRUCT_ID = 0x02000043;

    const cases = [
        ['min 1970-01-01', new Date('1970-01-01T00:00:00.000Z')],
        ['testvalue 2008-10-25', new Date('2008-10-25T08:12:34.567Z')],
        ['max 2262-04-11', new Date('2262-04-11T23:47:16.854Z')]
    ];

    for (const [label, date] of cases) {
        it(`${label} round-trips to the same UTC instant`, () => {
            const pv = encodeWriteValue(date, 'Dtl');
            assert.ok(pv instanceof pvalue.ValueStruct);
            assert.strictEqual(pv.id, DTL_STRUCT_ID);
            const back = decodeReadValue(roundTrip(pv), 'Dtl');
            assert.ok(back instanceof Date);
            assert.strictEqual(back.getTime(), date.getTime());
        });
    }

    it('accepts an ISO string and decodes via numeric id 67', () => {
        const pv = encodeWriteValue('2023-10-28T14:30:00.000Z', 'Dtl');
        const back = decodeReadValue(roundTrip(pv), 67);
        assert.strictEqual(back.getTime(), new Date('2023-10-28T14:30:00.000Z').getTime());
    });

    it('echoes the provided interface timestamp through the wire', () => {
        const ts = 0x0011223344556677n;
        const pv = encodeWriteValue(new Date('2020-01-02T03:04:05.000Z'), 'Dtl', { dtlInterfaceTimestamp: ts });
        const rt = roundTrip(pv);
        assert.strictEqual(rt.packedInterfaceTimestamp, ts);
    });

    it('encodes the 12-byte payload big-endian (year + nanoseconds)', () => {
        const pv = encodeWriteValue(new Date('2008-10-25T08:12:34.567Z'), 'Dtl');
        const buf = pv.getStructElement(DTL_STRUCT_ID).toJs();
        assert.ok(Buffer.isBuffer(buf));
        assert.strictEqual(buf.length, 12);
        assert.strictEqual((buf[0] << 8) | buf[1], 2008);
        assert.strictEqual(buf[2], 10);
        assert.strictEqual(buf[3], 25);
        assert.strictEqual(buf[5], 8);
        assert.strictEqual(buf[6], 12);
        assert.strictEqual(buf[7], 34);
        const ns = ((buf[8] << 24) | (buf[9] << 16) | (buf[10] << 8) | buf[11]) >>> 0;
        assert.strictEqual(ns, 567000000);
    });

    it('rejects values outside the DTL range', () => {
        assert.throws(() => encodeWriteValue(new Date('1969-12-31T23:59:59Z'), 'Dtl'), /DTL range/);
        assert.throws(() => encodeWriteValue(new Date('2300-01-01T00:00:00Z'), 'Dtl'), /DTL range/);
    });
});

// ===========================================================================
//  decodeReadValue – verifies the node-red-facing conversion
// ===========================================================================

describe('decodeReadValue – JS type contract', () => {

    it('Bool → boolean', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueBool(true)), 'boolean');
    });

    it('Byte → number', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueByte(42)), 'number');
    });

    it('Word → number', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueWord(1000)), 'number');
    });

    it('DWord → number', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueDWord(100000)), 'number');
    });

    it('LWord → BigInt (with softdatatype)', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueLWord(42n), 'LWord'), 'bigint');
        assert.strictEqual(decodeReadValue(new pvalue.ValueLWord(42n), 'LWord'), 42n);
    });

    it('SInt → number', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueSInt(-5)), 'number');
    });

    it('Int → number', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueInt(-1000)), 'number');
    });

    it('DInt → number', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueDInt(-100000)), 'number');
    });

    it('USInt → number', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueUSInt(200)), 'number');
    });

    it('UInt → number', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueUInt(50000)), 'number');
    });

    it('UDInt → number', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueUDInt(3000000000)), 'number');
    });

    it('LInt → number (BigInt converted by decodeReadValue)', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueLInt(42n)), 'number');
    });

    it('ULInt → number (BigInt converted by decodeReadValue)', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueULInt(42n)), 'number');
    });

    it('Real → number', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueReal(3.14)), 'number');
    });

    it('LReal → number', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueLReal(3.14)), 'number');
    });

    it('WString → string', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueWString('test')), 'string');
    });

    it('Timestamp → number (BigInt converted)', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueTimestamp(1000n)), 'number');
    });

    it('Timespan → number (BigInt converted)', () => {
        assert.strictEqual(typeof decodeReadValue(new pvalue.ValueTimespan(5000n)), 'number');
    });

    it('Blob → Buffer', () => {
        const result = decodeReadValue(new pvalue.ValueBlob(0, Buffer.from([1, 2, 3])));
        assert.ok(Buffer.isBuffer(result));
    });

    it('null input → null', () => {
        assert.strictEqual(decodeReadValue(null), null);
    });

    it('undefined input → null', () => {
        assert.strictEqual(decodeReadValue(undefined), null);
    });
});

// ===========================================================================
//  Edge cases – boundary values and special encodings
// ===========================================================================

describe('Datatype mapping – edge cases', () => {

    it('DInt min value -2147483648 encodes/decodes correctly', () => {
        const v = roundTrip(new pvalue.ValueDInt(-2147483648));
        assert.strictEqual(v.toJs(), -2147483648);
    });

    it('DInt max value 2147483647 encodes/decodes correctly', () => {
        const v = roundTrip(new pvalue.ValueDInt(2147483647));
        assert.strictEqual(v.toJs(), 2147483647);
    });

    it('UDInt max value 4294967295 encodes/decodes correctly', () => {
        const v = roundTrip(new pvalue.ValueUDInt(0xffffffff));
        assert.strictEqual(v.toJs(), 0xffffffff);
    });

    it('LReal special: NaN', () => {
        const v = roundTrip(new pvalue.ValueLReal(NaN));
        assert.ok(Number.isNaN(v.toJs()));
    });

    it('LReal special: Infinity', () => {
        const v = roundTrip(new pvalue.ValueLReal(Infinity));
        assert.strictEqual(v.toJs(), Infinity);
    });

    it('LReal special: -Infinity', () => {
        const v = roundTrip(new pvalue.ValueLReal(-Infinity));
        assert.strictEqual(v.toJs(), -Infinity);
    });

    it('Real special: NaN', () => {
        const v = roundTrip(new pvalue.ValueReal(NaN));
        assert.ok(Number.isNaN(v.toJs()));
    });

    it('WString with empty string', () => {
        const v = roundTrip(new pvalue.ValueWString(''));
        assert.strictEqual(v.toJs(), '');
    });

    it('WString with unicode BMP characters', () => {
        const s = '€£¥©®™';
        const v = roundTrip(new pvalue.ValueWString(s));
        assert.strictEqual(v.toJs(), s);
    });

    it('Blob with zero-length data', () => {
        const v = roundTrip(new pvalue.ValueBlob(0, Buffer.alloc(0)));
        assert.ok(Buffer.isBuffer(v.toJs()));
        assert.strictEqual(v.toJs().length, 0);
    });

    it('LInt negative boundary -9223372036854775808n', () => {
        const v = roundTrip(new pvalue.ValueLInt(-9223372036854775808n));
        assert.strictEqual(v.toJs(), -9223372036854775808n);
    });

    it('ULInt max 18446744073709551615n', () => {
        const v = roundTrip(new pvalue.ValueULInt(18446744073709551615n));
        assert.strictEqual(v.toJs(), 18446744073709551615n);
    });
});

// ===========================================================================
//  Real S7 String / WString wire format + numeric softdatatype ids
//  Regression: the CRC warmup cache used to store the numeric softdatatype
//  (19) instead of the name ('String'), so decodeReadValue fell through to
//  the default branch and returned the raw [maxLen, len, ...bytes] array.
//  These tests lock both the real wire format and the name/id equivalence.
// ===========================================================================

// Build the on-wire USInt array of an S7 String: [maxLen, curLen, ...latin1].
function makeS7String(str, maxLen = 254) {
    const bytes = Buffer.from(str, 'latin1');
    const arr = new Array(maxLen + 2).fill(0);
    arr[0] = maxLen;
    arr[1] = bytes.length;
    for (let i = 0; i < bytes.length; i++) arr[i + 2] = bytes[i];
    return new pvalue.ValueUSIntArray(arr);
}

// Build the on-wire UInt array of an S7 WString: [maxLen, curLen, ...UCS-2].
function makeS7WString(str, maxLen = 254) {
    const arr = new Array(maxLen + 2).fill(0);
    arr[0] = maxLen;
    arr[1] = str.length;
    for (let i = 0; i < str.length; i++) arr[i + 2] = str.charCodeAt(i);
    return new pvalue.ValueUIntArray(arr);
}

describe('decodeReadValue – real S7 String/WString wire format', () => {

    for (const str of ['', 'Hello World', 'Ä Ö Ü ß', 'A']) {
        it(`String "${str}" (USInt array) decodes to string via name`, () => {
            const v = roundTrip(makeS7String(str));
            const result = decodeReadValue(v, 'String');
            assert.strictEqual(typeof result, 'string');
            assert.strictEqual(result, str);
        });

        it(`String "${str}" decodes identically via numeric id 19`, () => {
            const v = roundTrip(makeS7String(str));
            assert.strictEqual(decodeReadValue(v, 19), decodeReadValue(v, 'String'));
        });
    }

    for (const str of ['', 'Hello', '日本語']) {
        it(`WString "${str}" (UInt array) decodes to string via name and id 62`, () => {
            const v = roundTrip(makeS7WString(str));
            const byName = decodeReadValue(v, 'WString');
            const byId = decodeReadValue(v, 62);
            assert.strictEqual(typeof byName, 'string');
            assert.strictEqual(byName, str);
            assert.strictEqual(byId, byName);
        });
    }
});

describe('decodeReadValue – numeric softdatatype id normalization', () => {

    it('Char id 3 → single-character string', () => {
        const result = decodeReadValue(new pvalue.ValueUSInt('A'.charCodeAt(0)), 3);
        assert.strictEqual(result, 'A');
    });

    it('Date id 9 → Date object (local calendar date)', () => {
        // 0 days since 1990-01-01, decoded as local midnight
        const result = decodeReadValue(new pvalue.ValueUInt(0), 9);
        assert.ok(result instanceof Date);
        assert.strictEqual(result.getFullYear(), 1990);
        assert.strictEqual(result.getMonth(), 0);
        assert.strictEqual(result.getDate(), 1);
        assert.strictEqual(result.getTime(), new Date(1990, 0, 1).getTime());
    });

    it('LInt id 50 → bigint', () => {
        const result = decodeReadValue(new pvalue.ValueLInt(42n), 50);
        assert.strictEqual(typeof result, 'bigint');
        assert.strictEqual(result, 42n);
    });

    it('id and name produce identical results for LInt', () => {
        assert.strictEqual(
            decodeReadValue(new pvalue.ValueLInt(7n), 50),
            decodeReadValue(new pvalue.ValueLInt(7n), 'LInt')
        );
    });
});

describe('encodeWriteValue – numeric softdatatype id normalization', () => {

    it('String id 19 encodes like name "String"', () => {
        const byId = encodeWriteValue('Hi', 19);
        const byName = encodeWriteValue('Hi', 'String');
        assert.strictEqual(byId.constructor, byName.constructor);
        assert.ok(byId instanceof pvalue.ValueUSIntArray);
    });

    it('LInt id 50 encodes like name "LInt"', () => {
        const byId = encodeWriteValue(5n, 50);
        const byName = encodeWriteValue(5n, 'LInt');
        assert.strictEqual(byId.constructor, byName.constructor);
        assert.ok(byId instanceof pvalue.ValueLInt);
    });
});

// ===========================================================================
//  encodeWriteValue – 64-bit values without precision loss
//  Regression: a Node-RED "num" inject of 0xFFFFFFFFFFFFFFFF arrives as a
//  double (2^64) and silently truncates to 0; 0x12345678ABCDEFAB rounds to
//  0x12345678ABCDF000. Strings and BigInt must survive intact, and an unsafe
//  JS number must be rejected loudly instead of corrupting the write.
// ===========================================================================
describe('encodeWriteValue – 64-bit precision', () => {

    it('LWord from hex string 0xFFFFFFFFFFFFFFFF round-trips exactly', () => {
        const v = roundTrip(encodeWriteValue('0xFFFFFFFFFFFFFFFF', 'LWord'));
        assert.strictEqual(v.toJs(), 0xFFFFFFFFFFFFFFFFn);
    });

    it('LWord from hex string 0x12345678ABCDEFAB keeps the low bits', () => {
        const v = roundTrip(encodeWriteValue('0x12345678ABCDEFAB', 'LWord'));
        assert.strictEqual(v.toJs(), 0x12345678ABCDEFABn);
    });

    it('LWord from decimal string round-trips exactly', () => {
        const v = roundTrip(encodeWriteValue('18446744073709551615', 'LWord'));
        assert.strictEqual(v.toJs(), 18446744073709551615n);
    });

    it('LWord from BigInt round-trips exactly', () => {
        const v = roundTrip(encodeWriteValue(0xFFFFFFFFFFFFFFFFn, 'LWord'));
        assert.strictEqual(v.toJs(), 0xFFFFFFFFFFFFFFFFn);
    });

    it('LInt min/max from string round-trip exactly', () => {
        assert.strictEqual(
            roundTrip(encodeWriteValue('-9223372036854775808', 'LInt')).toJs(),
            -9223372036854775808n
        );
        assert.strictEqual(
            roundTrip(encodeWriteValue('9223372036854775807', 'LInt')).toJs(),
            9223372036854775807n
        );
    });

    it('ULInt max from string round-trips exactly', () => {
        assert.strictEqual(
            roundTrip(encodeWriteValue('18446744073709551615', 'ULInt')).toJs(),
            18446744073709551615n
        );
    });

    it('LTime from string round-trips exactly', () => {
        assert.strictEqual(
            roundTrip(encodeWriteValue('9223372036854775807', 'LTime')).toJs(),
            9223372036854775807n
        );
    });

    it('rejects an unsafe JS number for LWord (no silent corruption)', () => {
        assert.throws(() => encodeWriteValue(2 ** 64, 'LWord'), /precision|BigInt|string/i);
    });

    it('rejects an unsafe JS number for LInt', () => {
        assert.throws(() => encodeWriteValue(2 ** 63, 'LInt'), /precision|BigInt|string/i);
    });

    it('rejects an unsafe JS number for ULInt', () => {
        assert.throws(() => encodeWriteValue(Number.MAX_SAFE_INTEGER + 2, 'ULInt'), /precision|BigInt|string/i);
    });

    it('still accepts a safe JS number for 64-bit types', () => {
        assert.strictEqual(roundTrip(encodeWriteValue(42, 'LWord')).toJs(), 42n);
        assert.strictEqual(roundTrip(encodeWriteValue(-5, 'LInt')).toJs(), -5n);
    });
});
