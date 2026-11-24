'use strict';

const crypto = require('crypto');
const { scoped } = require('./debug');

const log = scoped('browse-sessions');

// A browse session holds its own PLC connection. The editor dialog
// refreshes it with every request and releases it on close; the idle TTL
// only covers dialogs that never said goodbye (tab closed, browser crash).
// Requests after expiry transparently open a new session, so a short TTL
// costs at most one reconnect.
const DEFAULT_IDLE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_SWEEP_MS = 30 * 1000;

function sessionKey(creds) {
    return `${creds.address}:${creds.port}`;
}

/**
 * Editor browse sessions for endpoints that are not deployed yet.
 *
 * - One live connection per PLC address: a second dialog (or a dialog
 *   reopened before the old session expired) reuses it instead of opening
 *   another PLC connection.
 * - Idle sessions are closed by a periodic sweep, not only when the next
 *   session is created.
 * - close() releases a session as soon as the dialog closes.
 */
class BrowseSessionStore {
    constructor(options = {}) {
        if (typeof options.createClient !== 'function') {
            throw new Error('createClient is required');
        }
        this._createClient = options.createClient;
        this._idleTtlMs = options.idleTtlMs || DEFAULT_IDLE_TTL_MS;
        this._sweepMs = options.sweepMs || DEFAULT_SWEEP_MS;
        this._now = options.now || Date.now;
        this._sessions = new Map();
        this._pending = new Map();
        this._sweepTimer = null;
    }

    get size() {
        return this._sessions.size;
    }

    has(sessionId) {
        return this._sessions.has(sessionId);
    }

    startSweep() {
        if (this._sweepTimer) return;
        this._sweepTimer = setInterval(() => this.prune(), this._sweepMs);
        if (typeof this._sweepTimer.unref === 'function') this._sweepTimer.unref();
    }

    stopSweep() {
        if (this._sweepTimer) clearInterval(this._sweepTimer);
        this._sweepTimer = null;
    }

    _release(sessionId, sess, reason) {
        this._sessions.delete(sessionId);
        const client = sess.client;
        if (client.connected && typeof client.disconnect === 'function') {
            // Graceful: deletes the session on the PLC so its connection
            // resource is free immediately.
            Promise.resolve()
                .then(() => client.disconnect())
                .catch(() => {
                    try { client.forceDisconnect(reason); } catch { /* ignore */ }
                });
        } else {
            try { client.forceDisconnect(reason); } catch { /* ignore */ }
        }
    }

    prune() {
        const now = this._now();
        let removed = 0;
        for (const [id, sess] of this._sessions) {
            const expired = sess.expires < now;
            if (expired || sess.dead) {
                log('prune', { sessionId: id, dead: !!sess.dead, expired });
                this._release(id, sess, 'prune');
                removed++;
            }
        }
        return removed;
    }

    _findLive(key) {
        for (const [id, sess] of this._sessions) {
            if (sess.key === key && !sess.dead && sess.client.connected) return id;
        }
        return null;
    }

    /**
     * Return a session id for the given PLC, reusing a live one for the
     * same address. Concurrent calls for the same address share one connect.
     */
    async open(creds) {
        this.prune();
        const key = sessionKey(creds);
        const existing = this._findLive(key);
        if (existing) {
            log('reuse', { sessionId: existing, key });
            this._sessions.get(existing).expires = this._now() + this._idleTtlMs;
            return existing;
        }
        if (this._pending.has(key)) return this._pending.get(key);

        const p = (async () => {
            log('create', { key });
            const client = this._createClient();
            await client.connect(creds.address, creds.password, creds.username, creds.timeoutMs, creds.port);
            const sessionId = crypto.randomBytes(16).toString('hex');
            const sess = { client, key, expires: this._now() + this._idleTtlMs, dead: false };
            client.on('disconnect', (info) => {
                sess.dead = true;
                log('disconnect', { sessionId, reason: info && info.reason });
            });
            this._sessions.set(sessionId, sess);
            return sessionId;
        })();
        this._pending.set(key, p);
        try {
            return await p;
        } finally {
            this._pending.delete(key);
        }
    }

    /** Client for a session; refreshes its idle timer. */
    get(sessionId) {
        this.prune();
        const sess = this._sessions.get(sessionId);
        if (!sess) throw new Error('Browse session expired — open Browse PLC again');
        if (sess.dead || !sess.client.connected) {
            this._release(sessionId, sess, 'stale');
            throw new Error('Browse session stale — open Browse PLC again');
        }
        sess.expires = this._now() + this._idleTtlMs;
        return sess.client;
    }

    /** Release a session now (dialog closed, or retry after a stale error). */
    close(sessionId, reason = 'close') {
        const sess = this._sessions.get(sessionId);
        if (!sess) return false;
        log('close', { sessionId, reason });
        this._release(sessionId, sess, reason);
        return true;
    }

    closeAll(reason = 'close-all') {
        for (const [id, sess] of this._sessions) this._release(id, sess, reason);
    }
}

module.exports = {
    BrowseSessionStore,
    DEFAULT_IDLE_TTL_MS,
    DEFAULT_SWEEP_MS
};
