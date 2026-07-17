'use strict';

const { parseSymbolSegments } = require('./browse/resolve-symbolic');
const { MEMORY_AREA_NAMES } = require('./browse/areas');

/**
 * First path segment (DB name or memory area) of a symbolic PLC path.
 * @param {string} symbolPath
 * @returns {string|null}
 */
function symbolRoot(symbolPath) {
    const segments = parseSymbolSegments(symbolPath);
    return segments.length > 0 ? segments[0] : null;
}

/**
 * Scoped explore options for a single DB or memory area root.
 * @param {string} rootName
 * @returns {{ everything: boolean, dbs: string[], areas: string[] }}
 */
function exploreScopeForRoot(rootName) {
    if (MEMORY_AREA_NAMES.includes(rootName)) {
        return { everything: false, dbs: [], areas: [rootName] };
    }
    return { everything: false, dbs: [rootName], areas: [] };
}

/**
 * Unique DB / memory-area roots referenced by a list of symbol paths.
 * @param {string[]} symbolPaths
 * @returns {string[]}
 */
function uniqueSymbolRoots(symbolPaths) {
    const roots = [];
    const seen = new Set();
    for (const path of symbolPaths) {
        const root = symbolRoot(path);
        if (!root || seen.has(root)) continue;
        seen.add(root);
        roots.push(root);
    }
    return roots;
}

/**
 * Map a flat-browser symbol entry to a CRC-cache value object.
 * Uses computedCrc (same as lazy resolve), not vte.symbolCrc.
 * @param {object} flatSymbol
 * @returns {{ address: string, symbolCrc: number, datatype: string }|null}
 */
function flatSymbolToCacheEntry(flatSymbol) {
    if (!flatSymbol || !flatSymbol.name || !flatSymbol.accessSequence) return null;
    return {
        address: flatSymbol.accessSequence,
        symbolCrc: flatSymbol.computedCrc ?? 0,
        datatype: flatSymbol.softdatatypeName
    };
}

/**
 * Write all flat-browser symbols into the CRC cache via setFn(symbolPath, address, symbolCrc, datatype).
 * @param {object[]} flatSymbols
 * @param {(symbolPath: string, address: string, symbolCrc: number, datatype: string) => void} setFn
 * @returns {number} count of entries written
 */
function seedCrcCacheFromFlatSymbols(flatSymbols, setFn) {
    if (!Array.isArray(flatSymbols) || typeof setFn !== 'function') return 0;
    let count = 0;
    for (const flat of flatSymbols) {
        const entry = flatSymbolToCacheEntry(flat);
        if (!entry) continue;
        setFn(flat.name, entry.address, entry.symbolCrc, entry.datatype);
        count++;
    }
    return count;
}

module.exports = {
    symbolRoot,
    exploreScopeForRoot,
    uniqueSymbolRoots,
    flatSymbolToCacheEntry,
    seedCrcCacheFromFlatSymbols
};
