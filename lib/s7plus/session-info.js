'use strict';

const PAOM_VERSION_RE = /^[^;]*;[^;]*[17]\s?(\d{3}).*;[VS](\d{1,2}\.\d+)$/i;

const PROTECTION_LABELS = {
    1: 'fullAccess',
    2: 'readAccess',
    3: 'hmiAccess',
    4: 'noAccess'
};

/**
 * Parse the PAOM string from ServerSessionVersion (Thomas Legitimation.cs).
 * @param {string} paomStr
 * @returns {{ paom: string, orderNumber: string|null, deviceCode: string|null, firmware: string|null, deviceFamily: string|null }|null}
 */
function parsePaom(paomStr) {
    if (paomStr == null || paomStr === '') return null;
    const paom = String(paomStr).trim();
    const m = PAOM_VERSION_RE.exec(paom);
    if (!m) {
        return { paom, orderNumber: null, deviceCode: null, firmware: null, deviceFamily: null };
    }

    const deviceCode = m[1];
    const firmware = `V${m[2]}`;
    const parts = paom.split(';');
    const orderNumber = parts.length >= 2 ? parts[1].trim() : null;

    let deviceFamily = null;
    if (deviceCode.startsWith('5')) deviceFamily = 'S7-1500';
    else if (deviceCode.startsWith('2')) deviceFamily = 'S7-1200';
    else if (deviceCode.startsWith('6')) deviceFamily = 'S7-1500 Software';

    return { paom, orderNumber, deviceCode, firmware, deviceFamily };
}

function protectionLevelLabel(level) {
    if (level == null) return null;
    return PROTECTION_LABELS[level] || `level${level}`;
}

function formatSessionIdHex(id) {
    if (!id) return null;
    return `0x${(id >>> 0).toString(16)}`;
}

function isoTimestamp(ms) {
    if (ms == null || !Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
}

/**
 * Build the structured session info payload returned by getSessionInfo().
 * @param {object} source
 * @param {object} [connectionExtras] endpoint config/state merged by caller
 * @param {object} [meta]
 */
function buildSessionInfoPayload(source, connectionExtras = {}, meta = {}) {
    const parsed = source.parsedPaom || {};
    const limits = source.limits || {};
    const free = source.freeItems || {};

    return {
        plc: {
            paom: source.paom || null,
            orderNumber: parsed.orderNumber || null,
            deviceCode: parsed.deviceCode || null,
            deviceFamily: parsed.deviceFamily || null,
            firmware: parsed.firmware || null
        },
        session: {
            sessionId: formatSessionIdHex(source.sessionId),
            sessionId2: formatSessionIdHex(source.sessionId2)
        },
        limits: {
            tagsPerReadMax: limits.tagsPerReadMax ?? null,
            tagsPerWriteMax: limits.tagsPerWriteMax ?? null,
            subscriptionsMax: limits.subscriptionsMax ?? null,
            attributesMax: limits.attributesMax ?? null,
            subscriptionMemoryMax: limits.subscriptionMemoryMax ?? null,
            subscriptionsFree: free.subscriptionsFree ?? null,
            attributesFree: free.attributesFree ?? null,
            subscriptionMemoryFree: free.subscriptionMemoryFree ?? null
        },
        connection: {
            address: connectionExtras.address ?? null,
            port: connectionExtras.port ?? 102,
            timeoutMs: connectionExtras.timeoutMs ?? null,
            connected: !!source.connected,
            endpointState: connectionExtras.endpointState ?? null,
            lastResponseAt: isoTimestamp(source.lastResponseAt)
        },
        meta
    };
}

/**
 * Minimal payload for connection state changes (connecting/offline).
 * Only connection address/port/timeoutMs/connected/endpointState plus meta.
 * @param {object} [connectionExtras]
 * @param {object} [meta]
 */
function buildConnectionStatePayload(connectionExtras = {}, meta = {}) {
    return {
        connection: {
            address: connectionExtras.address ?? null,
            port: connectionExtras.port ?? 102,
            timeoutMs: connectionExtras.timeoutMs ?? null,
            connected: !!connectionExtras.connected,
            endpointState: connectionExtras.endpointState ?? null
        },
        meta
    };
}

module.exports = {
    parsePaom,
    protectionLevelLabel,
    formatSessionIdHex,
    buildSessionInfoPayload,
    buildConnectionStatePayload
};
