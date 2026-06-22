'use strict';

/**
 * Growable buffer with read/write cursor (Stream-like API for S7p codec).
 */
class BufferStream {
    constructor(initial) {
        if (Buffer.isBuffer(initial)) {
            this._buf = initial;
            this._pos = 0;
        } else {
            const size = typeof initial === 'number' ? initial : 256;
            this._buf = Buffer.alloc(size);
            this._pos = 0;
        }
    }

    get position() {
        return this._pos;
    }

    set position(p) {
        this._pos = p;
    }

    get length() {
        return this._buf.length;
    }

    remaining() {
        return this._buf.length - this._pos;
    }

    toBuffer() {
        return this._buf.subarray(0, this._pos);
    }

    reset() {
        this._pos = 0;
    }

    ensure(extra) {
        const need = this._pos + extra;
        if (need <= this._buf.length) return;
        let cap = this._buf.length;
        while (cap < need) cap *= 2;
        const nb = Buffer.alloc(cap);
        this._buf.copy(nb, 0, 0, this._pos);
        this._buf = nb;
    }

    writeByte(v) {
        this.ensure(1);
        this._buf[this._pos++] = v & 0xff;
        return 1;
    }

    readByte() {
        if (this._pos >= this._buf.length) return null;
        return this._buf[this._pos++];
    }

    writeBytes(buf, off = 0, len = buf.length) {
        this.ensure(len);
        buf.copy(this._buf, this._pos, off, off + len);
        this._pos += len;
        return len;
    }

    readBytes(len) {
        if (this._pos + len > this._buf.length) return null;
        const s = this._buf.subarray(this._pos, this._pos + len);
        this._pos += len;
        return s;
    }

    writeBuffer(other) {
        const b = other instanceof BufferStream ? other.toBuffer() : other;
        return this.writeBytes(b);
    }

    /** Set logical length (truncate view). */
    setLength(len) {
        if (len > this._buf.length) this.ensure(len - this._buf.length);
        this._pos = Math.max(this._pos, len);
        if (len < this._pos) this._pos = len;
        this._len = len;
    }

    sliceView() {
        const end = this._len !== undefined ? this._len : this._pos;
        return this._buf.subarray(0, end);
    }
}

module.exports = BufferStream;
