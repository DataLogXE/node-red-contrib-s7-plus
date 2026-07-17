'use strict';

const { isHexAddress, isRawHexAccessString, isSymbolicName, assertCrcSecuredTag } = require('../lib/s7plus/tag-routing');
const { formatOutputPayload } = require('../lib/s7plus/read-result');

/**
 * Normalize a tag entry from config or msg.symbols into a consistent shape.
 * Routing priority:
 *   1. Pre-computed symbolCrc + hex address → readTags with CRC (already secured)
 *   2. Symbolic address (no hex) → resolveAndRead
 *   3. Hex address + symbolic name → resolveAndRead (CRC protection for browsed vars)
 */
function normalizeTag(t, i) {
    if (!t) throw new Error(`Symbol #${i} is empty`);
    if (typeof t === 'string') {
        if (isRawHexAccessString(t)) {
            assertCrcSecuredTag({ address: t, name: t, symbolCrc: undefined }, i);
        }
        return { name: t, address: t, symbolic: !isRawHexAccessString(t) };
    }
    if (typeof t === 'object') {
        if (t.address) {
            const addrIsHex = isHexAddress(t.address);

            if (addrIsHex && t.symbolCrc) {
                return {
                    name: t.name || t.address,
                    address: t.address,
                    datatype: t.datatype,
                    symbolCrc: t.symbolCrc,
                    symbolic: false
                };
            }

            if (!addrIsHex) {
                return {
                    name: t.name || t.address,
                    address: t.address,
                    datatype: t.datatype,
                    symbolic: true
                };
            }

            if (isSymbolicName(t.name)) {
                return {
                    name: t.name,
                    address: t.name,
                    datatype: t.datatype,
                    symbolic: true
                };
            }

            assertCrcSecuredTag(
                { address: t.address, name: t.name || t.address, symbolCrc: t.symbolCrc },
                i
            );
        }
        if (t.symbol) {
            return { name: t.name || t.symbol, address: t.symbol, symbolic: true };
        }
    }
    throw new Error(`Symbol #${i} has no address or symbol`);
}

function parseAddSymbols(msg) {
    if (!Array.isArray(msg.addSymbols) || msg.addSymbols.length === 0) {
        return [];
    }
    if (!msg.addSymbols.every(s => typeof s === 'string')) {
        return [];
    }
    for (let i = 0; i < msg.addSymbols.length; i++) {
        if (isRawHexAccessString(msg.addSymbols[i])) {
            throw new Error(
                `msg.addSymbols[${i}]: hex access string requires a symbolic name or symbolCrc`
            );
        }
    }
    return msg.addSymbols;
}

/**
 * Parse a per-message symbol override from msg.symbols.
 * Only a (non-empty) array of strings is accepted; anything else is rejected.
 * Returns undefined when msg.symbols is not set (use configured symbols),
 * or an empty array when it is an empty array (also falls back to configured).
 */
function parseMsgSymbols(msg) {
    if (msg.symbols === undefined || msg.symbols === null) {
        return undefined;
    }
    if (!Array.isArray(msg.symbols)) {
        throw new Error('msg.symbols must be an array of strings');
    }
    if (!msg.symbols.every(s => typeof s === 'string')) {
        throw new Error('msg.symbols must be an array of strings');
    }
    return msg.symbols;
}

module.exports = function (RED) {
    function S7ComPlusIn(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        if (!node.endpoint) {
            node.error('Missing s7-plus endpoint configuration');
            return;
        }

        const configuredSymbols = Array.isArray(config.symbols) ? config.symbols : [];

        // Backpressure: silently drop input messages that arrive while a
        // previous read is still in flight. Without this, a fast inject
        // (e.g. 2 s) plus a slow read (resolveAndRead on thousands of
        // symbols) would let messages pile up in Node-RED's per-node
        // queue plus the endpoint's user-lock chain, blowing up the
        // heap until V8 freezes the whole runtime.
        let busy = false;

        node.on('input', async (msg, send, done) => {
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) node.error(err, msg); };

            if (busy) {
                node.status({ fill: 'grey', shape: 'ring', text: 'skipped (busy)' });
                done();
                return;
            }
            busy = true;

            try {
                // Additional symbolic paths from msg.addSymbols (string[]) are merged
                // with configured or msg.symbols tags. Duplicates are removed.
                let addPaths;
                try {
                    addPaths = parseAddSymbols(msg);
                } catch (e) {
                    done(e);
                    return;
                }

                // msg.symbols (string[]) overrides the configured symbols for this
                // one message. Only a plain array of strings is accepted.
                let msgSymbols;
                try {
                    msgSymbols = parseMsgSymbols(msg);
                } catch (e) {
                    done(e);
                    return;
                }

                const source = msgSymbols && msgSymbols.length
                    ? msgSymbols
                    : configuredSymbols;

                let tags = [];
                try {
                    if (source.length) tags = source.map(normalizeTag);
                } catch (e) {
                    done(e);
                    return;
                }

                const configuredSymbolicPaths = tags.filter(t => t.symbolic).map(t => t.address);
                const crcSecuredTags = tags.filter(t => !t.symbolic);

                const allSymbolicPaths = [...new Set([...configuredSymbolicPaths, ...addPaths])];

                if (allSymbolicPaths.length === 0 && crcSecuredTags.length === 0) {
                    done(new Error('No symbols configured'));
                    return;
                }

                node.status({ fill: 'blue', shape: 'ring', text: 'reading' });
                const t0 = Date.now();

                try {
                    let result = {};

                    if (allSymbolicPaths.length > 0) {
                        const symbolicResult = await node.endpoint.resolveAndRead(allSymbolicPaths);
                        Object.assign(result, symbolicResult);
                    }

                    if (crcSecuredTags.length > 0) {
                        const crcResult = await node.endpoint.readTags(crcSecuredTags);
                        Object.assign(result, crcResult);
                    }

                    const elapsed = Date.now() - t0;
                    const outputOrder = [...allSymbolicPaths, ...crcSecuredTags.map((t) => t.name)];
                    msg.payload = formatOutputPayload(result, outputOrder, config.outputFormat);
                    const allTags = Object.values(result);
                    const failed = allTags.filter(t => t.status !== 'ok').length;
                    if (failed > 0) {
                        node.status({
                            fill: 'yellow',
                            shape: 'dot',
                            text: `read ${allTags.length - failed}/${allTags.length} ok (${elapsed}ms)`
                        });
                    } else {
                        node.status({ fill: 'green', shape: 'dot', text: `read ${allTags.length} (${elapsed}ms)` });
                    }
                    send(msg);
                    done();
                } catch (e) {
                    const elapsed = Date.now() - t0;
                    node.status({ fill: 'red', shape: 'dot', text: `${e.message} (${elapsed}ms)` });
                    done(e);
                }
            } finally {
                busy = false;
            }
        });
    }

    RED.nodes.registerType('s7-plus read', S7ComPlusIn);
};

module.exports.parseAddSymbols = parseAddSymbols;
module.exports.parseMsgSymbols = parseMsgSymbols;
module.exports.normalizeTag = normalizeTag;
