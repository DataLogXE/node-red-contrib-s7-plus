'use strict';

// Per-key promise chain: operations sharing the same key run strictly one
// after another, while operations on different keys run independently.
//
// Used by the endpoint to serialize all record-mutating subscription
// operations per owner node id. Without this, a deploy-initiated subscribe
// racing an "inject once after startup" message would run two establishes
// on the same record and create an orphaned PLC subscription whose
// notifications get decoded with the wrong reference map.

class SerialQueue {
    constructor() {
        this._tails = new Map(); // key -> tail promise of the chain
    }

    /**
     * Enqueue `fn` behind all previously queued operations for `key`.
     * The returned promise settles with fn's result/error. A rejected
     * predecessor never blocks successors.
     *
     * @param {*} key
     * @param {() => Promise<*>|*} fn
     * @returns {Promise<*>}
     */
    run(key, fn) {
        const prev = this._tails.get(key) || Promise.resolve();
        const next = prev.catch(() => { /* predecessor errors are the caller's business */ })
            .then(() => fn());
        // Track the tail regardless of outcome; clean up once the chain
        // is idle so the map does not grow with dead keys.
        const tail = next.catch(() => { /* keep the chain alive */ });
        this._tails.set(key, tail);
        tail.finally(() => {
            if (this._tails.get(key) === tail) this._tails.delete(key);
        });
        return next;
    }

    /** Number of keys with in-flight chains (diagnostics/tests). */
    get size() {
        return this._tails.size;
    }
}

module.exports = { SerialQueue };
