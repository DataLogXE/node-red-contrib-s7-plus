'use strict';

const fs = require('fs');
const path = require('path');
const { EP, DEFAULT_OUTPUT_FORMAT, endpointNode, globalConfigNode } = require('./example-flow-shared');

const TAB = 'write_single_tab';

// All coordinates are multiples of 20 so the nodes snap onto the Node-RED
// editor grid.
const ROW_H = 40;        // vertical step between stacked inject rows
const GROUP_GAP = 40;    // gap below a finished write group
const SECTION_GAP = 40;  // extra gap between sections
const COMMENT_GAP = 40;  // gap below a section header comment

// Grid-aligned LEFT edge of the three node columns: inject | write/read | debug.
// Node-RED centers a node on its stored x, so each node's x is derived as
// leftEdge + nodeWidth/2 (see leftAlignedX) to line up the left edges exactly.
const LEFT_INJECT = 80;
const LEFT_MID = 520;
const LEFT_DEBUG = 860;

// Scalar datatype sections. One write node per *_write symbol; the inject
// values are derived from every constant of that datatype defined in the DB.
// Hardware and system datatypes are intentionally excluded.
const SECTIONS = [
    {
        title: 'Binary',
        db: 'DB_Binary',
        items: [{ var: 'Bool_write', dt: 'Bool' }]
    },
    {
        title: 'BitStrings',
        db: 'DB_BitStrings',
        items: [
            { var: 'Byte_write', dt: 'Byte' },
            { var: 'Word_write', dt: 'Word' },
            { var: 'DWord_write', dt: 'DWord' },
            { var: 'LWord_write', dt: 'LWord' }
        ]
    },
    {
        title: 'CharacterStrings',
        db: 'DB_CharacterStrings',
        items: [
            { var: 'Char_write', dt: 'Char' },
            { var: 'String_write', dt: 'String' },
            { var: 'WChar_write', dt: 'WChar' },
            { var: 'WString_write', dt: 'WString' }
        ]
    },
    {
        title: 'Integers',
        db: 'DB_Integers',
        items: [
            { var: 'SInt_write', dt: 'SInt' },
            { var: 'Int_write', dt: 'Int' },
            { var: 'DInt_write', dt: 'DInt' },
            { var: 'USInt_write', dt: 'USInt' },
            { var: 'UInt_write', dt: 'UInt' },
            { var: 'UDInt_write', dt: 'UDInt' },
            { var: 'LInt_write', dt: 'LInt' },
            { var: 'ULInt_write', dt: 'ULInt' }
        ]
    },
    {
        title: 'FloatingPoint',
        db: 'DB_FloatingPoint',
        items: [
            { var: 'Real_write', dt: 'Real' },
            { var: 'LReal_write', dt: 'LReal' }
        ]
    },
    {
        title: 'DateAndTime',
        db: 'DB_DateAndTime',
        items: [
            { var: 'Date_write', dt: 'Date' },
            { var: 'Time_Of_Day_write', dt: 'TimeOfDay' },
            { var: 'Date_And_Time_write', dt: 'DateAndTime' },
            { var: 'LTOD_write', dt: 'LTod' },
            { var: 'LDT_write', dt: 'Ldt' },
            { var: 'DTL_write', dt: 'Dtl' }
        ]
    },
    {
        title: 'Timers',
        db: 'DB_Timers',
        items: [
            { var: 'Time_write', dt: 'Time' },
            { var: 'S5Time_write', dt: 'S5Time' },
            { var: 'LTime_write', dt: 'LTime' }
        ]
    }
];

// Maps PLC datatype keywords (as written in the .db source) to the node datatype.
const PLC_TO_DT = {
    Bool: 'Bool',
    Byte: 'Byte', Word: 'Word', DWord: 'DWord', LWord: 'LWord',
    Char: 'Char', String: 'String', WChar: 'WChar', WString: 'WString',
    SInt: 'SInt', Int: 'Int', DInt: 'DInt',
    USInt: 'USInt', UInt: 'UInt', UDInt: 'UDInt', LInt: 'LInt', ULInt: 'ULInt',
    Real: 'Real', LReal: 'LReal',
    Date: 'Date', Time_Of_Day: 'TimeOfDay', Date_And_Time: 'DateAndTime',
    LTime_Of_Day: 'LTod', LDT: 'Ldt', DTL: 'Dtl',
    Time: 'Time', S5Time: 'S5Time', LTime: 'LTime'
};

function slug(s) {
    return s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

// ── Node-RED node-width model ────────────────────────────────────────────
// Node-RED measures the label in the editor font and sizes the node as
//   w = max(100, 20 * ceil((labelPx + 50 + (hasInput ? 7 : 0)) / 20))
// then centers the node on its stored x (see editor-client view.js). The
// label font stack is "Helvetica Neue, Arial, Helvetica, sans-serif" at 14px;
// on Windows the first faces are absent, so labels render in Arial 14px.
// Replicating Arial's advance widths lets us compute the exact rendered width
// and align every column on a shared, grid-aligned LEFT edge.
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

// Node-RED stores the node center in x; to align the LEFT edge of a column we
// offset each node by half its (grid-quantized) width.
function leftAlignedX(leftEdge, label, hasInput) {
    return leftEdge + nodeWidth(label, hasInput) / 2;
}

// ---------------------------------------------------------------------------
// S7 literal conversion: turn a DB constant value into a Node-RED inject
// payload that, when written, reproduces the value on the PLC.
// ---------------------------------------------------------------------------

function quoted(lit) {
    const m = lit.match(/'([^']*)'/);
    return m ? m[1] : '';
}

function isoDate(lit) {
    const m = lit.match(/(\d{4})-(\d{2})-(\d{2})/);
    return `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`;
}

function isoDateTime(lit) {
    const m = lit.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
    const ms = (m[7] || '').padEnd(3, '0').slice(0, 3) || '000';
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}Z`;
}

function todMs(lit) {
    const m = lit.match(/(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
    const ms = m[4] ? Number((m[4] + '000').slice(0, 3)) : 0;
    return String(((+m[1] * 3600) + (+m[2] * 60) + (+m[3])) * 1000 + ms);
}

function ltodNs(lit) {
    const m = lit.match(/(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
    const ns = m[4] ? BigInt((m[4] + '000000000').slice(0, 9)) : 0n;
    const secs = BigInt((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]));
    return (secs * 1000000000n + ns).toString();
}

function durationMs(lit) {
    const body = lit.replace(/^[A-Za-z0-9]+#/, '');
    const neg = body.startsWith('-');
    const s = body.replace(/^-/, '').replace(/_/g, '');
    const units = { D: 86400000, H: 3600000, M: 60000, S: 1000, MS: 1 };
    let ms = 0;
    const re = /(\d+)(MS|D|H|M|S)/g;
    let m;
    while ((m = re.exec(s))) ms += (+m[1]) * units[m[2]];
    return String(neg ? -ms : ms);
}

function durationNs(lit) {
    const body = lit.replace(/^[A-Za-z0-9]+#/, '');
    const neg = body.startsWith('-');
    const s = body.replace(/^-/, '').replace(/_/g, '');
    const units = {
        D: 86400000000000n, H: 3600000000000n, M: 60000000000n, S: 1000000000n,
        MS: 1000000n, US: 1000n, NS: 1n
    };
    let ns = 0n;
    const re = /(\d+)(MS|US|NS|D|H|M|S)/g;
    let m;
    while ((m = re.exec(s))) ns += BigInt(m[1]) * units[m[2]];
    return (neg ? -ns : ns).toString();
}

// Default payload for a constant that has no assignment in the DB BEGIN block
// (i.e. it keeps the datatype's start value).
const DEFAULTS = {
    Bool: { p: 'false', t: 'bool' },
    Byte: { p: '0', t: 'num' }, Word: { p: '0', t: 'num' },
    DWord: { p: '0', t: 'num' }, LWord: { p: '0x0', t: 'str' },
    Char: { p: ' ', t: 'str' }, WChar: { p: ' ', t: 'str' },
    String: { p: '', t: 'str' }, WString: { p: '', t: 'str' },
    SInt: { p: '0', t: 'num' }, Int: { p: '0', t: 'num' }, DInt: { p: '0', t: 'num' },
    USInt: { p: '0', t: 'num' }, UInt: { p: '0', t: 'num' }, UDInt: { p: '0', t: 'num' },
    LInt: { p: '0', t: 'str' }, ULInt: { p: '0', t: 'str' },
    Real: { p: '0', t: 'num' }, LReal: { p: '0', t: 'num' },
    Date: { p: '1990-01-01T00:00:00.000Z', t: 'str' },
    DateAndTime: { p: '1990-01-01T00:00:00.000Z', t: 'str' },
    Ldt: { p: '1970-01-01T00:00:00.000Z', t: 'str' },
    Dtl: { p: '1970-01-01T00:00:00.000Z', t: 'str' },
    TimeOfDay: { p: '0', t: 'num' }, LTod: { p: '0', t: 'str' },
    Time: { p: '0', t: 'num' }, S5Time: { p: '0', t: 'num' }, LTime: { p: '0', t: 'str' }
};

// Converts a raw S7 literal (RHS of a := assignment) to an inject payload.
function literalToPayload(dt, lit) {
    switch (dt) {
        case 'Bool':
            return { p: /true/i.test(lit) ? 'true' : 'false', t: 'bool' };
        case 'Byte': case 'Word': case 'DWord':
            return { p: '0x' + lit.replace(/^16#/i, '').replace(/_/g, '').toUpperCase(), t: 'num' };
        // LWord is 64-bit: keep it a string so values > 2^53 survive intact
        // (a JS "num" inject would round them via double precision).
        case 'LWord':
            return { p: '0x' + lit.replace(/^16#/i, '').replace(/_/g, '').toUpperCase(), t: 'str' };
        case 'SInt': case 'Int': case 'DInt':
        case 'USInt': case 'UInt': case 'UDInt':
            return { p: lit.replace(/_/g, ''), t: 'num' };
        // 64-bit integers: string transport to avoid double-precision loss.
        case 'LInt': case 'ULInt':
            return { p: lit.replace(/_/g, ''), t: 'str' };
        case 'Real': case 'LReal':
            return { p: lit.replace(/_/g, ''), t: 'num' };
        case 'Char': case 'WChar': case 'String': case 'WString':
            return { p: quoted(lit), t: 'str' };
        case 'Date':
            return { p: isoDate(lit), t: 'str' };
        case 'DateAndTime': case 'Ldt': case 'Dtl':
            return { p: isoDateTime(lit), t: 'str' };
        case 'TimeOfDay':
            return { p: todMs(lit), t: 'num' };
        case 'LTod':
            return { p: ltodNs(lit), t: 'str' };
        case 'Time': case 'S5Time':
            return { p: durationMs(lit), t: 'num' };
        case 'LTime':
            return { p: durationNs(lit), t: 'str' };
        default:
            throw new Error(`No literal converter for datatype ${dt}`);
    }
}

// Reads a .db source and returns its constant presets (everything except the
// *_write test symbol) with the inject payload for each, in source order.
function parseConstants(db) {
    const file = path.join(__dirname, '..', 'plc', 's7-1500', `${db}.db`);
    const text = fs.readFileSync(file, 'utf8');

    const varStart = text.search(/\n\s*VAR\b/);
    const varEnd = text.indexOf('END_VAR');
    const beginStart = text.indexOf('BEGIN');
    if (varStart === -1 || varEnd === -1) {
        throw new Error(`Cannot locate VAR block in ${db}.db`);
    }

    // Assigned values from the BEGIN block (skip struct-field assignments like
    // "DTL_x.YEAR := ..."; the scalar "DTL_x := DTL#..." line wins).
    const assigned = {};
    if (beginStart !== -1) {
        const beginBody = text.slice(beginStart);
        for (const line of beginBody.split(/\r?\n/)) {
            const m = line.match(/^\s*([A-Za-z_]\w*)\s*:=\s*(.+?);\s*$/);
            if (m) assigned[m[1]] = m[2].trim();
        }
    }

    const out = [];
    for (const line of text.slice(varStart, varEnd).split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_]\w*)\s*(?:\{[^}]*\})?\s*:\s*([A-Za-z_]\w*)/);
        if (!m) continue;
        const name = m[1];
        const plcType = m[2];
        if (name === 'VAR' || /_write$/i.test(name)) continue;
        const dt = PLC_TO_DT[plcType];
        if (!dt) {
            console.warn(`Skipping ${db}.${name}: unmapped PLC type ${plcType}`);
            continue;
        }
        const lit = assigned[name];
        const payload = lit != null ? literalToPayload(dt, lit) : DEFAULTS[dt];
        out.push({ name, dt, payload: payload.p, payloadType: payload.t });
    }
    return out;
}

function injectNode(id, name, y, writeId, payload, payloadType) {
    return {
        id,
        type: 'inject',
        z: TAB,
        name,
        props: [{ p: 'payload' }],
        repeat: '',
        crontab: '',
        once: false,
        onceDelay: 0.1,
        topic: '',
        payload,
        payloadType,
        x: leftAlignedX(LEFT_INJECT, name, false),
        y,
        wires: [[writeId]]
    };
}

function writeNode(id, name, y, debugId, symbol, datatype) {
    return {
        id,
        type: 's7-plus write',
        z: TAB,
        name,
        endpoint: EP,
        symbols: [{ name: symbol, address: symbol, datatype }],
        outputFormat: DEFAULT_OUTPUT_FORMAT,
        x: leftAlignedX(LEFT_MID, name, true),
        y,
        wires: [[debugId]]
    };
}

function readNode(id, name, y, debugId, symbol, datatype) {
    return {
        id,
        type: 's7-plus read',
        z: TAB,
        name,
        endpoint: EP,
        symbols: [{ name: symbol, address: symbol, datatype }],
        outputFormat: DEFAULT_OUTPUT_FORMAT,
        x: leftAlignedX(LEFT_MID, name, true),
        y,
        wires: [[debugId]]
    };
}

function debugNode(id, name, y, symbol) {
    return {
        id,
        type: 'debug',
        z: TAB,
        name,
        active: true,
        tosidebar: true,
        console: false,
        tostatus: true,
        complete: 'false',
        statusVal: `payload["${symbol}"].value`,
        statusType: 'msg',
        x: leftAlignedX(LEFT_DEBUG, name, true),
        y,
        wires: []
    };
}

function commentNode(id, name, y, info) {
    return {
        id,
        type: 'comment',
        z: TAB,
        name,
        info: info || '',
        x: leftAlignedX(LEFT_INJECT, name, false),
        y,
        wires: []
    };
}

const nodes = [];
let y = 60;

nodes.push({
    id: TAB,
    type: 'tab',
    label: 'Write Single Values',
    disabled: false,
    info: 'Write tests for all scalar datatypes in plc/s7-1500.\n'
        + 'For every datatype there is one s7-plus write node plus one inject per\n'
        + 'constant defined in the matching DB; each inject writes that constant\n'
        + 'value into the *_write symbol.\n'
        + 'Below each write group a read-back row (trigger inject + s7-plus read +\n'
        + 'debug) reads the same *_write tag back from the PLC for verification.\n'
        + 'Hardware and system datatypes are intentionally excluded.',
    env: []
});

nodes.push(commentNode('flow_hdr', 'Write single values — every plc/s7-1500 scalar constant', y));
y += ROW_H + SECTION_GAP;

for (const section of SECTIONS) {
    nodes.push(commentNode(`sec_${slug(section.title)}`, section.title, y, section.db));
    y += COMMENT_GAP;

    const constants = parseConstants(section.db);
    const groups = new Map();
    for (const c of constants) {
        if (!groups.has(c.dt)) groups.set(c.dt, []);
        groups.get(c.dt).push(c);
    }

    for (const item of section.items) {
        const members = groups.get(item.dt) || [];
        if (!members.length) {
            throw new Error(`No constants for ${section.db} datatype ${item.dt}`);
        }

        const symbol = `${section.db}.${item.var}`;
        const writeId = `wr_${slug(section.title)}_${slug(item.var)}`;
        const debugId = `db_${slug(section.title)}_${slug(item.var)}`;
        const blockTop = y;

        // Template layout: write + debug aligned to the first inject row.
        nodes.push(writeNode(writeId, item.var, blockTop, debugId, symbol, item.dt));
        nodes.push(debugNode(debugId, `${item.dt} result`, blockTop, symbol));

        for (let i = 0; i < members.length; i++) {
            const c = members[i];
            const injId = `inj_${slug(section.title)}_${slug(c.name)}`;
            nodes.push(injectNode(injId, c.name, blockTop + i * ROW_H, writeId, c.payload, c.payloadType));
        }

        y = blockTop + members.length * ROW_H + GROUP_GAP;

        // Read-back block: a manual trigger inject reads the same *_write tag
        // back from the PLC so the written value can be verified.
        const readTop = y;
        const readId = `rd_${slug(section.title)}_${slug(item.var)}`;
        const readDebugId = `dbr_${slug(section.title)}_${slug(item.var)}`;
        const trigId = `trg_${slug(section.title)}_${slug(item.var)}`;

        nodes.push(injectNode(trigId, `Read ${item.var.replace(/_write$/, '')}`, readTop, readId, '', 'date'));
        nodes.push(readNode(readId, item.var, readTop, readDebugId, symbol, item.dt));
        nodes.push(debugNode(readDebugId, `${item.dt} read`, readTop, symbol));

        y = readTop + ROW_H + GROUP_GAP;
    }

    y += SECTION_GAP;
}

nodes.push(endpointNode());
nodes.push(globalConfigNode('0.0.1'));

const out = path.join(__dirname, '..', 'examples', 'read-write-single-values-flow.json');
fs.writeFileSync(out, JSON.stringify(nodes, null, 4) + '\n');
console.log(`Wrote ${nodes.length} nodes to ${out}`);
