'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const BufferStream = require('../lib/s7plus/buffer-stream');
const { DeleteObjectRequest, DeleteObjectResponse } = require('../lib/s7plus/pdu-messages');
const { encodeObjectQualifier } = require('../lib/s7plus/pvalue');
const { ProtocolVersion } = require('../lib/s7plus/constants');

function qualifierBytes() {
    const buf = new BufferStream();
    encodeObjectQualifier(buf);
    return buf.toBuffer();
}

describe('DeleteObjectRequest', () => {
    it('serializes id, 0x00, object qualifier, integrity id, fill (reference layout)', () => {
        const req = new DeleteObjectRequest(ProtocolVersion.V2);
        req.deleteObjectId = 0x70000e4e;
        req.sessionId = 0x70000e4c;
        req.sequenceNumber = 0x10;
        req.integrityId = 5;
        const out = req.serialize();
        const header = Buffer.from('31000004d40000001070000e4c34', 'hex');
        const expected = Buffer.concat([
            header,
            Buffer.from('70000e4e', 'hex'),
            Buffer.from([0x00]),
            qualifierBytes(),
            Buffer.from([0x05]),
            Buffer.alloc(4)
        ]);
        assert.deepEqual(out, expected);
    });

    it('omits the integrity id when withIntegrityId is false (session delete)', () => {
        const req = new DeleteObjectRequest(ProtocolVersion.V2);
        req.deleteObjectId = 0x70000e4c;
        req.withIntegrityId = false;
        const out = req.serialize();
        const tail = Buffer.concat([Buffer.from('70000e4c00', 'hex'), qualifierBytes(), Buffer.alloc(4)]);
        assert.deepEqual(out.subarray(out.length - tail.length), tail);
    });
});

describe('DeleteObjectResponse', () => {
    it('decodes a successful response (live capture, S7-1500 FW V4.1)', () => {
        const pdu = new BufferStream(Buffer.from('0232000004d400000015340070000e4e1900000000', 'hex'));
        const res = DeleteObjectResponse.deserializeFromPdu(pdu);
        assert.equal(res.sequenceNumber, 0x15);
        assert.equal(BigInt(res.returnValue), 0n);
        assert.equal(res.deleteObjectId, 0x70000e4e);
    });

    it('decodes an error return value (live capture: object not found)', () => {
        const pdu = new BufferStream(Buffer.from('0232000004d40000001a34c08895b080e6b5fff470000e4e2000000000', 'hex'));
        const res = DeleteObjectResponse.deserializeFromPdu(pdu);
        assert.notEqual(BigInt(res.returnValue), 0n);
        assert.equal(res.deleteObjectId, 0x70000e4e);
    });

    it('returns null for a response of another function', () => {
        const pdu = new BufferStream(Buffer.from('0232000004f20000001634001600000000', 'hex'));
        assert.equal(DeleteObjectResponse.deserializeFromPdu(pdu), null);
    });
});
