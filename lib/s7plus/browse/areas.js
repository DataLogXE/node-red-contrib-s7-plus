'use strict';

const { Ids } = require('../constants');

const MEMORY_AREAS = [
    { name: 'IArea', label: 'IArea (Inputs)', accessId: Ids.NativeObjects_theIArea_Rid, tiRelId: 0x90010000 },
    { name: 'QArea', label: 'QArea (Outputs)', accessId: Ids.NativeObjects_theQArea_Rid, tiRelId: 0x90020000 },
    { name: 'MArea', label: 'MArea (Merker)', accessId: Ids.NativeObjects_theMArea_Rid, tiRelId: 0x90030000 },
    { name: 'S7Timers', label: 'S7Timers (Timers)', accessId: Ids.NativeObjects_theS7Timers_Rid, tiRelId: 0x90050000 },
    { name: 'S7Counters', label: 'S7Counters (Counters)', accessId: Ids.NativeObjects_theS7Counters_Rid, tiRelId: 0x90060000 }
];

const MEMORY_AREA_NAMES = MEMORY_AREAS.map(a => a.name);

/**
 * Normalize explore scope: empty partial selection falls back to everything.
 * @param {object} [scope]
 * @returns {{ everything: boolean, dbs: string[], areas: string[] }}
 */
function normalizeExploreScope(scope) {
    if (!scope || scope.everything) {
        return { everything: true, dbs: [], areas: [] };
    }
    const dbs = Array.isArray(scope.dbs) ? scope.dbs.filter(Boolean) : [];
    const areas = Array.isArray(scope.areas) ? scope.areas.filter(Boolean) : [];
    if (dbs.length === 0 && areas.length === 0) {
        return { everything: true, dbs: [], areas: [] };
    }
    return { everything: false, dbs, areas };
}

module.exports = {
    MEMORY_AREAS,
    MEMORY_AREA_NAMES,
    normalizeExploreScope
};
