'use strict';

const VALID_SYMBOL_INFOS = new Set(['none', 'object', 'array']);

function normalizeSymbolInfos(mode) {
    if (typeof mode === 'string' && VALID_SYMBOL_INFOS.has(mode)) return mode;
    return 'none';
}

function stripSymbolName(entry) {
    const { name, ...info } = entry;
    return info;
}

function formatExplorePayload(rawSymbols, symbolInfos) {
    const mode = normalizeSymbolInfos(symbolInfos);
    const symbols = rawSymbols.map(s => s.name);

    if (mode === 'none') {
        return { symbols };
    }

    if (mode === 'object') {
        const infos = {};
        for (const entry of rawSymbols) {
            infos[entry.name] = stripSymbolName(entry);
        }
        return { symbols, infos };
    }

    const infos = rawSymbols.map(entry => ({
        symbol: entry.name,
        ...stripSymbolName(entry)
    }));
    return { symbols, infos };
}

module.exports = {
    normalizeSymbolInfos,
    formatExplorePayload
};
