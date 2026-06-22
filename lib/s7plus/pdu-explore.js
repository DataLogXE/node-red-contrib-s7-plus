'use strict';

const BufferStream = require('./buffer-stream');
const S7p = require('./s7p');
const PObject = require('./pobject');
const { Opcode, Functioncode } = require('./constants');

function writeRequestHeader(buf, req) {
    S7p.encodeByte(buf, Opcode.Request);
    S7p.encodeUInt16(buf, 0);
    S7p.encodeUInt16(buf, req.functionCode);
    S7p.encodeUInt16(buf, 0);
    S7p.encodeUInt16(buf, req.sequenceNumber);
    S7p.encodeUInt32(buf, req.sessionId >>> 0);
    S7p.encodeByte(buf, req.transportFlags);
}

class ExploreRequest {
    constructor(protocolVersion) {
        this.protocolVersion = protocolVersion;
        this.functionCode = Functioncode.Explore;
        this.transportFlags = 0x34;
        this.exploreId = 0;
        this.exploreRequestId = 0;
        this.exploreChildsRecursive = 1;
        this.exploreParents = 0;
        this.filterData = null;
        this.addressList = [];
        this.sessionId = 0;
        this.sequenceNumber = 0;
        this.integrityId = 0;
        this.withIntegrityId = true;
    }

    serialize() {
        const buf = new BufferStream();
        writeRequestHeader(buf, this);
        S7p.encodeUInt32(buf, this.exploreId >>> 0);
        S7p.encodeUInt32Vlq(buf, this.exploreRequestId >>> 0);
        S7p.encodeByte(buf, this.exploreChildsRecursive);
        S7p.encodeByte(buf, 1);
        S7p.encodeByte(buf, this.exploreParents);
        if (this.filterData) {
            S7p.encodeByte(buf, 1);
            this.filterData.serialize(buf);
        }
        S7p.encodeByte(buf, 0);
        S7p.encodeUInt32Vlq(buf, this.addressList.length);
        for (const id of this.addressList) S7p.encodeUInt32Vlq(buf, id >>> 0);
        if (this.withIntegrityId) S7p.encodeUInt32Vlq(buf, this.integrityId >>> 0);
        S7p.encodeUInt32(buf, 0);
        S7p.encodeByte(buf, 0);
        return buf.toBuffer();
    }
}

class ExploreResponse {
    static deserializeFromPdu(pdu, withIntegrityId) {
        const ver = pdu.readByte();
        const op = pdu.readByte();
        if (op !== Opcode.Response) return null;
        S7p.decodeUInt16(pdu);
        const fn = S7p.decodeUInt16(pdu).v;
        S7p.decodeUInt16(pdu);
        if (fn !== Functioncode.Explore) return null;

        const seq = S7p.decodeUInt16(pdu).v;
        pdu.readByte();
        S7p.decodeUInt64Vlq(pdu);
        S7p.decodeUInt32(pdu);
        if (withIntegrityId) S7p.decodeUInt32Vlq(pdu);
        const objects = PObject.decodeObjectList(pdu);
        return { protocolVersion: ver, sequenceNumber: seq, objects };
    }
}

module.exports = { ExploreRequest, ExploreResponse };
