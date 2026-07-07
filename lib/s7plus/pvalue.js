'use strict';

const S7p = require('./s7p');
const { Datatype } = require('./constants');

const FLAGS_ARRAY = 0x10;

function writeTypeHeader(buf, flags, dt) {
    return S7p.encodeByte(buf, flags) + S7p.encodeByte(buf, dt);
}

class PValue {
    serialize(buf) { throw new Error('abstract'); }
    toJs() { return null; }
}

class ValueNull extends PValue {
    serialize(buf) { return writeTypeHeader(buf, 0, Datatype.Null); }
    toJs() { return null; }
}

class ValueBool extends PValue {
    constructor(v, flags = 0) { super(); this.v = !!v; this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.Bool);
        n += S7p.encodeByte(buf, this.v ? 1 : 0);
        return n;
    }
    toJs() { return this.v; }
}

class ValueUSInt extends PValue {
    constructor(v, flags = 0) { super(); this.v = v & 0xff; this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.USInt);
        n += S7p.encodeByte(buf, this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueUInt extends PValue {
    constructor(v, flags = 0) { super(); this.v = v & 0xffff; this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.UInt);
        n += S7p.encodeUInt16(buf, this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueUDInt extends PValue {
    constructor(v, flags = 0) { super(); this.v = v >>> 0; this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.UDInt);
        n += S7p.encodeUInt32Vlq(buf, this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueSInt extends PValue {
    constructor(v, flags = 0) { super(); this.v = (v << 24) >> 24; this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.SInt);
        n += S7p.encodeByte(buf, this.v & 0xff);
        return n;
    }
    toJs() { return this.v; }
}

class ValueInt extends PValue {
    constructor(v, flags = 0) { super(); this.v = v | 0; this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.Int);
        const u = this.v & 0xffff;
        n += S7p.encodeUInt16(buf, u);
        return n;
    }
    toJs() { return this.v; }
}

class ValueDInt extends PValue {
    constructor(v, flags = 0) { super(); this.v = v | 0; this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.DInt);
        n += S7p.encodeInt32Vlq(buf, this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueReal extends PValue {
    constructor(v, flags = 0) { super(); this.v = v; this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.Real);
        n += S7p.encodeFloat(buf, this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueLReal extends PValue {
    constructor(v, flags = 0) { super(); this.v = v; this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.LReal);
        n += S7p.encodeDouble(buf, this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueRID extends PValue {
    constructor(v, flags = 0) { super(); this.v = v >>> 0; this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.RID);
        n += S7p.encodeUInt32(buf, this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueAID extends PValue {
    constructor(v, flags = 0) { super(); this.v = v >>> 0; this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.AID);
        n += S7p.encodeUInt32Vlq(buf, this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueULInt extends PValue {
    constructor(v, flags = 0) { super(); this.v = typeof v === 'bigint' ? v : BigInt(v); this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.ULInt);
        n += S7p.encodeUInt64Vlq(buf, this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueLInt extends PValue {
    constructor(v, flags = 0) { super(); this.v = typeof v === 'bigint' ? v : BigInt(v); this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.LInt);
        // VLQ int64 encode not implemented in S7p.encodeUInt64Vlq for signed; reuse for now
        n += S7p.encodeUInt64Vlq(buf, this.v < 0n ? this.v + 0x10000000000000000n : this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueByte extends PValue {
    constructor(v, flags = 0) { super(); this.v = v & 0xff; this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.Byte);
        n += S7p.encodeByte(buf, this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueWord extends PValue {
    constructor(v, flags = 0) { super(); this.v = v & 0xffff; this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.Word);
        n += S7p.encodeUInt16(buf, this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueDWord extends PValue {
    constructor(v, flags = 0) { super(); this.v = v >>> 0; this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.DWord);
        n += S7p.encodeUInt32(buf, this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueLWord extends PValue {
    constructor(v, flags = 0) { super(); this.v = typeof v === 'bigint' ? v : BigInt(v); this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.LWord);
        n += S7p.encodeUInt64(buf, this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueTimestamp extends PValue {
    constructor(v, flags = 0) { super(); this.v = typeof v === 'bigint' ? v : BigInt(v); this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.Timestamp);
        n += S7p.encodeUInt64(buf, this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueTimespan extends PValue {
    constructor(v, flags = 0) { super(); this.v = typeof v === 'bigint' ? v : BigInt(v); this.flags = flags; }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.Timespan);
        n += S7p.encodeUInt64Vlq(buf, this.v < 0n ? this.v + 0x10000000000000000n : this.v);
        return n;
    }
    toJs() { return this.v; }
}

class ValueBlob extends PValue {
    constructor(_id, data, flags = 0) {
        super();
        this.data = Buffer.from(data);
        this.flags = flags;
    }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.Blob);
        n += S7p.encodeUInt32Vlq(buf, this.data.length);
        n += buf.writeBytes(this.data);
        return n;
    }
    toJs() { return this.data; }
}

class ValueWString extends PValue {
    constructor(s, flags = 0) {
        super();
        this.s = s;
        this.flags = flags;
    }
    serialize(buf) {
        const b = Buffer.from(this.s, 'utf8');
        let n = writeTypeHeader(buf, this.flags, Datatype.WString);
        n += S7p.encodeUInt32Vlq(buf, b.length);
        n += buf.writeBytes(b);
        return n;
    }
    toJs() { return this.s; }
}

class ValueUSIntArray extends PValue {
    constructor(arr, flags = FLAGS_ARRAY) {
        super();
        this.arr = arr;
        this.flags = flags;
    }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.USInt);
        n += S7p.encodeUInt32Vlq(buf, this.arr.length);
        for (const v of this.arr) n += S7p.encodeByte(buf, v);
        return n;
    }
    toJs() { return this.arr; }
}

class ValueUIntArray extends PValue {
    constructor(arr, flags = FLAGS_ARRAY) {
        super();
        this.arr = arr;
        this.flags = flags;
    }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.UInt);
        n += S7p.encodeUInt32Vlq(buf, this.arr.length);
        for (const v of this.arr) n += S7p.encodeUInt16(buf, v);
        return n;
    }
    toJs() { return this.arr; }
}

class ValueUDIntArray extends PValue {
    constructor(arr, flags = FLAGS_ARRAY) {
        super();
        this.arr = arr;
        this.flags = flags;
    }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.UDInt);
        n += S7p.encodeUInt32Vlq(buf, this.arr.length);
        for (const v of this.arr) n += S7p.encodeUInt32Vlq(buf, v >>> 0);
        return n;
    }
    toJs() { return this.arr; }
}

class ValueArray extends PValue {
    constructor(arr, datatype, flags = FLAGS_ARRAY) {
        super();
        this.arr = arr;
        this.datatype = datatype;
        this.flags = flags;
    }
    serialize() { throw new Error('Generic ValueArray serialize not implemented'); }
    toJs() { return this.arr; }
}

// Packed-struct ID range (system datatypes like DTL are transmitted as a
// single packed byte array instead of element-by-element). See
// _deserializeStruct and the S7CommPlusDriver reference.
function isPackedStructId(id) {
    return (id > 0x90000000 && id < 0x9fffffff) || (id > 0x02000000 && id < 0x02ffffff);
}

// Default transport flag for a packed struct write (bit 1 "AlwaysSet").
const PACKED_STRUCT_TRANSPORT_FLAGS_DEFAULT = 2;

class ValueStruct extends PValue {
    constructor(id, flags = 0) {
        super();
        this.id = id >>> 0;
        this.flags = flags;
        this.elements = new Map();
        // Only meaningful for packed structs (e.g. DTL). The interface
        // timestamp must match the PLC's type version exactly, otherwise
        // a write is rejected with InvalidTimestampInTypeSafeBlob.
        this.packedInterfaceTimestamp = 0n;
        this.packedTransportFlags = PACKED_STRUCT_TRANSPORT_FLAGS_DEFAULT;
    }
    addStructElement(id, val) { this.elements.set(id, val); }
    getStructElement(id) { return this.elements.get(id); }
    serialize(buf) {
        let n = writeTypeHeader(buf, this.flags, Datatype.Struct);
        n += S7p.encodeUInt32(buf, this.id);

        if (isPackedStructId(this.id)) {
            // Packed struct: interface timestamp + transport flags + a raw
            // byte array (no per-element headers). Mirrors the C# reference
            // ValueStruct.Serialize for system datatypes.
            for (const [, v] of this.elements) {
                n += S7p.encodeUInt64(buf, this.packedInterfaceTimestamp);
                n += S7p.encodeUInt32Vlq(buf, this.packedTransportFlags >>> 0);
                const bytes = Buffer.isBuffer(v) ? v : (v && v.toJs ? v.toJs() : null);
                if (!Buffer.isBuffer(bytes)) {
                    throw new Error('Packed struct element must be a Buffer (ValueBlob)');
                }
                n += S7p.encodeUInt32Vlq(buf, bytes.length);
                n += buf.writeBytes(bytes);
            }
            return n;
        }

        for (const [k, v] of this.elements) {
            n += S7p.encodeUInt32Vlq(buf, k >>> 0);
            n += v.serialize(buf);
        }
        n += S7p.encodeByte(buf, 0);
        return n;
    }

    toJs() {
        const o = {};
        for (const [k, v] of this.elements) o[k] = v.toJs();
        return o;
    }
}

const FLAGS_ADDRESSARRAY = 0x20;
const FLAGS_SPARSEARRAY = 0x40;

function deserialize(buf, disableVlq = false) {
    let flags, datatype;
    if (!disableVlq) {
        flags = buf.readByte();
        datatype = buf.readByte();
    } else {
        buf.readByte();
        flags = buf.readByte();
        buf.readByte();
        datatype = buf.readByte();
    }
    if (flags === null || datatype === null) return null;

    if (flags === FLAGS_ARRAY || flags === FLAGS_ADDRESSARRAY) {
        return _deserializeArray(buf, datatype, flags, disableVlq);
    }
    if (flags === FLAGS_SPARSEARRAY) {
        return _deserializeSparseArray(buf, datatype, flags, disableVlq);
    }

    switch (datatype) {
        case Datatype.Null: return new ValueNull();
        case Datatype.Bool: {
            const v = buf.readByte();
            return new ValueBool(!!v, flags);
        }
        case Datatype.USInt: return new ValueUSInt(buf.readByte() ?? 0, flags);
        case Datatype.UInt: {
            const r = S7p.decodeUInt16(buf);
            return new ValueUInt(r.v, flags);
        }
        case Datatype.UDInt: {
            const r = disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf);
            return new ValueUDInt(r.v, flags);
        }
        case Datatype.ULInt: {
            const r = disableVlq ? S7p.decodeUInt64(buf) : S7p.decodeUInt64Vlq(buf);
            return new ValueULInt(r.v, flags);
        }
        case Datatype.SInt: {
            const b = buf.readByte() ?? 0;
            return new ValueSInt(b & 0x80 ? b - 256 : b, flags);
        }
        case Datatype.Int: {
            const r = S7p.decodeInt16(buf);
            return new ValueInt(r.v, flags);
        }
        case Datatype.DInt: {
            const r = disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeInt32Vlq(buf);
            return new ValueDInt(disableVlq ? (r.v | 0) : r.v, flags);
        }
        case Datatype.LInt: {
            const r = disableVlq ? S7p.decodeInt64(buf) : S7p.decodeInt64Vlq(buf);
            return new ValueLInt(r.v, flags);
        }
        case Datatype.Byte: return new ValueByte(buf.readByte() ?? 0, flags);
        case Datatype.Word: {
            const r = S7p.decodeUInt16(buf);
            return new ValueWord(r.v, flags);
        }
        case Datatype.DWord: {
            const r = S7p.decodeUInt32(buf);
            return new ValueDWord(r.v, flags);
        }
        case Datatype.LWord: {
            const r = S7p.decodeUInt64(buf);
            return new ValueLWord(r.v, flags);
        }
        case Datatype.Real: {
            const r = S7p.decodeFloat(buf);
            return new ValueReal(r.v, flags);
        }
        case Datatype.LReal: {
            const r = S7p.decodeDouble(buf);
            return new ValueLReal(r.v, flags);
        }
        case Datatype.Timestamp: {
            const r = S7p.decodeUInt64(buf);
            return new ValueTimestamp(r.v, flags);
        }
        case Datatype.Timespan: {
            const r = disableVlq ? S7p.decodeInt64(buf) : S7p.decodeInt64Vlq(buf);
            return new ValueTimespan(r.v, flags);
        }
        case Datatype.RID: {
            const r = S7p.decodeUInt32(buf);
            return new ValueRID(r.v, flags);
        }
        case Datatype.AID: {
            const r = disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf);
            return new ValueAID(r.v, flags);
        }
        case Datatype.Blob: {
            const len = (disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf)).v;
            const data = buf.readBytes(len);
            return new ValueBlob(0, data || Buffer.alloc(0), flags);
        }
        case Datatype.WString: {
            const len = (disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf)).v;
            const data = buf.readBytes(len);
            return new ValueWString(data ? data.toString('utf8') : '', flags);
        }
        case Datatype.Struct:
            return _deserializeStruct(buf, flags, disableVlq);
        default:
            throw new Error(`Unsupported datatype 0x${datatype.toString(16)}`);
    }
}

function _arrSize(buf, disableVlq) {
    return (disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf)).v;
}

function _deserializeArray(buf, datatype, flags, disableVlq) {
    const len = _arrSize(buf, disableVlq);
    const arr = [];
    switch (datatype) {
        case Datatype.Bool:
            for (let i = 0; i < len; i++) arr.push(!!(buf.readByte() ?? 0));
            break;
        case Datatype.USInt:
        case Datatype.Byte:
            for (let i = 0; i < len; i++) arr.push(buf.readByte() ?? 0);
            return new ValueUSIntArray(arr, flags);
        case Datatype.SInt:
            for (let i = 0; i < len; i++) {
                const b = buf.readByte() ?? 0;
                arr.push(b & 0x80 ? b - 256 : b);
            }
            break;
        case Datatype.UInt:
        case Datatype.Word:
            for (let i = 0; i < len; i++) arr.push(S7p.decodeUInt16(buf).v);
            break;
        case Datatype.Int:
            for (let i = 0; i < len; i++) arr.push(S7p.decodeInt16(buf).v);
            break;
        case Datatype.UDInt:
            for (let i = 0; i < len; i++) arr.push((disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf)).v);
            break;
        case Datatype.DInt:
            for (let i = 0; i < len; i++) arr.push((disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeInt32Vlq(buf)).v);
            break;
        case Datatype.DWord:
        case Datatype.RID:
            for (let i = 0; i < len; i++) arr.push(S7p.decodeUInt32(buf).v);
            break;
        case Datatype.AID:
            for (let i = 0; i < len; i++) arr.push((disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf)).v);
            break;
        case Datatype.ULInt:
            for (let i = 0; i < len; i++) arr.push((disableVlq ? S7p.decodeUInt64(buf) : S7p.decodeUInt64Vlq(buf)).v);
            break;
        case Datatype.LInt:
            for (let i = 0; i < len; i++) arr.push((disableVlq ? S7p.decodeInt64(buf) : S7p.decodeInt64Vlq(buf)).v);
            break;
        case Datatype.LWord:
        case Datatype.Timestamp:
            for (let i = 0; i < len; i++) arr.push(S7p.decodeUInt64(buf).v);
            break;
        case Datatype.Timespan:
            for (let i = 0; i < len; i++) arr.push((disableVlq ? S7p.decodeInt64(buf) : S7p.decodeInt64Vlq(buf)).v);
            break;
        case Datatype.Real:
            for (let i = 0; i < len; i++) arr.push(S7p.decodeFloat(buf).v);
            break;
        case Datatype.LReal:
            for (let i = 0; i < len; i++) arr.push(S7p.decodeDouble(buf).v);
            break;
        case Datatype.Blob:
            for (let i = 0; i < len; i++) {
                const sz = (disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf)).v;
                arr.push(buf.readBytes(sz) || Buffer.alloc(0));
            }
            break;
        case Datatype.WString:
            for (let i = 0; i < len; i++) {
                const sz = (disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf)).v;
                const data = buf.readBytes(sz);
                arr.push(data ? data.toString('utf8') : '');
            }
            break;
        default:
            throw new Error(`Unsupported array datatype 0x${datatype.toString(16)}`);
    }
    return new ValueArray(arr, datatype, flags);
}

function _deserializeSparseArray(buf, datatype, flags, disableVlq) {
    const entries = new Map();
    let key = (disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf)).v;
    while (key > 0) {
        let v;
        switch (datatype) {
            case Datatype.UDInt:
                v = (disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf)).v; break;
            case Datatype.DInt:
                v = (disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeInt32Vlq(buf)).v; break;
            case Datatype.Blob: {
                const sz = (disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf)).v;
                v = buf.readBytes(sz) || Buffer.alloc(0); break;
            }
            case Datatype.WString: {
                const sz = (disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf)).v;
                const data = buf.readBytes(sz);
                v = data ? data.toString('utf8') : ''; break;
            }
            default:
                throw new Error(`Unsupported sparse array datatype 0x${datatype.toString(16)}`);
        }
        entries.set(key, v);
        key = (disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf)).v;
    }
    return new ValueArray([...entries.entries()], datatype, flags);
}

function _deserializeStruct(buf, flags, disableVlq) {
    const id = S7p.decodeUInt32(buf).v;
    const stru = new ValueStruct(id, flags);
    if (isPackedStructId(id)) {
        // Capture the interface timestamp and transport flags so the write
        // path can echo them back unchanged (required by the PLC for DTL).
        stru.packedInterfaceTimestamp = S7p.decodeUInt64(buf).v;
        const tf = disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf);
        stru.packedTransportFlags = tf.v;
        let ec = disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf);
        if (tf.v & (1 << 10)) {
            ec = disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf);
        }
        const barr = Buffer.alloc(ec.v);
        for (let i = 0; i < ec.v; i++) barr[i] = buf.readByte() ?? 0;
        stru.addStructElement(id, new ValueBlob(0, barr));
    } else {
        let key = disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf);
        while (key.v > 0) {
            stru.addStructElement(key.v, deserialize(buf, disableVlq));
            key = disableVlq ? S7p.decodeUInt32(buf) : S7p.decodeUInt32Vlq(buf);
        }
    }
    return stru;
}

function encodeObjectQualifier(buf) {
    let ret = 0;
    const { Ids } = require('./constants');
    ret += S7p.encodeUInt32(buf, Ids.ObjectQualifier);
    ret += S7p.encodeUInt32Vlq(buf, Ids.ParentRID);
    ret += new ValueRID(0).serialize(buf);
    ret += S7p.encodeUInt32Vlq(buf, Ids.CompositionAID);
    ret += new ValueAID(0).serialize(buf);
    ret += S7p.encodeUInt32Vlq(buf, Ids.KeyQualifier);
    ret += new ValueUDInt(0).serialize(buf);
    ret += S7p.encodeByte(buf, 0);
    return ret;
}

function valueFromJs(val, datatypeHint) {
    if (typeof val === 'boolean') return new ValueBool(val);
    if (typeof val === 'number') {
        if (Number.isInteger(val)) {
            if (datatypeHint === 'real' || datatypeHint === 'float') return new ValueReal(val);
            if (val >= -128 && val <= 127 && datatypeHint === 'sint') return new ValueSInt(val);
            if (val >= 0 && val <= 255 && datatypeHint === 'usint') return new ValueUSInt(val);
            if (val >= -32768 && val <= 32767 && datatypeHint === 'int') return new ValueInt(val);
            return new ValueDInt(val);
        }
        return new ValueReal(val);
    }
    if (typeof val === 'string') return new ValueWString(val);
    if (Buffer.isBuffer(val)) return new ValueBlob(0, val);
    throw new Error('Cannot encode value type');
}

module.exports = {
    deserialize,
    encodeObjectQualifier,
    valueFromJs,
    isPackedStructId,
    ValueNull,
    ValueBool,
    ValueUSInt,
    ValueUInt,
    ValueUDInt,
    ValueULInt,
    ValueSInt,
    ValueInt,
    ValueDInt,
    ValueLInt,
    ValueByte,
    ValueWord,
    ValueDWord,
    ValueLWord,
    ValueReal,
    ValueLReal,
    ValueTimestamp,
    ValueTimespan,
    ValueRID,
    ValueAID,
    ValueBlob,
    ValueWString,
    ValueUSIntArray,
    ValueUIntArray,
    ValueUDIntArray,
    ValueArray,
    ValueStruct
};
