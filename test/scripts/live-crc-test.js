'use strict';

/**
 * Live test: browse an array member, compare vte.symbolCrc from TypeInfo
 * with locally computed CRC variants, then attempt reads with CRC in the request.
 *
 * Usage: node test/scripts/live-crc-test.js <host> [port] [password] [arraySymbol]
 * Example: node test/scripts/live-crc-test.js 192.168.0.1 102 '' DB1.readings
 *
 * Env: S7_HOST, S7_PORT, S7_PASSWORD, S7_SYMBOL (array member path without index)
 */

const path = require('path');
const { S7CommPlusClient } = require(path.join('..', '..', 'lib', 's7plus', 'client'));
const ItemAddress = require(path.join('..', '..', 'lib', 's7plus', 'item-address'));
const { decodeNodeId } = require(path.join('..', '..', 'lib', 's7plus', 'browse', 'node-id'));
const { parseSymbolSegments } = require(path.join('..', '..', 'lib', 's7plus', 'browse', 'resolve-symbolic'));

const HOST = process.env.S7_HOST || process.argv[2];
if (!HOST) {
    console.error('Usage: node test/scripts/live-crc-test.js <host> [port] [password] [arraySymbol]');
    process.exit(1);
}
const PORT = parseInt(process.env.S7_PORT || process.argv[3] || '102', 10);
const PASSWORD = process.env.S7_PASSWORD || process.argv[4] || '';
const ARRAY_SYMBOL = process.env.S7_SYMBOL || process.argv[5] || '';
const TIMEOUT_MS = 10000;

// S7CommPlus CRC32 polynomial
let POLY = 0;
[31,30,29,28,26,23,21,19,18,15,14,13,12,9,8,4,1,0].forEach(b => POLY |= (1 << b));
POLY = POLY >>> 0;

const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
        if (crc & 1) crc = (crc >>> 1) ^ POLY;
        else crc = crc >>> 1;
    }
    TABLE[i] = crc >>> 0;
}

function crc32raw(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc = (crc >>> 8) ^ TABLE[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function computeSymbolCrc(symbolPath, softdatatype) {
    const pathBuf = Buffer.from(symbolPath.replace(/\./g, '\x09'), 'utf8');
    const input = Buffer.alloc(pathBuf.length + 1);
    pathBuf.copy(input);
    input[input.length - 1] = softdatatype & 0xFF;
    const firstCrc = crc32raw(input);
    const secondInput = Buffer.alloc(4);
    secondInput.writeUInt32LE(firstCrc);
    return crc32raw(secondInput);
}

function computeSymbolCrcNoDouble(symbolPath, softdatatype) {
    const pathBuf = Buffer.from(symbolPath.replace(/\./g, '\x09'), 'utf8');
    const input = Buffer.alloc(pathBuf.length + 1);
    pathBuf.copy(input);
    input[input.length - 1] = softdatatype & 0xFF;
    return crc32raw(input);
}

function computePathOnlyCrc(symbolPath) {
    const pathBuf = Buffer.from(symbolPath.replace(/\./g, '\x09'), 'utf8');
    return crc32raw(pathBuf);
}

function computePathOnlyCrcDouble(symbolPath) {
    const pathBuf = Buffer.from(symbolPath.replace(/\./g, '\x09'), 'utf8');
    const first = crc32raw(pathBuf);
    const secondInput = Buffer.alloc(4);
    secondInput.writeUInt32LE(first);
    return crc32raw(secondInput);
}

function ts() {
    return new Date().toISOString().split('T')[1].replace('Z', '');
}

function log(...args) {
    console.log(`[${ts()}]`, ...args);
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
    log('Connected!');

    try {
        if (!ARRAY_SYMBOL) {
            log('ERROR: array symbol path required (CLI arg or S7_SYMBOL env).');
            return;
        }

        const segments = parseSymbolSegments(ARRAY_SYMBOL);
        if (segments.length < 2) {
            log(`ERROR: invalid symbol path '${ARRAY_SYMBOL}' (need at least DB.member).`);
            return;
        }
        const dbName = segments[0];
        const memberName = segments[segments.length - 1];
        const quotedDb = dbName.includes(' ') ? `"${dbName}"` : dbName;

        // Step 1: Browse roots to find the DB block
        log('--- Step 1: Browse roots ---');
        const roots = await client.browseRoots();
        const dbNode = roots.nodes.find(n => n.label === dbName);
        if (!dbNode) {
            log(`ERROR: '${dbName}' not found in roots!`);
            log('Available roots:', roots.nodes.map(n => n.label).join(', '));
            return;
        }
        log(`Found ${dbName}, id=${dbNode.id.slice(0, 40)}...`);

        // Step 2: Browse children to find the array member
        log(`--- Step 2: Browse children of ${dbName} ---`);
        const children = await client.browseChildren(dbNode.id);
        log(`Found ${children.nodes.length} children`);
        for (const n of children.nodes) {
            log(`  ${n.label} (${n.nodeKind}) ${n.datatype || ''}`);
        }
        const arrayNode = children.nodes.find(n => n.label === memberName);
        if (!arrayNode) {
            log(`ERROR: '${memberName}' not found!`);
            return;
        }
        log(`Found ${memberName}, id=${arrayNode.id.slice(0, 40)}...`);

        // Decode the nodeId to access the path with VTE info
        const arrayDesc = decodeNodeId(arrayNode.id);
        log(`${memberName} descriptor type:`, arrayDesc.t);
        
        // Get VTE from path
        const lastSeg = arrayDesc.path[arrayDesc.path.length - 1];
        if (lastSeg.vte) {
            log('=== VTE SYMBOLCRC FROM PLC ===');
            log(`  vte.symbolCrc = 0x${(lastSeg.vte.symbolCrc >>> 0).toString(16).toUpperCase()} (${lastSeg.vte.symbolCrc})`);
            log(`  vte.lid = 0x${(lastSeg.vte.lid >>> 0).toString(16).toUpperCase()} (${lastSeg.vte.lid})`);
            log(`  vte.softdatatype = ${lastSeg.vte.softdatatype}`);
            
            // Compare with computed CRCs
            const sd = lastSeg.vte.softdatatype;
            const plcCrc = lastSeg.vte.symbolCrc >>> 0;
            
            console.log('\n=== CRC COMPARISON ===');
            const variants = [
                [`subsymCrc(${ARRAY_SYMBOL}, sd)`, computeSymbolCrc(ARRAY_SYMBOL, sd)],
                [`subsymCrc_noDouble(${ARRAY_SYMBOL}, sd)`, computeSymbolCrcNoDouble(ARRAY_SYMBOL, sd)],
                [`pathOnly(${ARRAY_SYMBOL})`, computePathOnlyCrc(ARRAY_SYMBOL)],
                [`pathOnlyDouble(${ARRAY_SYMBOL})`, computePathOnlyCrcDouble(ARRAY_SYMBOL)],
                [`subsymCrc("${quotedDb}".${memberName}, sd)`, computeSymbolCrc(`${quotedDb}.${memberName}`, sd)],
                [`subsymCrc_noDouble("${quotedDb}".${memberName}, sd)`, computeSymbolCrcNoDouble(`${quotedDb}.${memberName}`, sd)],
                [`pathOnly("${quotedDb}".${memberName})`, computePathOnlyCrc(`${quotedDb}.${memberName}`)],
                [`pathOnlyDouble("${quotedDb}".${memberName})`, computePathOnlyCrcDouble(`${quotedDb}.${memberName}`)],
                [`subsymCrc(${memberName}, sd)`, computeSymbolCrc(memberName, sd)],
                [`subsymCrc_noDouble(${memberName}, sd)`, computeSymbolCrcNoDouble(memberName, sd)],
                [`pathOnly(${memberName})`, computePathOnlyCrc(memberName)],
            ];
            
            for (const [label, val] of variants) {
                const match = val === plcCrc ? ' *** MATCH! ***' : '';
                console.log(`  ${label.padEnd(50)} = 0x${val.toString(16).toUpperCase().padStart(8, '0')}${match}`);
            }
            console.log(`  PLC vte.symbolCrc${' '.repeat(31)} = 0x${plcCrc.toString(16).toUpperCase().padStart(8, '0')}`);
        } else {
            log('WARNING: No VTE in path segment');
        }

        // Step 3: Browse array pages to get to element [0]
        log('\n--- Step 3: Browse array pages ---');
        const pages = await client.browseChildren(arrayNode.id);
        if (pages.nodes.length === 0) {
            log('ERROR: no array pages');
            return;
        }
        log(`Array pages: ${pages.nodes.length}`);
        const firstPage = pages.nodes[0];
        log(`First page: ${firstPage.label}`);

        // Step 4: Browse elements in first page
        log('--- Step 4: Browse array elements ---');
        const elements = await client.browseChildren(firstPage.id);
        log(`Elements: ${elements.nodes.length}`);
        const elem0 = elements.nodes[0];
        if (!elem0) {
            log('ERROR: element[0] not found');
            return;
        }
        log(`Element[0]: ${elem0.label} (${elem0.nodeKind})`);

        // Resolve the leaf to get address
        log('--- Step 5: Resolve leaf [0] ---');
        const resolved = await client.browseResolve(elem0.id);
        log(`Resolved: name=${resolved.name}, address=${resolved.address}, datatype=${resolved.datatype}`);

        // Step 6: Read WITHOUT CRC (baseline)
        log('\n--- Step 6: Read WITHOUT CRC (symbolCrc=0) ---');
        const addr = new ItemAddress(resolved.address);
        addr.symbolCrc = 0;
        log(`  ItemAddress: area=0x${addr.accessArea.toString(16)}, subArea=0x${addr.accessSubArea.toString(16)}, lids=[${addr.lid.map(l=>l.toString(16)).join(',')}]`);
        
        try {
            const result = await client.readValues([addr]);
            log(`  READ OK! value = ${JSON.stringify(result.values[0])}`);
            log(`  error = ${result.errors[0]}`);
        } catch (e) {
            log(`  READ FAILED: ${e.message}`);
        }

        // Step 7: Read WITH vte.symbolCrc
        if (lastSeg.vte && lastSeg.vte.symbolCrc) {
            log('\n--- Step 7: Read WITH vte.symbolCrc ---');
            const addr2 = new ItemAddress(resolved.address);
            addr2.symbolCrc = lastSeg.vte.symbolCrc >>> 0;
            log(`  symbolCrc = 0x${addr2.symbolCrc.toString(16).toUpperCase()}`);
            
            try {
                const result2 = await client.readValues([addr2]);
                log(`  READ OK! value = ${JSON.stringify(result2.values[0])}`);
                log(`  error = ${result2.errors[0]}`);
            } catch (e) {
                log(`  READ FAILED: ${e.message}`);
            }
        }

        // Step 8: Try computed CRC variants using HarpoS7 polynomial 0xF4ACFB13
        log('\n--- Step 8: Try computed CRC variants (poly 0xF4ACFB13, MSB-first) ---');
        const POLY = 0xF4ACFB13;
        const CRCTABLE = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = (i << 24) >>> 0;
            for (let j = 0; j < 8; j++) {
                if (c & 0x80000000) c = ((c << 1) ^ POLY) >>> 0;
                else c = (c << 1) >>> 0;
            }
            CRCTABLE[i] = c >>> 0;
        }
        function crcByte(state, b) {
            return (CRCTABLE[(b ^ (state >>> 24)) & 0xFF] ^ ((state << 8) >>> 0)) >>> 0;
        }
        function crcStr(str) {
            let s = 0;
            const buf = Buffer.from(str, 'binary');
            for (let i = 0; i < buf.length; i++) s = crcByte(s, buf[i]);
            return s;
        }
        function crcUpdateWith(state, val) {
            state = crcByte(state, val & 0xFF);
            state = crcByte(state, (val >>> 8) & 0xFF);
            state = crcByte(state, (val >>> 16) & 0xFF);
            state = crcByte(state, (val >>> 24) & 0xFF);
            return state;
        }
        
        const tryVariants = [
            [`crc("${ARRAY_SYMBOL}")`, crcStr(ARRAY_SYMBOL)],
            [`crc("${ARRAY_SYMBOL.replace(/\./g, '\\x09')}")`, crcStr(ARRAY_SYMBOL.replace(/\./g, '\x09'))],
            [`crc("\\"${quotedDb}\\".${memberName}")`, crcStr(`${quotedDb}.${memberName}`)],
            [`double(${ARRAY_SYMBOL})`, crcUpdateWith(0, crcStr(ARRAY_SYMBOL))],
            [`double(${ARRAY_SYMBOL.replace(/\./g, '\\x09')})`, crcUpdateWith(0, crcStr(ARRAY_SYMBOL.replace(/\./g, '\x09')))],
            [`crc("${ARRAY_SYMBOL}[0]")`, crcStr(`${ARRAY_SYMBOL}[0]`)],
            [`crc("${ARRAY_SYMBOL.replace(/\./g, '\\x09')}[0]")`, crcStr(`${ARRAY_SYMBOL.replace(/\./g, '\x09')}[0]`)],
        ];
        
        for (const [label, crcVal] of tryVariants) {
            const addr3 = new ItemAddress(resolved.address);
            addr3.symbolCrc = crcVal;
            log(`\n  Trying ${label} = 0x${crcVal.toString(16).toUpperCase()}`);
            try {
                const result3 = await client.readValues([addr3]);
                const errCode = result3.errors[0];
                if (errCode === 0n) {
                    log(`  *** SUCCESS! *** value = ${JSON.stringify(result3.values[0])}`);
                } else {
                    log(`  Error code: 0x${errCode.toString(16)}`);
                }
            } catch (e) {
                log(`  FAILED: ${e.message}`);
            }
        }

    } catch (e) {
        log('ERROR:', e.message, e.stack);
    } finally {
        log('\nDisconnecting...');
        client.forceDisconnect('test-done');
        log('Done.');
    }
}

main().catch(e => { console.error(e); process.exit(1); });
