'use strict';

/**
 * Live test of lazy browse against a connected PLC.
 *
 * Usage: node test/scripts/live-browse.js <host> [port] [password]
 * Example: node test/scripts/live-browse.js 192.168.0.1 102
 *
 * Env: S7_HOST, S7_PORT, S7_PASSWORD
 */

const path = require('path');
const { S7CommPlusClient } = require(path.join('..', '..', 'lib', 's7plus', 'client'));

const HOST = process.env.S7_HOST || process.argv[2];
if (!HOST) {
    console.error('Usage: node test/scripts/live-browse.js <host> [port] [password]');
    process.exit(1);
}
const PORT = parseInt(process.env.S7_PORT || process.argv[3] || '102', 10);
const PASSWORD = process.env.S7_PASSWORD || process.argv[4] || '';
const TIMEOUT_MS = 10000;
const STEP_LIMIT = 20;

function ts() {
    const d = new Date();
    return d.toISOString().split('T')[1].replace('Z', '');
}

function log(...args) {
    console.log(`[${ts()}]`, ...args);
}

function shortenLabel(s) {
    if (!s) return '';
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

async function main() {
    const client = new S7CommPlusClient();

    log(`Connecting to ${HOST}:${PORT} (password ${PASSWORD ? 'set' : 'empty'}) ...`);
    const t0 = Date.now();
    try {
        await client.connect(HOST, PASSWORD, '', TIMEOUT_MS, PORT);
    } catch (e) {
        log('CONNECT FAILED:', e.message);
        process.exit(2);
    }
    log(`Connected in ${Date.now() - t0} ms`);

    let roots;
    try {
        const t1 = Date.now();
        log('browseRoots() ...');
        roots = await client.browseRoots();
        log(`browseRoots() returned ${roots.nodes.length} root(s) in ${Date.now() - t1} ms`);
    } catch (e) {
        log('browseRoots FAILED:', e.message);
        await client.disconnect().catch(() => {});
        process.exit(3);
    }

    for (const r of roots.nodes) {
        log(`  root: ${r.nodeKind} "${r.label}" hasChildren=${r.hasChildren}`);
    }

    const candidates = roots.nodes.filter(n => n.hasChildren).slice(0, STEP_LIMIT);
    let firstLeaf = null;
    let firstStruct = null;
    let firstArray = null;

    for (const root of candidates) {
        try {
            const t2 = Date.now();
            log(`browseChildren() on "${root.label}" (kind=${root.nodeKind}) ...`);
            const { nodes } = await client.browseChildren(root.id);
            log(`  -> ${nodes.length} child(ren) in ${Date.now() - t2} ms`);
            for (const c of nodes.slice(0, 6)) {
                log(`     ${c.nodeKind.padEnd(12)} ${shortenLabel(c.label)}  ${c.datatype || ''}  ${c.isLeaf ? '[leaf]' : ''}`);
            }
            if (nodes.length > 6) log(`     ... (${nodes.length - 6} more)`);
            for (const c of nodes) {
                if (!firstLeaf && c.isLeaf) firstLeaf = c;
                if (!firstStruct && c.nodeKind === 'struct') firstStruct = c;
                if (!firstArray && c.nodeKind === 'array') firstArray = c;
            }
        } catch (e) {
            log(`  browseChildren("${root.label}") FAILED: ${e.message}`);
        }
    }

    if (firstStruct) {
        try {
            log(`browseChildren() on first struct "${firstStruct.label}" ...`);
            const { nodes } = await client.browseChildren(firstStruct.id);
            log(`  -> ${nodes.length} struct member(s)`);
            for (const c of nodes.slice(0, 6)) {
                log(`     ${c.nodeKind.padEnd(12)} ${shortenLabel(c.label)}  ${c.datatype || ''}`);
            }
        } catch (e) {
            log(`  struct browseChildren FAILED: ${e.message}`);
        }
    } else {
        log('(no struct found in tested roots)');
    }

    if (firstArray) {
        try {
            log(`browseChildren() on first array "${firstArray.label}" ...`);
            const { nodes: pages } = await client.browseChildren(firstArray.id);
            log(`  -> ${pages.length} page(s)`);
            if (pages.length) {
                const { nodes: elements } = await client.browseChildren(pages[0].id);
                log(`  -> first page has ${elements.length} element(s); sample:`);
                for (const c of elements.slice(0, 4)) {
                    log(`     ${c.nodeKind.padEnd(12)} ${shortenLabel(c.label)}  ${c.datatype || ''}`);
                }
                if (!firstLeaf) firstLeaf = elements.find(c => c.isLeaf) || null;
            }
        } catch (e) {
            log(`  array browseChildren FAILED: ${e.message}`);
        }
    } else {
        log('(no array found in tested roots)');
    }

    if (firstLeaf) {
        try {
            const resolved = await client.browseResolve(firstLeaf.id);
            log(`browseResolve("${firstLeaf.label}") -> name=${resolved.name} address=${resolved.address} datatype=${resolved.datatype}`);

            const { ItemAddress } = require(path.join('..', '..', 'lib', 's7plus', 'client'));
            const { decodeReadValue } = require(path.join('..', '..', 'lib', 's7plus', 'values', 'encode-decode'));
            const adr = new ItemAddress(resolved.address);
            const { values, errors } = await client.readValues([adr]);
            const err = errors[0];
            if (err && err !== 0n) {
                log(`  readValues -> error 0x${err.toString(16)}`);
            } else {
                log(`  readValues -> ${JSON.stringify(decodeReadValue(values[0]))}`);
            }
        } catch (e) {
            log(`  resolve/read FAILED: ${e.message}`);
        }
    } else {
        log('(no leaf symbol found)');
    }

    log('simulating stale connection (transport close) and verifying reconnect ...');
    client._transport.emit('close', { reason: 'simulated-test' });
    log(`  client.connected = ${client.connected}`);
    try {
        await client.browseRoots();
        log('  ERROR: browseRoots() should have thrown after close');
    } catch (e) {
        log(`  expected throw after close: ${e.message}`);
    }

    log('reconnecting ...');
    await client.connect(HOST, PASSWORD, '', TIMEOUT_MS, PORT);
    const rootsAgain = await client.browseRoots();
    log(`  browseRoots() after reconnect -> ${rootsAgain.nodes.length} root(s)`);

    log('disconnecting ...');
    await client.disconnect().catch((e) => log('disconnect error:', e.message));
    log('done.');
}

main().catch((e) => {
    log('FATAL:', e && e.stack ? e.stack : e);
    process.exit(1);
});
