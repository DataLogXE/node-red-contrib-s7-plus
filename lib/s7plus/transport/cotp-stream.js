'use strict';

const { EventEmitter } = require('events');
const { Duplex } = require('stream');

const ISO_HEADER_SIZE = 7;
const TPKT_COTP_HEADER = Buffer.from([0x03, 0x00, 0x00, 0x1f, 0x02, 0xf0, 0x80]);
const MAX_PAYLOAD = 16 * 1024;

const READER_KEY = Symbol('s7plus.socketReader');

function getWord(b, pos) {
    return (b[pos] << 8) | b[pos + 1];
}

function setWord(b, pos, value) {
    b[pos] = (value >> 8) & 0xff;
    b[pos + 1] = value & 0xff;
}

/**
 * Persistent buffered reader attached to a socket via a Symbol.
 * Mirrors the synchronous Stream.Read accumulation pattern used in the C# driver
 * and avoids Node's flowing-mode + unshift() data-loss pitfall.
 */
class SocketReader {
    constructor(socket) {
        this.socket = socket;
        this.chunks = [];
        this.totalLen = 0;
        this.waiter = null;
        this.error = null;
        this._onData = (chunk) => {
            this.chunks.push(chunk);
            this.totalLen += chunk.length;
            this._tryResolve();
        };
        this._onErr = (err) => this._fail(err);
        this._onClose = () => this._fail(new Error('Socket closed'));
        socket.on('data', this._onData);
        socket.on('error', this._onErr);
        socket.on('close', this._onClose);
    }

    _tryResolve() {
        if (!this.waiter) return;
        if (this.totalLen < this.waiter.count) return;
        const w = this.waiter;
        this.waiter = null;
        clearTimeout(w.timer);
        w.resolve(this._consume(w.count));
    }

    _consume(count) {
        const out = Buffer.alloc(count);
        let offset = 0;
        while (offset < count) {
            const head = this.chunks[0];
            const take = Math.min(count - offset, head.length);
            head.copy(out, offset, 0, take);
            offset += take;
            this.totalLen -= take;
            if (take === head.length) {
                this.chunks.shift();
            } else {
                this.chunks[0] = head.subarray(take);
            }
        }
        return out;
    }

    _fail(err) {
        if (!this.error) this.error = err;
        const w = this.waiter;
        if (w) {
            this.waiter = null;
            clearTimeout(w.timer);
            w.reject(err);
        }
    }

    /**
     * Read exactly `count` bytes. If `timeoutMs > 0`, reject after that
     * many ms with 'COTP read timeout'. If `timeoutMs <= 0` or not finite,
     * wait indefinitely — used by the recv loop's "wait for next packet"
     * read, where an idle connection MUST NOT be treated as a timeout
     * (otherwise the loop dies silently every `timeoutMs` ms of idle).
     */
    read(count, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (this.error && this.totalLen < count) {
                return reject(this.error);
            }
            if (this.totalLen >= count) {
                return resolve(this._consume(count));
            }
            if (this.waiter) {
                return reject(new Error('SocketReader: concurrent read not supported'));
            }
            let timer = null;
            if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
                timer = setTimeout(() => {
                    if (this.waiter && this.waiter.timer === timer) {
                        this.waiter = null;
                        reject(new Error('COTP read timeout'));
                    }
                }, timeoutMs);
            }
            this.waiter = { count, timer, resolve, reject };
        });
    }

    /**
     * Aborts the currently pending read (if any) without dropping buffered bytes
     * and without marking the reader as failed. The reader can immediately be
     * reused by a new consumer (e.g. when switching from plain to TLS framing).
     */
    interrupt(reason) {
        const w = this.waiter;
        if (w) {
            this.waiter = null;
            clearTimeout(w.timer);
            const err = new Error(reason || 'SocketReader: read interrupted');
            err.code = 'EREADINTERRUPTED';
            w.reject(err);
        }
    }

    dispose() {
        this.socket.removeListener('data', this._onData);
        this.socket.removeListener('error', this._onErr);
        this.socket.removeListener('close', this._onClose);
        const w = this.waiter;
        if (w) {
            this.waiter = null;
            clearTimeout(w.timer);
            w.reject(new Error('SocketReader disposed'));
        }
    }
}

function getReader(socket) {
    let r = socket[READER_KEY];
    if (!r) {
        r = new SocketReader(socket);
        socket[READER_KEY] = r;
    }
    return r;
}

function readExactly(socket, count, timeoutMs) {
    return getReader(socket).read(count, timeoutMs);
}

function disposeReader(socket) {
    const r = socket[READER_KEY];
    if (r) {
        r.dispose();
        delete socket[READER_KEY];
    }
}

function interruptReader(socket, reason) {
    const r = socket[READER_KEY];
    if (r) r.interrupt(reason);
}

/**
 * Framed ISO-on-TCP stream for TLS layer (matches CotpStream.cs).
 */
class CotpStream extends EventEmitter {
    constructor(innerSocket, timeoutMs = 60000) {
        super();
        this._socket = innerSocket;
        this._timeoutMs = timeoutMs;
        this._queue = [];
        this._current = null;
        this._offset = 0;
        this._closed = false;
        this._syncReaderActive = false;
        this._recvLoop();
    }

    async _recvLoop() {
        const lenBuf = Buffer.alloc(4);
        try {
            while (!this._closed && !this._socket.destroyed) {
                // Wait indefinitely for the next packet header. Idle
                // connections are normal — only an actual socket close
                // or error should terminate this loop.
                const h = await readExactly(this._socket, 4, 0);
                h.copy(lenBuf, 0);
                if (lenBuf[0] !== 0x03) continue;
                const packetLen = getWord(lenBuf, 2);
                if (packetLen < ISO_HEADER_SIZE) continue;
                const toRead = packetLen - 4;
                // Mid-packet: once we have the header, the body MUST
                // arrive within timeoutMs. A stalled mid-packet read
                // indicates real trouble.
                const rest = await readExactly(this._socket, toRead, this._timeoutMs);
                const payloadLen = toRead - 3;
                if (payloadLen <= 0) continue;
                const payload = rest.subarray(3, 3 + payloadLen);
                // The 'packet' event is the only active consumer (CotpDuplex
                // for the TLS pipeline). The _queue/_drain/readSync path is
                // dead code in this driver — pushing here without a drainer
                // grows _queue monotonically with every PLC frame and pins
                // every received COTP buffer in the arrayBuffers pool, which
                // eventually freezes Node-RED. Only buffer for readSync if a
                // sync reader has actually subscribed.
                if (this._syncReaderActive) this._queue.push(payload);
                this.emit('packet', payload);
            }
        } catch (_) {
            /* connection ended — _installSocketWatch on the wrapping
               transport surfaces this via a 'close' event */
        } finally {
            this._closed = true;
        }
    }

    _drain(buf, offset, count) {
        let written = 0;
        while (written < count) {
            if (!this._current || this._offset >= this._current.length) {
                if (this._queue.length === 0) return written;
                this._current = this._queue.shift();
                this._offset = 0;
            }
            const avail = this._current.length - this._offset;
            const n = Math.min(avail, count - written);
            this._current.copy(buf, offset + written, this._offset, this._offset + n);
            this._offset += n;
            written += n;
            if (this._offset >= this._current.length) this._current = null;
        }
        return written;
    }

    readSync(buffer, offset, count, waitMs = 30000) {
        // Subscribe to the buffered queue so _recvLoop knows to retain
        // payloads. Without an active sync reader the queue is intentionally
        // not populated to avoid an unbounded retainer.
        this._syncReaderActive = true;
        const n = this._drain(buffer, offset, count);
        if (n === count) {
            if (this._queue.length === 0 && !this._current) this._syncReaderActive = false;
            return n;
        }
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + waitMs;
            const tick = () => {
                const r = this._drain(buffer, offset, count);
                if (r === count) {
                    if (this._queue.length === 0 && !this._current) this._syncReaderActive = false;
                    return resolve(r);
                }
                if (this._closed) {
                    this._syncReaderActive = false;
                    return reject(new Error('COTP stream closed'));
                }
                if (Date.now() > deadline) {
                    this._syncReaderActive = false;
                    return reject(new Error('Timeout waiting for COTP packet'));
                }
                setImmediate(tick);
            };
            this.once('packet', tick);
            tick();
        });
    }

    write(buffer) {
        const packet = Buffer.alloc(ISO_HEADER_SIZE + buffer.length);
        TPKT_COTP_HEADER.copy(packet, 0);
        setWord(packet, 2, ISO_HEADER_SIZE + buffer.length);
        buffer.copy(packet, ISO_HEADER_SIZE);
        this._socket.write(packet);
    }

    end() {
        this._closed = true;
    }
}

/** Duplex adapter so tls.TLSSocket can run over COTP framing. */
class CotpDuplex extends Duplex {
    constructor(cotpStream) {
        super();
        this._cotp = cotpStream;
        this._pending = [];
        cotpStream.on('packet', (p) => {
            this._pending.push(p);
            this._readFromQueue();
        });
    }

    _readFromQueue() {
        while (this._pending.length) {
            const p = this._pending.shift();
            if (!this.push(p)) return;
        }
    }

    _read() {
        this._readFromQueue();
    }

    _write(chunk, _enc, cb) {
        try {
            this._cotp.write(chunk);
            cb();
        } catch (e) {
            cb(e);
        }
    }

    _final(cb) {
        this._cotp.end();
        cb();
    }
}

module.exports = {
    CotpStream,
    CotpDuplex,
    SocketReader,
    readExactly,
    disposeReader,
    interruptReader,
    getWord,
    setWord,
    ISO_HEADER_SIZE,
    TPKT_COTP_HEADER
};
