'use strict';

/**
 * Re-layout write-single-values-flow.json into three left-aligned columns:
 *   inject (left) | s7-plus write / s7-plus read (center) | debug (right)
 *
 * Node-RED stores the node center in x, so columns are left-aligned by
 * offsetting each node by half its estimated width.
 *
 * Usage: node scripts/layout-write-flow.js [path-to-flow.json]
 */

const fs = require('fs');
const path = require('path');

const FLOW_PATH = process.argv[2]
    || path.join(__dirname, '..', 'examples', 'write-single-values-flow.json');

const TAB = 'write_single_tab';

// All coordinates are multiples of 20 to snap onto the Node-RED editor grid.
const ROW_H = 40;        // vertical step between stacked inject rows
const GROUP_GAP = 40;    // gap below a finished write group
const SECTION_GAP = 40;  // gap below the flow header
const COMMENT_GAP = 40;  // gap below a section header comment

// Grid-aligned LEFT edge of the three node columns: inject | write/read | debug.
// Node-RED centers a node on its stored x, so each node's x is derived as
// leftEdge + nodeWidth/2 to line up the left edges exactly.
const LEFT_INJECT = 80;
const LEFT_MID = 520;
const LEFT_DEBUG = 860;

const ACTION_TYPES = new Set(['s7-plus write', 's7-plus read']);

// Node-RED node-width model (see generate-write-flow.js for details): labels
// render in Arial 14px on Windows; node width is
//   w = max(100, 20 * ceil((labelPx + 50 + (hasInput ? 7 : 0)) / 20)).
const ARIAL_ADVANCE_1000 = {
    ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
    '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
    '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
    '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
    '@': 1015, 'A': 667, 'B': 667, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778,
    'H': 722, 'I': 278, 'J': 500, 'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778,
    'P': 667, 'Q': 778, 'R': 722, 'S': 667, 'T': 611, 'U': 722, 'V': 667, 'W': 944,
    'X': 667, 'Y': 667, 'Z': 611, '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556,
    '`': 333, 'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556,
    'h': 556, 'i': 222, 'j': 222, 'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556,
    'p': 556, 'q': 556, 'r': 333, 's': 500, 't': 278, 'u': 556, 'v': 500, 'w': 722,
    'x': 500, 'y': 500, 'z': 500, '{': 334, '|': 260, '}': 334, '~': 584
};

function labelPx(label) {
    let units = 0;
    for (const ch of String(label || '')) {
        units += ARIAL_ADVANCE_1000[ch] != null ? ARIAL_ADVANCE_1000[ch] : 556;
    }
    return Math.round((units * 14) / 1000);
}

function nodeWidth(label, hasInput) {
    return Math.max(100, 20 * Math.ceil((labelPx(label) + 50 + (hasInput ? 7 : 0)) / 20));
}

function leftAlignedX(leftEdge, label, hasInput) {
    return leftEdge + nodeWidth(label, hasInput) / 2;
}

const nodes = JSON.parse(fs.readFileSync(FLOW_PATH, 'utf8'));
const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

const tabNodes = nodes.filter((n) => n.z === TAB);
const actions = tabNodes.filter((n) => ACTION_TYPES.has(n.type));
const injects = tabNodes.filter((n) => n.type === 'inject');
const debugs = tabNodes.filter((n) => n.type === 'debug');
const comments = tabNodes.filter((n) => n.type === 'comment');

const injectsByAction = new Map();
for (const inj of injects) {
    const targetId = inj.wires?.[0]?.[0];
    if (!targetId) continue;
    if (!injectsByAction.has(targetId)) injectsByAction.set(targetId, []);
    injectsByAction.get(targetId).push(inj);
}

const debugByAction = new Map();
for (const act of actions) {
    const debugId = act.wires?.[0]?.[0];
    if (debugId && byId[debugId]?.type === 'debug') {
        debugByAction.set(act.id, byId[debugId]);
    }
}

// Preserve visual order from current canvas (top → bottom, left → right).
const ordered = [...comments, ...actions].sort((a, b) => a.y - b.y || a.x - b.x);

let y = 60;

const header = comments.find((c) => c.id === 'flow_hdr')
    || comments.sort((a, b) => a.y - b.y)[0];
if (header) {
    header.x = leftAlignedX(LEFT_INJECT, header.name, false);
    header.y = y;
    y += ROW_H + SECTION_GAP;
}

for (const item of ordered) {
    if (item === header) continue;

    if (item.type === 'comment') {
        item.x = leftAlignedX(LEFT_INJECT, item.name, false);
        item.y = y;
        y += COMMENT_GAP;
        continue;
    }

    if (!ACTION_TYPES.has(item.type)) continue;

    const groupInjects = (injectsByAction.get(item.id) || [])
        .sort((a, b) => a.y - b.y || a.name.localeCompare(b.name));
    const dbg = debugByAction.get(item.id);

    const blockTop = y;

    for (let i = 0; i < groupInjects.length; i++) {
        const inj = groupInjects[i];
        inj.x = leftAlignedX(LEFT_INJECT, inj.name, false);
        inj.y = blockTop + i * ROW_H;
    }

    // Write/read + debug align to the first inject row (template layout).
    item.x = leftAlignedX(LEFT_MID, item.name, true);
    item.y = blockTop;

    if (dbg) {
        dbg.x = leftAlignedX(LEFT_DEBUG, dbg.name, true);
        dbg.y = blockTop;
    }

    const blockRows = Math.max(groupInjects.length, 1);
    y = blockTop + blockRows * ROW_H + GROUP_GAP;
}

fs.writeFileSync(FLOW_PATH, JSON.stringify(nodes, null, 4) + '\n');

const summary = {
    path: FLOW_PATH,
    actions: actions.length,
    injects: injects.length,
    debugs: debugs.length,
    comments: comments.length,
    canvasHeight: y,
    columns: { inject: LEFT_INJECT, mid: LEFT_MID, debug: LEFT_DEBUG }
};
console.log(JSON.stringify(summary, null, 2));
