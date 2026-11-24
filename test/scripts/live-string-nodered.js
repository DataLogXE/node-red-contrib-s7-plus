'use strict';

/**
 * Live test through a running Node-RED: writes and reads every String /
 * WString variant of DB_StringTest (plc/s7-1500/DB_StringTest.db) with the
 * real s7-plus write / read nodes.
 *
 * The script deploys a temporary flow tab over the Node-RED admin API
 * (HTTP in -> s7-plus write/read -> HTTP response), runs the checks and
 * removes the tab again. Existing flows are not touched.
 *
 * Tests DB_StringTest (optimized) and DB_StringTestStd (standard access).
 * --skip-missing-db skips a DB that is not loaded instead of failing.
 *
 * Usage: node test/scripts/live-string-nodered.js <node-red-url> <plc-ip> [<plc-ip> ...] [--skip-missing-db]
 * Example: node test/scripts/live-string-nodered.js http://raspberrypi01:1880 192.168.178.240 192.168.178.241
 */

const BASE = (process.argv[2] || '').replace(/\/$/, '');
const PLCS = process.argv.slice(3).filter(a => !a.startsWith('--'));
if (!BASE || !PLCS.length) {
    console.error('Usage: node test/scripts/live-string-nodered.js <node-red-url> <plc-ip> [<plc-ip> ...]');
    process.exit(1);
}

let DB = 'DB_StringTest';
// [member, type, declared length]
const VAR_SETS = {};
VAR_SETS.DB_StringTest = [
    ['S_Len1', 'String', 1], ['S_Len2', 'String', 2], ['S_Len10', 'String', 10], ['S_Len80', 'String', 80],
    ['S_Len253', 'String', 253], ['S_Len254', 'String', 254], ['S_Default', 'String', 254], ['S_Init', 'String', 20],
    ['W_Len1', 'WString', 1], ['W_Len2', 'WString', 2], ['W_Len10', 'WString', 10], ['W_Len80', 'WString', 80],
    ['W_Len254', 'WString', 254], ['W_Default', 'WString', 254], ['W_Len255', 'WString', 255],
    ['W_Len1000', 'WString', 1000], ['W_Len4000', 'WString', 4000], ['W_Len16382', 'WString', 16382],
    ['W_Init', 'WString', 20],
    ['S_Arr[0]', 'String', 8], ['S_Arr[1]', 'String', 8], ['S_Arr[2]', 'String', 8], ['S_Arr[3]', 'String', 8],
    ['W_Arr[0]', 'WString', 8], ['W_Arr[1]', 'WString', 8], ['W_Arr[2]', 'WString', 8], ['W_Arr[3]', 'WString', 8],
    ['St.S5', 'String', 5], ['St.W5', 'WString', 5]
];
// Same idea in a DB with standard (non-optimized) access.
VAR_SETS.DB_StringTestStd = [
    ['S_Len1', 'String', 1], ['S_Len10', 'String', 10], ['S_Len80', 'String', 80], ['S_Len254', 'String', 254],
    ['S_Default', 'String', 254],
    ['W_Len1', 'WString', 1], ['W_Len10', 'WString', 10], ['W_Len254', 'WString', 254], ['W_Default', 'WString', 254],
    ['W_Len1000', 'WString', 1000],
    ['S_Arr[0]', 'String', 8], ['S_Arr[1]', 'String', 8], ['S_Arr[2]', 'String', 8], ['S_Arr[3]', 'String', 8],
    ['W_Arr[0]', 'WString', 8], ['W_Arr[1]', 'WString', 8], ['W_Arr[2]', 'WString', 8], ['W_Arr[3]', 'WString', 8],
    ['St.S5', 'String', 5], ['St.W5', 'WString', 5]
];
let VARS = [];
function useDb(name) {
    DB = name;
    VARS = VAR_SETS[name].map(([member, type, len]) => ({ member, type, len, sym: `${DB}.${member}` }));
}

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label, info = '') {
    if (cond) { pass++; return; }
    fail++;
    failures.push(label);
    console.log(`  FAIL ${label}  -> ${String(info).slice(0, 300)}`);
}
const short = (v) => (typeof v === 'string' && v.length > 16 ? `${JSON.stringify(v.slice(0, 10))}...(${v.length})` : JSON.stringify(v));

// Deterministic test text of exactly n UTF-16 code units.
// String: all of ISO-8859-1 from 0x20 to 0xFF. WString: BMP characters from
// several scripts incl. the euro sign, so every element is a real 16-bit value.
const WCHARS = 'AäΣЖ€אع中あ한ßz';
function text(type, n, seed = 0) {
    let s = '';
    for (let i = 0; i < n; i++) {
        s += type === 'String'
            ? String.fromCharCode(0x20 + ((i * 7 + seed * 13) % 0xE0))
            : WCHARS[(i + seed) % WCHARS.length];
    }
    return s;
}

async function post(url, body) {
    const r = await fetch(BASE + url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const t = await r.text();
    try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
}

function buildFlow() {
    const nodes = [];
    const configs = [];
    const prep = 'const b = msg.payload || {};\nmsg.symbols = b.symbols;\nmsg.payload = b.values;\nreturn msg;';
    let y = 60;
    PLCS.forEach((ip, i) => {
        const ep = `s7strtest_ep${i}`;
        configs.push({ id: ep, type: 's7-plus endpoint', name: `string test ${ip}`, address: ip, timeout: 10000 });
        for (const [k, type] of [['w', 's7-plus write'], ['r', 's7-plus read']]) {
            const b = `s7strtest_${k}${i}`;
            nodes.push({ id: `${b}in`, type: 'http in', url: `/s7strtest/${k}${i}`, method: 'post', x: 120, y, wires: [[`${b}fn`]] });
            nodes.push({ id: `${b}fn`, type: 'function', func: prep, outputs: 1, x: 300, y, wires: [[`${b}node`]] });
            nodes.push({ id: `${b}node`, type, endpoint: ep, symbols: [], outputFormat: 'object', x: 470, y, wires: [[`${b}out`]] });
            nodes.push({ id: `${b}out`, type: 'http response', x: 640, y, wires: [] });
            y += 50;
        }
    });
    nodes.push({ id: 's7strtest_catch', type: 'catch', scope: null, uncaught: false, x: 120, y, wires: [['s7strtest_catchfn']] });
    nodes.push({
        id: 's7strtest_catchfn', type: 'function', outputs: 1, x: 300, y, wires: [['s7strtest_catchout']],
        func: 'if (!msg.res) return null;\nmsg.statusCode = 500;\nmsg.payload = { nodeError: msg.error.message };\nreturn msg;'
    });
    nodes.push({ id: 's7strtest_catchout', type: 'http response', x: 470, y, wires: [] });
    return { label: 'S7+ String-Test (temp)', nodes, configs };
}

async function testPlc(i, ip) {
    console.log(`\n##### PLC ${ip}  ${DB} (${VARS.length} strings)`);
    const write = (symbols, values) => post(`/s7strtest/w${i}`, { symbols, values });
    const read = async (symbols) => (await post(`/s7strtest/r${i}`, { symbols })).body;
    const all = VARS.map(v => v.sym);
    const guardSyms = [`${DB}.Guard`, `${DB}.St.Num`];

    // --- start state -------------------------------------------------
    let r = await read([...all, ...guardSyms]);
    const missing = [...all, ...guardSyms].filter(s => !r[s] || r[s].status !== 'ok');
    if (missing.length === all.length + guardSyms.length && process.argv.includes('--skip-missing-db')) {
        console.log(`  SKIPPED: ${DB} is not loaded on this PLC`);
        return;
    }
    ok(missing.length === 0, `all variables of ${DB} readable`, JSON.stringify(missing.length ? { missing, sample: r[missing[0]] || r } : ''));
    if (missing.length) return;
    const guard0 = r[guardSyms[0]].value;
    const num0 = r[guardSyms[1]].value;
    console.log(`  start: Guard=${guard0} St.Num=${num0}`);

    // --- per variable: lengths 0, 1, n-1, n, then too long -----------
    for (const v of VARS) {
        const lens = [...new Set([0, 1, Math.floor(v.len / 2), v.len - 1, v.len])].filter(n => n >= 0 && n <= v.len);
        for (const n of lens) {
            const t = text(v.type, n, n);
            const w = await write([v.sym], t);
            const rb = (await read([v.sym]))[v.sym];
            ok(w.status === 200 && w.body[v.sym] && (w.body[v.sym] || {}).status === 'ok' && rb.status === 'ok' && rb.value === t,
                `${v.member} (${v.type}[${v.len}]) <- ${n} chars`,
                `${JSON.stringify(w.body).slice(0, 160)} rb=${short(rb.value)}`);
        }
        const before = (await read([v.sym]))[v.sym].value;
        for (const n of [v.len + 1, v.len + 100]) {
            const w = await write([v.sym], text(v.type, n, 3));
            const e = w.status === 200 ? w.body[v.sym] : null;
            const rb = (await read([v.sym]))[v.sym].value;
            ok(e && e.status === 'error' && e.value === null
                && e.error.includes(`${n} characters`) && e.error.includes(`declared as ${v.type}[${v.len}]`) && rb === before,
                `${v.member} (${v.type}[${v.len}]) rejects ${n} chars, value unchanged`, JSON.stringify(w.body).slice(0, 200));
        }
        if (v.type === 'String') {
            const w = await write([v.sym], '€');
            const e = w.status === 200 ? w.body[v.sym] : null;
            ok(e && e.status === 'error' && /not representable/.test(e.error) && (await read([v.sym]))[v.sym].value === before,
                `${v.member} rejects a non ISO-8859-1 character`, JSON.stringify(w.body).slice(0, 200));
        }
        // shorter text after a full one must not leave old characters behind
        const w2 = await write([v.sym], '');
        ok(w2.body[v.sym] && (w2.body[v.sym] || {}).status === 'ok' && (await read([v.sym]))[v.sym].value === '', `${v.member} cleared again`);
    }

    // --- all variables in ONE message, each filled completely ---------
    const full = Object.fromEntries(VARS.map((v, k) => [v.sym, text(v.type, v.len, k + 1)]));
    r = await write(all, full);
    ok(r.status === 200 && all.every(s => r.body[s] && (r.body[s] || {}).status === 'ok'), 'one message: all strings filled to their declared length',
        JSON.stringify(Object.entries(r.body).filter(([, x]) => !x || x.status !== 'ok').slice(0, 3)));
    let rb = await read(all);
    const wrong = all.filter(s => (rb[s] || {}).value !== full[s]);
    ok(wrong.length === 0, 'one message: every string read back unchanged (no neighbour overwritten)', wrong.join(', '));

    // --- one message with different short texts ----------------------
    const mixed = Object.fromEntries(VARS.map((v, k) => [v.sym, text(v.type, Math.min(v.len, 1 + (k % 7)), k + 40)]));
    r = await write(all, mixed);
    rb = await read(all);
    ok(all.every(s => r.body[s] && (r.body[s] || {}).status === 'ok' && (rb[s] || {}).value === mixed[s]), 'one message: all strings with short texts',
        all.filter(s => (rb[s] || {}).value !== mixed[s]).join(', '));

    // --- one message with valid and invalid values --------------------
    const partial = {};
    VARS.forEach((v, k) => { partial[v.sym] = k % 3 === 0 ? text(v.type, v.len + 1, 5) : text(v.type, Math.min(v.len, 2), k); });
    r = await write(all, partial);
    rb = await read(all);
    ok(VARS.every((v, k) => (k % 3 === 0
        ? (r.body[v.sym] || {}).status === 'error' && (rb[v.sym] || {}).value === mixed[v.sym]
        : (r.body[v.sym] || {}).status === 'ok' && (rb[v.sym] || {}).value === partial[v.sym])),
    'one message: too long values rejected per tag, all others written',
    JSON.stringify(VARS.filter((v, k) => (k % 3 === 0) !== ((r.body[v.sym] || {}).status === 'error')).map(v => v.member)));

    // --- surrogate pairs on WString ----------------------------------
    const emoji = '\u{1F600}\u{1F680}';
    r = await write([`${DB}.W_Len10`], emoji);
    ok((r.body[`${DB}.W_Len10`] || {}).status === 'ok' && (await read([`${DB}.W_Len10`]))[`${DB}.W_Len10`].value === emoji, 'WString keeps surrogate pairs (emoji)');
    r = await write([`${DB}.W_Len1`], '\u{1F600}');
    ok((r.body[`${DB}.W_Len1`] || {}).status === 'error', 'WString[1] rejects one emoji (2 code units)', JSON.stringify(r.body));

    // --- repeated writes ---------------------------------------------
    let cyclesOk = true;
    for (let k = 0; k < 30; k++) {
        const vals = Object.fromEntries(VARS.map(v => [v.sym, text(v.type, k % (Math.min(v.len, 40) + 1), k)]));
        const w = await write(all, vals);
        const b = await read(all);
        cyclesOk = cyclesOk && all.every(s => (w.body[s] || {}).status === 'ok' && (b[s] || {}).value === vals[s]);
    }
    ok(cyclesOk, '30 write/readback cycles over all strings');

    // --- neighbours untouched, restore start state ---------------------
    r = await read(guardSyms);
    ok(r[guardSyms[0]].value === guard0 && r[guardSyms[1]].value === num0, `Guard (${guard0}) and St.Num unchanged after all writes`, JSON.stringify(r));
    const restore = Object.fromEntries(VARS.map(v => [v.sym, '']));
    if (`${DB}.S_Init` in restore) restore[`${DB}.S_Init`] = 'Init äöü';
    if (`${DB}.W_Init` in restore) restore[`${DB}.W_Init`] = 'Init ΣΛΔ';
    r = await write(all, restore);
    rb = await read(all);
    ok(all.every(s => (r.body[s] || {}).status === 'ok' && (rb[s] || {}).value === restore[s]), 'start state restored');
}

(async () => {
    const created = await post('/flow', buildFlow());
    if (created.status !== 200 || !created.body.id) throw new Error(`cannot deploy test tab: ${created.status} ${JSON.stringify(created.body)}`);
    console.log(`temporary test tab ${created.body.id} deployed on ${BASE}`);
    try {
        await new Promise(res => setTimeout(res, 6000)); // let the endpoints connect
        for (let i = 0; i < PLCS.length; i++) {
            for (const db of Object.keys(VAR_SETS)) {
                useDb(db);
                await testPlc(i, PLCS[i]);
            }
        }
    } finally {
        const del = await fetch(`${BASE}/flow/${created.body.id}`, { method: 'DELETE' });
        console.log(`\ntemporary test tab removed (${del.status})`);
    }
    console.log(`RESULT: ${pass} pass, ${fail} fail`);
    if (fail) console.log('failed: ' + failures.join(' | '));
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
