'use strict';

/**
 * Stable node ids for lazy PLC browse (base64url JSON descriptors).
 */

function encodeNodeId(descriptor) {
    return Buffer.from(JSON.stringify(descriptor), 'utf8').toString('base64url');
}

function decodeNodeId(nodeId) {
    if (!nodeId || typeof nodeId !== 'string') {
        throw new Error('Invalid browse node id');
    }
    try {
        return JSON.parse(Buffer.from(nodeId, 'base64url').toString('utf8'));
    } catch {
        throw new Error('Invalid browse node id');
    }
}

module.exports = { encodeNodeId, decodeNodeId };
