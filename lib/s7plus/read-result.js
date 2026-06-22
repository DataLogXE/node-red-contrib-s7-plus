'use strict';

const { errorText, S7Consts } = require('./constants');

function readTagErrorText(err) {
    if (!err || err === 0n) return 'OK';
    if (err <= BigInt(Number.MAX_SAFE_INTEGER)) {
        const n = Number(err);
        const text = errorText(n);
        if (text !== `CLI: Unknown error (0x${(n >>> 0).toString(16)})`) {
            return text;
        }
    }
    return `PLC: Read error (0x${err.toString(16)})`;
}

function buildReadTagStatus(err) {
    if (!err || err === 0n) {
        return { status: 'ok', error: '' };
    }
    return { status: 'error', error: readTagErrorText(err) };
}

function writeTagErrorText(err) {
    if (!err || err === 0n) return 'OK';
    if (err <= BigInt(Number.MAX_SAFE_INTEGER)) {
        const n = Number(err);
        const text = errorText(n);
        if (text !== `CLI: Unknown error (0x${(n >>> 0).toString(16)})`) {
            return text;
        }
    }
    return `PLC: Write error (0x${err.toString(16)})`;
}

function buildReadPayload(prepared, rawValues, errors, decodeReadValue) {
    const result = {};
    for (let i = 0; i < prepared.length; i++) {
        const name = prepared[i].tag.name || `tag${i}`;
        const err = errors[i];
        const tagStatus = buildReadTagStatus(err);
        if (tagStatus.status === 'ok') {
            const softdatatype = prepared[i].tag.datatype || undefined;
            result[name] = { value: decodeReadValue(rawValues[i], softdatatype), ...tagStatus };
        } else {
            result[name] = { value: null, ...tagStatus };
        }
    }
    return result;
}

function buildWriteTagStatus(err) {
    if (!err || err === 0n) {
        return { status: 'ok', error: '' };
    }
    return { status: 'error', error: writeTagErrorText(err) };
}

/**
 * Build a per-tag write result keyed by tag name, mirroring buildReadPayload.
 * On success the written value is echoed back; on error the value is null,
 * exactly like the read payload.
 */
function buildWritePayload(tags, errors) {
    const result = {};
    for (let i = 0; i < tags.length; i++) {
        const name = tags[i].name || `tag${i}`;
        const tagStatus = buildWriteTagStatus(errors[i]);
        result[name] = tagStatus.status === 'ok'
            ? { value: tags[i].value, ...tagStatus }
            : { value: null, ...tagStatus };
    }
    return result;
}

function formatOutputPayload(result, order, format) {
    if (format !== 'array') return result;
    return order
        .filter((symbol) => Object.prototype.hasOwnProperty.call(result, symbol))
        .map((symbol) => ({ symbol, ...result[symbol] }));
}

module.exports = {
    readTagErrorText,
    writeTagErrorText,
    buildReadTagStatus,
    buildReadPayload,
    buildWriteTagStatus,
    buildWritePayload,
    formatOutputPayload
};
