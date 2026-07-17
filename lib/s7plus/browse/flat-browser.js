'use strict';

const { Ids } = require('../constants');
const { MEMORY_AREAS } = require('./areas');
const { eNodeType, softdatatypeName, isSoftdatatypeSupported, isPackedLeafDatatype, getSizeOfDatatype } = require('./datatypes');
const { applyBoolBitoffsets } = require('./vte-helpers');
const { computeCrcFromMeta } = require('../crc');
const { FLAT_YIELD_EVERY, yieldToEventLoop } = require('../cooperative');

function oitLowerBound(oit) {
    if (!oit) return 0;
    if (typeof oit.getArrayLowerBounds === 'function') return oit.getArrayLowerBounds() | 0;
    if (typeof oit.arrayLowerBounds === 'number') return oit.arrayLowerBounds | 0;
    return 0;
}

function crcMetaFromSegments(segments) {
    if (segments.length === 0) return null;
    if (segments.length === 1) return segments[0];
    return { pathSegments: segments };
}

const SOFTDATATYPE_BBOOL = 40;

function normalizeMaxSymbols(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return Infinity;
    return Math.floor(n);
}

function createNode(overrides = {}) {
    return {
        nodeType: eNodeType.Undefined,
        name: '',
        accessId: 0,
        softdatatype: 0,
        relationId: 0,
        vte: null,
        arrayAdrOffsetOpt: 0,
        arrayAdrOffsetNonOpt: 0,
        childs: [],
        ...overrides
    };
}

function findObjectByRelId(objs, relId) {
    if (!objs || relId === 0) return null;
    for (const ob of objs) {
        if (ob.relationId === relId) return ob;
    }
    return null;
}

function getTComSize(ob, objs) {
    const attr = ob.getAttribute ? ob.getAttribute(Ids.TI_TComSize) : null;
    if (attr && typeof attr.toJs === 'function') {
        const v = attr.toJs();
        return typeof v === 'number' ? v : Number(v);
    }
    return 0;
}

class FlatBrowser {
    constructor(options = {}) {
        this.rootNodes = [];
        this.typeInfoObjects = [];
        this.varInfoList = [];
        this.maxSymbols = normalizeMaxSymbols(options.maxSymbols);
        this._symbolCount = 0;
        this.limitExceeded = false;
        this._limitPending = false;
    }

    _noteOversizedArray(elementCount) {
        if (elementCount > this.maxSymbols) {
            this._limitPending = true;
        }
    }

    _cappedArrayCount(elementCount) {
        if (!Number.isFinite(this.maxSymbols)) return elementCount;
        return Math.min(elementCount, this.maxSymbols);
    }

    _emitFlatSymbol(info) {
        if (this._symbolCount >= this.maxSymbols) {
            this.limitExceeded = true;
            return false;
        }
        this.varInfoList.push(info);
        this._symbolCount++;
        return true;
    }

    setTypeInfoContainerObjects(objs) {
        this.typeInfoObjects = objs || [];
    }

    addBlockNode(nodeType, name, accessId, tiRelId) {
        this.rootNodes.push(createNode({
            nodeType: nodeType || eNodeType.Root,
            name,
            accessId,
            relationId: tiRelId
        }));
    }

    async buildTree() {
        for (let i = 0; i < this.rootNodes.length; i++) {
            const root = this.rootNodes[i];
            const ob = findObjectByRelId(this.typeInfoObjects, root.relationId);
            if (ob) {
                await this.addSubNodes(root, ob);
            }
        }
    }

    async buildFlatList() {
        this.varInfoList = [];
        this._symbolCount = 0;
        for (const node of this.rootNodes) {
            if (this.limitExceeded) break;
            if (node.childs.length > 0) {
                await this.addFlatSubnodes(node, '', '', 0, 0, []);
            }
        }
        if (this._limitPending || this.limitExceeded) {
            this.limitExceeded = true;
        }
        return this.varInfoList;
    }

    async addFlatSubnodes(node, names, accessIds, optOffset, nonOptOffset, crcPath) {
        if (this.limitExceeded) return;
        let nextCrcPath = crcPath;

        switch (node.nodeType) {
            case eNodeType.Root:
                names += node.name;
                accessIds += node.accessId.toString(16).toUpperCase();
                break;
            case eNodeType.Array: {
                names += node.name;
                accessIds += '.' + node.accessId.toString(16).toUpperCase();
                const oit = node.vte ? node.vte.offsetInfoType : null;
                const prev = crcPath[crcPath.length - 1];
                nextCrcPath = crcPath.slice(0, -1);
                nextCrcPath.push({
                    memberName: prev ? prev.memberName : '',
                    softdatatype: prev ? prev.softdatatype : node.softdatatype,
                    isArray: true,
                    elementSoftdatatype: node.softdatatype,
                    lowerBound: oitLowerBound(oit)
                });
                break;
            }
            case eNodeType.StructArray: {
                names += node.name;
                accessIds += '.' + node.accessId.toString(16).toUpperCase() + '.1';
                const oit = node.vte ? node.vte.offsetInfoType : null;
                const prev = crcPath[crcPath.length - 1];
                nextCrcPath = crcPath.slice(0, -1);
                nextCrcPath.push({
                    memberName: prev ? prev.memberName : '',
                    softdatatype: prev ? prev.softdatatype : node.softdatatype,
                    isArray: true,
                    elementSoftdatatype: node.softdatatype,
                    lowerBound: oitLowerBound(oit)
                });
                break;
            }
            default:
                names += '.' + node.name;
                accessIds += '.' + node.accessId.toString(16).toUpperCase();
                nextCrcPath = crcPath.concat([{
                    memberName: node.name,
                    softdatatype: node.softdatatype,
                    isArray: false,
                    elementSoftdatatype: 0,
                    lowerBound: 0
                }]);
                break;
        }

        if (node.childs.length === 0) {
            if (!isSoftdatatypeSupported(node.softdatatype)) return;
            const info = {
                name: names,
                accessSequence: accessIds,
                softdatatype: node.softdatatype,
                softdatatypeName: softdatatypeName(node.softdatatype),
                optAddress: 0,
                nonOptAddress: 0,
                optBitoffset: 0,
                nonOptBitoffset: 0
            };
            if (node.vte) info.symbolCrc = node.vte.symbolCrc;
            const meta = crcMetaFromSegments(nextCrcPath);
            if (meta) info.computedCrc = computeCrcFromMeta(meta);
            if (node.nodeType === eNodeType.Array) {
                info.optAddress = optOffset;
                info.nonOptAddress = nonOptOffset;
            } else if (node.vte && node.vte.offsetInfoType) {
                const oit = node.vte.offsetInfoType;
                info.optAddress = optOffset + (oit.optimizedAddress || 0);
                info.nonOptAddress = nonOptOffset + (oit.nonoptimizedAddress || 0);
            }
            if (node.vte) applyBoolBitoffsets(info, node.vte);
            this._emitFlatSymbol(info);
            // Cooperative scheduling: a full flat browse can emit tens of
            // thousands of symbols in one synchronous recursion. Yield
            // periodically so timers and I/O stay alive.
            if (this._symbolCount % FLAT_YIELD_EVERY === 0) {
                await yieldToEventLoop();
            }
            return;
        }

        let nextOpt = optOffset;
        let nextNon = nonOptOffset;
        if (node.vte) {
            const oit = node.vte.offsetInfoType;
            if (node.nodeType === eNodeType.Array && oit) {
                nextOpt = oit.optimizedAddress || 0;
                nextNon = oit.nonoptimizedAddress || 0;
            } else if (node.nodeType === eNodeType.StructArray) {
                nextOpt += node.arrayAdrOffsetOpt;
                nextNon += node.arrayAdrOffsetNonOpt;
            } else if (oit) {
                nextOpt += oit.optimizedAddress || 0;
                nextNon += oit.nonoptimizedAddress || 0;
            }
        }

        for (const sub of node.childs) {
            if (this.limitExceeded) return;
            if (sub.nodeType === eNodeType.Array) {
                await this.addFlatSubnodes(
                    sub, names, accessIds,
                    nextOpt + sub.arrayAdrOffsetOpt,
                    nextNon + sub.arrayAdrOffsetNonOpt,
                    nextCrcPath
                );
            } else {
                await this.addFlatSubnodes(sub, names, accessIds, nextOpt, nextNon, nextCrcPath);
            }
        }
    }

    async addSubNodes(node, o) {
        if (!o.vartypeList || !o.varnameList) return;
        let elementIndex = 0;
        for (const vte of o.vartypeList.elements) {
            const subnode = createNode({
                name: o.varnameList.names[elementIndex],
                softdatatype: vte.softdatatype,
                accessId: vte.lid,
                vte
            });
            node.childs.push(subnode);
            const oit = vte.offsetInfoType;

            if (oit && oit.is1Dim && oit.is1Dim()) {
                const count = oit.getArrayElementCount();
                this._noteOversizedArray(count);
                const expandCount = this._cappedArrayCount(count);
                const lower = oit.getArrayLowerBounds();
                for (let i = 0; i < expandCount; i++) {
                    // Large arrays expand synchronously; yield periodically.
                    if (i > 0 && i % FLAT_YIELD_EVERY === 0) {
                        await yieldToEventLoop();
                    }
                    if (oit.hasRelation && oit.hasRelation()) {
                        const relId = oit.getRelationId();
                        const arraynode = createNode({
                            nodeType: eNodeType.StructArray,
                            name: `[${i + lower}]`,
                            softdatatype: vte.softdatatype,
                            accessId: i,
                            vte
                        });
                        subnode.childs.push(arraynode);
                        const relOb = findObjectByRelId(this.typeInfoObjects, relId);
                        if (relOb) {
                            const tcom = getTComSize(relOb, this.typeInfoObjects);
                            arraynode.arrayAdrOffsetOpt = i * tcom;
                            arraynode.arrayAdrOffsetNonOpt = i * tcom;
                            await this.addSubNodes(arraynode, relOb);
                        }
                    } else {
                        const tcom = getSizeOfDatatype(vte);
                        subnode.childs.push(createNode({
                            nodeType: eNodeType.Array,
                            name: `[${i + lower}]`,
                            softdatatype: vte.softdatatype,
                            accessId: i,
                            vte,
                            arrayAdrOffsetOpt: i * tcom,
                            arrayAdrOffsetNonOpt: i * tcom
                        }));
                    }
                }
            } else if (oit && oit.isMDim && oit.isMDim()) {
                await this.addMdimArrayChildren(subnode, vte, oit);
            } else if (oit && oit.hasRelation && oit.hasRelation() && !isPackedLeafDatatype(vte.softdatatype)) {
                const relOb = findObjectByRelId(this.typeInfoObjects, oit.getRelationId());
                if (relOb) await this.addSubNodes(subnode, relOb);
            }
            // A packed leaf system type (e.g. DTL) keeps no children and is
            // emitted as a single leaf symbol by buildFlatList.
            elementIndex++;
        }
    }

    async addMdimArrayChildren(subnode, vte, oit) {
        const arrayElementCount = oit.getArrayElementCount();
        this._noteOversizedArray(arrayElementCount);
        const cappedCount = this._cappedArrayCount(arrayElementCount);
        const mdimCounts = oit.getMdimArrayElementCount();
        const mdimLowers = oit.getMdimArrayLowerBounds();
        let actdimensions = 0;
        for (let d = 0; d < 6; d++) {
            if (mdimCounts[d] > 0) actdimensions++;
        }
        const xx = [0, 0, 0, 0, 0, 0];
        let n = 1;
        let id = 0;
        do {
            if (n > 1 && (n - 1) % FLAT_YIELD_EVERY === 0) {
                await yieldToEventLoop();
            }
            let aname = '[';
            for (let j = actdimensions - 1; j >= 0; j--) {
                aname += (xx[j] + mdimLowers[j]).toString();
                if (j > 0) aname += ',';
                else aname += ']';
            }
            if (oit.hasRelation()) {
                const relId = oit.getRelationId();
                const arraynode = createNode({
                    nodeType: eNodeType.StructArray,
                    name: aname,
                    softdatatype: vte.softdatatype,
                    accessId: id,
                    vte
                });
                subnode.childs.push(arraynode);
                const relOb = findObjectByRelId(this.typeInfoObjects, relId);
                if (relOb) {
                    const tcom = getTComSize(relOb, this.typeInfoObjects);
                    arraynode.arrayAdrOffsetOpt = (n - 1) * tcom;
                    arraynode.arrayAdrOffsetNonOpt = (n - 1) * tcom;
                    await this.addSubNodes(arraynode, relOb);
                }
            } else {
                const tcom = getSizeOfDatatype(vte);
                subnode.childs.push(createNode({
                    nodeType: eNodeType.Array,
                    name: aname,
                    softdatatype: vte.softdatatype,
                    accessId: id,
                    vte,
                    arrayAdrOffsetOpt: (n - 1) * tcom,
                    arrayAdrOffsetNonOpt: (n - 1) * tcom
                }));
            }
            xx[0]++;
            if (subnode.softdatatype === SOFTDATATYPE_BBOOL && xx[0] >= mdimCounts[0]) {
                if (mdimCounts[0] % 8 !== 0) {
                    id += 8 - (xx[0] % 8);
                }
            }
            for (let dim = 0; dim < 5; dim++) {
                if (xx[dim] >= mdimCounts[dim]) {
                    xx[dim] = 0;
                    xx[dim + 1]++;
                }
            }
            id++;
            n++;
        } while (n <= cappedCount);
    }
}

/**
 * Enumerate the type relation ids a single type object references through
 * its members. Mirrors the exact relation conditions FlatBrowser.addSubNodes
 * uses to descend into nested types, so a transitive fetch of these ids
 * yields every type object findObjectByRelId will later look up:
 *   - 1-dim array member with a relation  -> element type relId
 *   - m-dim array member with a relation  -> element type relId
 *   - scalar member with a relation that is NOT a packed leaf (DTL) -> relId
 * @param {object} typeOb - a type object carrying a vartypeList
 * @returns {number[]} referenced relation ids (may contain duplicates/zeros)
 */
function collectReferencedRelIds(typeOb) {
    const ids = [];
    if (!typeOb || !typeOb.vartypeList || !typeOb.vartypeList.elements) return ids;
    for (const vte of typeOb.vartypeList.elements) {
        const oit = vte.offsetInfoType;
        if (!oit) continue;
        if (oit.is1Dim && oit.is1Dim()) {
            if (oit.hasRelation && oit.hasRelation()) ids.push(oit.getRelationId());
        } else if (oit.isMDim && oit.isMDim()) {
            if (oit.hasRelation && oit.hasRelation()) ids.push(oit.getRelationId());
        } else if (oit.hasRelation && oit.hasRelation() && !isPackedLeafDatatype(vte.softdatatype)) {
            ids.push(oit.getRelationId());
        }
    }
    return ids;
}

/**
 * Build flat symbol list from DB roots + type-info container objects (C# Browse).
 * Yields to the event loop periodically so a large catalog cannot freeze
 * Node-RED (timers, dashboard, Ctrl+C).
 * @param {Array} dbList - from _fetchDbListFromPlc
 * @param {object[]} typeInfoObjects - children of OMSTypeInfoContainer
 * @param {object} [options]
 * @param {number} [options.maxSymbols]
 * @returns {Promise<{ symbols: object[], limitExceeded: boolean, maxSymbols: number|null }>}
 */
async function buildFlatSymbolList(dbList, typeInfoObjects, options = {}) {
    const browser = new FlatBrowser(options);
    browser.setTypeInfoContainerObjects(typeInfoObjects);
    const scope = options.scope;
    const scoped = scope && scope.everything === false;

    for (const ed of dbList) {
        browser.addBlockNode(eNodeType.Root, ed.db_name, ed.db_block_relid, ed.db_block_ti_relid);
    }
    for (const area of MEMORY_AREAS) {
        if (scoped && !scope.areas.includes(area.name)) continue;
        browser.addBlockNode(eNodeType.Root, area.name, area.accessId, area.tiRelId);
    }
    await browser.buildTree();
    const symbols = await browser.buildFlatList();
    return {
        symbols,
        limitExceeded: browser.limitExceeded,
        maxSymbols: browser.maxSymbols === Infinity ? null : browser.maxSymbols
    };
}

module.exports = {
    FlatBrowser,
    buildFlatSymbolList,
    findObjectByRelId,
    collectReferencedRelIds
};
