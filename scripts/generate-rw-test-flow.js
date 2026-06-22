'use strict';

// ---------------------------------------------------------------------------
// Generates examples/read-write-test-flow.json: an automated read/write verification
// flow. A single inject starts a sequential test that, for every constant of
// every scalar datatype defined in plc/s7-1500, writes the value into the
// matching *_write tag, reads it back and compares write vs. read-back.
//
// The test never aborts on a failure: it runs to completion and emits one
// result per datatype plus a final summary. A central "Test Runner" function
// node orchestrates one generic s7-plus write and one s7-plus read node
// strictly sequentially (both nodes drop messages while busy).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { EP, DEFAULT_OUTPUT_FORMAT, endpointNode, globalConfigNode } = require('./example-flow-shared');

const TAB = 'rw_test_tab';

// Scalar datatype sections, mirroring scripts/generate-write-flow.js. One
// *_write tag per datatype; the test values come from every constant of that
// datatype defined in the matching DB. Hardware/system datatypes are excluded.
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

// ---------------------------------------------------------------------------
// Literal helpers (shared shape with scripts/generate-write-flow.js)
// ---------------------------------------------------------------------------

function quoted(lit) {
    const m = lit.match(/'([^']*)'/);
    return m ? m[1] : '';
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

// Splits an S7 date-time literal into its components, with the fractional
// seconds truncated/padded to `frac` digits (3 = milliseconds).
function dateTimeParts(lit, frac) {
    const m = lit.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
    const fill = '0'.repeat(frac);
    const f = m[7] ? Number((m[7] + fill).slice(0, frac)) : 0;
    return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6], frac: f };
}

// ---------------------------------------------------------------------------
// literalToTestCase: turn a DB constant value into a JS expression string that
// is used BOTH as the value written to the PLC and as the expected read-back
// value (the per-datatype comparator handles type/precision, e.g. float32 for
// Real, BigInt for 64-bit types, Date.getTime() for date/time types).
//
// We compare write vs. read-back of the *_write tag, NOT against the DB's
// stored constant; so even datatype default values (constants without a BEGIN
// assignment) round-trip self-consistently.
// ---------------------------------------------------------------------------

const DEFAULT_EXPR = {
    Bool: 'false',
    Byte: '0', Word: '0', DWord: '0', LWord: '0n',
    Char: '" "', WChar: '" "', String: '""', WString: '""',
    SInt: '0', Int: '0', DInt: '0', USInt: '0', UInt: '0', UDInt: '0',
    LInt: '0n', ULInt: '0n',
    Real: '0', LReal: '0',
    Date: 'new Date(1990, 0, 1)',
    DateAndTime: 'new Date(Date.UTC(1990, 0, 1, 0, 0, 0, 0))',
    Ldt: 'new Date(0)',
    Dtl: 'new Date(0)',
    TimeOfDay: '0', LTod: '0n',
    Time: '0', S5Time: '0', LTime: '0n'
};

function literalToValueExpr(dt, lit) {
    if (lit == null) {
        if (!(dt in DEFAULT_EXPR)) throw new Error(`No default value for datatype ${dt}`);
        return DEFAULT_EXPR[dt];
    }
    switch (dt) {
        case 'Bool':
            return /true/i.test(lit) ? 'true' : 'false';
        case 'Byte': case 'Word': case 'DWord':
            return String(parseInt(lit.replace(/^16#/i, '').replace(/_/g, ''), 16));
        case 'LWord':
            return '0x' + lit.replace(/^16#/i, '').replace(/_/g, '').toUpperCase() + 'n';
        case 'SInt': case 'Int': case 'DInt':
        case 'USInt': case 'UInt': case 'UDInt':
            return lit.replace(/_/g, '');
        case 'LInt': case 'ULInt':
            return lit.replace(/_/g, '') + 'n';
        case 'Real': case 'LReal':
            return lit.replace(/_/g, '');
        case 'Char': case 'WChar': case 'String': case 'WString':
            return JSON.stringify(quoted(lit));
        case 'Date': {
            const m = lit.match(/(\d{4})-(\d{2})-(\d{2})/);
            return `new Date(${+m[1]}, ${+m[2] - 1}, ${+m[3]})`;
        }
        case 'TimeOfDay':
            return todMs(lit);
        case 'LTod':
            return ltodNs(lit) + 'n';
        case 'DateAndTime': case 'Dtl': case 'Ldt': {
            const p = dateTimeParts(lit, 3);
            return `new Date(Date.UTC(${p.y}, ${p.mo - 1}, ${p.d}, ${p.h}, ${p.mi}, ${p.s}, ${p.frac}))`;
        }
        case 'Time': case 'S5Time':
            return durationMs(lit);
        case 'LTime':
            return durationNs(lit) + 'n';
        default:
            throw new Error(`No value converter for datatype ${dt}`);
    }
}

// Reads a .db source and returns its constant presets (everything except the
// *_write test symbol) with the raw assigned literal (or null for defaults).
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
        out.push({ name, dt, value: literalToValueExpr(dt, assigned[name]) });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Build the TESTS dataset: one entry per *_write tag, with all constants of
// that datatype as test cases (in DB source order).
// ---------------------------------------------------------------------------

const TESTS = [];
for (const section of SECTIONS) {
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
        TESTS.push({
            group: section.title,
            datatype: item.dt,
            symbol: `${section.db}.${item.var}`,
            cases: members.map(c => ({ name: c.name, value: c.value }))
        });
    }
}

// ---------------------------------------------------------------------------
// Render the TESTS dataset as JS source for embedding in the function node.
// `value` is a raw JS expression (number / BigInt literal / Date / string),
// so it must NOT be JSON-encoded.
// ---------------------------------------------------------------------------

function renderTests(tests) {
    const blocks = tests.map((t) => {
        const cases = t.cases
            .map(c => `            { name: ${JSON.stringify(c.name)}, value: ${c.value} }`)
            .join(',\n');
        return [
            '    {',
            `        group: ${JSON.stringify(t.group)},`,
            `        datatype: ${JSON.stringify(t.datatype)},`,
            `        symbol: ${JSON.stringify(t.symbol)},`,
            '        cases: [',
            cases,
            '        ]',
            '    }'
        ].join('\n');
    });
    return '[\n' + blocks.join(',\n') + '\n]';
}

// ---------------------------------------------------------------------------
// Test Runner function node body. Sequential state machine driven by message
// feedback. msg._t carries the phase ('write' | 'read') and the current
// datatype/case indices; msg.symbols is a string[] (read node requirement);
// write uses msg.datatype for the single *_write tag. The write/read nodes
// preserve all msg fields except payload, and the catch node re-delivers the
// same msg with msg.error set.
// (Uses only string concatenation, never template literals.)
// ---------------------------------------------------------------------------

const RUNNER_BODY = `
// ---- comparators (read-back value vs. expected) ----
var eq = function (e, r) { return r === e; };
var bigeq = function (e, r) {
    try { return (typeof r === 'bigint' ? r : BigInt(r)) === (typeof e === 'bigint' ? e : BigInt(e)); }
    catch (_) { return false; }
};
var realeq = function (e, r) { return typeof r === 'number' && r === Math.fround(e); };
var lrealeq = function (e, r) { return r === e || (Number.isNaN(e) && Number.isNaN(r)); };
// Duck-type the Date (getTime) instead of using instanceof, so the comparison
// is robust even if the read-back Date crosses a vm realm boundary into the
// function-node sandbox (where instanceof Date can be false).
var dateeq = function (e, r) {
    var te = e && typeof e.getTime === 'function' ? e.getTime() : Date.parse(e);
    var tr = r && typeof r.getTime === 'function' ? r.getTime() : Date.parse(r);
    return !isNaN(te) && te === tr;
};

var COMPARATORS = {
    Bool: eq,
    Byte: eq, Word: eq, DWord: eq, LWord: bigeq,
    SInt: eq, Int: eq, DInt: eq, USInt: eq, UInt: eq, UDInt: eq,
    LInt: bigeq, ULInt: bigeq,
    Real: realeq, LReal: lrealeq,
    Char: eq, WChar: eq, String: eq, WString: eq,
    Date: dateeq, DateAndTime: dateeq, Ldt: dateeq, Dtl: dateeq,
    TimeOfDay: eq, Time: eq, S5Time: eq,
    LTod: bigeq, LTime: bigeq
};

function show(v) {
    if (typeof v === 'bigint') return v.toString();
    if (v && typeof v.toISOString === 'function') return v.toISOString();
    return v;
}

function tagResult(payload, symbol) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload[symbol]) return payload[symbol];
    var keys = Object.keys(payload);
    return keys.length ? payload[keys[0]] : null;
}

function newAcc() { return { passed: 0, failed: 0, cases: [] }; }

function buildWriteMsg(S) {
    var t = TESTS[S.di];
    var c = t.cases[S.ci];
    return {
        _t: { phase: 'write', di: S.di, ci: S.ci },
        symbols: [t.symbol],
        datatype: t.datatype,
        payload: c.value
    };
}

function buildReadMsg(S) {
    var t = TESTS[S.di];
    return {
        _t: { phase: 'read', di: S.di, ci: S.ci },
        symbols: [t.symbol],
        payload: ''
    };
}

function record(S, t, c, ok, wrote, read, error) {
    S.cur.cases.push({
        name: c.name,
        ok: ok,
        wrote: show(wrote),
        read: read === null || read === undefined ? null : show(read),
        error: error || ''
    });
    if (ok) { S.cur.passed++; S.totalPassed++; } else { S.cur.failed++; S.totalFailed++; }
    S.totalCases++;
}

// Advance to the next case; emit a per-datatype result when a datatype is
// finished and a final summary when all datatypes are done.
function advance(S) {
    var t = TESTS[S.di];
    S.ci++;
    if (S.ci < t.cases.length) {
        context.set('state', S);
        return [buildWriteMsg(S), null, null, null];
    }

    var result = {
        topic: t.group + '/' + t.datatype,
        payload: {
            group: t.group,
            datatype: t.datatype,
            symbol: t.symbol,
            total: t.cases.length,
            passed: S.cur.passed,
            failed: S.cur.failed,
            cases: S.cur.cases
        }
    };
    S.results.push({ group: t.group, datatype: t.datatype, total: t.cases.length, passed: S.cur.passed, failed: S.cur.failed });
    node.status({ fill: S.cur.failed ? 'yellow' : 'green', shape: 'dot', text: t.datatype + ': ' + S.cur.passed + '/' + t.cases.length + ' ok' });

    S.di++;
    S.ci = 0;
    if (S.di < TESTS.length) {
        S.cur = newAcc();
        context.set('state', S);
        return [buildWriteMsg(S), null, result, null];
    }

    S.running = false;
    context.set('state', S);
    var summary = {
        topic: 'SUMMARY',
        payload: {
            totalDatatypes: TESTS.length,
            totalCases: S.totalCases,
            passed: S.totalPassed,
            failed: S.totalFailed,
            failures: S.results.filter(function (r) { return r.failed > 0; })
        }
    };
    node.status({ fill: S.totalFailed ? 'red' : 'green', shape: 'dot', text: 'done: ' + S.totalPassed + '/' + S.totalCases + ' ok' });
    return [null, null, result, summary];
}

var S = context.get('state');

// Start trigger (inject): no _t marker.
if (!msg || !msg._t) {
    if (S && S.running) {
        node.warn('R/W test already running, ignoring start trigger');
        return null;
    }
    S = {
        running: true,
        di: 0,
        ci: 0,
        cur: newAcc(),
        results: [],
        totalCases: 0,
        totalPassed: 0,
        totalFailed: 0
    };
    context.set('state', S);
    node.status({ fill: 'blue', shape: 'dot', text: 'running...' });
    return [buildWriteMsg(S), null, null, null];
}

// Stray feedback (e.g. after a completed run) is ignored.
if (!S || !S.running) {
    return null;
}

var t = TESTS[S.di];
var c = t.cases[S.ci];
var phase = msg._t.phase;
var errText = msg.error && msg.error.message ? msg.error.message : null;

if (phase === 'write') {
    var wr = tagResult(msg.payload, t.symbol);
    if (errText || !wr || wr.status !== 'ok') {
        record(S, t, c, false, c.value, null, errText || (wr && wr.error) || 'write failed');
        return advance(S);
    }
    // write ok -> read the same tag back
    return [null, buildReadMsg(S), null, null];
}

if (phase === 'read') {
    var rd = tagResult(msg.payload, t.symbol);
    if (errText || !rd || rd.status !== 'ok') {
        record(S, t, c, false, c.value, null, errText || (rd && rd.error) || 'read failed');
        return advance(S);
    }
    var cmp = COMPARATORS[t.datatype] || eq;
    var ok = cmp(c.value, rd.value);
    var note = ok ? '' : 'value mismatch';
    record(S, t, c, ok, c.value, rd.value, note);
    return advance(S);
}

return null;
`;

const RUNNER_FUNC = 'const TESTS = ' + renderTests(TESTS) + ';\n' + RUNNER_BODY;

// ---------------------------------------------------------------------------
// Assemble the flow nodes.
// ---------------------------------------------------------------------------

const RUNNER_ID = 'rw_test_runner';
const WRITE_ID = 'rw_test_write';
const READ_ID = 'rw_test_read';
const CATCH_ID = 'rw_test_catch';
const DEBUG_RESULT_ID = 'rw_test_dbg_result';
const DEBUG_SUMMARY_ID = 'rw_test_dbg_summary';
const INJECT_ID = 'rw_test_start';

const nodes = [];

nodes.push({
    id: TAB,
    type: 'tab',
    label: 'R/W Verification Test',
    disabled: false,
    info: 'Automated read/write verification for all scalar datatypes in '
        + 'plc/s7-1500.\n'
        + 'Press the "Run all R/W tests" inject. The Test Runner writes every '
        + 'constant value of every datatype into the matching *_write tag, '
        + 'reads it back and compares write vs. read-back.\n'
        + 'The run never aborts on a failure: it completes fully and emits one '
        + 'result per datatype ("Datatype Result") plus a final "Summary".\n'
        + 'DTL round-trips as Date (ms resolution).\n'
        + 'Regenerate with: node scripts/generate-rw-test-flow.js'
});

nodes.push({
    id: 'rw_test_hdr',
    type: 'comment',
    z: TAB,
    name: 'R/W verification — write, read back and compare every scalar constant',
    info: '',
    x: 320,
    y: 40,
    wires: []
});

nodes.push({
    id: INJECT_ID,
    type: 'inject',
    z: TAB,
    name: 'Run all R/W tests',
    props: [{ p: 'payload' }],
    repeat: '',
    crontab: '',
    once: false,
    onceDelay: 0.1,
    topic: '',
    payload: '',
    payloadType: 'date',
    x: 150,
    y: 140,
    wires: [[RUNNER_ID]]
});

nodes.push({
    id: RUNNER_ID,
    type: 'function',
    z: TAB,
    name: 'Test Runner',
    func: RUNNER_FUNC,
    outputs: 4,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 410,
    y: 140,
    wires: [
        [WRITE_ID],
        [READ_ID],
        [DEBUG_RESULT_ID],
        [DEBUG_SUMMARY_ID]
    ]
});

nodes.push({
    id: WRITE_ID,
    type: 's7-plus write',
    z: TAB,
    name: 'write *_write',
    endpoint: EP,
    symbols: [],
    outputFormat: DEFAULT_OUTPUT_FORMAT,
    x: 690,
    y: 100,
    wires: [[RUNNER_ID]]
});

nodes.push({
    id: READ_ID,
    type: 's7-plus read',
    z: TAB,
    name: 'read *_write',
    endpoint: EP,
    symbols: [],
    outputFormat: DEFAULT_OUTPUT_FORMAT,
    x: 690,
    y: 180,
    wires: [[RUNNER_ID]]
});

nodes.push({
    id: CATCH_ID,
    type: 'catch',
    z: TAB,
    name: 'write/read errors',
    scope: [WRITE_ID, READ_ID],
    uncaught: false,
    x: 410,
    y: 260,
    wires: [[RUNNER_ID]]
});

nodes.push({
    id: DEBUG_RESULT_ID,
    type: 'debug',
    z: TAB,
    name: 'Datatype Result',
    active: true,
    tosidebar: true,
    console: false,
    tostatus: false,
    complete: 'payload',
    targetType: 'msg',
    statusVal: '',
    statusType: 'auto',
    x: 720,
    y: 280,
    wires: []
});

nodes.push({
    id: DEBUG_SUMMARY_ID,
    type: 'debug',
    z: TAB,
    name: 'Summary',
    active: true,
    tosidebar: true,
    console: false,
    tostatus: false,
    complete: 'payload',
    targetType: 'msg',
    statusVal: '',
    statusType: 'auto',
    x: 700,
    y: 340,
    wires: []
});

nodes.push(endpointNode());
nodes.push(globalConfigNode('0.0.1'));

const out = path.join(__dirname, '..', 'examples', 'read-write-test-flow.json');
fs.writeFileSync(out, JSON.stringify(nodes, null, 4) + '\n');

const totalCases = TESTS.reduce((n, t) => n + t.cases.length, 0);
console.log(`Wrote ${nodes.length} nodes (${TESTS.length} datatypes, ${totalCases} test cases) to ${out}`);
