'use strict';

/**
 * Cooperative-scheduling helpers for heavy browse/resolve work.
 *
 * Node-RED, the dashboard websocket, all timers and this driver share ONE
 * event loop. Long chains of awaits that resolve synchronously (cache
 * hits, local tree walks) never return to the event loop — timers,
 * socket.io ping/pong and even SIGINT handling starve. These helpers
 * yield periodically on the hot paths only.
 */

/** Yield interval for the flat symbol browser (emitted symbols / array elems). */
const FLAT_YIELD_EVERY = 500;

/** Yield interval for symbolic batch resolve (paths processed). */
const RESOLVE_YIELD_EVERY = 50;

/**
 * Return to the event loop once. setImmediate is not a delay — it just
 * lets pending I/O, timers (watchdog, socket.io ping) and signal
 * handlers run before continuing.
 */
function yieldToEventLoop() {
    return new Promise((resolve) => setImmediate(resolve));
}

module.exports = {
    FLAT_YIELD_EVERY,
    RESOLVE_YIELD_EVERY,
    yieldToEventLoop
};
