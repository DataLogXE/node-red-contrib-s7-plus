'use strict';

/**
 * Validate + time the real browseFull (Explore node) against a live PLC.
 *
 * Exercises the actual S7CommPlusClient.browseFull code path for both the
 * full (everything) scope and per-DB scopes, so we can confirm:
 *   - scoped browse no longer downloads the whole type catalog (bytes/time),
 *   - scoped symbol counts match the full-browse counts exactly,
 *   - the everything path is unchanged.
 *
 * Usage: node test/scripts/live-browse-timing.js <host> [port] [password] [timeoutMs]
 * Env:   S7_HOST, S7_PORT, S7_PASSWORD, S7_SCOPE_DBS (comma-separated)
 */

const path = require('path');
const { S7CommPlusClient } = require(path.join('..', '..', 'lib', 's7plus', 'client'));

const HOST = process.env.S7_HOST || process.argv[2];
if (!HOST) {
    console.error('Usage: node test/scripts/live-browse-timing.js <host> [port] [password] [timeoutMs]');
    process.exit(1);
}
const PORT = parseInt(process.env.S7_PORT || process.argv[3] || '102', 10);
const PASSWORD = process.env.S7_PASSWORD || process.argv[4] || '';
const TIMEOUT_MS = parseInt(process.argv[5] || process.env.S7_TIMEOUT || '120000', 10);
const SCOPE_DBS = (process.env.S7_SCOPE_DBS || 'GB-DriveData,SV-Recipe-DB,LB-Matrix-Parameter-DB')
    .split(',').map(s => s.trim()).filter(Boolean);

function ms(t) { return `${(Date.now() - t).toString().padStart(7)} ms`; }

async function main() {
    const client = new S7CommPlusClient();

    // Count inbound frames + bytes so we can see a scoped browse transfer
    // a fraction of the data the full type catalog requires.
    let rxFragments = 0;
    let rxBytes = 0;
    const origOnData = client._onDataReceived.bind(client);
    client._onDataReceived = (pdu) => { rxFragments++; rxBytes += pdu.length; return origOnData(pdu); };
    const resetRx = () => { rxFragments = 0; rxBytes = 0; };

    console.log(`\n=== browseFull validation: ${HOST}:${PORT} (timeout ${TIMEOUT_MS} ms) ===\n`);

    let t = Date.now();
    await client.connect(HOST, PASSWORD, '', TIMEOUT_MS, PORT);
    console.log(`connect ......................... ${ms(t)}\n`);

    // 1) Full browse (everything) — baseline counts per root.
    resetRx();
    t = Date.now();
    const full = await client.browseFull({ scope: { everything: true } });
    console.log(`EVERYTHING ...................... ${ms(t)}  rx ${rxFragments} frag / ${rxBytes} bytes`);
    console.log(`   -> ${full.meta.symbolCount} symbol(s), ${full.meta.dbCount} DB(s)`);

    const fullPerRoot = new Map();
    for (const s of full.symbols) {
        const root = String(s.name).split(/[.[]/)[0];
        fullPerRoot.set(root, (fullPerRoot.get(root) || 0) + 1);
    }

    // 2) Scoped browse per DB — must match the full per-root counts.
    console.log('');
    for (const db of SCOPE_DBS) {
        resetRx();
        t = Date.now();
        const scoped = await client.browseFull({ scope: { everything: false, dbs: [db], areas: [] } });
        const elapsed = Date.now() - t;
        const expected = fullPerRoot.get(db) || 0;
        const got = scoped.meta.symbolCount;
        const ok = got === expected ? 'OK ' : 'MISMATCH';
        console.log(`SCOPE "${db}"`);
        console.log(`   time ${String(elapsed).padStart(6)} ms   rx ${String(rxFragments).padStart(4)} frag / ${String(rxBytes).padStart(7)} bytes`);
        console.log(`   symbols ${got}  (full=${expected})  [${ok}]`);
    }

    await client.disconnect().catch(() => {});
    console.log('\ndone.\n');
}

main().catch((e) => {
    console.error('\nFATAL:', e && e.stack ? e.stack : e);
    process.exit(1);
});
