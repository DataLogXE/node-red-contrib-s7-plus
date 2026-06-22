'use strict';

const pvalue = require('./pvalue');
const { softdatatypeName } = require('./browse/datatypes');

// ── S7 String (softdatatype 19) ──────────────────────────────────────
// Wire format: USInt array  [maxLen, currentLen, ...bytes]
// Byte 0       = max capacity
// Byte 1       = actual character count
// Bytes 2..n   = ISO-8859-1 / CP1252 encoded characters
function decodeS7String(arr) {
    if (!Array.isArray(arr) || arr.length < 2) return '';
    const len = arr[1];
    const bytes = arr.slice(2, 2 + len);
    return Buffer.from(bytes).toString('latin1');
}

// ── S7 WString (softdatatype 62) ─────────────────────────────────────
// Wire format: UInt16 array  [maxLen, currentLen, ...UCS-2 codepoints]
// Word 0       = max capacity (chars)
// Word 1       = actual character count
// Words 2..n   = UCS-2 code points
function decodeS7WString(arr) {
    if (!Array.isArray(arr) || arr.length < 2) return '';
    const len = arr[1];
    const codes = arr.slice(2, 2 + len);
    return String.fromCharCode(...codes);
}

// ── S5Time (BCD) → milliseconds ──────────────────────────────────────
// Wire: UInt16 (ValueWord).  Bits 13-12 = time base, 11-0 = BCD value
function decodeS5Time(raw) {
    const n = typeof raw === 'number' ? raw : Number(raw);
    const base = (n >> 12) & 0x03;
    const bcd = n & 0x0fff;
    const hundreds = (bcd >> 8) & 0x0f;
    const tens     = (bcd >> 4) & 0x0f;
    const ones     = bcd & 0x0f;
    const val = hundreds * 100 + tens * 10 + ones;
    const multipliers = [10, 100, 1000, 10000];
    return val * multipliers[base];
}

function encodeS5Time(ms) {
    const abs = Math.max(0, Math.min(ms, 9990000));
    let base, divisor;
    if (abs <= 9990)        { base = 0; divisor = 10; }
    else if (abs <= 99900)  { base = 1; divisor = 100; }
    else if (abs <= 999000) { base = 2; divisor = 1000; }
    else                    { base = 3; divisor = 10000; }
    const val = Math.round(abs / divisor);
    const hundreds = Math.floor(val / 100) % 10;
    const tens     = Math.floor(val / 10) % 10;
    const ones     = val % 10;
    return (base << 12) | (hundreds << 8) | (tens << 4) | ones;
}

// ── DateAndTime (BCD, 8 bytes) → Date ────────────────────────────────
// Wire: USInt array [YY, MM, DD, HH, MM, SS, ms_hi, ms_lo_dow]
function decodeDateAndTime(arr) {
    if (!Array.isArray(arr) || arr.length < 8) return new Date(0);
    const bcd = b => ((b >> 4) & 0x0f) * 10 + (b & 0x0f);
    let year = bcd(arr[0]);
    year += year >= 90 ? 1900 : 2000;
    const month  = bcd(arr[1]);
    const day    = bcd(arr[2]);
    const hour   = bcd(arr[3]);
    const minute = bcd(arr[4]);
    const second = bcd(arr[5]);
    const msHi   = bcd(arr[6]);
    const msLo   = (arr[7] >> 4) & 0x0f;
    const ms     = msHi * 10 + msLo;
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
}

function encodeDateAndTimeBcd(d) {
    const toBcd = n => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
    const year = d.getUTCFullYear();
    const ms = d.getUTCMilliseconds();
    const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    const arr = [
        toBcd(year % 100),
        toBcd(d.getUTCMonth() + 1),
        toBcd(d.getUTCDate()),
        toBcd(d.getUTCHours()),
        toBcd(d.getUTCMinutes()),
        toBcd(d.getUTCSeconds()),
        toBcd(Math.floor(ms / 10)),
        ((ms % 10) << 4) | (dow & 0x0f),
    ];
    return new pvalue.ValueUSIntArray(arr);
}

// ── LDT / Ldt  →  Date ──────────────────────────────────────────────
// Wire: Timestamp (UInt64), nanoseconds since 1970-01-01
function decodeLdt(bigVal) {
    const ns = typeof bigVal === 'bigint' ? bigVal : BigInt(bigVal);
    const ms = Number(ns / 1000000n);
    return new Date(ms);
}

// ── DTL (softdatatype 67) ↔ Date ─────────────────────────────────────
// DTL is transmitted as a packed Struct (id 0x02000043 = TI_LIB.SimpleType.67)
// carrying a 12-byte big-endian array:
//   [0..1] YEAR (UInt)   [2] MONTH   [3] DAY   [4] WEEKDAY
//   [5] HOUR  [6] MINUTE  [7] SECOND  [8..11] NANOSECOND (UDInt)
// Valid range: 1970-01-01 00:00:00 .. 2262-04-11 23:47:16.
const DTL_STRUCT_ID = 0x02000043;
// Type-version timestamp the PLC expects when writing a packed DTL. Used
// only as a fallback when the live value has not been captured from the
// PLC yet (see endpoint DTL timestamp cache).
const DTL_DEFAULT_INTERFACE_TIMESTAMP = 0x10ff4ad6dfd5774cn;
const DTL_MIN_MS = Date.UTC(1970, 0, 1, 0, 0, 0);
const DTL_MAX_MS = Date.UTC(2262, 3, 11, 23, 47, 16, 999);

// Extract the raw 12-byte payload from a decoded DTL value. The packed
// struct decodes to { <structId>: Buffer }; accept a Buffer/array directly
// for robustness.
function dtlBytes(j) {
    if (Buffer.isBuffer(j)) return j;
    if (Array.isArray(j)) return Buffer.from(j);
    if (j && typeof j === 'object') {
        const buf = Object.values(j).find(v => Buffer.isBuffer(v));
        if (buf) return buf;
        const arr = Object.values(j).find(v => Array.isArray(v));
        if (arr) return Buffer.from(arr);
    }
    return null;
}

function decodeDtl(j) {
    const b = dtlBytes(j);
    if (!b || b.length < 12) return new Date(0);
    const year = (b[0] << 8) | b[1];
    const month = b[2];
    const day = b[3];
    // b[4] = WEEKDAY (derived from the date; ignored here)
    const hour = b[5];
    const minute = b[6];
    const second = b[7];
    const nanosecond = ((b[8] << 24) | (b[9] << 16) | (b[10] << 8) | b[11]) >>> 0;
    const ms = Math.round(nanosecond / 1e6);
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
}

function encodeDtlBytes(d) {
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const hour = d.getUTCHours();
    const minute = d.getUTCMinutes();
    const second = d.getUTCSeconds();
    const nanosecond = (d.getUTCMilliseconds() * 1e6) >>> 0;
    const b = Buffer.alloc(12);
    b[0] = (year >> 8) & 0xff;
    b[1] = year & 0xff;
    b[2] = month;
    b[3] = day;
    b[4] = 0; // WEEKDAY: the PLC recomputes it on write
    b[5] = hour;
    b[6] = minute;
    b[7] = second;
    b[8] = (nanosecond >>> 24) & 0xff;
    b[9] = (nanosecond >>> 16) & 0xff;
    b[10] = (nanosecond >>> 8) & 0xff;
    b[11] = nanosecond & 0xff;
    return b;
}

// ── Date (softdatatype 9) → Date ─────────────────────────────────────
// Wire: UInt16, days since 1990-01-01
const DATE_EPOCH = Date.UTC(1990, 0, 1);
function decodeS7Date(daysSinceEpoch) {
    const n = typeof daysSinceEpoch === 'number' ? daysSinceEpoch : Number(daysSinceEpoch);
    // Return local midnight of the calendar day so encode/decode are symmetric
    // and read->write round-trips stay stable in any timezone.
    const utc = new Date(DATE_EPOCH + n * 86400000);
    return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

// ═════════════════════════════════════════════════════════════════════
//  decodeReadValue  –  PValue → JS value, per README type contract
// ═════════════════════════════════════════════════════════════════════

function decodeReadValue(pval, softdatatype) {
    if (!pval || typeof pval.toJs !== 'function') return null;
    const j = pval.toJs();

    // Accept both the canonical type name ('String') and the raw numeric
    // softdatatype id (19). The latter may leak in from the CRC warmup
    // cache; normalizing here keeps the switch a single source of truth.
    if (typeof softdatatype === 'number') softdatatype = softdatatypeName(softdatatype);

    switch (softdatatype) {
        // ── Char / WChar → string ────────────────────────────────
        case 'Char':
            return String.fromCharCode(typeof j === 'number' ? j : Number(j));
        case 'WChar':
            return String.fromCharCode(typeof j === 'number' ? j : Number(j));

        // ── String → decode header+bytes to string ───────────────
        case 'String':
            if (Array.isArray(j)) return decodeS7String(j);
            if (typeof j === 'string') return j;
            if (Buffer.isBuffer(j)) return j.toString('latin1');
            return String(j);

        // ── WString → decode header+UCS2 to string ──────────────
        case 'WString':
            if (Array.isArray(j)) return decodeS7WString(j);
            if (typeof j === 'string') return j;
            return String(j);

        // ── 64-bit integers → BigInt ─────────────────────────────
        case 'LInt':
        case 'ULInt':
            return typeof j === 'bigint' ? j : BigInt(j);

        // ── LTime → BigInt (nanoseconds) ─────────────────────────
        case 'LTime':
            return typeof j === 'bigint' ? j : BigInt(j);

        // ── LTOD → BigInt (nanoseconds since midnight) ───────────
        case 'LTod':
            return typeof j === 'bigint' ? j : BigInt(j);

        // ── Date → Date object ───────────────────────────────────
        case 'Date':
            return decodeS7Date(j);

        // ── LDT / Ldt → Date object ─────────────────────────────
        case 'Ldt':
            return decodeLdt(j);

        // ── DTL → Date object (packed struct, 12-byte payload) ───
        case 'Dtl':
            return decodeDtl(j);

        // ── DateAndTime → Date object ────────────────────────────
        case 'DateAndTime':
            if (Array.isArray(j)) return decodeDateAndTime(j);
            if (typeof j === 'bigint') return decodeLdt(j);
            return new Date(typeof j === 'number' ? j : 0);

        // ── S5Time → number (milliseconds) ───────────────────────
        case 'S5Time':
            return decodeS5Time(typeof j === 'number' ? j : Number(j));

        // ── Time → number (milliseconds, already DInt) ───────────
        case 'Time':
            return typeof j === 'number' ? j : Number(j);

        // ── TOD → number (ms since midnight, already UDInt) ──────
        case 'TimeOfDay':
            return typeof j === 'number' ? j : Number(j);

        // ── LWord → BigInt (64-bit, cannot fit a JS number) ──────
        case 'LWord':
            return typeof j === 'bigint' ? j : BigInt(j);

        // ── default: best-effort ─────────────────────────────────
        default:
            if (typeof j === 'bigint') return Number(j);
            if (Buffer.isBuffer(j)) return j;
            return j;
    }
}

// ═════════════════════════════════════════════════════════════════════
//  encodeWriteValue  –  JS value → PValue, per softdatatype
// ═════════════════════════════════════════════════════════════════════

// Coerce a write value to a 64-bit BigInt without silent precision loss.
// A JS number only holds 53 significant bits, so any 64-bit literal beyond
// Number.MAX_SAFE_INTEGER is already corrupted by the time it arrives here
// (e.g. a Node-RED "num" inject of 0xFFFFFFFFFFFFFFFF). We therefore accept
// BigInt and strings (hex "0x.." or decimal, losslessly parsed) and reject
// unsafe numbers loudly instead of writing a wrong value.
function toBigInt64(val, typeName) {
    if (typeof val === 'bigint') return val;
    if (typeof val === 'string') {
        const s = val.trim();
        try {
            return BigInt(s);
        } catch (e) {
            throw new Error(`Cannot encode ${typeName} value "${val}": not a valid integer`);
        }
    }
    if (typeof val === 'number') {
        if (!Number.isInteger(val) || !Number.isSafeInteger(val)) {
            throw new Error(
                `Cannot encode ${typeName} value ${val}: 64-bit values beyond ` +
                `Number.MAX_SAFE_INTEGER (2^53) lose precision as a JS number — ` +
                `pass a BigInt or a string instead`
            );
        }
        return BigInt(val);
    }
    return BigInt(val);
}

function encodeWriteValue(val, softdatatype, opts = {}) {
    if (typeof softdatatype === 'number') softdatatype = softdatatypeName(softdatatype);

    switch (softdatatype) {
        case 'Bool':
        case 'BBool':
            return new pvalue.ValueBool(!!val);

        case 'Byte':
            return new pvalue.ValueByte(Number(val));
        case 'Word':
            return new pvalue.ValueWord(Number(val));
        case 'DWord':
            return new pvalue.ValueDWord(Number(val));
        case 'LWord':
            return new pvalue.ValueLWord(toBigInt64(val, 'LWord'));

        case 'SInt':
            return new pvalue.ValueSInt(Number(val));
        case 'Int':
            return new pvalue.ValueInt(Number(val));
        case 'DInt':
            return new pvalue.ValueDInt(Number(val));
        case 'USInt':
            return new pvalue.ValueUSInt(Number(val));
        case 'UInt':
            return new pvalue.ValueUInt(Number(val));
        case 'UDInt':
            return new pvalue.ValueUDInt(Number(val));
        case 'LInt':
            return new pvalue.ValueLInt(toBigInt64(val, 'LInt'));
        case 'ULInt':
            return new pvalue.ValueULInt(toBigInt64(val, 'ULInt'));

        case 'Real':
            return new pvalue.ValueReal(Number(val));
        case 'LReal':
            return new pvalue.ValueLReal(Number(val));

        case 'Char':
            return new pvalue.ValueUSInt(typeof val === 'string' ? val.charCodeAt(0) : Number(val));
        case 'WChar':
            return new pvalue.ValueUInt(typeof val === 'string' ? val.charCodeAt(0) : Number(val));
        case 'String': {
            const s = String(val);
            const bytes = Buffer.from(s, 'latin1');
            const maxLen = 254;
            const actualLen = Math.min(bytes.length, maxLen);
            const arr = new Array(maxLen + 2).fill(0);
            arr[0] = maxLen;
            arr[1] = actualLen;
            for (let i = 0; i < actualLen; i++) arr[i + 2] = bytes[i];
            return new pvalue.ValueUSIntArray(arr);
        }
        case 'WString': {
            const s = String(val);
            const maxLen = 254;
            const actualLen = Math.min(s.length, maxLen);
            const arr = new Array(maxLen + 2).fill(0);
            arr[0] = maxLen;
            arr[1] = actualLen;
            for (let i = 0; i < actualLen; i++) arr[i + 2] = s.charCodeAt(i);
            return new pvalue.ValueUIntArray(arr);
        }

        case 'Time':
            return new pvalue.ValueDInt(Number(val));
        case 'S5Time': {
            const bcd = encodeS5Time(Number(val));
            return new pvalue.ValueWord(bcd);
        }
        case 'LTime':
            return new pvalue.ValueTimespan(toBigInt64(val, 'LTime'));

        case 'TimeOfDay':
            return new pvalue.ValueUDInt(Number(val));
        case 'LTod':
            return new pvalue.ValueULInt(toBigInt64(val, 'LTod'));

        case 'Date': {
            const d = val instanceof Date ? val : new Date(val);
            // Treat the JS Date as a local calendar date: derive the day count
            // from its local Y/M/D so a local-midnight Date does not truncate to
            // the previous day in timezones east of UTC.
            const localMidnightUtc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
            const days = Math.floor((localMidnightUtc - DATE_EPOCH) / 86400000);
            return new pvalue.ValueUInt(Math.max(0, days));
        }
        case 'Ldt': {
            const d = val instanceof Date ? val : (typeof val === 'bigint' ? val : new Date(val));
            const ns = typeof d === 'bigint'
                ? toBigInt64(d, 'Ldt')
                : BigInt(d.getTime()) * 1000000n;
            // LDT is an unsigned nanosecond count since 1970-01-01. A value
            // before the epoch (e.g. a Date parsed in a positive UTC offset)
            // would otherwise wrap to ~2554 via two's complement.
            if (ns < 0n || ns > 0xffffffffffffffffn) {
                throw new Error(
                    `Cannot encode Ldt value ${ns} ns: out of LDT range ` +
                    `(1970-01-01 00:00:00.000000000 .. 2554-07-21 23:34:33.709551615)`
                );
            }
            return new pvalue.ValueTimestamp(ns);
        }
        case 'DateAndTime': {
            const d = val instanceof Date ? val : new Date(val);
            return encodeDateAndTimeBcd(d);
        }
        case 'Dtl': {
            const d = val instanceof Date ? val : new Date(val);
            const ms = d.getTime();
            if (Number.isNaN(ms) || ms < DTL_MIN_MS || ms > DTL_MAX_MS) {
                throw new Error(
                    `Cannot encode Dtl value ${val}: out of DTL range ` +
                    `(1970-01-01 00:00:00 .. 2262-04-11 23:47:16)`
                );
            }
            const struct = new pvalue.ValueStruct(DTL_STRUCT_ID);
            struct.packedInterfaceTimestamp = opts.dtlInterfaceTimestamp != null
                ? (typeof opts.dtlInterfaceTimestamp === 'bigint'
                    ? opts.dtlInterfaceTimestamp
                    : BigInt(opts.dtlInterfaceTimestamp))
                : DTL_DEFAULT_INTERFACE_TIMESTAMP;
            struct.packedTransportFlags = 2;
            struct.addStructElement(DTL_STRUCT_ID, new pvalue.ValueBlob(0, encodeDtlBytes(d)));
            return struct;
        }

        default:
            return pvalue.valueFromJs(val, softdatatype ? softdatatype.toLowerCase() : undefined);
    }
}

module.exports = { encodeWriteValue, decodeReadValue, decodeS5Time, encodeS5Time };
