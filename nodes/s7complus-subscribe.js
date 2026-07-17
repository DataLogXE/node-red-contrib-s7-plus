'use strict';

const { isHexAddress, isSymbolicName } = require('../lib/s7plus/tag-routing');
const { formatOutputPayload } = require('../lib/s7plus/read-result');
const { decodeReadValue } = require('../lib/s7plus/pvalue-codec');
const { OutputMsgQueue } = require('../lib/s7plus/output-msg-queue');
const { parseAddSymbols, parseMsgSymbols } = require('./s7complus-in');

// Minimum cycle accepted by the PLC. The breakpoint test showed every tested
// CPU rejects subscriptions with a cycle below 100 ms.
const MIN_CYCLE_MS = 100;

// Resend option: how often the stale-value scan runs.
const RESEND_CHECK_PERIOD_MS = 1000;

const CTX_RUNTIME_ADDS = 'runtimeAddSymbols';
const CTX_OVERRIDE = 'overrideSymbols';

/** In-process runtime state keyed by subscribe-node id (survives deploy). */
const runtimeStateByNodeId = new Map();

/**
 * Extract the symbolic PLC path from a configured symbol entry. Mirrors the
 * read node's routing: a non-hex address is the symbolic path; otherwise a
 * symbolic name is used. A hex-only entry cannot be subscribed symbolically
 * (no CRC) and is rejected.
 */
function symbolPathOf(t) {
    if (typeof t === 'string') return t;
    if (!t || typeof t !== 'object') return null;
    const addr = t.address || t.symbol;
    if (addr && !isHexAddress(addr)) return addr;
    if (isSymbolicName(t.name)) return t.name;
    if (addr) return null;
    return t.name || null;
}

/**
 * Derive the symbolic paths to subscribe from configured symbols and optional
 * msg.symbols / msg.addSymbols (same rules as the read node).
 */
function resolveSubscribePaths(msg, configuredSymbols) {
    const addPaths = parseAddSymbols(msg);
    const msgSymbols = parseMsgSymbols(msg);
    const source = msgSymbols !== undefined ? msgSymbols : configuredSymbols;

    const paths = [];
    for (let i = 0; i < source.length; i++) {
        const p = typeof source[i] === 'string'
            ? (isHexAddress(source[i]) ? null : source[i])
            : symbolPathOf(source[i]);
        if (p) paths.push(p);
    }
    return [...new Set([...paths, ...addPaths])];
}

/** Set comparison for subscription symbol lists (order-independent). */
function pathsEqual(a, b) {
    if (a.length !== b.length) return false;
    const setB = new Set(b);
    return a.every((p) => setB.has(p));
}

/** Paths added at runtime beyond the editor-configured base list. */
function computeRuntimeAdds(fullPaths, configuredSymbols) {
    const base = new Set(resolveSubscribePaths({}, configuredSymbols));
    return fullPaths.filter((p) => !base.has(p));
}

/** Rebuild the subscribed path list from editor config and persisted runtime state. */
function restoreSubscribePathsFromState(configuredSymbols, state) {
    const msg = {};
    if (state && state.overrideSymbols) msg.symbols = state.overrideSymbols;
    if (state && state.runtimeAddSymbols && state.runtimeAddSymbols.length) {
        msg.addSymbols = state.runtimeAddSymbols;
    }
    return resolveSubscribePaths(msg, configuredSymbols);
}

/** Read persisted runtime state (module map first, node context as fallback). */
function readRuntimeState(nodeId, context) {
    const cached = runtimeStateByNodeId.get(nodeId);
    if (cached) return { ...cached };

    if (!context) return {};

    const adds = contextGet(context, CTX_RUNTIME_ADDS);
    const override = contextGet(context, CTX_OVERRIDE);
    const state = {};
    if (Array.isArray(adds) && adds.length) state.runtimeAddSymbols = adds;
    if (Array.isArray(override) && override.length) state.overrideSymbols = override;
    if (state.runtimeAddSymbols || state.overrideSymbols) {
        runtimeStateByNodeId.set(nodeId, { ...state });
        return state;
    }
    return {};
}

function contextGet(context, key) {
    const value = context.get(key);
    if (value && typeof value.then === 'function') return undefined;
    return value;
}

function contextSet(context, key, value) {
    const result = context.set(key, value);
    if (result && typeof result.then === 'function') {
        result.catch(() => {});
    }
}

function contextDelete(context, key) {
    const result = context.set(key, undefined);
    if (result && typeof result.then === 'function') {
        result.catch(() => {});
    }
}

/** Rebuild the subscribed path list from editor config and persisted context (tests). */
function restoreSubscribePaths(configuredSymbols, context) {
    if (!context) return resolveSubscribePaths({}, configuredSymbols);
    const adds = contextGet(context, CTX_RUNTIME_ADDS);
    const override = contextGet(context, CTX_OVERRIDE);
    const state = {};
    if (Array.isArray(adds) && adds.length) state.runtimeAddSymbols = adds;
    if (Array.isArray(override) && override.length) state.overrideSymbols = override;
    return restoreSubscribePathsFromState(configuredSymbols, state);
}

/**
 * Persist runtime subscription state for deploy survival.
 * inputMeta.overrideSymbols: undefined = leave override unchanged;
 *   string[] = set/replace; null/[] = clear override.
 */
function persistSubscriptionState(nodeId, context, symbols, configuredSymbols, inputMeta) {
    const state = readRuntimeState(nodeId, context);
    state.runtimeAddSymbols = computeRuntimeAdds(symbols, configuredSymbols);
    if (inputMeta && inputMeta.overrideSymbols !== undefined) {
        if (inputMeta.overrideSymbols && inputMeta.overrideSymbols.length) {
            state.overrideSymbols = inputMeta.overrideSymbols;
        } else {
            delete state.overrideSymbols;
        }
    }

    if (state.runtimeAddSymbols.length || state.overrideSymbols) {
        runtimeStateByNodeId.set(nodeId, { ...state });
    } else {
        runtimeStateByNodeId.delete(nodeId);
    }

    if (context) {
        contextSet(context, CTX_RUNTIME_ADDS, state.runtimeAddSymbols);
        if (state.overrideSymbols) {
            contextSet(context, CTX_OVERRIDE, state.overrideSymbols);
        } else {
            contextDelete(context, CTX_OVERRIDE);
        }
    }
}

function clearSubscriptionState(nodeId, context) {
    runtimeStateByNodeId.delete(nodeId);
    if (!context) return;
    contextDelete(context, CTX_RUNTIME_ADDS);
    contextDelete(context, CTX_OVERRIDE);
}

function parseCloseArgs(args) {
    if (args.length === 1 && typeof args[0] === 'function') {
        return { removed: false, done: args[0] };
    }
    const removed = args.length >= 2 && args[0] === true;
    const done = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : () => {};
    return { removed, done };
}

module.exports = function (RED) {
    function S7ComPlusSubscribe(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        if (!node.endpoint) {
            node.error('Missing s7-plus endpoint configuration');
            return;
        }

        const configuredSymbols = Array.isArray(config.symbols) ? config.symbols : [];

        let cycleMs = parseInt(config.cycleMs, 10) > 0 ? parseInt(config.cycleMs, 10) : 1000;
        if (cycleMs < MIN_CYCLE_MS) {
            node.warn(`cycleMs ${cycleMs} below PLC minimum, raised to ${MIN_CYCLE_MS} ms`);
            cycleMs = MIN_CYCLE_MS;
        }
        // RouteMode/CreditLimit are intentionally NOT configurable: the only
        // supported combination is "changes only, unlimited, no credit
        // refresh" (0x20 / -1, the lib default). Credit-consuming modes would
        // silently starve because no credit refresh is implemented.
        const subOpts = { cycleMs };

        const resendEnabled = config.resendEnabled === true || config.resendEnabled === 'true';
        // Interval is configured in whole seconds, so >= 1 s by construction.
        const resendIntervalS = parseInt(config.resendIntervalS, 10);
        const resendIntervalMs = (resendIntervalS > 0 ? resendIntervalS : 60) * 1000;

        function nodeContext() {
            return typeof node.context === 'function' ? node.context() : null;
        }

        // The node status reflects this node's own state (subscribed / update /
        // error). The shared endpoint subscription count is no longer shown.
        let lastOwn = { fill: 'grey', shape: 'ring', text: '' };
        let activeSymbols = [];
        let busy = false;

        // Last known state per symbol name, used by the resend option.
        // lastSentAt tracks when the symbol was last part of an output message.
        const lastValues = new Map();
        let resendTimer = null;

        function render() {
            node.status({ fill: lastOwn.fill, shape: lastOwn.shape, text: lastOwn.text });
        }

        function applyStatus(event) {
            switch (event.state) {
                case 'subscribed': {
                    const errCount = event.resolveErrors ? Object.keys(event.resolveErrors).length : 0;
                    if (errCount > 0) {
                        lastOwn = { fill: 'yellow', shape: 'dot', text: `subscribed ${event.itemCount}, ${errCount} unresolved` };
                    } else {
                        lastOwn = { fill: 'green', shape: 'dot', text: `subscribed ${event.itemCount}` };
                    }
                    break;
                }
                case 'connecting':
                    lastOwn = { fill: 'yellow', shape: 'ring', text: 'connecting\u2026' };
                    break;
                case 'error':
                    lastOwn = { fill: 'red', shape: 'dot', text: event.text };
                    break;
                default:
                    lastOwn = { fill: 'grey', shape: 'ring', text: '' };
            }
            render();
        }

        const outputQueue = new OutputMsgQueue((batch) => {
            if (batch.length === 0) return;
            node.send(batch);
            render();
        }, {
            onOverflow: ({ dropped, remaining }) => {
                node.warn(`output queue overflow: dropped ${dropped} oldest msg(s), ${remaining} remaining`);
            }
        });

        function buildOutputMsg(noti, refToName) {
            if (!refToName) return null;
            const msgTimestamp = new Date();
            const result = {};
            for (const [ref, info] of refToName) {
                if (noti.values.has(ref)) {
                    result[info.name] = {
                        value: decodeReadValue(noti.values.get(ref), info.datatype),
                        status: 'ok',
                        error: '',
                        plcTimestamp: noti.plcTimestamp || null,
                        msgTimestamp,
                        source: 'plc'
                    };
                } else if (noti.errors.has(ref)) {
                    const code = noti.errors.get(ref);
                    result[info.name] = {
                        value: null,
                        status: 'error',
                        error: `PLC: Subscription item error (0x${code.toString(16)})`,
                        plcTimestamp: noti.plcTimestamp || null,
                        msgTimestamp,
                        source: 'plc'
                    };
                }
                // Absent ref = unchanged this cycle; omit it ("only changes").
            }

            const changed = Object.keys(result);
            if (changed.length === 0) return null;

            for (const name of changed) {
                const entry = result[name];
                lastValues.set(name, {
                    value: entry.value,
                    status: entry.status,
                    error: entry.error,
                    plcTimestamp: entry.plcTimestamp,
                    lastSentAt: msgTimestamp.getTime()
                });
            }

            const order = [...refToName.values()].map((v) => v.name);
            lastOwn = { fill: 'green', shape: 'dot', text: `update ${changed.length} (#${noti.seqNum % 1000})` };
            return {
                payload: formatOutputPayload(result, order, config.outputFormat),
                timestamp: msgTimestamp
            };
        }

        /**
         * Resend cached values that have not been sent for the configured
         * interval. Paused while the endpoint is offline or no subscription
         * is active: resending stale values without a live connection would
         * suggest a freshness that cannot be verified.
         */
        function resendStaleValues() {
            if (activeSymbols.length === 0) return;
            if (typeof node.endpoint.getStatus === 'function'
                && node.endpoint.getStatus() !== 'online') return;

            const now = Date.now();
            const stale = [];
            for (const [name, entry] of lastValues) {
                if (now - entry.lastSentAt >= resendIntervalMs) stale.push(name);
            }
            if (stale.length === 0) return;

            const msgTimestamp = new Date(now);
            const result = {};
            for (const name of stale) {
                const entry = lastValues.get(name);
                result[name] = {
                    value: entry.value,
                    status: entry.status,
                    error: entry.error,
                    plcTimestamp: entry.plcTimestamp,
                    msgTimestamp,
                    source: 'cache'
                };
                entry.lastSentAt = now;
            }

            lastOwn = { fill: 'green', shape: 'dot', text: `resent ${stale.length}` };
            outputQueue.enqueue({
                payload: formatOutputPayload(result, stale, config.outputFormat),
                timestamp: msgTimestamp
            });
        }

        function stopResendTimer() {
            if (resendTimer) {
                clearInterval(resendTimer);
                resendTimer = null;
            }
        }

        if (resendEnabled) {
            resendTimer = setInterval(resendStaleValues, RESEND_CHECK_PERIOD_MS);
            if (typeof resendTimer.unref === 'function') resendTimer.unref();
        }

        const onEvent = (event) => {
            if (event.type === 'status') applyStatus(event);
            else if (event.type === 'data') {
                const msg = buildOutputMsg(event.noti, event.refToName);
                if (msg) outputQueue.enqueue(msg);
            }
        };

        async function applySubscription(symbols, inputMeta = {}) {
            lastOwn = { fill: 'yellow', shape: 'ring', text: 'subscribing\u2026' };
            render();
            const record = await node.endpoint.subscribe(node.id, symbols, subOpts, onEvent);
            // Persist regardless of the outcome so the intended symbol list
            // survives deploys and reconnects.
            persistSubscriptionState(node.id, nodeContext(), symbols, configuredSymbols, inputMeta);
            // Treat the symbols as active unless the establish positively
            // failed: record present but no PLC object id while the endpoint
            // is online. In that case activeSymbols stays empty so a
            // re-inject with the same list retries instead of hitting the
            // pathsEqual short-circuit. An offline endpoint is not a failure
            // (the reconnect handler establishes the subscription later).
            const endpointOnline = typeof node.endpoint.getStatus !== 'function'
                || node.endpoint.getStatus() === 'online';
            const establishFailed = record && !record.subscriptionObjectId && endpointOnline;
            activeSymbols = establishFailed ? [] : symbols;

            // Drop cached values of symbols that are no longer subscribed so
            // the resend option never replays unsubscribed symbols.
            const keep = new Set(symbols);
            for (const name of [...lastValues.keys()]) {
                if (!keep.has(name)) lastValues.delete(name);
            }
        }

        // Deploy: restore editor + persisted runtime symbols when present.
        const initialPaths = restoreSubscribePathsFromState(
            configuredSymbols,
            readRuntimeState(node.id, nodeContext())
        );
        if (initialPaths.length > 0) {
            applySubscription(initialPaths).catch((e) => {
                lastOwn = { fill: 'red', shape: 'dot', text: e.message };
                render();
                node.error(e);
            });
        } else {
            lastOwn = { fill: 'grey', shape: 'ring', text: 'waiting for symbols' };
            render();
        }

        node.on('input', async (msg, send, done) => {
            done = done || function (err) { if (err) node.error(err, msg); };

            if (busy) {
                node.status({ fill: 'grey', shape: 'ring', text: 'skipped (busy)' });
                done();
                return;
            }
            busy = true;

            try {
                let msgSymbols;
                try {
                    msgSymbols = parseMsgSymbols(msg);
                } catch (e) {
                    done(e);
                    return;
                }

                if (msgSymbols !== undefined && msgSymbols.length === 0) {
                    try {
                        await node.endpoint.unsubscribe(node.id);
                        clearSubscriptionState(node.id, nodeContext());
                        activeSymbols = [];
                        lastValues.clear();
                        lastOwn = { fill: 'grey', shape: 'ring', text: 'waiting for symbols' };
                        render();
                        done();
                    } catch (e) {
                        lastOwn = { fill: 'red', shape: 'dot', text: e.message };
                        render();
                        done(e);
                    }
                    return;
                }

                let paths;
                try {
                    paths = resolveSubscribePaths(msg, configuredSymbols);
                } catch (e) {
                    done(e);
                    return;
                }

                if (paths.length === 0) {
                    done(new Error('No symbols configured'));
                    return;
                }

                if (pathsEqual(paths, activeSymbols)) {
                    render();
                    done();
                    return;
                }

                const inputMeta = msgSymbols !== undefined
                    ? { overrideSymbols: msgSymbols }
                    : {};

                try {
                    await applySubscription(paths, inputMeta);
                    done();
                } catch (e) {
                    lastOwn = { fill: 'red', shape: 'dot', text: e.message };
                    render();
                    done(e);
                }
            } finally {
                busy = false;
            }
        });

        node.on('close', (...args) => {
            const { removed, done } = parseCloseArgs(args);
            stopResendTimer();
            outputQueue.reset();
            if (removed) {
                clearSubscriptionState(node.id, nodeContext());
                Promise.resolve(node.endpoint.unsubscribe(node.id)).finally(() => done());
            } else {
                done();
            }
        });
    }

    RED.nodes.registerType('s7-plus subscribe', S7ComPlusSubscribe);
};

module.exports.symbolPathOf = symbolPathOf;
module.exports.resolveSubscribePaths = resolveSubscribePaths;
module.exports.pathsEqual = pathsEqual;
module.exports.computeRuntimeAdds = computeRuntimeAdds;
module.exports.restoreSubscribePaths = restoreSubscribePaths;
module.exports.restoreSubscribePathsFromState = restoreSubscribePathsFromState;
module.exports.readRuntimeState = readRuntimeState;
module.exports.persistSubscriptionState = persistSubscriptionState;
module.exports.clearSubscriptionState = clearSubscriptionState;
module.exports.parseCloseArgs = parseCloseArgs;
module.exports._resetRuntimeStateForTests = () => runtimeStateByNodeId.clear();
module.exports.CTX_RUNTIME_ADDS = CTX_RUNTIME_ADDS;
module.exports.CTX_OVERRIDE = CTX_OVERRIDE;
