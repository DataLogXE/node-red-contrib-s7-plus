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

module.exports = {
    HEX_ADDRESS_RE,
    isHexAddress,
    isSymbolicName
};
