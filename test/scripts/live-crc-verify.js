'use strict';

/**
 * Live verification: read symbolic symbols with computed CRC.
 *
 * Usage: node test/scripts/live-crc-verify.js <host> [port] [password] <symbol> [symbol2...]
 * Example: node test/scripts/live-crc-verify.js 192.168.0.1 102 '' DB1.flag DB1.readings[0]
 *
 * Env: S7_HOST, S7_PORT, S7_PASSWORD, S7_SYMBOLS (comma-separated)
 */

const path = require('path');
const { S7CommPlusClient } = require(path.join('..', '..', 'lib', 's7plus', 'client'));
const ItemAddress = require(path.join('..', '..', 'lib', 's7plus', 'item-address'));
const { computeCrcFromMeta } = require(path.join('..', '..', 'lib', 's7plus', 'crc'));

const HOST = process.env.S7_HOST || process.argv[2];
if (!HOST) {
    console.error('Usage: node test/scripts/live-crc-verify.js <host> [port] [password] <symbol> [symbol2...]');
    process.exit(1);
}
const PORT = parseInt(process.env.S7_PORT || process.argv[3] || '102', 10);
const PASSWORD = process.env.S7_PASSWORD || process.argv[4] || '';
const SYMBOLS = (process.env.S7_SYMBOLS
    ? process.env.S7_SYMBOLS.split(',').map(s => s.trim()).filter(Boolean)
    : process.argv.slice(5));

if (!SYMBOLS.length) {
    console.error('At least one symbol path is required (CLI arg or S7_SYMBOLS env).');
    process.exit(1);
}

function ts() { return new Date().toISOString().split('T')[1].replace('Z', ''); }
function log(...args) { console.log(`[${ts()}]`, ...args); }

async function verifySymbol(client, symbolPath, index) {
    log(`\n=== Test ${index + 1}: ${symbolPath} ===`);
    const resolved = await client.browseResolveSymbolic(symbolPath);
    log(`  Resolved: ${resolved.name} -> ${resolved.address} (${resolved.datatype})`);

    const addr = new ItemAddress(resolved.address);
    addr.symbolCrc = computeCrcFromMeta(resolved.crcMeta) >>> 0;
    log(`  CRC = 0x${addr.symbolCrc.toString(16).toUpperCase()}`);

    const result = await client.readValues([addr]);
    if (result.errors[0] === 0n) {
        log(`  SUCCESS: value = ${JSON.stringify(result.values[0])}`);
    } else {
        log(`  FAILED: error = 0x${result.errors[0].toString(16)}`);
    }
}

async function main() {
    const client = new S7CommPlusClient();
    log(`Connecting to ${HOST}:${PORT}...`);
    await client.connect(HOST, PASSWORD, '', 10000, PORT);
    log('Connected!');

    try {
        for (let i = 0; i < SYMBOLS.length; i++) {
            await verifySymbol(client, SYMBOLS[i], i);
        }
    } finally {
        client.forceDisconnect('done');
        log('Done.');
    }
}

main().catch(e => { console.error(e); process.exit(1); });
