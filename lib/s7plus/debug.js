'use strict';

/**
 * Tiny scope-aware debug logger.
 *
 * Activation:
 *   - environment variable `S7P_DEBUG`:
 *       `1` / `true` / `*`     enable all scopes
 *       `client,endpoint`      enable only listed scopes (comma-separated)
 *   - programmatic: `require('./debug').setEnabled('client,transport')`
 *
 * Output goes to stderr via `console.error` so it surfaces in the Node-RED
 * log without interfering with stdout-based protocols.
 */

const SCOPE_PREFIX = 's7p';
let enabledScopes = parseScopes(process.env.S7P_DEBUG || '');
let sink = (line) => { try { console.error(line); } catch { /* ignore */ } };

function parseScopes(spec) {
    if (!spec) return new Set();
    const s = String(spec).trim().toLowerCase();
    if (s === '0' || s === 'false' || s === 'off') return new Set();
    if (s === '1' || s === 'true' || s === '*' || s === 'all') return new Set(['*']);
    return new Set(s.split(',').map(x => x.trim()).filter(Boolean));
}

function setEnabled(spec) {
    enabledScopes = parseScopes(spec);
}

function isEnabled(scope) {
    if (!enabledScopes.size) return false;
    if (enabledScopes.has('*')) return true;
    return enabledScopes.has(String(scope).toLowerCase());
}

function setSink(fn) {
    sink = typeof fn === 'function' ? fn : sink;
}

function ts() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
}

function fmtValue(v) {
    if (v == null) return String(v);
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NaN';
    if (typeof v === 'string') return v;
    if (Buffer.isBuffer(v)) return `<Buffer ${v.length}b ${v.subarray(0, 16).toString('hex')}${v.length > 16 ? '…' : ''}>`;
    if (v instanceof Error) return v.message;
    try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Lazily resolve a debug record so we never pay the formatting cost when
 * the scope is disabled. Accepts either positional args or a thunk:
 *   debug('client', 'connect', { host });
 *   debug('client', () => ['connect', { host }]);
 */
function debug(scope, ...args) {
    if (!isEnabled(scope)) return;
    let parts = args;
    if (parts.length === 1 && typeof parts[0] === 'function') {
        try { parts = parts[0]() || []; } catch (e) { parts = [`<debug-thunk-error: ${e.message}>`]; }
        if (!Array.isArray(parts)) parts = [parts];
    }
    const head = `[${SCOPE_PREFIX}:${scope}] ${ts()}`;
    const tail = parts.map(fmtValue).join(' ');
    sink(`${head} ${tail}`);
}

/**
 * Convenience scoped logger:
 *   const log = require('./debug').scoped('client');
 *   log('connect', { host });
 */
function scoped(scope) {
    return (...args) => debug(scope, ...args);
}

module.exports = { debug, scoped, setEnabled, isEnabled, setSink };
