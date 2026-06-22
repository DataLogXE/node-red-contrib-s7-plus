'use strict';

/**
 * Diagnose tool for the "Read error 0x8009890012cbffef" on array elements
 * of arrays with non-zero lowerBound (e.g. Array[1..10000] of SInt).
 *
 * Approach: resolve a single array element, dump all relevant data, then
 * try reading with multiple CRC / address variants and report which one
 * succeeds. This pinpoints the wrong assumption in the CRC/address logic.
 *
 * Usage: node test/scripts/live-array-crc-diagnose.js <host> [port] [password] <symbol> [symbol2...]
 * Example: node test/scripts/live-array-crc-diagnose.js 192.168.0.1 102 '' DB2.sintItems[1] DB2.realItems[1]
 *
 * Env: S7_HOST, S7_PORT, S7_PASSWORD, S7_SYMBOLS (comma-separated)
 */

const path = require('path');
const { S7CommPlusClient } = require(path.join('..', '..', 'lib', 's7plus', 'client'));
const ItemAddress = require(path.join('..', '..', 'lib', 's7plus', 'item-address'));
const { decodeNodeId } = require(path.join('..', '..', 'lib', 's7plus', 'browse', 'node-id'));
const {
    computeCrcFromMeta,
    computeItemCrc,
    TypeCode,
    softdatatypeToTypeCode
} = require(path.join('..', '..', 'lib', 's7plus', 'crc'));

const HOST = process.env.S7_HOST || process.argv[2];
if (!HOST) {
    console.error('Usage: node test/scripts/live-array-crc-diagnose.js <host> [port] [password] <symbol> [symbol2...]');
    process.exit(1);
}
const PORT = parseInt(process.env.S7_PORT || process.argv[3] || '102', 10);
const PASSWORD = process.env.S7_PASSWORD || process.argv[4] || '';
const SYMBOLS = (process.env.S7_SYMBOLS
    ? process.env.S7_SYMBOLS.split(',').map(s => s.trim()).filter(Boolean)
    : process.argv.slice(5));
const TIMEOUT_MS = 15000;

function ts() { return new Date().toISOString().split('T')[1].replace('Z', ''); }
function log(...a) { console.log(`[${ts()}]`, ...a); }
function hex(n) { return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0'); }

async function resolveAndDump(client, symbolPath) {
    log(`--- Resolve: ${symbolPath} ---`);
    const resolved = await client.browseResolveSymbolic(symbolPath);
    log(`  address    = ${resolved.address}`);
    log(`  datatype   = ${resolved.datatype}`);
    log(`  crcMeta    = ${JSON.stringify(resolved.crcMeta)}`);

    // Decode the underlying nodeId via separate browse walk to grab the leaf path
    // (browseResolveSymbolic does not expose the nodeId path directly)
    return resolved;
}

async function tryRead(client, label, address, symbolCrc) {
    const a = new ItemAddress(address);
    a.symbolCrc = symbolCrc >>> 0;
    try {
        const { values, errors } = await client.readValues([a]);
        const err = errors[0];
        if (!err || err === 0n) {
            log(`  [OK ] ${label.padEnd(42)} crc=${hex(symbolCrc)} value=${JSON.stringify(values[0])}`);
            return true;
        } else {
            log(`  [ERR] ${label.padEnd(42)} crc=${hex(symbolCrc)} err=0x${err.toString(16)}`);
            return false;
        }
    } catch (e) {
        log(`  [EXC] ${label.padEnd(42)} crc=${hex(symbolCrc)} ${e.message}`);
        return false;
    }
}

/**
 * Walk the browse tree to the same leaf as resolveSymbolic but keep the
 * decoded nodeId path so we can inspect vte.symbolCrc on every segment.
 */
async function fullPath(client, symbolPath) {
    const { parseSymbolSegments } = require(path.join('..', '..', 'lib', 's7plus', 'browse', 'resolve-symbolic'));
    const segments = parseSymbolSegments(symbolPath);
    const { nodes: roots } = await client.browseRoots();
    let current = roots.find(n => n.label === segments[0]);
    if (!current) throw new Error(`Root '${segments[0]}' not found`);

    for (let i = 1; i < segments.length; i++) {
        const { nodes: children } = await client.browseChildren(current.id);
        let next = children.find(n => n.label === segments[i]);
        if (!next) {
            for (const c of children) {
                if (c.nodeKind === 'arrpage') {
                    const { nodes: pageElems } = await client.browseChildren(c.id);
                    next = pageElems.find(n => n.label === segments[i]);
                    if (next) break;
                }
            }
        }
        if (!next) throw new Error(`Segment '${segments[i]}' not found under '${current.label}'`);
        current = next;
    }
    return decodeNodeId(current.id);
}

async function diagnoseSymbol(client, symbolPath) {
    console.log('\n==============================================================');
    console.log(`SYMBOL: ${symbolPath}`);
    console.log('==============================================================');

    let leafDesc;
    try {
        leafDesc = await fullPath(client, symbolPath);
    } catch (e) {
        log(`Cannot resolve path: ${e.message}`);
        return;
    }

    // Show every path segment with its VTE info
    log('Path segments:');
    leafDesc.path.forEach((seg, idx) => {
        const v = seg.vte || {};
        const oit = v.offsetInfoType || {};
        const lower = (oit.getArrayLowerBounds && oit.getArrayLowerBounds()) || 0;
        const count = (oit.getArrayElementCount && oit.getArrayElementCount()) || 0;
        log(`  [${idx}] nodeType=${seg.nodeType} name='${seg.name}' accessId=${hex(seg.accessId || 0)} softdatatype=${seg.softdatatype || 0}`
            + ` vte.lid=${hex(v.lid || 0)} vte.symbolCrc=${hex(v.symbolCrc || 0)} vte.softdatatype=${v.softdatatype || 0}`
            + ` arr.lower=${lower} arr.count=${count}`);
    });

    const resolved = await resolveAndDump(client, symbolPath);

    // Collect CRC candidates
    const crcMeta = resolved.crcMeta || {};
    const lastVte = (leafDesc.path[leafDesc.path.length - 1].vte) || {};
    const arrayVte = leafDesc.path.length >= 2 ? (leafDesc.path[leafDesc.path.length - 2].vte || {}) : {};

    const candidates = [];

    candidates.push(['computeCrcFromMeta(current)', computeCrcFromMeta(crcMeta)]);
    candidates.push(['vte.symbolCrc (leaf seg)', lastVte.symbolCrc >>> 0]);
    candidates.push(['vte.symbolCrc (array var seg)', arrayVte.symbolCrc >>> 0]);

    if (crcMeta.isArray) {
        const elemTc = softdatatypeToTypeCode(crcMeta.elementSoftdatatype);
        candidates.push(['Array(lb=0)', computeItemCrc(crcMeta.memberName, TypeCode.Array, {
            elementTypeCode: elemTc, lowerBound: 0
        })]);
        if (crcMeta.lowerBound !== 1) {
            candidates.push(['Array(lb=1)', computeItemCrc(crcMeta.memberName, TypeCode.Array, {
                elementTypeCode: elemTc, lowerBound: 1
            })]);
        }
        candidates.push([`Array(lb=${crcMeta.lowerBound}) duplicate`, computeItemCrc(crcMeta.memberName, TypeCode.Array, {
            elementTypeCode: elemTc, lowerBound: crcMeta.lowerBound || 0
        })]);
        candidates.push(['As single member (no array)', computeItemCrc(crcMeta.memberName,
            softdatatypeToTypeCode(crcMeta.elementSoftdatatype))]);
    }
    candidates.push(['no CRC', 0]);

    // Address variants
    const baseAddr = resolved.address;
    const parts = baseAddr.split('.');
    const lastIdx = parts.length - 1;
    const lastVal = parseInt(parts[lastIdx], 16);

    const addressVariants = [
        ['address (as is)', baseAddr]
    ];
    if (crcMeta.isArray && (crcMeta.lowerBound || 0) > 0) {
        const tiaIdxParts = parts.slice();
        tiaIdxParts[lastIdx] = (lastVal + (crcMeta.lowerBound || 0)).toString(16).toUpperCase();
        addressVariants.push([`address with TIA index (+${crcMeta.lowerBound})`, tiaIdxParts.join('.')]);
    }

    console.log('\n-- READ ATTEMPTS --');
    for (const [aLabel, addr] of addressVariants) {
        console.log(`\n  Address: ${addr}  (${aLabel})`);
        for (const [cLabel, crc] of candidates) {
            await tryRead(client, cLabel, addr, crc);
        }
    }
}

async function main() {
    const client = new S7CommPlusClient();
    log(`Connecting to ${HOST}:${PORT} ...`);
    try {
        await client.connect(HOST, PASSWORD, '', TIMEOUT_MS, PORT);
    } catch (e) {
        log('CONNECT FAILED:', e.message);
        process.exit(1);
    }
    log('Connected.');

    try {
        if (!SYMBOLS.length) {
            log('At least one symbol path is required (CLI arg or S7_SYMBOLS env).');
            process.exit(1);
        }
        for (const symbolPath of SYMBOLS) {
            await diagnoseSymbol(client, symbolPath);
        }
    } catch (e) {
        log('FATAL:', e.message, e.stack);
    } finally {
        log('\nDisconnecting...');
        client.forceDisconnect('diagnose-done');
    }
}

main().catch(e => { console.error(e); process.exit(1); });
