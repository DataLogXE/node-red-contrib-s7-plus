'use strict';

const DEFAULT_MAX_SYMBOLS = 100000;
const { normalizeExploreScope } = require('../lib/s7plus/browse/areas');
const { formatExplorePayload, normalizeSymbolInfos } = require('../lib/s7plus/explore-result');

function parseLimit(value, fallback = DEFAULT_MAX_SYMBOLS) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
}

module.exports = function (RED) {
    function S7ComPlusExplore(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        if (!node.endpoint) {
            node.error('Missing s7-plus endpoint configuration');
            return;
        }

        const configuredMaxSymbols = parseLimit(config.maxSymbols, DEFAULT_MAX_SYMBOLS);
        const configuredScope = normalizeExploreScope(config.exploreScope);
        const configuredSymbolInfos = normalizeSymbolInfos(config.symbolInfos);

        let busy = false;

        node.on('input', async (msg, send, done) => {
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) node.error(err, msg); };

            if (busy) {
                node.warn('Browse already in progress');
                node.status({ fill: 'yellow', shape: 'ring', text: 'skipped (busy)' });
                done();
                return;
            }
            busy = true;
            node.status({ fill: 'blue', shape: 'ring', text: 'browsing...' });
            const t0 = Date.now();
            const maxSymbols = parseLimit(
                msg && msg.maxSymbols !== undefined ? msg.maxSymbols : configuredMaxSymbols,
                configuredMaxSymbols
            );
            const scope = normalizeExploreScope(
                msg && msg.exploreScope !== undefined ? msg.exploreScope : configuredScope
            );
            const symbolInfos = normalizeSymbolInfos(
                msg && msg.symbolInfos !== undefined ? msg.symbolInfos : configuredSymbolInfos
            );

            try {
                const result = await node.endpoint.browseFull({ maxSymbols, scope });
                const elapsed = Date.now() - t0;
                const formatted = formatExplorePayload(result.symbols, symbolInfos);
                msg.payload = formatted.symbols;
                if (formatted.infos !== undefined) {
                    msg.infos = formatted.infos;
                } else {
                    delete msg.infos;
                }
                msg.meta = result.meta;
                if (result.meta.limitExceeded) {
                    node.status({
                        fill: 'yellow',
                        shape: 'dot',
                        text: `${result.meta.symbolCount}/${result.meta.maxSymbols} symbols (limit)`
                    });
                } else {
                    node.status({
                        fill: 'green',
                        shape: 'dot',
                        text: `${result.meta.symbolCount} symbol(s) (${elapsed}ms)`
                    });
                }
                send(msg);
                done();
            } catch (e) {
                const elapsed = Date.now() - t0;
                node.status({ fill: 'red', shape: 'dot', text: `${e.message} (${elapsed}ms)` });
                done(e);
            } finally {
                busy = false;
            }
        });
    }

    RED.nodes.registerType('s7-plus explore', S7ComPlusExplore);
};
