'use strict';

/**
 * S7CommPlus CRC32 - used for SymbolCRC in ItemAddress of read/write requests.
 *
 * Polynomial: 0xF4ACFB13 (MSB-first, non-reflected)
 * Init: 0, Final XOR: none
 *
 * Informed by HarpoS7 (https://github.com/bonk-dev/HarpoS7, Copyright (c) 2024 bonk, MIT).
 * Wireshark S7CommPlus dissector used as an additional protocol reference.
 *
 */

const POLY = 0xF4ACFB13;

const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let crc = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
        if (crc & 0x80000000) {
            crc = ((crc << 1) ^ POLY) >>> 0;
        } else {
            crc = (crc << 1) >>> 0;
        }
    }
    TABLE[i] = crc >>> 0;
}

class S7CRC32 {
    constructor() {
        this.state = 0;
    }

    get result() {
        return this.state >>> 0;
    }

    updateByte(b) {
        this.state = (TABLE[(b ^ (this.state >>> 24)) & 0xFF] ^ ((this.state << 8) >>> 0)) >>> 0;
    }

    update(input) {
        // Symbol/member names must be hashed over their UTF-8 byte
        // representation, exactly as the PLC stores and transmits them
        // (PVarnameList uses a byte-length prefix + UTF-8 payload). Using
        // latin1 here would produce a wrong SymbolCRC for any non-ASCII
        // name (e.g. an umlaut "ä" is 0xC3 0xA4 in UTF-8 vs. 0xE4 in
        // latin1), which the PLC rejects with a CRC-mismatch read error.
        const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
        for (let i = 0; i < buf.length; i++) {
            this.updateByte(buf[i]);
        }
        return this;
    }

    updateUInt32LE(value) {
        this.updateByte(value & 0xFF);
        this.updateByte((value >>> 8) & 0xFF);
        this.updateByte((value >>> 16) & 0xFF);
        this.updateByte((value >>> 24) & 0xFF);
        return this;
    }

    reset() {
        this.state = 0;
        return this;
    }
}

module.exports = { S7CRC32, TABLE, POLY };
