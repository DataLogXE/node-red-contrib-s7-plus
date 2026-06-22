'use strict';

/**
 * Reproduces an idle reconnect / stale-socket scenario (TCP receive timeout),
 * then verifies that stabilization and retry logic recover.
 *
 * Pass 1 mirrors a working browse session (roots + first children).
 * Pass 2 fakes a dead PLC half-connection (hard destroy of the underlying
 * socket WITHOUT touching the client._connected flag) and re-runs the same
 * browse via the same withReconnect logic the endpoint uses.
 *
 * Expected output (good case):
 *   - pass 1 succeeds quickly
 *   - pass 2 first attempt fails fast (~timeout) and the retry succeeds
 *   - total wall time for pass 2 ~= one timeout + one reconnect + one browse
 *     (NOT two timeouts; that would be the regression we are guarding against)
 *
 * Usage: node test/scripts/live-reconnect.js <host> [port] [password] [timeoutMs]
 * Example: node test/scripts/live-reconnect.js 192.168.0.1 102 '' 3000
 *
 * Env: S7_HOST, S7_PORT, S7_PASSWORD
 */

const path = require('path');
const { S7CommPlusClient } = require(path.join('..', '..', 'lib', 's7plus', 'client'));
const { setEnabled } = require(path.join('..', '..', 'lib', 's7plus', 'debug'));

if (!process.env.S7P_DEBUG) setEnabled('*');

const HOST = process.env.S7_HOST || process.argv[2];
if (!HOST) {
    console.error('Usage: node test/scripts/live-reconnect.js <host> [port] [password] [timeoutMs]');
    process.exit(1);
}
const PORT = parseInt(process.env.S7_PORT || process.argv[3] || '102', 10);
const PASSWORD = process.env.S7_PASSWORD || process.argv[4] || '';
const TIMEOUT_MS = parseInt(process.argv[5] || '3000', 10);

function ts() { return new Date().toISOString().split('T')[1].replace('Z', ''); }
function log(...a) { console.log(`[${ts()}]`, ...a); }

// Mirrors nodes/s7complus-endpoint.js withReconnect
function isStaleConnectionError(err) {
    if (!err || !err.message) return false;
    const m = err.message;
    return m.includes('Data receive Timeout')
        || m.includes('Client not connected')
        || m.includes('socket-close')
        || m.includes('socket-end')
        || m.includes('socket-error')
        || m.includes('pdu-read-timeout');
}

async function withReconnect(client, doConnect, fn, tag) {
    if (!client.connected) await doConnect();
    try {
        return await fn();
    } catch (e) {
        if (!isStaleConnectionError(e)) throw e;
        log(`  [retry] ${tag}: ${e.message} -> forceDisconnect + reconnect`);
        try { client.forceDisconnect('endpoint-style-retry'); } catch { /* ignore */ }
        await doConnect();
        return fn();
    }
}

async function main() {
    const client = new S7CommPlusClient();
    const doConnect = async () => {
        const t = Date.now();
        await client.connect(HOST, PASSWORD, '', TIMEOUT_MS, PORT);
        log(`  connect() ok in ${Date.now() - t}ms`);
    };

    log(`=== Pass 1: clean browse ===`);
    const p1 = Date.now();
    let roots;
    try {
        await doConnect();
        roots = await withReconnect(client, doConnect, () => client.browseRoots(), 'roots-1');
        log(`  pass1 roots: ${roots.nodes.length} root(s)`);
        const first = roots.nodes.find(r => r.hasChildren);
        if (first) {
            const ch = await withReconnect(client, doConnect, () => client.browseChildren(first.id), `children-1:${first.label}`);
            log(`  pass1 children of "${first.label}": ${ch.nodes.length}`);
        }
        log(`  pass1 total: ${Date.now() - p1}ms`);
    } catch (e) {
        log(`  pass1 UNEXPECTED FAIL: ${e.message}`);
        process.exit(2);
    }

    // Socket is dead but client believes it's connected.
    // We hard-destroy the underlying socket WITHOUT firing the watch event so
    // _connected stays true — exactly what happens when the PLC silently drops
    // a NAT idle connection and the FIN never reaches us.
    log(`=== Pass 2: simulating silent dead connection (no FIN, no socket-close event) ===`);
    const sock = client._transport._socket;
    if (sock) {
        sock.removeAllListeners('close');
        sock.removeAllListeners('end');
        sock.removeAllListeners('error');
        sock._s7pClosedWatch = false;
        sock._s7pCloseFired = true;
        sock.destroy();
        client._transport._socket = sock;
    }
    log(`  client.connected before retry: ${client.connected}`);

    const p2 = Date.now();
    try {
        const r2 = await withReconnect(client, doConnect, () => client.browseRoots(), 'roots-2');
        const dur = Date.now() - p2;
        log(`  pass2 roots: ${r2.nodes.length} root(s) in ${dur}ms`);
        if (dur > (TIMEOUT_MS * 2 + 5000)) {
            log(`  WARN: pass2 took ${dur}ms, more than (2*timeout + 5s buffer). Regression?`);
        } else {
            log(`  OK: pass2 within expected window (~timeout + connect time)`);
        }
    } catch (e) {
        log(`  pass2 FAIL after ${Date.now() - p2}ms: ${e.message}`);
        process.exit(3);
    }

    log(`=== Pass 3: idempotent forceDisconnect + reconnect loop ===`);
    for (let i = 0; i < 3; i++) {
        client.forceDisconnect(`loop-${i}`);
        client.forceDisconnect(`loop-${i}-dup`);
        const t = Date.now();
        await doConnect();
        const r = await client.browseRoots();
        log(`  loop ${i}: roots=${r.nodes.length} in ${Date.now() - t}ms`);
    }

    log(`disconnecting ...`);
    await client.disconnect().catch((e) => log('disconnect error:', e.message));
    log(`done.`);
}

main().catch((e) => {
    log('FATAL:', e && e.stack ? e.stack : e);
    process.exit(1);
});
