'use strict';

const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');
const {
    CotpStream,
    CotpDuplex,
    readExactly,
    disposeReader,
    interruptReader,
    getWord,
    setWord,
    ISO_HEADER_SIZE,
    TPKT_COTP_HEADER
} = require('./cotp-stream');
const { S7Consts } = require('../constants');
const { scoped } = require('../debug');
const log = scoped('transport');

const DEFAULT_PORT_ISO_TCP = 102;
const ISO_CR_PREFIX = Buffer.from([
    0x03, 0x00, 0x00, 0x24, 0x1f, 0xe0, 0x00, 0x00, 0x00, 0x01, 0x00, 0xc0, 0x01, 0x0a,
    0xc1, 0x02, 0x01, 0x00, 0xc2, 0x10
]);

class S7Transport extends EventEmitter {
    constructor() {
        super();
        this._socket = null;
        this._io = null;
        this._cotp = null;
        this._ssl = false;
        this._recvBufs = [];
        this._stopAfterNext = false;
        this._recvRunning = false;
        this._ip = '';
        this._port = DEFAULT_PORT_ISO_TCP;
        this._remoteTsap = null;
        this._connTimeout = 10000;
        this._recvTimeout = 10000;
        this.lastError = 0;
    }

    setConnectionParams(address, _localTsap, remoteTsap, port) {
        this._ip = address;
        this._remoteTsap = Buffer.from(remoteTsap);
        if (port && Number.isFinite(port) && port > 0) this._port = port;
        else this._port = DEFAULT_PORT_ISO_TCP;
        return 0;
    }

    setStopAfterNextPacket() {
        this._stopAfterNext = true;
    }

    setTimeouts(ms) {
        this._connTimeout = ms;
        this._recvTimeout = ms;
    }

    _onPayload(payload) {
        try {
            this.emit('data', payload);
        } catch (_) { /* ignore */ }
        if (this._stopAfterNext) {
            this._stopAfterNext = false;
            this._plainRecv = false;
        }
    }

    _startPlainRecv() {
        if (this._recvRunning) return;
        this._recvRunning = true;
        const loop = async () => {
            let exitReason = null;
            while (this._plainRecv && this._socket && !this._socket.destroyed && !this._ssl) {
                try {
                    // Wait indefinitely for the next packet header.
                    // The recv loop only runs during the brief pre-TLS
                    // CC handshake phase, but even there an idle gap
                    // must not be misread as a failure.
                    const lenBuf = await readExactly(this._io, 4, 0);
                    if (lenBuf[0] !== 0x03) continue;
                    const total = getWord(lenBuf, 2);
                    if (total <= ISO_HEADER_SIZE) continue;
                    // Mid-packet: body must arrive within the configured
                    // recv timeout.
                    const rest = await readExactly(this._io, total - 4, this._recvTimeout);
                    const pdu = Buffer.concat([lenBuf, rest]);
                    const payloadLen = total - ISO_HEADER_SIZE;
                    const payload = pdu.subarray(ISO_HEADER_SIZE, ISO_HEADER_SIZE + payloadLen);
                    this._onPayload(payload);
                } catch (err) {
                    if (err && err.code === 'EREADINTERRUPTED' && !this._plainRecv) {
                        // expected interrupt (e.g. switching to TLS)
                        break;
                    }
                    // Real failure — record reason and surface to client.
                    exitReason = `plain-recv: ${err && err.message ? err.message : err}`;
                    log('plain recv loop terminated', { reason: exitReason });
                    break;
                }
            }
            this._recvRunning = false;
            if (exitReason) {
                try { this.emit('close', { kind: 'plain', reason: exitReason }); } catch { /* ignore */ }
            }
        };
        this._plainRecvDone = loop();
    }

    connect() {
        return new Promise((resolve) => {
            this.lastError = 0;
            if (!this._ip || !this._remoteTsap) {
                this.lastError = S7Consts.errCliInvalidParams;
                return resolve(this.lastError);
            }

            let settled = false;
            const finish = (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(connectTimer);
                this.lastError = code;
                resolve(code);
            };

            log('connect tcp', { host: this._ip, port: this._port, connTimeout: this._connTimeout });
            const sock = net.connect({ host: this._ip, port: this._port });
            sock.setNoDelay(true);
            sock.setKeepAlive(true, 15000);

            const connectTimer = setTimeout(() => {
                log('connect tcp timeout', { host: this._ip, port: this._port });
                try { sock.destroy(); } catch { /* ignore */ }
                finish(S7Consts.errTCPConnectionTimeout);
            }, this._connTimeout);

            sock.once('error', (err) => {
                log('connect tcp error', { msg: err && err.message });
                finish(S7Consts.errTCPConnectionFailed);
            });

            sock.once('connect', async () => {
                clearTimeout(connectTimer);
                log('tcp established', { host: this._ip, port: this._port });
                this._socket = sock;
                this._io = sock;
                this._installSocketWatch(sock, 'plain');
                try {
                    const cr = Buffer.alloc(20 + this._remoteTsap.length);
                    ISO_CR_PREFIX.copy(cr, 0, 0, 20);
                    this._remoteTsap.copy(cr, 20);
                    setWord(cr, 2, 20 + this._remoteTsap.length);
                    cr[4] = 15 + this._remoteTsap.length;
                    cr[19] = this._remoteTsap.length;
                    sock.write(cr);
                    const ccHdr = await readExactly(sock, 4, this._connTimeout);
                    if (!ccHdr || ccHdr[0] !== 0x03) {
                        return finish(S7Consts.errIsoConnect);
                    }
                    const ccTotal = getWord(ccHdr, 2);
                    if (ccTotal < ISO_HEADER_SIZE) {
                        return finish(S7Consts.errIsoConnect);
                    }
                    const ccBody = await readExactly(sock, ccTotal - 4, this._connTimeout);
                    if (!ccBody || ccBody[1] !== 0xd0) {
                        return finish(S7Consts.errIsoConnect);
                    }
                    this._plainRecv = true;
                    this._startPlainRecv();
                    if (!settled) {
                        settled = true;
                        resolve(0);
                    }
                } catch {
                    finish(S7Consts.errIsoConnect);
                }
            });
        });
    }

    async sslActivate() {
        if (!this._socket) {
            this.lastError = S7Consts.errOpenSSL;
            return this.lastError;
        }
        // Stop the plain receive loop cleanly: signal exit and interrupt the
        // pending readExactly so the loop does not race with the upcoming
        // CotpStream._recvLoop (both share the same SocketReader).
        this._plainRecv = false;
        interruptReader(this._socket, 'switching to TLS');
        if (this._plainRecvDone) {
            try { await this._plainRecvDone; } catch { /* ignore */ }
        }

        return new Promise((resolve) => {
            try {
                const cotp = new CotpStream(this._socket, this._recvTimeout);
                this._cotp = cotp;
                const duplex = new CotpDuplex(cotp);
                // tls.connect (NOT new tls.TLSSocket) actually drives the
                // handshake by sending ClientHello on the underlying duplex.
                // S7-1500 only supports TLS 1.3, and the negotiated COTP TPDU
                // size is 1024 bytes - default Node.js offers many key share
                // groups (~1450 byte ClientHello) which the PLC silently drops.
                // Restrict to X25519 so the ClientHello stays around 224 bytes
                // and comfortably fits a single TPKT/COTP frame.
                const secure = tls.connect({
                    socket: duplex,
                    minVersion: 'TLSv1.3',
                    maxVersion: 'TLSv1.3',
                    ecdhCurve: 'X25519',
                    rejectUnauthorized: false
                });
                let settled = false;
                // Hard bound the handshake. Without this, a PLC that
                // accepts the TCP connection but never sends ServerHello
                // (firmware update, half-broken state) would block
                // sslActivate forever.
                const sslTimer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    log('ssl handshake timeout', { timeoutMs: this._connTimeout });
                    this.lastError = S7Consts.errOpenSSL;
                    this._tlsError = new Error(`SSL handshake timeout (${this._connTimeout}ms)`);
                    try { secure.destroy(); } catch { /* ignore */ }
                    resolve(this.lastError);
                }, this._connTimeout);
                secure.once('secureConnect', () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(sslTimer);
                    this._ssl = true;
                    this._tlsSocket = secure;
                    this._io = secure;
                    this._recvRunning = true;
                    secure.on('data', (chunk) => this._onPayload(chunk));
                    this._installSocketWatch(secure, 'tls');
                    resolve(0);
                });
                secure.once('error', (e) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(sslTimer);
                    this.lastError = S7Consts.errOpenSSL;
                    this._tlsError = e;
                    resolve(this.lastError);
                });
            } catch (e) {
                this.lastError = S7Consts.errOpenSSL;
                this._tlsError = e;
                resolve(this.lastError);
            }
        });
    }

    /**
     * Write a packet to the underlying socket. All failure modes throw
     * so the caller learns immediately — a silent "write disappeared"
     * would leave the request waiter sitting around until its read
     * timeout fires, hiding the real cause.
     */
    send(packet) {
        if (!this._io) {
            this.lastError = S7Consts.errTCPNotConnected;
            throw new Error('Send failed: client not connected');
        }
        this.lastError = 0;
        try {
            if (this._ssl) {
                this._tlsSocket.write(packet);
            } else {
                const packetLen = ISO_HEADER_SIZE + packet.length;
                const out = Buffer.alloc(packetLen);
                TPKT_COTP_HEADER.copy(out, 0);
                setWord(out, 2, packetLen);
                packet.copy(out, ISO_HEADER_SIZE);
                this._io.write(out);
            }
        } catch (err) {
            this.lastError = S7Consts.errTCPDataSend;
            throw new Error(`Send failed: ${err && err.message ? err.message : err}`);
        }
    }

    disconnect() {
        if (!this._socket && !this._io && !this._tlsSocket) {
            return 0;
        }
        log('disconnect', { hadSocket: !!this._socket, hadTls: !!this._tlsSocket });
        this._recvRunning = false;
        this._plainRecv = false;
        try {
            if (this._cotp) this._cotp.end();
            if (this._socket) {
                disposeReader(this._socket);
                this._socket.destroy();
            }
        } catch { /* ignore */ }
        this._socket = null;
        this._io = null;
        this._tlsSocket = null;
        this._cotp = null;
        this._ssl = false;
        return 0;
    }

    /**
     * Watch the raw or TLS socket for close/error/end and surface a single
     * 'close' event so the client can flip its `_connected` flag and reject
     * pending PDU waiters instead of hanging until the read timeout fires.
     */
    _installSocketWatch(sock, kind) {
        if (!sock || sock._s7pClosedWatch) return;
        sock._s7pClosedWatch = true;
        const fire = (reason) => {
            if (sock._s7pCloseFired) return;
            sock._s7pCloseFired = true;
            log('socket close-event', { kind, reason });
            try { this.emit('close', { kind, reason }); } catch { /* ignore */ }
        };
        sock.once('close', () => fire('socket-close'));
        sock.once('end', () => fire('socket-end'));
        sock.once('error', (err) => fire(`socket-error: ${err && err.message ? err.message : err}`));
    }

    get connected() {
        return this._socket && !this._socket.destroyed;
    }
}

module.exports = S7Transport;
