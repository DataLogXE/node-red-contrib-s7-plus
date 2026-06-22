'use strict';

const TAGDESCR_ATTRIBUTE2_BITOFFSET = 0x0007;
const BITOFFSETINFO_CLASSIC = 0x08;
const BITOFFSETINFO_NONOPTBITOFFSET = 0x70;
const BITOFFSETINFO_OPTBITOFFSET = 0x07;

function getAttributeBitoffset(vte) {
    return (vte.attributeFlags || 0) & TAGDESCR_ATTRIBUTE2_BITOFFSET;
}

function getBitoffsetinfoFlagClassic(vte) {
    return ((vte.bitoffsetinfoFlags || 0) & BITOFFSETINFO_CLASSIC) !== 0;
}

function getBitoffsetinfoNonoptimizedBitoffset(vte) {
    return ((vte.bitoffsetinfoFlags || 0) & BITOFFSETINFO_NONOPTBITOFFSET) >> 4;
}

function getBitoffsetinfoOptimizedBitoffset(vte) {
    return (vte.bitoffsetinfoFlags || 0) & BITOFFSETINFO_OPTBITOFFSET;
}

function applyBoolBitoffsets(info, vte) {
    const BOOL = 1;
    const BBOOL = 40;
    if (vte.softdatatype === BOOL) {
        info.optBitoffset = getAttributeBitoffset(vte);
        if (getBitoffsetinfoFlagClassic(vte)) {
            info.nonOptBitoffset = getBitoffsetinfoNonoptimizedBitoffset(vte);
        } else {
            info.nonOptBitoffset = getAttributeBitoffset(vte);
        }
    } else if (vte.softdatatype === BBOOL) {
        info.optBitoffset = getBitoffsetinfoOptimizedBitoffset(vte);
        info.nonOptBitoffset = 0;
    } else {
        info.optBitoffset = 0;
        info.nonOptBitoffset = 0;
    }
}

module.exports = {
    getAttributeBitoffset,
    getBitoffsetinfoFlagClassic,
    getBitoffsetinfoNonoptimizedBitoffset,
    getBitoffsetinfoOptimizedBitoffset,
    applyBoolBitoffsets
};
