'use strict';

const S7p = require('./s7p');
const PObject = require('./pobject');
const pvalue = require('./pvalue');
const { Ids, Opcode } = require('./constants');
const {
    ValueWString,
    ValueUSInt,
    ValueUInt,
    ValueInt,
    ValueLInt,
    ValueUDInt,
    ValueBool,
    ValueUDIntArray
} = pvalue;

// Flag byte that marks a UDInt array as an "address array" on the wire.
const FLAGS_ADDRESSARRAY = 0x20;

// Default subscription tuning. RouteMode 0x20 with CreditLimit -1 means:
// all values on create, then only changed values each cycle, unlimited
// without retriggering and with CreditTick staying 0 — i.e. no credit
// refresh is ever required (see thomas-v2 Subscription.cs notes).
const DEFAULT_ROUTE_MODE = 0x20;
const DEFAULT_CREDIT_LIMIT = -1;
const DEFAULT_CYCLE_MS = 1000;
const SUBSCRIPTION_RELATION_ID_START = 0x7fffc001;

/**
 * Build the SubscriptionReferenceList (attribute 1048) as an address-array.
 * 1:1 port of GetSubscriptionListArray in thomas-v2 Subscriptions/Subscription.cs.
 *
 * @param {Array<{name: string, address: ItemAddress, datatype?: *}>} items
 * @param {number} changeCounter - 1-byte subscription change counter
 * @returns {{ value: ValueUDIntArray, refToName: Map<number, {name: string, datatype: *}> }}
 */
function buildSubscriptionReferenceList(items, changeCounter = 1) {
    const la = [];
    // 0x8?ssxxxx: 0x8 = flag CreateNew, ss = subscription change counter.
    la.push((0x80000000 | ((changeCounter & 0xff) << 16)) >>> 0);
    la.push(0);                  // number of items to unsubscribe
    la.push(items.length >>> 0); // number of items to subscribe

    const refToName = new Map();
    let tagReferenceId = 1;
    for (const item of items) {
        const addr = item.address;
        const lids = addr.lid || [];
        refToName.set(tagReferenceId, { name: item.name, datatype: item.datatype });
        // 0x8aaabbbb: bbbb = number of fields in the 2nd part (counting starts
        // at AccessSubArea), i.e. 1 (sub-area) + one entry per LID.
        const head = (0x80040000 | ((1 + lids.length) & 0xffff)) >>> 0;
        la.push(head);
        la.push(tagReferenceId);
        la.push(0);                            // unknown 1
        la.push(addr.accessArea >>> 0);
        la.push((addr.symbolCrc || 0) >>> 0);
        la.push(addr.accessSubArea >>> 0);
        for (const li of lids) la.push(li >>> 0);
        tagReferenceId++;
    }
    return { value: new ValueUDIntArray(la, FLAGS_ADDRESSARRAY), refToName };
}

/**
 * Build the subscription PObject used as the CreateObject request object.
 * Attribute set and order mirror SubscriptionCreate in the reference driver.
 *
 * @param {Array} items - resolved tags { name, address (ItemAddress), datatype }
 * @param {object} [opts]
 * @returns {{ object: PObject, refToName: Map, relationId: number }}
 */
function buildSubscriptionObject(items, opts = {}) {
    const cycleMs = opts.cycleMs > 0 ? opts.cycleMs : DEFAULT_CYCLE_MS;
    const routeMode = opts.routeMode != null ? opts.routeMode : DEFAULT_ROUTE_MODE;
    const creditLimit = opts.creditLimit != null ? opts.creditLimit : DEFAULT_CREDIT_LIMIT;
    const changeCounter = opts.changeCounter != null ? opts.changeCounter : 1;
    const relationId = (opts.relationId != null ? opts.relationId : SUBSCRIPTION_RELATION_ID_START) >>> 0;

    const { value: refList, refToName } = buildSubscriptionReferenceList(items, changeCounter);

    const obj = new PObject(relationId, Ids.ClassSubscription, Ids.None);
    obj.addAttribute(Ids.ObjectVariableTypeName, new ValueWString('Subscription_' + relationId));
    obj.addAttribute(Ids.SubscriptionFunctionClassId, new ValueUSInt(0));
    obj.addAttribute(Ids.SubscriptionMissedSendings, new ValueUInt(0));
    obj.addAttribute(Ids.SubscriptionSubsystemError, new ValueLInt(0));
    obj.addAttribute(Ids.SubscriptionRouteMode, new ValueUSInt(routeMode));
    obj.addAttribute(Ids.SubscriptionActive, new ValueBool(true));
    obj.addAttribute(Ids.SubscriptionReferenceList, refList);
    obj.addAttribute(Ids.SubscriptionCycleTime, new ValueUDInt(cycleMs >>> 0));
    obj.addAttribute(Ids.SubscriptionDisabled, new ValueUSInt(0));
    obj.addAttribute(Ids.SubscriptionCount, new ValueUSInt(0));
    obj.addAttribute(Ids.SubscriptionCreditLimit, new ValueInt(creditLimit));
    obj.addAttribute(Ids.SubscriptionTicks, new ValueUInt(65535));

    return { object: obj, refToName, relationId };
}

// .Net DateTime epoch offset is irrelevant here; PLC notification timestamps
// are microseconds since the Unix epoch (UTC).
function microsToDate(micros) {
    return new Date(Number(micros / 1000n));
}

/**
 * Decode a Notification PDU (opcode 0x33). 1:1 port of Notification.Deserialize
 * in thomas-v2 Core/Notification.cs. The stream must be positioned at the very
 * start of the assembled PDU (protocolVersion byte first).
 *
 * @param {BufferStream} stream
 * @returns {null | {
 *   protocolVersion: number, subscriptionId: number, creditTick: number,
 *   seqNum: number, changeCounter: number, plcTimestamp: Date|null,
 *   values: Map<number, object>, errors: Map<number, number>
 * }}
 */
function parseNotification(stream) {
    const protocolVersion = S7p.decodeByte(stream).v;
    const opcode = S7p.decodeByte(stream).v;
    if (opcode !== Opcode.Notification) return null;

    const subscriptionId = S7p.decodeUInt32(stream).v;
    S7p.decodeUInt16(stream); // unknown2
    S7p.decodeUInt16(stream); // unknown3
    S7p.decodeUInt16(stream); // unknown4

    const creditTick = S7p.decodeByte(stream).v;
    const seqNum = S7p.decodeUInt32Vlq(stream).v;
    let changeCounter = S7p.decodeByte(stream).v;
    let plcTimestamp = null;
    if (changeCounter === 0) {
        // Newer S7-1500 firmware: instead of the change counter, an 8-byte UTC
        // microsecond timestamp follows (first byte always 0), then the counter.
        stream.position -= 1;
        const micros = S7p.decodeUInt64(stream).v;
        plcTimestamp = microsToDate(micros);
        changeCounter = S7p.decodeByte(stream).v;
    }

    const values = new Map();
    const errors = new Map();
    let itemReturnValue;
    do {
        itemReturnValue = S7p.decodeByte(stream).v;
        switch (itemReturnValue) {
            case 0x00:
                break;
            case 0x92: {
                const itemRef = S7p.decodeUInt32(stream).v;
                values.set(itemRef, pvalue.deserialize(stream));
                break;
            }
            case 0x9b: {
                const itemRef = S7p.decodeUInt32Vlq(stream).v;
                values.set(itemRef, pvalue.deserialize(stream));
                break;
            }
            case 0x9c:
                S7p.decodeUInt32(stream); // online-with-status-table marker; discard
                break;
            case 0x13:
            case 0x03: {
                const itemRef = S7p.decodeUInt32(stream).v;
                errors.set(itemRef, itemReturnValue);
                break;
            }
            default:
                // Unknown return code (e.g. 0x83 alarm value in protocol v1).
                // Stop decoding gracefully instead of throwing in the receive path.
                itemReturnValue = 0;
                break;
        }
    } while (itemReturnValue !== 0);

    // An optional alarm-object part may follow (peek byte != 0); it is not
    // relevant for data-change subscriptions, so it is intentionally ignored.

    return {
        protocolVersion,
        subscriptionId,
        creditTick,
        seqNum,
        changeCounter,
        plcTimestamp,
        values,
        errors
    };
}

// NOTE on notification sequence numbers: with RouteMode 0x20 the PLC skips
// sending on cycles without changes, but the sequence number still advances
// per CYCLE. A seqNum jump therefore means "empty cycles were skipped", NOT
// "notifications were lost" — seqNum-based gap detection is unusable in this
// mode (verified against the RouteMode table in thomas-v2/S7CommPlusDriver,
// Subscriptions/Subscription.cs). Transport loss cannot occur on a live
// TCP/TLS session; loss across disconnects is covered by the re-establish
// full snapshot.

module.exports = {
    buildSubscriptionReferenceList,
    buildSubscriptionObject,
    parseNotification,
    SUBSCRIPTION_RELATION_ID_START
};
