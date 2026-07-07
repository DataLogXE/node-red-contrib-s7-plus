'use strict';

// ---------------------------------------------------------------------------
// Generates examples/read-multiple-values-flow.json: an example that shows how
// to read MANY symbols at once with a single s7-plus read node (one request to
// the PLC), in two ways:
//
//   1. Static config read  - the read node lists multiple values (one
//      representative constant per scalar datatype from plc/s7-1500 plus a few
//      sample symbols). One inject triggers a single read of the whole set.
//   2. Dynamic msg.symbols  - a function node builds msg.symbols (a string[])
//      at runtime with the same multiple values and feeds an unconfigured read node.
//
// Regenerate with: node scripts/generate-read-multiple-flow.js
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { EP, DEFAULT_OUTPUT_FORMAT, endpointNode, globalConfigNode } = require('./example-flow-shared');

const TAB = 'read_multi_tab';

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

// Scalar datatype sections, mirroring scripts/generate-read-write-single-values-flow.js. For the
// static block we pick ONE representative read symbol per datatype: the
// first non-write constant of that datatype defined in the matching DB.
const SECTIONS = [
    { db: 'DB_Binary', datatypes: ['Bool'] },
    { db: 'DB_BitStrings', datatypes: ['Byte', 'Word', 'DWord', 'LWord'] },
    { db: 'DB_CharacterStrings', datatypes: ['Char', 'String', 'WChar', 'WString'] },
    {
        db: 'DB_Integers',
        datatypes: ['SInt', 'Int', 'DInt', 'USInt', 'UInt', 'UDInt', 'LInt', 'ULInt']
    },
    { db: 'DB_FloatingPoint', datatypes: ['Real', 'LReal'] },
    {
        db: 'DB_DateAndTime',
        datatypes: ['Date', 'TimeOfDay', 'DateAndTime', 'LTod', 'Ldt', 'Dtl']
    },
    { db: 'DB_Timers', datatypes: ['Time', 'S5Time', 'LTime'] }
];

// A few selected, real symbols from the sample DBs (plc/s7-1500). These are
// constants, but they are real readable variables, so the dynamic msg.symbols
// read returns actual values. Existence is validated below against the .db
// sources so the example never references a non-existent symbol.
const LIVE_SIGNALS = [
    { db: 'DB_FloatingPoint', name: 'Real_987d125', datatype: 'Real' },
    { db: 'DB_FloatingPoint', name: 'LReal_987d125', datatype: 'LReal' },
    { db: 'DB_Integers', name: 'Int_12345', datatype: 'Int' }
].map((s) => ({ symbol: `${s.db}.${s.name}`, datatype: s.datatype, db: s.db, name: s.name }));

// Reads a .db source and returns its non-write variables as { name, dt } in
// source order (the *_write test tags are skipped).
function parseVariables(db) {
    const file = path.join(__dirname, '..', 'plc', 's7-1500', `${db}.db`);
    const text = fs.readFileSync(file, 'utf8');

    const varStart = text.search(/\n\s*VAR\b/);
    const varEnd = text.indexOf('END_VAR');
    if (varStart === -1 || varEnd === -1) {
        throw new Error(`Cannot locate VAR block in ${db}.db`);
    }

    const out = [];
    for (const line of text.slice(varStart, varEnd).split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_]\w*)\s*(?:\{[^}]*\})?\s*:\s*([A-Za-z_]\w*)/);
        if (!m) continue;
        const name = m[1];
        const plcType = m[2];
        if (name === 'VAR' || /_write$/i.test(name)) continue;
        const dt = PLC_TO_DT[plcType];
        if (!dt) continue;
        out.push({ name, dt });
    }
    return out;
}

// Picks the first variable matching each requested datatype, in the order the
// datatypes are listed for the section.
function representativeSymbols(section) {
    const variables = parseVariables(section.db);
    return section.datatypes.map((dt) => {
        const hit = variables.find((v) => v.dt === dt);
        if (!hit) throw new Error(`No read symbol for ${section.db} datatype ${dt}`);
        const symbol = `${section.db}.${hit.name}`;
        return { name: symbol, address: symbol, datatype: dt };
    });
}

// Fail loudly if a selected sample symbol does not exist in its .db source.
for (const sig of LIVE_SIGNALS) {
    const exists = parseVariables(sig.db).some((v) => v.name === sig.name);
    if (!exists) {
        throw new Error(`Selected symbol ${sig.symbol} does not exist in ${sig.db}.db`);
    }
}

// Build the symbol list for both read blocks: every representative scalar plus
// representative scalar plus the selected sample signals.
const ALL_SYMBOLS = [];
for (const signal of LIVE_SIGNALS) {
    ALL_SYMBOLS.push({ name: signal.symbol, address: signal.symbol, datatype: signal.datatype });
}
for (const section of SECTIONS) {
    for (const s of representativeSymbols(section)) ALL_SYMBOLS.push(s);
}

// ---------------------------------------------------------------------------
// Dynamic msg.symbols function-node body. Same symbol list as the static
// read node (ALL_SYMBOLS). msg.symbols must be a string[].
// (Uses only string concatenation, never template literals.)
// ---------------------------------------------------------------------------

const BUILD_SYMBOLS_FUNC =
    'msg.symbols = ' + JSON.stringify(
        ALL_SYMBOLS.map((s) => s.name),
        null,
        4
    ) + ';\n' +
    'msg.payload = \'\';\n' +
    'return msg;\n';

// ---------------------------------------------------------------------------
// Assemble the flow nodes.
// ---------------------------------------------------------------------------

const HDR_ID = 'rm_hdr';
const ALL_INJECT_ID = 'rm_inject_all';
const ALL_READ_ID = 'rm_read_all';
const ALL_DEBUG_ID = 'rm_debug_all';
const ALL_COMMENT_ID = 'rm_comment_all';
const LIVE_COMMENT_ID = 'rm_comment_live';
const LIVE_INJECT_ID = 'rm_inject_live';
const LIVE_FN_ID = 'rm_fn_live';
const LIVE_READ_ID = 'rm_read_live';
const LIVE_DEBUG_ID = 'rm_debug_live';

const nodes = [];

nodes.push({
    id: TAB,
    type: 'tab',
    label: 'Read Multiple Symbols',
    disabled: false,
    info: 'Reads multiple values with a single s7-plus read node (one PLC request).\n'
        + '\n'
        + 'The list contains one representative constant per scalar datatype '
        + 'in plc/s7-1500 plus a few sample symbols.\n'
        + '\n'
        + '1) "Read multiple values" (static) — symbols listed in the read node config; '
        + 'one request returns the whole payload object (keyed by symbol).\n'
        + '\n'
        + '2) "Read multiple values" (dynamic) — a function node sets msg.symbols '
        + '(a string[] with the same symbols) at runtime and feeds an '
        + 'unconfigured read node.\n'
        + '\n'
        + 'Regenerate with: node scripts/generate-read-multiple-flow.js'
});

nodes.push({
    id: HDR_ID,
    type: 'comment',
    z: TAB,
    name: 'Read multiple symbols — one s7-plus read node, one request',
    info: '',
    x: 360,
    y: 40,
    wires: []
});

// --- Block 1: static multi-symbol read -------------------------------------

nodes.push({
    id: ALL_COMMENT_ID,
    type: 'comment',
    z: TAB,
    name: '1) Static — multiple values in node config',
    info: '',
    x: 250,
    y: 100,
    wires: []
});

nodes.push({
    id: ALL_INJECT_ID,
    type: 'inject',
    z: TAB,
    name: 'Read multiple values',
    props: [{ p: 'payload' }],
    repeat: '',
    crontab: '',
    once: false,
    onceDelay: 0.1,
    topic: '',
    payload: '',
    payloadType: 'date',
    x: 150,
    y: 160,
    wires: [[ALL_READ_ID]]
});

nodes.push({
    id: ALL_READ_ID,
    type: 's7-plus read',
    z: TAB,
    name: 'read multiple values (config)',
    endpoint: EP,
    symbols: ALL_SYMBOLS,
    outputFormat: DEFAULT_OUTPUT_FORMAT,
    x: 410,
    y: 160,
    wires: [[ALL_DEBUG_ID]]
});

nodes.push({
    id: ALL_DEBUG_ID,
    type: 'debug',
    z: TAB,
    name: 'multiple values',
    active: true,
    tosidebar: true,
    console: false,
    tostatus: false,
    complete: 'payload',
    targetType: 'msg',
    statusVal: '',
    statusType: 'auto',
    x: 660,
    y: 160,
    wires: []
});

// --- Block 2: dynamic msg.symbols read -------------------------------------

nodes.push({
    id: LIVE_COMMENT_ID,
    type: 'comment',
    z: TAB,
    name: '2) Dynamic — same multiple values via msg.symbols',
    info: '',
    x: 280,
    y: 260,
    wires: []
});

nodes.push({
    id: LIVE_INJECT_ID,
    type: 'inject',
    z: TAB,
    name: 'Read multiple values',
    props: [{ p: 'payload' }],
    repeat: '',
    crontab: '',
    once: false,
    onceDelay: 0.1,
    topic: '',
    payload: '',
    payloadType: 'date',
    x: 150,
    y: 320,
    wires: [[LIVE_FN_ID]]
});

nodes.push({
    id: LIVE_FN_ID,
    type: 'function',
    z: TAB,
    name: 'Build msg.symbols',
    func: BUILD_SYMBOLS_FUNC,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 360,
    y: 320,
    wires: [[LIVE_READ_ID]]
});

nodes.push({
    id: LIVE_READ_ID,
    type: 's7-plus read',
    z: TAB,
    name: 'read multiple values (msg.symbols)',
    endpoint: EP,
    symbols: [],
    outputFormat: DEFAULT_OUTPUT_FORMAT,
    x: 600,
    y: 320,
    wires: [[LIVE_DEBUG_ID]]
});

nodes.push({
    id: LIVE_DEBUG_ID,
    type: 'debug',
    z: TAB,
    name: 'multiple values',
    active: true,
    tosidebar: true,
    console: false,
    tostatus: false,
    complete: 'payload',
    targetType: 'msg',
    statusVal: '',
    statusType: 'auto',
    x: 840,
    y: 320,
    wires: []
});

nodes.push(endpointNode());
nodes.push(globalConfigNode('0.0.1'));

const out = path.join(__dirname, '..', 'examples', 'read-multiple-values-flow.json');
fs.writeFileSync(out, JSON.stringify(nodes, null, 4) + '\n');

console.log(`Wrote ${nodes.length} nodes (${ALL_SYMBOLS.length} symbols in the static read) to ${out}`);
