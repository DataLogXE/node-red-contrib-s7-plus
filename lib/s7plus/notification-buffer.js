'use strict';

// A notification can arrive BEFORE the CreateObject response has been
// processed (same TCP segment): the PLC pushes the initial full-value
// snapshot right after creating the subscription object, but the endpoint
// only learns the subscription object id once the awaited response
// resolves. Dropping that first notification would silently lose values
// that never change (RouteMode 0x20 sends them exactly once).
//
// This buffer holds such unmatched notifications for a short time so the
// endpoint can replay them right after registering the object id.

const DEFAULT_TTL_MS = 5000;
const DEFAULT_MAX_PER_ID = 10;

class NotificationBuffer {
    /**
     * @param {object} [opts]
     * @param {number} [opts.ttlMs] - how long an entry stays replayable
     * @param {number} [opts.maxPerId] - cap of buffered notifications per id
     */
    constructor(opts = {}) {
        this._ttlMs = opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
        this._maxPerId = opts.maxPerId > 0 ? opts.maxPerId : DEFAULT_MAX_PER_ID;
        this._byId = new Map(); // subscriptionId -> [{ noti, at }]
    }

    _prune(now) {
        const cutoff = now - this._ttlMs;
        for (const [id, entries] of this._byId) {
            const kept = entries.filter((e) => e.at >= cutoff);
            if (kept.length === 0) this._byId.delete(id);
            else if (kept.length !== entries.length) this._byId.set(id, kept);
        }
    }

    /**
     * Buffer an unmatched notification for later replay.
     * @param {number} subscriptionId
     * @param {object} noti - parsed notification
     * @param {number} [now] - injectable clock for tests
     */
    push(subscriptionId, noti, now = Date.now()) {
        this._prune(now);
        let entries = this._byId.get(subscriptionId);
        if (!entries) {
            entries = [];
            this._byId.set(subscriptionId, entries);
        }
        entries.push({ noti, at: now });
        // Keep only the newest entries; the oldest carry the least value
        // once the cap is hit (changes are cumulative per cycle anyway).
        if (entries.length > this._maxPerId) {
            entries.splice(0, entries.length - this._maxPerId);
        }
    }

    /**
     * Remove and return all buffered notifications for a subscription id,
     * in arrival order. Expired entries are dropped.
     * @param {number} subscriptionId
     * @param {number} [now] - injectable clock for tests
     * @returns {object[]} notifications (possibly empty)
     */
    drain(subscriptionId, now = Date.now()) {
        this._prune(now);
        const entries = this._byId.get(subscriptionId);
        if (!entries) return [];
        this._byId.delete(subscriptionId);
        return entries.map((e) => e.noti);
    }

    /**
     * Drop buffered notifications for a subscription id. Call AFTER the
     * DeleteObject request for that id completed: TCP ordering guarantees
     * that every notification of the old object arrived before the delete
     * response, so anything buffered under the id at that point is stale
     * and must never be replayed into a new subscription that happens to
     * reuse the id. No push-block is installed on purpose — a later push
     * for this id can only originate from a legitimately recreated
     * subscription (the PLC cannot reuse the id while the object exists),
     * and its racing initial snapshot must be buffered normally.
     * @param {number} subscriptionId
     */
    discard(subscriptionId) {
        this._byId.delete(subscriptionId);
    }

    /** Drop everything (e.g. on disconnect: old object ids are invalid). */
    clear() {
        this._byId.clear();
    }

    /** Number of subscription ids currently buffered (diagnostics/tests). */
    get size() {
        return this._byId.size;
    }
}

module.exports = { NotificationBuffer };
