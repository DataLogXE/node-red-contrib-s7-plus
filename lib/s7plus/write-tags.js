'use strict';

const {
    encodeWriteValue,
    isStringDatatype,
    stringMaxLenFromValue,
    STRING_VALUE_ERROR
} = require('./pvalue-codec');
const { buildWritePayload } = require('./read-result');

function isOk(err) {
    return !err || err === 0n;
}

/**
 * Read the declared max length of the String / WString targets at the given
 * tag indices and store it in `cache` (keyed by access string). The PLC
 * returns it as element 0 of the value. Returns Map<index, readError> for
 * targets whose read failed.
 */
async function readStringLengths(client, tags, addresses, indices, cache) {
    const failed = new Map();
    if (!indices.length) return failed;
    const { values, errors } = await client.readValues(indices.map(i => addresses[i]));
    indices.forEach((tagIdx, k) => {
        const maxLen = isOk(errors[k]) ? stringMaxLenFromValue(values[k]) : null;
        if (maxLen == null) {
            failed.set(tagIdx, isOk(errors[k]) ? null : errors[k]);
        } else {
            cache.set(tags[tagIdx].address, maxLen);
        }
    });
    return failed;
}

/**
 * Encode and write tags, returning the per-tag result payload
 * (`{ name: { value, status, error } }`).
 *
 * String / WString: the write must carry the DECLARED length of the target
 * (`String[n]`), otherwise the PLC rejects it. The length is read from the
 * PLC once per address and kept in `stringLenCache`. A cached length that
 * turned stale (PLC program changed) is detected by the failed write and
 * refreshed with a single retry.
 *
 * Values that do not fit the target string (too long, not representable)
 * are reported as a per-tag error and are not sent; the other tags are
 * still written.
 *
 * @param {object} client        S7CommPlusClient (readValues / writeValues)
 * @param {Array}  tags          `{ name?, address, value, datatype }`
 * @param {Array}  addresses     ItemAddress per tag (same order)
 * @param {object} ctx
 * @param {Map}    ctx.stringLenCache        access string -> declared length
 * @param {bigint} [ctx.dtlInterfaceTimestamp]
 */
async function writeTagsEncoded(client, tags, addresses, ctx = {}) {
    const cache = ctx.stringLenCache || new Map();
    const baseOpts = { dtlInterfaceTimestamp: ctx.dtlInterfaceTimestamp };

    const errors = tags.map(() => 0n);      // PLC error code per tag
    const localErrors = new Map();           // tag index -> error text
    const skipped = new Set();               // not sent to the PLC

    const stringIdx = tags
        .map((t, i) => (isStringDatatype(t && t.datatype) ? i : -1))
        .filter(i => i >= 0);
    const fromCache = new Set(stringIdx.filter(i => cache.has(tags[i].address)));

    const unreadable = (failed) => {
        for (const [i, readErr] of failed) {
            skipped.add(i);
            // Keep the PLC's own code (e.g. stale address / CRC mismatch) so
            // the caller's self-heal still recognises it.
            if (readErr != null) errors[i] = readErr;
            else localErrors.set(i, 'Cannot determine the declared string length of the target');
        }
    };
    unreadable(await readStringLengths(
        client, tags, addresses, stringIdx.filter(i => !fromCache.has(i)), cache
    ));

    const encode = (i) => {
        const t = tags[i];
        const opts = isStringDatatype(t.datatype)
            ? { ...baseOpts, stringMaxLen: cache.get(t.address) }
            : baseOpts;
        try {
            return encodeWriteValue(t.value, t.datatype, opts);
        } catch (e) {
            if (!e || e.code !== STRING_VALUE_ERROR) throw e;
            skipped.add(i);
            localErrors.set(i, e.message);
            return null;
        }
    };

    const send = async (indices) => {
        const items = [];
        for (const i of indices) {
            if (skipped.has(i)) continue;
            const value = encode(i);
            if (value !== null) items.push({ i, value });
        }
        if (!items.length) return;
        const res = await client.writeValues(items.map(x => addresses[x.i]), items.map(x => x.value));
        items.forEach((x, k) => { errors[x.i] = res.errors[k]; });
    };

    await send(tags.map((_, i) => i));

    // A string write rejected with a cached length: the declaration may have
    // changed. Re-read the length and retry once if it really differs.
    const suspects = [...fromCache].filter(i => !skipped.has(i) && !isOk(errors[i]));
    if (suspects.length) {
        const before = new Map(suspects.map(i => [i, cache.get(tags[i].address)]));
        for (const i of suspects) cache.delete(tags[i].address);
        const failed = await readStringLengths(client, tags, addresses, suspects, cache);
        const retry = suspects.filter(i => !failed.has(i) && cache.get(tags[i].address) !== before.get(i));
        for (const i of retry) localErrors.delete(i);
        await send(retry);
    }

    const result = buildWritePayload(tags, errors);
    for (const [i, message] of localErrors) {
        const name = tags[i].name || `tag${i}`;
        result[name] = { value: null, status: 'error', error: message };
    }
    return result;
}

module.exports = { writeTagsEncoded };
