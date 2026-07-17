'use strict';

const { isHexAddress, isRawHexAccessString, isSymbolicName, assertCrcSecuredTag } = require('../lib/s7plus/tag-routing');
const { formatOutputPayload } = require('../lib/s7plus/read-result');

/**
 * Normalize a write symbol from config or msg.symbols and classify it
 * as symbolic vs. hex, mirroring the read node's normalizeTag routing:
 *   1. hex address + symbolCrc        -> CRC-secured writeTags
 *   2. symbolic address (no hex)      -> resolveAndWrite
 *   3. hex address + symbolic name    -> resolveAndWrite (CRC protection)
 */
function normalizeSymbol(v, i) {
    if (!v) throw new Error(`Symbol #${i} is empty`);
    if (typeof v === 'string') {
        if (isRawHexAccessString(v)) {
            assertCrcSecuredTag({ address: v, name: v, symbolCrc: undefined }, i);
        }
        return { name: v, address: v, datatype: undefined, symbolic: !isRawHexAccessString(v) };
    }

    const address = v.address || v.symbol;
    if (!address) throw new Error(`Symbol #${i} has no address`);
    const addrIsHex = isHexAddress(address);

    if (addrIsHex && v.symbolCrc) {
        return {
            name: v.name || address,
            address,
            datatype: v.datatype,
            symbolCrc: v.symbolCrc,
            symbolic: false
        };
    }
    if (!addrIsHex) {
        return { name: v.name || address, address, datatype: v.datatype, symbolic: true };
    }
    if (isSymbolicName(v.name)) {
        return { name: v.name, address: v.name, datatype: v.datatype, symbolic: true };
    }
    assertCrcSecuredTag(
        { address, name: v.name || address, symbolCrc: v.symbolCrc },
        i
    );
}

function resolveValueForSymbol(payload, symbol, isOnlySymbol) {
    if (payload && typeof payload === 'object' && !Buffer.isBuffer(payload) && symbol.name in payload) {
        return payload[symbol.name];
    }
    if (isOnlySymbol) return payload;
    throw new Error(`msg.payload is missing value for "${symbol.name}"`);
}

function formatStatusValue(value) {
    if (typeof value === 'boolean') return String(value);
    if (value == null) return 'null';
    if (Buffer.isBuffer(value)) return value.toString('hex');
    if (typeof value === 'object') {
        const s = JSON.stringify(value);
        return s.length > 40 ? `${s.slice(0, 37)}...` : s;
    }
    const s = String(value);
    return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

function writeStatusText(tags) {
    if (tags.length === 1) {
        return `wrote ${formatStatusValue(tags[0].value)}`;
    }
    return `wrote ${tags.length} tags`;
}

module.exports = function (RED) {
    function S7ComPlusOut(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        if (!node.endpoint) {
            node.error('Missing s7-plus endpoint configuration');
            return;
        }

        const configuredSymbols = Array.isArray(config.symbols) ? config.symbols : [];

        // Same backpressure as s7-plus read: silently drop input
        // messages while a write is still in flight, so a fast inject
        // cannot pile up writes that overflow Node-RED's queue and the
        // endpoint's user-lock chain.
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
                const source = Array.isArray(msg.symbols) && msg.symbols.length
                    ? msg.symbols
                    : configuredSymbols;

                if (!source.length) {
                    done(new Error('No symbols configured'));
                    return;
                }

                let symbols;
                try {
                    symbols = source.map(normalizeSymbol);
                } catch (e) {
                    done(e);
                    return;
                }

                const isSingle = symbols.length === 1;
                let tags;
                try {
                    tags = symbols.map((v) => ({
                        name: v.name,
                        address: v.address,
                        symbolCrc: v.symbolCrc,
                        symbolic: v.symbolic,
                        datatype: v.datatype || (msg.datatype && isSingle ? msg.datatype : undefined),
                        value: resolveValueForSymbol(msg.payload, v, isSingle)
                    }));
                } catch (e) {
                    node.status({ fill: 'red', shape: 'dot', text: e.message });
                    done(e);
                    return;
                }

                // Symbolic tags must be resolved to a hex address + CRC
                // before writing (resolveAndWrite); CRC-secured hex tags go
                // straight to writeTags. Same split as the read node.
                const symbolicTags = tags.filter(t => t.symbolic);
                const crcSecuredTags = tags.filter(t => !t.symbolic);

                node.status({ fill: 'blue', shape: 'ring', text: 'writing' });
                const t0 = Date.now();
                try {
                    // Merge per-tag results from both write paths into a
                    // single object keyed by name, mirroring the read node.
                    const result = {};
                    if (symbolicTags.length > 0) {
                        Object.assign(result, await node.endpoint.resolveAndWrite(symbolicTags));
                    }
                    if (crcSecuredTags.length > 0) {
                        Object.assign(result, await node.endpoint.writeTags(crcSecuredTags));
                    }

                    const elapsed = Date.now() - t0;
                    const outputOrder = tags.map((t) => t.name);
                    msg.payload = formatOutputPayload(result, outputOrder, config.outputFormat);
                    const allTags = Object.values(result);
                    const failed = allTags.filter(t => t.status !== 'ok').length;
                    if (failed > 0) {
                        node.status({
                            fill: 'yellow',
                            shape: 'dot',
                            text: `wrote ${allTags.length - failed}/${allTags.length} ok (${elapsed}ms)`
                        });
                    } else {
                        node.status({
                            fill: 'green',
                            shape: 'dot',
                            text: `${writeStatusText(tags)} (${elapsed}ms)`
                        });
                    }
                    send(msg);
                    done();
                } catch (e) {
                    node.status({ fill: 'red', shape: 'dot', text: e.message });
                    done(e);
                }
            } finally {
                busy = false;
            }
        });
    }

    RED.nodes.registerType('s7-plus write', S7ComPlusOut);
};

module.exports.normalizeSymbol = normalizeSymbol;
