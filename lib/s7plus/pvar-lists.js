'use strict';

const S7p = require('./s7p');

const TAGDESCR_ATTRIBUTE2_OFFSETINFOTYPE = 0xf000;
const OFFSETINFOTYPE_FB_ARRAY = 0;
const OFFSETINFOTYPE_STRUCTELEM_STD = 1;
const OFFSETINFOTYPE_STD = 8;
const OFFSETINFOTYPE_STRING = 9;
const OFFSETINFOTYPE_ARRAY1DIM = 10;
const OFFSETINFOTYPE_ARRAYMDIM = 11;
const OFFSETINFOTYPE_STRUCT = 12;
const OFFSETINFOTYPE_STRUCT1DIM = 13;
const OFFSETINFOTYPE_STRUCTMDIM = 14;
const OFFSETINFOTYPE_FBSFB = 15;

class POffsetInfoType {
    constructor() {
        this.optimizedAddress = 0;
        this.nonoptimizedAddress = 0;
    }
    hasRelation() { return false; }
    is1Dim() { return false; }
    isMDim() { return false; }
    getRelationId() { return 0; }
    getArrayLowerBounds() { return 0; }
    getArrayElementCount() { return 0; }
    getMdimArrayLowerBounds() { return [0, 0, 0, 0, 0, 0]; }
    getMdimArrayElementCount() { return [0, 0, 0, 0, 0, 0]; }

    static deserialize(buf, offsetinfotype) {
        switch (offsetinfotype) {
            case OFFSETINFOTYPE_FB_ARRAY:
                return POffsetInfoTypeFbArray.deserialize(buf);
            case OFFSETINFOTYPE_STRUCTELEM_STD:
            case OFFSETINFOTYPE_STD:
                return POffsetInfoTypeStd.deserialize(buf, offsetinfotype);
            case 2: // StructElemString
            case OFFSETINFOTYPE_STRING:
                return POffsetInfoTypeString.deserialize(buf);
            case 3:
            case OFFSETINFOTYPE_ARRAY1DIM:
                return POffsetInfoTypeArray1Dim.deserialize(buf);
            case 4:
            case OFFSETINFOTYPE_ARRAYMDIM:
                return POffsetInfoTypeArrayMDim.deserialize(buf);
            case 5:
            case OFFSETINFOTYPE_STRUCT:
                return POffsetInfoTypeStruct.deserialize(buf);
            case 6:
            case OFFSETINFOTYPE_STRUCT1DIM:
                return POffsetInfoTypeStruct1Dim.deserialize(buf);
            case 7:
            case OFFSETINFOTYPE_STRUCTMDIM:
                return POffsetInfoTypeStructMDim.deserialize(buf);
            case OFFSETINFOTYPE_FBSFB:
                return POffsetInfoTypeFbSfb.deserialize(buf);
            default:
                return { oi: new POffsetInfoType(), n: 0 };
        }
    }
}

class POffsetInfoTypeStd extends POffsetInfoType {
    static deserialize(buf, offsetinfotype) {
        const oi = new POffsetInfoTypeStd();
        let r;
        if (offsetinfotype === OFFSETINFOTYPE_STD) {
            r = S7p.decodeUInt16LE(buf);
            oi.optimizedAddress = r.v;
            r = S7p.decodeUInt16LE(buf);
            oi.nonoptimizedAddress = r.v;
        } else {
            r = S7p.decodeUInt16LE(buf);
            oi.nonoptimizedAddress = r.v;
            r = S7p.decodeUInt16LE(buf);
            oi.optimizedAddress = r.v;
        }
        return { oi, n: r.n + (offsetinfotype === OFFSETINFOTYPE_STD ? 2 : 2) };
    }
}

class POffsetInfoTypeString extends POffsetInfoType {
    static deserialize(buf) {
        const oi = new POffsetInfoTypeString();
        let n = 0;
        let r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.optimizedAddress = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.nonoptimizedAddress = r.v; n += r.n;
        return { oi, n };
    }
}

class POffsetInfoTypeArray1Dim extends POffsetInfoType {
    static deserialize(buf) {
        const oi = new POffsetInfoTypeArray1Dim();
        let n = 0;
        let r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.optimizedAddress = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.nonoptimizedAddress = r.v; n += r.n;
        r = S7p.decodeInt32LE(buf); oi.arrayLowerBounds = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.arrayElementCount = r.v; n += r.n;
        oi.is1Dim = () => true;
        oi.getArrayLowerBounds = () => oi.arrayLowerBounds;
        oi.getArrayElementCount = () => oi.arrayElementCount;
        return { oi, n };
    }
}

class POffsetInfoTypeArrayMDim extends POffsetInfoType {
    static deserialize(buf) {
        const oi = new POffsetInfoTypeArrayMDim();
        let n = 0;
        let r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.optimizedAddress = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.nonoptimizedAddress = r.v; n += r.n;
        r = S7p.decodeInt32LE(buf); oi.arrayLowerBounds = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.arrayElementCount = r.v; n += r.n;
        oi.mdimArrayLowerBounds = [];
        oi.mdimArrayElementCount = [];
        for (let d = 0; d < 6; d++) {
            r = S7p.decodeInt32LE(buf); oi.mdimArrayLowerBounds[d] = r.v; n += r.n;
        }
        for (let d = 0; d < 6; d++) {
            r = S7p.decodeUInt32LE(buf); oi.mdimArrayElementCount[d] = r.v; n += r.n;
        }
        oi.isMDim = () => true;
        oi.getArrayLowerBounds = () => oi.arrayLowerBounds;
        oi.getArrayElementCount = () => oi.arrayElementCount;
        oi.getMdimArrayLowerBounds = () => oi.mdimArrayLowerBounds;
        oi.getMdimArrayElementCount = () => oi.mdimArrayElementCount;
        return { oi, n };
    }
}

class POffsetInfoTypeStruct extends POffsetInfoType {
    static deserialize(buf) {
        const oi = new POffsetInfoTypeStruct();
        let n = 0;
        let r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.optimizedAddress = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.nonoptimizedAddress = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.relationId = r.v; n += r.n;
        for (let i = 0; i < 4; i++) { r = S7p.decodeUInt32LE(buf); n += r.n; }
        oi.hasRelation = () => true;
        oi.getRelationId = () => oi.relationId;
        return { oi, n };
    }
}

class POffsetInfoTypeStruct1Dim extends POffsetInfoType {
    static deserialize(buf) {
        const oi = new POffsetInfoTypeStruct1Dim();
        let n = 0;
        let r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.optimizedAddress = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.nonoptimizedAddress = r.v; n += r.n;
        r = S7p.decodeInt32LE(buf); oi.arrayLowerBounds = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.arrayElementCount = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); n += r.n;
        r = S7p.decodeUInt32LE(buf); n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.relationId = r.v; n += r.n;
        for (let i = 0; i < 4; i++) { r = S7p.decodeUInt32LE(buf); n += r.n; }
        oi.is1Dim = () => true;
        oi.hasRelation = () => true;
        oi.getRelationId = () => oi.relationId;
        oi.getArrayLowerBounds = () => oi.arrayLowerBounds;
        oi.getArrayElementCount = () => oi.arrayElementCount;
        return { oi, n };
    }
}

class POffsetInfoTypeStructMDim extends POffsetInfoType {
    static deserialize(buf) {
        const oi = new POffsetInfoTypeStructMDim();
        let n = 0;
        let r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.optimizedAddress = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.nonoptimizedAddress = r.v; n += r.n;
        r = S7p.decodeInt32LE(buf); oi.arrayLowerBounds = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.arrayElementCount = r.v; n += r.n;
        oi.mdimArrayLowerBounds = [];
        oi.mdimArrayElementCount = [];
        for (let d = 0; d < 6; d++) {
            r = S7p.decodeInt32LE(buf); oi.mdimArrayLowerBounds[d] = r.v; n += r.n;
        }
        for (let d = 0; d < 6; d++) {
            r = S7p.decodeUInt32LE(buf); oi.mdimArrayElementCount[d] = r.v; n += r.n;
        }
        r = S7p.decodeUInt32LE(buf); n += r.n;
        r = S7p.decodeUInt32LE(buf); n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.relationId = r.v; n += r.n;
        for (let i = 0; i < 4; i++) { r = S7p.decodeUInt32LE(buf); n += r.n; }
        oi.isMDim = () => true;
        oi.hasRelation = () => true;
        oi.getRelationId = () => oi.relationId;
        oi.getArrayLowerBounds = () => oi.arrayLowerBounds;
        oi.getArrayElementCount = () => oi.arrayElementCount;
        oi.getMdimArrayLowerBounds = () => oi.mdimArrayLowerBounds;
        oi.getMdimArrayElementCount = () => oi.mdimArrayElementCount;
        return { oi, n };
    }
}

class POffsetInfoTypeFbSfb extends POffsetInfoType {
    static deserialize(buf) {
        const oi = new POffsetInfoTypeFbSfb();
        let n = 0;
        let r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.optimizedAddress = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.nonoptimizedAddress = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.relationId = r.v; n += r.n;
        for (let i = 0; i < 6; i++) { r = S7p.decodeUInt32LE(buf); n += r.n; }
        oi.hasRelation = () => true;
        oi.getRelationId = () => oi.relationId;
        return { oi, n };
    }
}

class POffsetInfoTypeFbArray extends POffsetInfoType {
    static deserialize(buf) {
        const oi = new POffsetInfoTypeFbArray();
        let n = 0;
        let r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt16LE(buf); n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.optimizedAddress = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.nonoptimizedAddress = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); oi.relationId = r.v; n += r.n;
        for (let i = 0; i < 10; i++) { r = S7p.decodeUInt32LE(buf); n += r.n; }
        for (let d = 0; d < 6; d++) { r = S7p.decodeInt32LE(buf); n += r.n; }
        for (let d = 0; d < 6; d++) { r = S7p.decodeUInt32LE(buf); n += r.n; }
        oi.hasRelation = () => true;
        oi.getRelationId = () => oi.relationId;
        return { oi, n };
    }
}

class PVartypeListElement {
    constructor() {
        this.lid = 0;
        this.symbolCrc = 0;
        this.softdatatype = 0;
        this.attributeFlags = 0;
        this.bitoffsetinfoFlags = 0;
        this.offsetInfoType = new POffsetInfoType();
    }

    deserialize(buf) {
        let n = 0;
        let r = S7p.decodeUInt32LE(buf); this.lid = r.v; n += r.n;
        r = S7p.decodeUInt32LE(buf); this.symbolCrc = r.v; n += r.n;
        r = S7p.decodeByte(buf); this.softdatatype = r.v; n += r.n;
        r = S7p.decodeUInt16(buf); this.attributeFlags = r.v; n += r.n;
        const offsetinfotype = (this.attributeFlags & TAGDESCR_ATTRIBUTE2_OFFSETINFOTYPE) >> 12;
        r = S7p.decodeByte(buf); this.bitoffsetinfoFlags = r.v; n += r.n;
        const des = POffsetInfoType.deserialize(buf, offsetinfotype);
        this.offsetInfoType = des.oi;
        n += des.n;
        return n;
    }
}

class PVartypeList {
    constructor() {
        this.elements = [];
        this.firstId = 0;
    }

    deserialize(buf) {
        let n = 0;
        let r = S7p.decodeUInt16(buf);
        let blocklen = r.v;
        n += r.n;
        let maxret = n + blocklen;
        r = S7p.decodeUInt32LE(buf);
        this.firstId = r.v;
        n += r.n;
        while (blocklen > 0) {
            do {
                // Stall guard: on a truncated/corrupt buffer every decode
                // returns 0 consumed bytes and `n` never reaches `maxret`,
                // which would spin this loop forever — synchronously on
                // the event loop. Abort instead.
                const before = buf.position;
                const elem = new PVartypeListElement();
                n += elem.deserialize(buf);
                this.elements.push(elem);
                if (buf.position <= before) {
                    throw new Error('decode stalled in vartype list (truncated or corrupt buffer)');
                }
            } while (n < maxret);
            r = S7p.decodeUInt16(buf);
            blocklen = r.v;
            n += r.n;
            maxret = n + blocklen;
        }
        return n;
    }
}

class PVarnameList {
    constructor() {
        this.names = [];
    }

    deserialize(buf) {
        let n = 0;
        let r = S7p.decodeUInt16(buf);
        let blocklen = r.v;
        n += r.n;
        let maxret = n + blocklen;
        while (blocklen > 0) {
            do {
                // Same stall guard as PVartypeList: never spin without
                // consuming bytes.
                const before = buf.position;
                r = S7p.decodeByte(buf);
                const namelen = r.v;
                n += r.n;
                r = S7p.decodeWString(buf, namelen);
                this.names.push(r.v);
                n += r.n;
                r = S7p.decodeByte(buf);
                n += r.n;
                if (buf.position <= before) {
                    throw new Error('decode stalled in varname list (truncated or corrupt buffer)');
                }
            } while (n < maxret);
            r = S7p.decodeUInt16(buf);
            blocklen = r.v;
            n += r.n;
            maxret = n + blocklen;
        }
        return n;
    }
}

module.exports = {
    PVartypeList,
    PVartypeListElement,
    PVarnameList,
    POffsetInfoType
};
