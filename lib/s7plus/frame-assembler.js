'use strict';

/**
 * Streaming reassembler for S7CommPlus wire frames.
 *
 * Wire format (both directions, inside the TLS stream and inside plain
 * COTP payloads):
 *
 *   0x72 <protoVersion> <lenHi> <lenLo> <data ...>
 *
 * A logical PDU may span several such fragments; it is terminated by a
 * zero-length frame (`0x72 <protoVersion> 0x00 0x00`).
 *
 * The previous receive logic assumed "one data chunk == exactly one
 * frame (+ trailing end marker)". That holds for plain COTP delivery,
 * but after the TLS upgrade the transport emits raw decrypted stream
 * chunks with arbitrary boundaries: two frames can arrive coalesced in
 * one chunk, or one frame can be split across chunks. Under load (fast
 * subscription cycles, large explores) this corrupted the reassembly
 * state and produced garbage PDUs — which in turn triggered unbounded
 * synchronous decode loops that froze the whole Node-RED event loop.
 *
 * This assembler treats the input as a byte stream:
 *   - any number of frames per push() call,
 *   - frames split at any byte position across push() calls,
 *   - resynchronisation to the next 0x72 byte if the stream ever
 *     desyncs (dropping the corrupt partial PDU instead of gluing
 *     unrelated bytes together),
 *   - a hard cap on the accumulated PDU size.
 *
 * The completed PDU layout matches what `_dispatchPdu` expects:
 * [protoVersion, ...data-of-all-fragments].
 */

const DEFAULT_MAX_PDU_BYTES = 16 * 1024 * 1024;
const SYNC_BYTE = 0x72;

class FrameAssembler {
    /**
     * @param {object} opts
     * @param {(pdu: Buffer) => void} opts.onPdu - complete-PDU callback
     * @param {number} [opts.systemEventVersion] - protoVersion byte that
     *        marks a system event frame; such frames are consumed and
     *        discarded (they also invalidate a partial PDU, mirroring
     *        the previous receive logic)
     * @param {number} [opts.maxPduBytes] - hard cap for one logical PDU
     * @param {(msg: string, data?: object) => void} [opts.log]
     */
    constructor(opts) {
        this._onPdu = opts.onPdu;
        this._systemEventVersion = opts.systemEventVersion;
        this._maxPduBytes = opts.maxPduBytes > 0 ? opts.maxPduBytes : DEFAULT_MAX_PDU_BYTES;
        this._log = opts.log || (() => {});
        /** @type {Buffer|null} unparsed leftover bytes */
        this._buf = null;
        /** @type {Buffer[]|null} fragments of the PDU being assembled */
        this._fragments = null;
        this._pduBytes = 0;
        /** Total bytes skipped by resync since construction (diagnostics). */
        this.resyncSkippedBytes = 0;
        /** Number of oversized PDUs dropped since construction. */
        this.oversizedDropped = 0;
    }

    /** True while a partial frame or partial PDU is buffered. */
    get hasPartial() {
        return !!(this._fragments || (this._buf && this._buf.length));
    }

    /** Drop all buffered state (new connection, teardown, ...). */
    reset() {
        this._buf = null;
        this._fragments = null;
        this._pduBytes = 0;
    }

    _dropPartialPdu() {
        this._fragments = null;
        this._pduBytes = 0;
    }

    /**
     * Feed one received chunk. Dispatches zero or more complete PDUs.
     * @param {Buffer} chunk
     */
    push(chunk) {
        if (!chunk || chunk.length === 0) return;
        const buf = (this._buf && this._buf.length)
            ? Buffer.concat([this._buf, chunk])
            : chunk;
        let pos = 0;

        for (;;) {
            // Resynchronise: skip to the next possible frame start. Lost
            // sync also invalidates whatever partial PDU was in flight —
            // gluing fragments across a gap would produce a corrupt PDU.
            if (pos < buf.length && buf[pos] !== SYNC_BYTE) {
                const idx = buf.indexOf(SYNC_BYTE, pos);
                const skipped = (idx === -1 ? buf.length : idx) - pos;
                this.resyncSkippedBytes += skipped;
                this._log('frame resync: skipping garbage bytes', { skipped, hadPartialPdu: !!this._fragments });
                this._dropPartialPdu();
                if (idx === -1) {
                    pos = buf.length;
                    break;
                }
                pos = idx;
            }

            if (buf.length - pos < 4) break; // incomplete header — wait

            const protoVersion = buf[pos + 1];
            const dataLen = (buf[pos + 2] << 8) | buf[pos + 3];

            if (dataLen === 0) {
                // End-of-PDU marker.
                pos += 4;
                if (this._fragments) {
                    const complete = Buffer.concat(this._fragments);
                    this._dropPartialPdu();
                    this._onPdu(complete);
                }
                // A stray end marker without a pending PDU is ignored.
                continue;
            }

            if (buf.length - pos < 4 + dataLen) break; // incomplete body — wait

            const data = buf.subarray(pos + 4, pos + 4 + dataLen);
            pos += 4 + dataLen;

            if (this._systemEventVersion !== undefined && protoVersion === this._systemEventVersion) {
                // System event frames carry no user data we consume; they
                // also invalidate a partial PDU (mirrors previous logic).
                this._dropPartialPdu();
                continue;
            }

            if (!this._fragments) {
                this._fragments = [Buffer.from([protoVersion])];
                this._pduBytes = 1;
            }
            this._fragments.push(data);
            this._pduBytes += dataLen;

            if (this._pduBytes > this._maxPduBytes) {
                this.oversizedDropped++;
                this._log('oversized PDU dropped', { bytes: this._pduBytes, maxPduBytes: this._maxPduBytes });
                this._dropPartialPdu();
            }
        }

        // Keep the unparsed tail. Copy it so we do not pin the (possibly
        // large) concatenated buffer via a subarray view.
        this._buf = pos >= buf.length ? null : Buffer.from(buf.subarray(pos));
    }
}

module.exports = { FrameAssembler, DEFAULT_MAX_PDU_BYTES };
