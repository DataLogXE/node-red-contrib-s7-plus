'use strict';

const HEX_ADDRESS_RE = /^[0-9A-Fa-f]+(\.[0-9A-Fa-f]+)*$/;

/**
 * Determine if a symbol string is a raw hex access address (as returned
 * by browseResolve, e.g. "8A0E0001.A.0") rather than a symbolic path.
 * Hex addresses consist solely of hex digits separated by dots.
 */
function isHexAddress(str) {
    return HEX_ADDRESS_RE.test(str);
}

/**
 * True for resolved PLC access strings (e.g. "8A0E0001.A"), not short
 * symbolic-looking paths like "DB1.a" that also match isHexAddress.
 */
function isRawHexAccessString(str) {
    if (!isHexAddress(str)) return false;
    const head = str.split('.')[0];
    // S7CommPlus access areas are 32-bit values encoded as 8 hex digits.
    return head.length >= 8;
}

/**
 * Determine if a name string looks like a symbolic PLC path. Symbolic
 * paths contain dots with at least one non-hex segment, or brackets
 * (array indexing). Used to decide whether a tag must be resolved
 * (CRC-secured) before reading/writing.
 */
function isSymbolicName(name) {
    if (!name || typeof name !== 'string') return false;
    if (isHexAddress(name)) return false;
    return /[.\[]/.test(name);
}

/**
 * Reject hex-only tags that lack CRC protection (no symbolCrc and no
 * symbolic name to resolve through explore).
 */
function assertCrcSecuredTag({ address, name, symbolCrc }, index) {
    if (isRawHexAccessString(address) && !symbolCrc && !isSymbolicName(name)) {
        throw new Error(
            `Symbol #${index}: hex access string requires a symbolic name or symbolCrc`
        );
    }
}

module.exports = {
    HEX_ADDRESS_RE,
    isHexAddress,
    isRawHexAccessString,
    isSymbolicName,
    assertCrcSecuredTag
};
