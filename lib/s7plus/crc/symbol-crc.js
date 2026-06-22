'use strict';

/**
 * Compute the ItemAddress SymbolCRC for S7CommPlus read/write requests.
 *
 * The CRC identifies a symbol path so the PLC can verify the client
 * is accessing the intended symbol even if LIDs have shifted after
 * a program download.
 *
 * Algorithm (verified against S7-1500 FW):
 *   1. innerCrc = CRC(memberName + typeInfo)
 *   2. result   = new CRC().updateUInt32LE(innerCrc)
 *
 * TypeInfo encoding (appended to member name):
 *   - Simple types: 1 byte TypeCode
 *   - Arrays:       0x10 + elementTypeCode(1) + lowerBound(4 LE)
 *   - Structs:      0x11
 *
 * For nested struct members the CRC chains hierarchically:
 *   parentCrc → updateUInt32LE(parentCrc) → updateByte(0x89) → updateUInt32LE(childCrc)
 *
 * TypeCodes (S7-1500, scope Default):
 *   Bool=0x01, Byte=0x02, Char=0x03, Word=0x04, Int=0x05, DWord=0x06,
 *   DInt=0x07, Real=0x08, Date=0x09, TimeOfDay=0x0A, Time=0x0B,
 *   S5Time=0x0C, DateAndTime=0x0E, Array=0x10, Struct=0x11, String=0x13,
 *   LReal=0x30, ULInt=0x31, LInt=0x32, LWord=0x33, USInt=0x34, UInt=0x35,
 *   UDInt=0x36, SInt=0x37, WChar=0x3D, WString=0x3E, LTime=0x40,
 *   LTimeOfDay=0x41
 */

const { S7CRC32 } = require('./s7-crc32');

const STRUCT_CHILD_DELIMITER = 0x89;

const TypeCode = Object.freeze({
    Bool: 0x01,
    Byte: 0x02,
    Char: 0x03,
    Word: 0x04,
    Int: 0x05,
    DWord: 0x06,
    DInt: 0x07,
    Real: 0x08,
    Date: 0x09,
    TimeOfDay: 0x0A,
    Time: 0x0B,
    S5Time: 0x0C,
    DateAndTime: 0x0E,
    Array: 0x10,
    Struct: 0x11,
    String: 0x13,
    LReal: 0x30,
    ULInt: 0x31,
    LInt: 0x32,
    LWord: 0x33,
    USInt: 0x34,
    UInt: 0x35,
    UDInt: 0x36,
    SInt: 0x37,
    WChar: 0x3D,
    WString: 0x3E,
    LTime: 0x40,
    LTimeOfDay: 0x41
});

/**
 * Map softdatatype (from PVartypeListElement) → TypeCode for CRC computation.
 * The softdatatype values used by the S7-1500 firmware in TypeInfo responses
 * happen to align with the CRC TypeCodes for most types.
 */
const SOFTDATATYPE_TO_TYPECODE = Object.freeze({
    1: TypeCode.Bool,
    2: TypeCode.Byte,
    3: TypeCode.Char,
    4: TypeCode.Word,
    5: TypeCode.Int,
    6: TypeCode.DWord,
    7: TypeCode.DInt,
    8: TypeCode.Real,
    9: TypeCode.Date,
    10: TypeCode.TimeOfDay,
    11: TypeCode.Time,
    12: TypeCode.S5Time,
    14: TypeCode.DateAndTime,
    17: TypeCode.Struct,
    19: TypeCode.String,
    40: TypeCode.Bool,
    48: TypeCode.LReal,
    49: TypeCode.ULInt,
    50: TypeCode.LInt,
    51: TypeCode.LWord,
    52: TypeCode.USInt,
    53: TypeCode.UInt,
    54: TypeCode.UDInt,
    55: TypeCode.SInt,
    61: TypeCode.WChar,
    62: TypeCode.WString,
    64: TypeCode.LTime,
    65: TypeCode.LTimeOfDay,

    // Hardware / system softdatatypes → CRC TypeCode of underlying storage type
    // 32-bit types (DWord): AOM_IDENT, EVENT_*
    128: TypeCode.DWord,   // AOM_IDENT
    129: TypeCode.DWord,   // EVENT_ANY
    130: TypeCode.DWord,   // EVENT_ATT
    131: TypeCode.DWord,   // EVENT_HWINT
    132: TypeCode.DWord,   // FOLDER
    133: TypeCode.DWord,   // AOM_AID
    134: TypeCode.DWord,   // AOM_LINK

    // 16-bit Word types: HW_*, CONN_ANY/PRG/OUC
    144: TypeCode.Word,    // HW_ANY
    145: TypeCode.Word,    // HW_IOSYSTEM
    146: TypeCode.Word,    // HW_DPMASTER
    147: TypeCode.Word,    // HW_DEVICE
    148: TypeCode.Word,    // HW_DPSLAVE
    149: TypeCode.Word,    // HW_IO
    150: TypeCode.Word,    // HW_MODULE
    151: TypeCode.Word,    // HW_SUBMODULE
    152: TypeCode.Word,    // HW_HSC
    153: TypeCode.Word,    // HW_PWM
    154: TypeCode.Word,    // HW_PTO
    155: TypeCode.Word,    // HW_INTERFACE
    156: TypeCode.Word,    // HW_IEPORT
    168: TypeCode.Word,    // CONN_ANY
    169: TypeCode.Word,    // CONN_PRG
    170: TypeCode.Word,    // CONN_OUC
    171: TypeCode.DWord,   // CONN_R_ID (32-bit)

    // 16-bit Int types: OB_* (OB numbers are signed Int per TIA Portal)
    160: TypeCode.Int,     // OB_ANY
    161: TypeCode.Int,     // OB_DELAY
    162: TypeCode.Int,     // OB_TOD
    163: TypeCode.Int,     // OB_CYCLIC
    164: TypeCode.Int,     // OB_ATT
    192: TypeCode.Int,     // OB_PCYCLE
    193: TypeCode.Int,     // OB_HWINT
    195: TypeCode.Int,     // OB_DIAG
    196: TypeCode.Int,     // OB_TIMEERROR
    197: TypeCode.Int,     // OB_STARTUP

    // 16-bit UInt types: DB_*, PORT, RTM, PIP
    173: TypeCode.UInt,    // PORT
    174: TypeCode.UInt,    // RTM
    175: TypeCode.UInt,    // PIP
    208: TypeCode.UInt,    // DB_ANY
    209: TypeCode.UInt,    // DB_WWW
    210: TypeCode.UInt     // DB_DYN
});

function softdatatypeToTypeCode(sd) {
    return SOFTDATATYPE_TO_TYPECODE[sd] || sd;
}

/**
 * Compute the inner CRC for a single member (name + type info).
 * @param {string} name - member name (UTF-8)
 * @param {number} typeCode - TypeCode byte
 * @param {object} [arrayInfo] - { elementTypeCode, lowerBound } for arrays
 * @returns {number} raw CRC (before double-hash)
 */
function memberInnerCrc(name, typeCode, arrayInfo) {
    const crc = new S7CRC32();
    crc.update(name);
    if (typeCode === TypeCode.Array && arrayInfo) {
        crc.updateByte(TypeCode.Array);
        crc.updateByte(arrayInfo.elementTypeCode & 0xFF);
        const lb = Buffer.alloc(4);
        lb.writeInt32LE(arrayInfo.lowerBound || 0);
        crc.update(lb);
    } else {
        crc.updateByte(typeCode & 0xFF);
    }
    return crc.result;
}

/**
 * Double-hash: wrap an inner CRC into the final ItemAddress CRC format.
 * @param {number} innerCrc
 * @returns {number}
 */
function finalizeItemCrc(innerCrc) {
    const crc = new S7CRC32();
    crc.updateUInt32LE(innerCrc);
    return crc.result;
}

/**
 * Compute ItemAddress SymbolCRC for a direct DB member (no struct nesting).
 * @param {string} name - member name
 * @param {number} typeCode - TypeCode byte
 * @param {object} [arrayInfo] - { elementTypeCode, lowerBound }
 * @returns {number}
 */
function computeItemCrc(name, typeCode, arrayInfo) {
    return finalizeItemCrc(memberInnerCrc(name, typeCode, arrayInfo));
}

/**
 * Compute ItemAddress SymbolCRC for a struct-nested member.
 * @param {Array<{name: string, typeCode: number, arrayInfo?: object}>} pathSegments
 *   Ordered from outermost struct to leaf member.
 * @returns {number}
 */
function computeNestedItemCrc(pathSegments) {
    if (pathSegments.length === 0) return 0;
    if (pathSegments.length === 1) {
        const s = pathSegments[0];
        return computeItemCrc(s.name, s.typeCode, s.arrayInfo);
    }

    const first = pathSegments[0];
    const crc = new S7CRC32();
    crc.updateUInt32LE(memberInnerCrc(first.name, first.typeCode, first.arrayInfo));

    for (let i = 1; i < pathSegments.length; i++) {
        crc.updateByte(STRUCT_CHILD_DELIMITER);
        const seg = pathSegments[i];
        crc.updateUInt32LE(memberInnerCrc(seg.name, seg.typeCode, seg.arrayInfo));
    }

    return crc.result;
}

/**
 * Compute ItemAddress SymbolCRC directly from browse crcMeta.
 * Supports single members, arrays, and nested struct paths.
 * @param {object} crcMeta - as returned by resolveLeaf().crcMeta
 * @returns {number}
 */
function computeCrcFromMeta(crcMeta) {
    if (!crcMeta) return 0;

    if (crcMeta.pathSegments) {
        return computeNestedItemCrc(crcMeta.pathSegments.map(seg => {
            if (seg.isArray) {
                return {
                    name: seg.memberName,
                    typeCode: TypeCode.Array,
                    arrayInfo: {
                        elementTypeCode: softdatatypeToTypeCode(seg.elementSoftdatatype),
                        lowerBound: seg.lowerBound || 0
                    }
                };
            }
            return { name: seg.memberName, typeCode: softdatatypeToTypeCode(seg.softdatatype) };
        }));
    }

    if (!crcMeta.memberName) return 0;
    if (crcMeta.isArray) {
        return computeItemCrc(crcMeta.memberName, TypeCode.Array, {
            elementTypeCode: softdatatypeToTypeCode(crcMeta.elementSoftdatatype),
            lowerBound: crcMeta.lowerBound || 0
        });
    }
    const tc = softdatatypeToTypeCode(crcMeta.softdatatype);
    return computeItemCrc(crcMeta.memberName, tc);
}

module.exports = {
    S7CRC32,
    TypeCode,
    STRUCT_CHILD_DELIMITER,
    softdatatypeToTypeCode,
    memberInnerCrc,
    finalizeItemCrc,
    computeItemCrc,
    computeNestedItemCrc,
    computeCrcFromMeta
};
