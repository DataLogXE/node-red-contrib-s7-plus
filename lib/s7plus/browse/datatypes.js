'use strict';

const eNodeType = { Root: 1, Var: 2, Array: 3, StructArray: 4 };

// Primitive + hardware/S7 names (Wireshark tagdescr_softdatatype_names + vendor-specific IDs)
const SOFTDATATYPE_NAMES = {
    1: 'Bool', 2: 'Byte', 3: 'Char', 4: 'Word', 5: 'Int', 6: 'DWord', 7: 'DInt', 8: 'Real',
    9: 'Date', 10: 'TimeOfDay', 11: 'Time', 12: 'S5Time', 14: 'DateAndTime', 17: 'Struct',
    19: 'String', 20: 'Pointer', 22: 'Any', 23: 'BlockFb', 24: 'BlockFc', 28: 'Counter',
    29: 'Timer', 40: 'BBool', 48: 'LReal', 49: 'ULInt', 50: 'LInt', 51: 'LWord', 52: 'USInt',
    53: 'UInt', 54: 'UDInt', 55: 'SInt', 61: 'WChar', 62: 'WString', 64: 'LTime', 65: 'LTod',
    66: 'Ldt', 67: 'Dtl',
    96: 'REMOTE',
    128: 'AOM_IDENT', 129: 'EVENT_ANY', 130: 'EVENT_ATT', 131: 'EVENT_HWINT',
    132: 'FOLDER', 133: 'AOM_AID', 134: 'AOM_LINK',
    144: 'HW_ANY', 145: 'HW_IOSYSTEM', 146: 'HW_DPMASTER', 147: 'HW_DEVICE', 148: 'HW_DPSLAVE',
    149: 'HW_IO', 150: 'HW_MODULE', 151: 'HW_SUBMODULE', 152: 'HW_HSC', 153: 'HW_PWM',
    154: 'HW_PTO', 155: 'HW_INTERFACE', 156: 'HW_IEPORT',
    160: 'OB_ANY', 161: 'OB_DELAY', 162: 'OB_TOD', 163: 'OB_CYCLIC', 164: 'OB_ATT',
    168: 'CONN_ANY', 169: 'CONN_PRG', 170: 'CONN_OUC', 171: 'CONN_R_ID',
    173: 'PORT', 174: 'RTM', 175: 'PIP',
    192: 'OB_PCYCLE', 193: 'OB_HWINT', 195: 'OB_DIAG', 196: 'OB_TIMEERROR', 197: 'OB_STARTUP',
    208: 'DB_ANY', 209: 'DB_WWW', 210: 'DB_DYN'
};

const SUPPORTED_SOFTDATATYPES = new Set([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 19, 20, 22, 23, 24, 28, 29, 40,
    48, 49, 50, 51, 52, 53, 54, 55, 61, 62, 64, 65, 66, 67, 96,
    128, 129, 130, 131, 132, 133, 134,
    144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156,
    160, 161, 162, 163, 164,
    168, 169, 170, 171, 173, 174, 175,
    192, 193, 195, 196, 197,
    208, 209, 210
]);

function softdatatypeName(id) {
    return SOFTDATATYPE_NAMES[id] || `Softdatatype_${id}`;
}

function isSoftdatatypeSupported(sd) {
    return SUPPORTED_SOFTDATATYPES.has(sd);
}

// System datatypes that carry a type relation (and would otherwise look
// like a nested struct) but are read/written as a single packed leaf
// value. Currently only DTL (67). Such types must be classified as leaves
// in the browse tree, not descended into.
const PACKED_LEAF_SOFTDATATYPES = new Set([67]);

function isPackedLeafDatatype(sd) {
    return PACKED_LEAF_SOFTDATATYPES.has(sd);
}

function getSizeOfDatatype(vte) {
    const oit = vte.offsetInfoType;
    switch (vte.softdatatype) {
        case 1: return 1;
        case 2: case 3: case 40: case 52: case 55: return 1;
        case 4: case 5: case 53: return 2;
        case 6: case 7: case 8: case 10: case 11: case 54: return 4;
        case 9: case 12: case 23: case 24: case 28: case 29: return 2;
        case 14: case 48: case 49: case 50: case 51: case 64: case 65: case 66: return 8;
        case 67: return 12; // DTL: packed 12-byte date/time structure
        case 19: {
            const isArr = (oit.is1Dim && oit.is1Dim()) || (oit.isMDim && oit.isMDim());
            return isArr ? (oit.unspecifiedOffsetinfo1 || 0) + 2 : 0;
        }
        case 20: return 6;
        case 22: return 10;
        // Hardware / system types — 32-bit (AOM_IDENT, EVENT_*, FOLDER, AOM_AID, AOM_LINK, CONN_R_ID)
        case 128: case 129: case 130: case 131: case 132: case 133: case 134: case 171: return 4;
        // Hardware / system types — 16-bit (HW_*, OB_*, CONN_ANY/PRG/OUC, PORT, RTM, PIP, DB_*)
        case 144: case 145: case 146: case 147: case 148: case 149:
        case 150: case 151: case 152: case 153: case 154: case 155: case 156:
        case 160: case 161: case 162: case 163: case 164:
        case 168: case 169: case 170:
        case 173: case 174: case 175:
        case 192: case 193: case 195: case 196: case 197:
        case 208: case 209: case 210: return 2;
        default: return 0;
    }
}

module.exports = {
    eNodeType,
    softdatatypeName,
    isSoftdatatypeSupported,
    isPackedLeafDatatype,
    getSizeOfDatatype
};
