'use strict';

const { Ids } = require('./constants');

const S7p = {
    encodeByte(buf, v) { return buf.writeByte(v); },
    encodeUInt16(buf, v) {
        buf.writeByte((v & 0xff00) >> 8);
        buf.writeByte(v & 0xff);
        return 2;
    },
    encodeUInt32(buf, v) {
        buf.writeByte((v >>> 24) & 0xff);
        buf.writeByte((v >>> 16) & 0xff);
        buf.writeByte((v >>> 8) & 0xff);
        buf.writeByte(v & 0xff);
        return 4;
    },
    encodeUInt64(buf, v) {
        const n = BigInt(v);
        // Unsigned 64-bit wire field: a negative or oversized value would be
        // silently re-encoded as its two's-complement bit pattern (e.g. a
        // pre-1970 LDT turning into year 2554). Reject it loudly instead.
        if (n < 0n || n > 0xffffffffffffffffn) {
            throw new Error(`encodeUInt64: value ${n} out of unsigned 64-bit range (0 .. 2^64-1)`);
        }
        const hi = Number((n >> 32n) & 0xffffffffn);
        const lo = Number(n & 0xffffffffn);
        S7p.encodeUInt32(buf, hi);
        S7p.encodeUInt32(buf, lo);
        return 8;
    },
    encodeInt32Vlq(buf, value) {
        const b = [];
        let absV;
        if (value === -2147483648) absV = 2147483648;
        else absV = Math.abs(value);
        b[0] = value & 0x7f;
        let length = 1;
        for (let i = 1; i < 5; i++) {
            if (absV >= 0x40) {
                length++;
                absV >>>= 7;
                value >>= 7;
                b[i] = (value & 0x7f) + 0x80;
            } else break;
        }
        for (let i = length - 1; i >= 0; i--) buf.writeByte(b[i]);
        return length;
    },
    encodeUInt32Vlq(buf, value) {
        const bytes = [];
        let i;
        for (i = 4; i > 0; i--) {
            if (value & (0x7f << (i * 7))) break;
        }
        for (let j = 0; j <= i; j++) {
            bytes[j] = ((value >> ((i - j) * 7)) & 0x7f) | 0x80;
        }
        bytes[i] ^= 0x80;
        buf.writeBytes(Buffer.from(bytes.slice(0, i + 1)));
        return i + 1;
    },
    encodeUInt64Vlq(buf, value) {
        const b = [];
        let val = BigInt(value);
        const special = val > 0x00ffffffffffffffn;
        if (special) b[0] = Number(val & 0xffn);
        else b[0] = Number(val & 0x7fn);
        let length = 1;
        for (let i = 1; i < 9; i++) {
            if (val >= 0x80n) {
                length++;
                if (i === 1 && special) val >>= 8n;
                else val >>= 7n;
                b[i] = Number(val & 0x7fn) + 0x80;
            } else break;
        }
        if (special && length === 8) {
            length++;
            b[8] = 0x80;
        }
        for (let i = length - 1; i >= 0; i--) buf.writeByte(b[i]);
        return length;
    },
    encodeFloat(buf, value) {
        const v = Buffer.alloc(4);
        v.writeFloatLE(value, 0);
        buf.writeByte(v[3]);
        buf.writeByte(v[2]);
        buf.writeByte(v[1]);
        buf.writeByte(v[0]);
        return 4;
    },
    encodeDouble(buf, value) {
        const v = Buffer.alloc(8);
        v.writeDoubleLE(value, 0);
        for (let i = 7; i >= 0; i--) buf.writeByte(v[i]);
        return 8;
    },

    decodeByte(buf) {
        const v = buf.readByte();
        return v === null ? { n: 0, v: 0 } : { n: 1, v };
    },
    decodeUInt16(buf) {
        const a = buf.readByte();
        const b = buf.readByte();
        if (a === null || b === null) return { n: 0, v: 0 };
        return { n: 2, v: (a << 8) | b };
    },
    decodeUInt32(buf) {
        const a = buf.readByte(); const b = buf.readByte();
        const c = buf.readByte(); const d = buf.readByte();
        if (d === null) return { n: 0, v: 0 };
        return { n: 4, v: ((a << 24) | (b << 16) | (c << 8) | d) >>> 0 };
    },
    decodeInt16(buf) {
        const r = S7p.decodeUInt16(buf);
        let v = r.v;
        if (v & 0x8000) v -= 0x10000;
        return { n: r.n, v };
    },
    decodeUInt64(buf) {
        const hi = S7p.decodeUInt32(buf);
        const lo = S7p.decodeUInt32(buf);
        return { n: 8, v: (BigInt(hi.v) << 32n) | BigInt(lo.v) };
    },
    decodeInt64(buf) {
        const r = S7p.decodeUInt64(buf);
        let v = r.v;
        if (v >= 0x8000000000000000n) v -= 0x10000000000000000n;
        return { n: 8, v };
    },
    decodeUInt16LE(buf) {
        const a = buf.readByte(); const b = buf.readByte();
        if (b === null) return { n: 0, v: 0 };
        return { n: 2, v: (a | (b << 8)) & 0xffff };
    },
    decodeUInt32LE(buf) {
        const a = buf.readByte(); const b = buf.readByte();
        const c = buf.readByte(); const d = buf.readByte();
        if (d === null) return { n: 0, v: 0 };
        return { n: 4, v: (a | (b << 8) | (c << 16) | (d << 24)) >>> 0 };
    },
    decodeInt32LE(buf) {
        const r = S7p.decodeUInt32LE(buf);
        let v = r.v;
        if (v & 0x80000000) v = v - 0x100000000;
        return { n: r.n, v };
    },
    decodeWString(buf, len) {
        const bytes = buf.readBytes(len);
        if (!bytes) return { n: 0, v: '' };
        return { n: len, v: bytes.toString('utf8') };
    },
    decodeUInt32Vlq(buf) {
        let val = 0;
        let length = 0;
        for (let counter = 1; counter <= 5; counter++) {
            const octet = buf.readByte();
            if (octet === null) break;
            length++;
            val <<= 7;
            const cont = octet & 0x80;
            val += octet & 0x7f;
            if (cont === 0) break;
        }
        return { n: length, v: val >>> 0 };
    },
    decodeInt32Vlq(buf) {
        let val = 0;
        let length = 0;
        for (let counter = 1; counter <= 5; counter++) {
            let octet = buf.readByte();
            if (octet === null) break;
            length++;
            if (counter === 1 && (octet & 0x40)) {
                octet &= 0xbf;
                val = -64;
            } else val <<= 7;
            const cont = octet & 0x80;
            val += octet & 0x7f;
            if (cont === 0) break;
        }
        return { n: length, v: val | 0 };
    },
    decodeUInt64Vlq(buf) {
        let val = 0n;
        let length = 0;
        let cont = 0;
        let octet = 0;
        for (let counter = 1; counter <= 8; counter++) {
            octet = buf.readByte();
            if (octet === null) break;
            length++;
            val <<= 7n;
            cont = octet & 0x80;
            val += BigInt(octet & 0x7f);
            if (cont === 0) break;
        }
        if (cont > 0) {
            octet = buf.readByte();
            if (octet !== null) {
                length++;
                val <<= 8n;
                val += BigInt(octet);
            }
        }
        return { n: length, v: val };
    },
    decodeInt64Vlq(buf) {
        let val = 0n;
        let length = 0;
        let cont = 0;
        let octet = 0;
        for (let counter = 1; counter <= 8; counter++) {
            octet = buf.readByte();
            if (octet === null) break;
            length++;
            if (counter === 1 && (octet & 0x40)) {
                octet &= 0xbf;
                val = -64n;
            } else val <<= 7n;
            cont = octet & 0x80;
            val += BigInt(octet & 0x7f);
            if (cont === 0) break;
        }
        if (cont > 0) {
            octet = buf.readByte();
            if (octet !== null) {
                length++;
                val <<= 8n;
                val += BigInt(octet);
            }
        }
        return { n: length, v: val };
    },
    decodeFloat(buf) {
        const v = Buffer.alloc(4);
        v[3] = buf.readByte();
        v[2] = buf.readByte();
        v[1] = buf.readByte();
        v[0] = buf.readByte();
        return { n: 4, v: v.readFloatLE(0) };
    },
    decodeDouble(buf) {
        const v = Buffer.alloc(8);
        for (let i = 7; i >= 0; i--) v[i] = buf.readByte();
        return { n: 8, v: v.readDoubleLE(0) };
    },
    decodeHeader(buf) {
        buf.readByte();
        const ver = buf.readByte();
        const len = S7p.decodeUInt16(buf);
        return { version: ver, length: len.v };
    },
    encodeHeader(buf, version, length) {
        buf.writeByte(0x72);
        buf.writeByte(version);
        S7p.encodeUInt16(buf, length);
        return 4;
    }
};

module.exports = S7p;
