'use strict';

/**
 * Live integration test: read presets + write/readback for S7 datatypes.
 *
 * Usage:  node test/scripts/live-datatype-rw.js <host> [port] [password]
 * Example: node test/scripts/live-datatype-rw.js 192.168.0.1 102
 *
 * Env: S7_HOST, S7_PORT, S7_PASSWORD, S7_DB_PREFIX (default: DB), S7_WRITE_MARKER (default: write)
 */

const path = require('path');
const { S7CommPlusClient, ItemAddress } = require(path.join('..', '..', 'lib', 's7plus', 'client'));
const { decodeReadValue, encodeWriteValue } = require(path.join('..', '..', 'lib', 's7plus', 'pvalue-codec'));

const HOST = process.env.S7_HOST || process.argv[2];
if (!HOST) {
    console.error('Usage: node test/scripts/live-datatype-rw.js <host> [port] [password]');
    process.exit(1);
}
const PORT = parseInt(process.env.S7_PORT || process.argv[3] || '102', 10);
const PASSWORD = process.env.S7_PASSWORD || process.argv[4] || '';
const DB_PREFIX = process.env.S7_DB_PREFIX || 'DB';
const WRITE_MARKER = process.env.S7_WRITE_MARKER || 'write';
const TIMEOUT_MS = 10000;

function ts() { return new Date().toISOString().split('T')[1].replace('Z', ''); }
function log(...a) { console.log(`[${ts()}]`, ...a); }

// ── README type contract ─────────────────────────────────────────────
const TYPE_CONTRACT = {
    BBool:       'boolean',
    Bool:        'boolean',
    Byte:        'number',
    Word:        'number',
    DWord:       'number',
    LWord:       'number',
    Char:        'string',
    WChar:       'string',
    String:      'string',
    WString:     'string',
    SInt:        'number',
    Int:         'number',
    DInt:        'number',
    USInt:       'number',
    UInt:        'number',
    UDInt:       'number',
    LInt:        'bigint',
    ULInt:       'bigint',
    Real:        'number',
    LReal:       'number',
    Time:        'number',
    S5Time:      'number',
    LTime:       'bigint',
    TimeOfDay:   'number',
    LTod:        'bigint',
    Date:        'Date',
    DateAndTime: 'Date',
    Ldt:         'Date',
    Dtl:         'Date',
};

// ── Write test values per datatype ───────────────────────────────────
const WRITE_TESTS = {
    BBool:  [false, true],
    Bool:   [false, true],
    Byte:   [0, 255, 0xAB],
    Word:   [0, 0xFFFF, 0xCAFE],
    DWord:  [0, 0xFFFFFFFF, 0xDEADBEEF],
    LWord:  [0n, 0xFFFFFFFFFFFFFFFFn, 0x123456789ABCDEFn],
    Char:   ['A', 'Z', '0'],
    WChar:  ['A', 'Z', '\u03A3'],
    String: ['', 'Hello S7', 'Test'],
    WString:['', 'Hallo Welt', '\u03A3\u039B\u0394'],
    SInt:   [-128, 127, 0, -1],
    Int:    [-32768, 32767, 0, -1],
    DInt:   [-2147483648, 2147483647, 0, -1],
    USInt:  [0, 255, 128],
    UInt:   [0, 65535, 12345],
    UDInt:  [0, 0xFFFFFFFF, 123456789],
    LInt:   [-9223372036854775808n, 9223372036854775807n, 0n, 1234567890123456789n],
    ULInt:  [0n, 0xFFFFFFFFFFFFFFFFn, 12345678901234567890n],
    Real:   [0.0, -123.456, 987.654],
    LReal:  [0.0, -1.23456789012345e10, 9.87654321098765e10],
    Time:   [0, 1000, -5000, 86400000],
    S5Time: [0, 120, 12300, 9990000],
    LTime:  [0n, 1000000n, -5000000n, 86400000000000n],
    TimeOfDay: [0, 43200000, 86399999],
    LTod:   [0n, 43200000000000n, 86399999999999n],
    Date:   [new Date('1990-01-01'), new Date('2023-10-28'), new Date('2050-06-15')],
    Ldt:    [new Date('1970-01-01'), new Date('2023-10-28T14:30:00Z')],
    DateAndTime: [new Date('1990-01-01'), new Date('2023-10-28T23:58:59.123Z')],
    Dtl:    [new Date('1970-01-01T00:00:00Z'), new Date('2008-10-25T08:12:34.567Z')],
};

// ── Comparison helpers ───────────────────────────────────────────────
function floatClose(a, b) {
    if (a === 0 && b === 0) return true;
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b)) < 1e-4;
}

function valuesMatch(actual, expected, s7type) {
    if (actual === expected) return true;

    switch (s7type) {
        case 'Real':
            return floatClose(actual, expected);
        case 'LReal':
            return floatClose(actual, expected);
        case 'Char':
        case 'WChar':
            if (typeof actual === 'string' && typeof expected === 'string')
                return actual === expected;
            return false;
        case 'String':
        case 'WString':
            return String(actual) === String(expected);
        case 'LInt':
        case 'ULInt':
        case 'LTime':
        case 'LTod':
            return BigInt(actual) === BigInt(expected);
        case 'LWord':
            if (typeof expected === 'bigint') return actual === Number(expected);
            return actual === expected;
        case 'Date':
        case 'Ldt':
        case 'Dtl':
        case 'DateAndTime': {
            const da = actual instanceof Date ? actual.getTime() : actual;
            const de = expected instanceof Date ? expected.getTime() : expected;
            return Math.abs(da - de) < 1000;
        }
        case 'S5Time':
            return Math.abs(actual - expected) <= expected * 0.05 + 10;
        default:
            return actual === expected;
    }
}

function jsTypeOf(v) {
    if (v instanceof Date) return 'Date';
    if (Buffer.isBuffer(v)) return 'Buffer';
    return typeof v;
}

function fmt(v) {
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'bigint') return v.toString() + 'n';
    if (typeof v === 'string') return JSON.stringify(v);
    return String(v);
}

// ── Browse helper ────────────────────────────────────────────────────
async function collectLeaves(client, parentId, parentLabel) {
    const { nodes: children } = await client.browseChildren(parentId);
    const leaves = [];
    for (const c of children) {
        if (c.isLeaf) {
            const r = await client.browseResolve(c.id);
            leaves.push({
                path: `${parentLabel}.${c.label}`,
                varName: c.label,
                datatype: r.datatype || c.datatype,
                address: r.address,
            });
        } else if (c.hasChildren && c.nodeKind !== 'array') {
            leaves.push(...await collectLeaves(client, c.id, `${parentLabel}.${c.label}`));
        }
    }
    return leaves;
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
    const client = new S7CommPlusClient();
    log(`Connecting to ${HOST}:${PORT} ...`);
    try { await client.connect(HOST, PASSWORD, '', TIMEOUT_MS, PORT); }
    catch (e) { log('CONNECT FAILED:', e.message); process.exit(2); }
    log('Connected.');

    const { nodes: roots } = await client.browseRoots();
    const dbRoots = roots.filter(r => r.label.startsWith(DB_PREFIX));
    log(`Found ${dbRoots.length} ${DB_PREFIX}* block(s): ${dbRoots.map(r => r.label).join(', ')}`);
    if (!dbRoots.length) { await client.disconnect(); process.exit(3); }

    const allLeaves = [];
    for (const root of dbRoots) {
        const leaves = await collectLeaves(client, root.id, root.label);
        log(`  ${root.label}: ${leaves.length} leaf(s)`);
        allLeaves.push(...leaves);
    }
    log(`Total: ${allLeaves.length} leaves\n`);

    let pass = 0, fail = 0, skip = 0;
    const failures = [];

    // ── Phase 1: Read all values, check JS type ──────────────────
    log('═══ Phase 1: Read + type check ═══');
    for (const leaf of allLeaves) {
        const expected = TYPE_CONTRACT[leaf.datatype];
        if (!expected) { skip++; continue; }

        const addr = new ItemAddress(leaf.address);
        try {
            const { values, errors } = await client.readValues([addr]);
            if (errors[0] && errors[0] !== 0n) throw new Error(`Read error 0x${errors[0].toString(16)}`);
            const decoded = decodeReadValue(values[0], leaf.datatype);
            const actual = jsTypeOf(decoded);
            if (actual !== expected) {
                fail++;
                const msg = `TYPE ${leaf.path} [${leaf.datatype}]: expected ${expected}, got ${actual} = ${fmt(decoded)}`;
                log(`  FAIL  ${msg}`);
                failures.push(msg);
            } else {
                pass++;
            }
        } catch (e) {
            fail++;
            const msg = `READ ${leaf.path} [${leaf.datatype}]: ${e.message}`;
            log(`  FAIL  ${msg}`);
            failures.push(msg);
        }
    }
    log(`  Phase 1 done: ${pass} pass, ${fail} fail, ${skip} skip\n`);

    // ── Phase 2: Write test values to writable vars, readback ──────
    log('═══ Phase 2: Write + readback ═══');
    const writeLeaves = allLeaves.filter(l => l.varName.toLowerCase().includes(WRITE_MARKER.toLowerCase()));
    log(`  ${writeLeaves.length} writable symbol(s) matching marker "${WRITE_MARKER}"`);

    for (const leaf of writeLeaves) {
        const tests = WRITE_TESTS[leaf.datatype];
        if (!tests) {
            log(`  SKIP  ${leaf.path} [${leaf.datatype}] – no write tests defined`);
            skip++;
            continue;
        }

        const addr = new ItemAddress(leaf.address);
        for (const tv of tests) {
            const label = `${leaf.path} [${leaf.datatype}] <- ${fmt(tv)}`;
            try {
                const wval = encodeWriteValue(tv, leaf.datatype);
                await client.writeValues([addr], [wval]);

                const { values, errors } = await client.readValues([addr]);
                if (errors[0] && errors[0] !== 0n) throw new Error(`Read error 0x${errors[0].toString(16)}`);
                const decoded = decodeReadValue(values[0], leaf.datatype);

                const expectedType = TYPE_CONTRACT[leaf.datatype];
                const actualType = jsTypeOf(decoded);
                if (expectedType && actualType !== expectedType) {
                    throw new Error(`Type: expected ${expectedType}, got ${actualType} (${fmt(decoded)})`);
                }

                if (!valuesMatch(decoded, tv, leaf.datatype)) {
                    throw new Error(`Value: wrote ${fmt(tv)}, read ${fmt(decoded)}`);
                }

                log(`  PASS  ${label}  =>  ${fmt(decoded)}`);
                pass++;
            } catch (e) {
                fail++;
                const msg = `WRITE ${label}: ${e.message}`;
                log(`  FAIL  ${msg}`);
                failures.push(msg);
            }
        }
    }

    // ── Summary ──────────────────────────────────────────────────
    log('\n═══════════════════════════════════════════════════════');
    log(`  RESULT: ${pass} PASS, ${fail} FAIL, ${skip} SKIP`);
    log('═══════════════════════════════════════════════════════');

    if (failures.length) {
        log('\nFAILURES:');
        for (const f of failures) log(`  ${f}`);
    }

    const tested = new Set(allLeaves.filter(l => TYPE_CONTRACT[l.datatype]).map(l => l.datatype));
    const missed = new Set(allLeaves.filter(l => !TYPE_CONTRACT[l.datatype]).map(l => l.datatype));
    log(`\nCoverage: ${[...tested].sort().join(', ')}`);
    if (missed.size) log(`Not covered: ${[...missed].sort().join(', ')}`);

    await client.disconnect().catch(() => {});
    log('Done.');
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { log('FATAL:', e.stack || e); process.exit(1); });
