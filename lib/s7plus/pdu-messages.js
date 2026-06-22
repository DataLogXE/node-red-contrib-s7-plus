'use strict';

const BufferStream = require('./buffer-stream');
const S7p = require('./s7p');
const PObject = require('./pobject');
const { encodeObjectQualifier } = require('./pvalue');
const {
    Opcode,
    Functioncode,
    ProtocolVersion,
    Ids,
    Datatype
} = require('./constants');
const ItemAddress = require('./item-address');

function writeRequestHeader(buf, req) {
    let n = 0;
    n += S7p.encodeByte(buf, Opcode.Request);
    n += S7p.encodeUInt16(buf, 0);
    n += S7p.encodeUInt16(buf, req.functionCode);
    n += S7p.encodeUInt16(buf, 0);
    n += S7p.encodeUInt16(buf, req.sequenceNumber);
    n += S7p.encodeUInt32(buf, req.sessionId >>> 0);
    n += S7p.encodeByte(buf, req.transportFlags);
    return n;
}

function parseResponseHeader(pdu) {
    const ver = pdu.readByte();
    const op = pdu.readByte();
    if (op !== Opcode.Response) return null;
    S7p.decodeUInt16(pdu);
    const fn = S7p.decodeUInt16(pdu).v;
    S7p.decodeUInt16(pdu);
    return { protocolVersion: ver, functionCode: fn };
}

class InitSslRequest {
    constructor(protocolVersion, seqNum, sessionId) {
        this.protocolVersion = protocolVersion;
        this.sequenceNumber = seqNum;
        this.sessionId = sessionId;
        this.functionCode = Functioncode.InitSsl;
        this.transportFlags = 0x30;
        this.withIntegrityId = false;
        this.integrityId = 0;
    }
    serialize() {
        const buf = new BufferStream();
        writeRequestHeader(buf, this);
        S7p.encodeUInt32(buf, 0);
        return buf.toBuffer();
    }
}

class InitSslResponse {
    static deserializeFromPdu(pdu) {
        const h = parseResponseHeader(pdu);
        if (!h || h.functionCode !== Functioncode.InitSsl) return null;
        const seq = S7p.decodeUInt16(pdu).v;
        S7p.decodeByte(pdu);
        const rv = S7p.decodeUInt64Vlq(pdu).v;
        return { sequenceNumber: seq, returnValue: rv };
    }
}

class CreateObjectRequest {
    constructor(protocolVersion, seqNum, withIntegrityId) {
        this.protocolVersion = protocolVersion;
        this.sequenceNumber = seqNum;
        this.withIntegrityId = withIntegrityId;
        this.functionCode = Functioncode.CreateObject;
        this.transportFlags = 0x36;
        this.sessionId = 0;
        this.integrityId = 0;
        this.requestId = 0;
        this.requestValue = null;
        this.requestObject = null;
    }
    setNullServerSessionData() {
        const { ValueUDInt, ValueRID } = require('./pvalue');
        this.transportFlags = 0x36;
        this.requestId = Ids.ObjectServerSessionContainer;
        this.requestValue = new ValueUDInt(0);
        const sess = new PObject(Ids.GetNewRIDOnServer, Ids.ClassServerSession, Ids.None);
        sess.addAttribute(Ids.ServerSessionClientRID, new ValueRID(0x80c3c901));
        sess.addObject(new PObject(Ids.GetNewRIDOnServer, Ids.ClassSubscriptions, Ids.None));
        this.requestObject = sess;
    }
    serialize() {
        const buf = new BufferStream();
        writeRequestHeader(buf, this);
        S7p.encodeUInt32(buf, this.requestId >>> 0);
        this.requestValue.serialize(buf);
        S7p.encodeUInt32(buf, 0);
        if (this.withIntegrityId) S7p.encodeUInt32Vlq(buf, this.integrityId >>> 0);
        this.requestObject.serialize(buf);
        S7p.encodeUInt32(buf, 0);
        return buf.toBuffer();
    }
}

class CreateObjectResponse {
    static deserializeFromPdu(pdu) {
        const h = parseResponseHeader(pdu);
        if (!h || h.functionCode !== Functioncode.CreateObject) return null;
        const seq = S7p.decodeUInt16(pdu).v;
        S7p.decodeByte(pdu);
        const returnValue = S7p.decodeUInt64Vlq(pdu).v;
        const idCount = pdu.readByte();
        const objectIds = [];
        for (let i = 0; i < idCount; i++) {
            objectIds.push(S7p.decodeUInt32Vlq(pdu).v);
        }
        const responseObject = PObject.decode(pdu);
        return { sequenceNumber: seq, returnValue, objectIds, responseObject };
    }
}

class SetMultiVariablesRequest {
    constructor(protocolVersion) {
        this.protocolVersion = protocolVersion;
        this.functionCode = Functioncode.SetMultiVariables;
        this.transportFlags = 0x34;
        this.withIntegrityId = true;
        this.inObjectId = 0;
        this.addressList = [];
        this.addressListVar = [];
        this.valueList = [];
        this.sessionId = 0;
        this.sequenceNumber = 0;
        this.integrityId = 0;
    }
    setSessionSetupData(sessionId, sessionVersion) {
        this.sessionId = sessionId;
        this.inObjectId = sessionId;
        this.addressList = [Ids.ServerSessionVersion];
        this.valueList = [sessionVersion];
        this.withIntegrityId = false;
    }
    serialize() {
        const buf = new BufferStream();
        writeRequestHeader(buf, this);
        S7p.encodeUInt32(buf, this.inObjectId >>> 0);
        S7p.encodeUInt32Vlq(buf, this.valueList.length);
        if (this.inObjectId > 0) {
            S7p.encodeUInt32Vlq(buf, this.addressList.length);
            for (const id of this.addressList) S7p.encodeUInt32Vlq(buf, id >>> 0);
        } else {
            let fieldCount = 0;
            for (const adr of this.addressListVar) fieldCount += adr.getNumberOfFields();
            S7p.encodeUInt32Vlq(buf, fieldCount);
            for (const adr of this.addressListVar) adr.serialize(buf);
        }
        let i = 1;
        for (const val of this.valueList) {
            S7p.encodeUInt32Vlq(buf, i++);
            val.serialize(buf);
        }
        S7p.encodeByte(buf, 0);
        encodeObjectQualifier(buf);
        if (this.withIntegrityId) S7p.encodeUInt32Vlq(buf, this.integrityId >>> 0);
        S7p.encodeUInt32(buf, 0);
        return buf.toBuffer();
    }
}

class SetMultiVariablesResponse {
    static deserializeFromPdu(pdu) {
        const h = parseResponseHeader(pdu);
        if (!h || h.functionCode !== Functioncode.SetMultiVariables) return null;
        const seq = S7p.decodeUInt16(pdu).v;
        S7p.decodeByte(pdu);
        const returnValue = S7p.decodeUInt64Vlq(pdu).v;
        let itemnr = S7p.decodeUInt32Vlq(pdu).v;
        const errorValues = new Map();
        while (itemnr > 0) {
            const rv = S7p.decodeUInt64Vlq(pdu).v;
            errorValues.set(itemnr, rv);
            itemnr = S7p.decodeUInt32Vlq(pdu).v;
        }
        const integrityId = S7p.decodeUInt32Vlq(pdu).v;
        return { sequenceNumber: seq, returnValue, errorValues, integrityId };
    }
}

class GetMultiVariablesRequest {
    constructor(protocolVersion) {
        this.protocolVersion = protocolVersion;
        this.functionCode = Functioncode.GetMultiVariables;
        this.transportFlags = 0x34;
        this.linkId = 0;
        this.addressList = [];
        this.withIntegrityId = true;
        this.sessionId = 0;
        this.sequenceNumber = 0;
        this.integrityId = 0;
    }
    serialize() {
        const buf = new BufferStream();
        writeRequestHeader(buf, this);
        S7p.encodeUInt32(buf, this.linkId >>> 0);
        S7p.encodeUInt32Vlq(buf, this.addressList.length);
        let fieldCount = 0;
        for (const adr of this.addressList) fieldCount += adr.getNumberOfFields();
        S7p.encodeUInt32Vlq(buf, fieldCount);
        for (const adr of this.addressList) adr.serialize(buf);
        encodeObjectQualifier(buf);
        if (this.withIntegrityId) S7p.encodeUInt32Vlq(buf, this.integrityId >>> 0);
        S7p.encodeUInt32(buf, 0);
        return buf.toBuffer();
    }
}

class GetMultiVariablesResponse {
    static deserializeFromPdu(pdu) {
        const h = parseResponseHeader(pdu);
        if (!h || h.functionCode !== Functioncode.GetMultiVariables) return null;
        const pvalue = require('./pvalue');
        const seq = S7p.decodeUInt16(pdu).v;
        S7p.decodeByte(pdu);
        const returnValue = S7p.decodeUInt64Vlq(pdu).v;
        const values = new Map();
        let itemnr = S7p.decodeUInt32Vlq(pdu).v;
        while (itemnr > 0) {
            values.set(itemnr, pvalue.deserialize(pdu));
            itemnr = S7p.decodeUInt32Vlq(pdu).v;
        }
        const errorValues = new Map();
        itemnr = S7p.decodeUInt32Vlq(pdu).v;
        while (itemnr > 0) {
            const rv = S7p.decodeUInt64Vlq(pdu).v;
            errorValues.set(itemnr, rv);
            itemnr = S7p.decodeUInt32Vlq(pdu).v;
        }
        const integrityId = S7p.decodeUInt32Vlq(pdu).v;
        return { sequenceNumber: seq, returnValue, values, errorValues, integrityId };
    }
}

class DeleteObjectRequest {
    constructor(protocolVersion) {
        this.protocolVersion = protocolVersion;
        this.functionCode = Functioncode.DeleteObject;
        this.transportFlags = 0x34;
        this.deleteObjectId = 0;
        this.withIntegrityId = true;
        this.sessionId = 0;
        this.sequenceNumber = 0;
        this.integrityId = 0;
    }
    serialize() {
        const buf = new BufferStream();
        writeRequestHeader(buf, this);
        S7p.encodeUInt32(buf, this.deleteObjectId >>> 0);
        if (this.withIntegrityId) S7p.encodeUInt32Vlq(buf, this.integrityId >>> 0);
        S7p.encodeUInt32(buf, 0);
        return buf.toBuffer();
    }
}

class GetVarSubstreamedRequest {
    constructor(protocolVersion) {
        this.protocolVersion = protocolVersion;
        this.functionCode = Functioncode.GetVarSubStreamed;
        this.transportFlags = 0x34;
        this.inObjectId = 0;
        this.address = 0;
        this.withIntegrityId = true;
        this.sessionId = 0;
        this.sequenceNumber = 0;
        this.integrityId = 0;
    }
    serialize() {
        const buf = new BufferStream();
        writeRequestHeader(buf, this);
        S7p.encodeUInt32(buf, this.inObjectId >>> 0);
        S7p.encodeByte(buf, 0x20);
        S7p.encodeByte(buf, Datatype.UDInt);
        S7p.encodeByte(buf, 1);
        S7p.encodeUInt32Vlq(buf, this.address >>> 0);
        encodeObjectQualifier(buf);
        S7p.encodeUInt16(buf, 0x0001);
        if (this.withIntegrityId) S7p.encodeUInt32Vlq(buf, this.integrityId >>> 0);
        S7p.encodeUInt32(buf, 0);
        return buf.toBuffer();
    }
}

class GetVarSubstreamedResponse {
    static deserializeFromPdu(pdu) {
        const h = parseResponseHeader(pdu);
        if (!h || h.functionCode !== Functioncode.GetVarSubStreamed) return null;
        const pvalue = require('./pvalue');
        const seq = S7p.decodeUInt16(pdu).v;
        S7p.decodeByte(pdu);
        const returnValue = S7p.decodeUInt64Vlq(pdu).v;
        const value = pvalue.deserialize(pdu);
        const integrityId = S7p.decodeUInt32Vlq(pdu).v;
        return { sequenceNumber: seq, returnValue, value, integrityId };
    }
}

class SetVariableRequest {
    constructor(protocolVersion) {
        this.protocolVersion = protocolVersion;
        this.functionCode = Functioncode.SetVariable;
        this.transportFlags = 0x34;
        this.inObjectId = 0;
        this.address = 0;
        this.value = null;
        this.withIntegrityId = true;
        this.sessionId = 0;
        this.sequenceNumber = 0;
        this.integrityId = 0;
    }
    serialize() {
        const buf = new BufferStream();
        writeRequestHeader(buf, this);
        S7p.encodeUInt32(buf, this.inObjectId >>> 0);
        S7p.encodeByte(buf, 0x20);
        S7p.encodeByte(buf, Datatype.UDInt);
        S7p.encodeByte(buf, 1);
        S7p.encodeUInt32Vlq(buf, this.address >>> 0);
        this.value.serialize(buf);
        encodeObjectQualifier(buf);
        S7p.encodeUInt16(buf, 0x0001);
        if (this.withIntegrityId) S7p.encodeUInt32Vlq(buf, this.integrityId >>> 0);
        S7p.encodeUInt32(buf, 0);
        return buf.toBuffer();
    }
}

class SetVariableResponse {
    static deserializeFromPdu(pdu) {
        const h = parseResponseHeader(pdu);
        if (!h || h.functionCode !== Functioncode.SetVariable) return null;
        const seq = S7p.decodeUInt16(pdu).v;
        S7p.decodeByte(pdu);
        const returnValue = S7p.decodeUInt64Vlq(pdu).v;
        return { sequenceNumber: seq, returnValue };
    }
}

module.exports = {
    InitSslRequest,
    InitSslResponse,
    CreateObjectRequest,
    CreateObjectResponse,
    SetMultiVariablesRequest,
    SetMultiVariablesResponse,
    GetMultiVariablesRequest,
    GetMultiVariablesResponse,
    DeleteObjectRequest,
    GetVarSubstreamedRequest,
    GetVarSubstreamedResponse,
    SetVariableRequest,
    SetVariableResponse
};
