'use strict';

const { Ids } = require('../constants');
const { MEMORY_AREAS } = require('./areas');
const { encodeNodeId } = require('./node-id');
const {
    eNodeType,
    softdatatypeName,
    isSoftdatatypeSupported,
    isPackedLeafDatatype,
    getSizeOfDatatype
} = require('./datatypes');

const ARRAY_PAGE_SIZE = 32;

/**
 * Lazy browse: one tree level at a time, arrays as single node or paginated indices.
 * exploreChildsRecursive=0 on PLC; fallback loads subtree from cache (see client).
 */

function pathNames(path) {
    return path.map(p => p.name).join('');
}

function pathAccess(path) {
    let accessIds = '';
    for (const p of path) {
        if (p.nodeType === eNodeType.Root) {
            accessIds += p.accessId.toString(16).toUpperCase();
        } else {
            accessIds += '.' + p.accessId.toString(16).toUpperCase();
            if (p.nodeType === eNodeType.StructArray) accessIds += '.1';
        }
    }
    return accessIds;
}

function publicNode(id, label, nodeKind, hasChildren, datatype, isLeaf) {
    return { id, label, nodeKind, hasChildren, datatype: datatype || undefined, isLeaf: !!isLeaf };
}

function resolveTypeName(cache, relationId, fallbackSoftdatatype) {
    const ob = relationId ? cache.get(relationId) || null : null;
    if (ob && typeof ob.getAttribute === 'function') {
        const nameAttr = ob.getAttribute(Ids.ObjectVariableTypeName);
        if (nameAttr) return String(nameAttr.toJs());
    }
    return softdatatypeName(fallbackSoftdatatype);
}

function listBlockRoots(dbList) {
    const nodes = [];
    for (const ed of dbList) {
        if (!ed.db_block_ti_relid) continue;
        const path = [{
            nodeType: eNodeType.Root,
            name: ed.db_name,
            accessId: ed.db_block_relid,
            tiRelId: ed.db_block_ti_relid
        }];
        nodes.push(publicNode(
            encodeNodeId({ t: 'block', path, tiRelId: ed.db_block_ti_relid }),
            ed.db_name,
            'block',
            true,
            undefined,
            false
        ));
    }
    for (const a of MEMORY_AREAS) {
        const path = [{ nodeType: eNodeType.Root, name: a.name, accessId: a.accessId, tiRelId: a.tiRelId }];
        nodes.push(publicNode(
            encodeNodeId({ t: 'block', path, tiRelId: a.tiRelId }),
            a.name,
            'area',
            true,
            undefined,
            false
        ));
    }
    return nodes;
}

function listMembersForTypeInfo(typeOb, parentPath, cache) {
    const nodes = [];
    if (!typeOb || !typeOb.vartypeList) return nodes;

    let elementIndex = 0;
    for (const vte of typeOb.vartypeList.elements) {
        const name = typeOb.varnameList.names[elementIndex];
        const oit = vte.offsetInfoType;
        const path = parentPath.concat([{
            nodeType: eNodeType.Var,
            name: '.' + name,
            accessId: vte.lid,
            softdatatype: vte.softdatatype,
            vte
        }]);

        if (oit.is1Dim && oit.is1Dim()) {
            const count = oit.getArrayElementCount();
            const lower = oit.getArrayLowerBounds();
            const hasRel = oit.hasRelation();
            const relId = hasRel ? oit.getRelationId() : 0;
            const dtName = hasRel
                ? resolveTypeName(cache, relId, vte.softdatatype)
                : softdatatypeName(vte.softdatatype);
            const desc = {
                t: 'array',
                path,
                elementIndex,
                lower,
                count,
                hasRelation: hasRel,
                relationId: relId
            };
            nodes.push(publicNode(
                encodeNodeId(desc),
                name,
                'array',
                count > 0,
                `Array[${lower}..${lower + count - 1}] of ${dtName}`,
                false
            ));
        } else if (oit.isMDim && oit.isMDim()) {
            const count = oit.getArrayElementCount();
            const hasRel = oit.hasRelation();
            const relId = hasRel ? oit.getRelationId() : 0;
            const dtName = hasRel
                ? resolveTypeName(cache, relId, vte.softdatatype)
                : softdatatypeName(vte.softdatatype);
            const desc = {
                t: 'array',
                path,
                elementIndex,
                lower: 0,
                count,
                mdim: true,
                hasRelation: hasRel,
                relationId: relId
            };
            nodes.push(publicNode(
                encodeNodeId(desc),
                name,
                'array',
                count > 0,
                `Array[${count}] of ${dtName}`,
                false
            ));
        } else if (oit.hasRelation && oit.hasRelation() && !isPackedLeafDatatype(vte.softdatatype)) {
            const relId = oit.getRelationId();
            const childOb = relId ? cache.get(relId) || null : null;
            const desc = { t: 'struct', path, tiRelId: relId };
            nodes.push(publicNode(
                encodeNodeId(desc),
                name,
                'struct',
                !!(childOb && childOb.vartypeList) || relId !== 0,
                resolveTypeName(cache, relId, vte.softdatatype),
                false
            ));
        } else if (isSoftdatatypeSupported(vte.softdatatype)) {
            const desc = { t: 'leaf', path };
            nodes.push(publicNode(
                encodeNodeId(desc),
                name,
                'leaf',
                false,
                softdatatypeName(vte.softdatatype),
                true
            ));
        } else {
            const desc = { t: 'unsupported', path };
            nodes.push(publicNode(
                encodeNodeId(desc),
                name,
                'unsupported',
                false,
                softdatatypeName(vte.softdatatype),
                false
            ));
        }
        elementIndex++;
    }
    return nodes;
}

function listArrayPages(desc, cache) {
    const { lower, count } = desc;
    const nodes = [];
    const lastSeg = desc.path[desc.path.length - 1];
    const dtLabel = desc.hasRelation
        ? resolveTypeName(cache, desc.relationId, lastSeg.softdatatype)
        : softdatatypeName(lastSeg.softdatatype);
    for (let start = 0; start < count; start += ARRAY_PAGE_SIZE) {
        const end = Math.min(start + ARRAY_PAGE_SIZE - 1, count - 1);
        const label = `[${lower + start}..${lower + end}]`;
        const pageDesc = {
            t: 'arrpage',
            path: desc.path,
            lower: desc.lower,
            count: desc.count,
            hasRelation: desc.hasRelation,
            relationId: desc.relationId,
            mdim: desc.mdim,
            start,
            end
        };
        nodes.push(publicNode(
            encodeNodeId(pageDesc),
            label,
            'arrpage',
            true,
            dtLabel,
            false
        ));
    }
    return nodes;
}

function listArrayElements(pageDesc, cache) {
    const vte = pageDesc.path[pageDesc.path.length - 1].vte;
    const nodes = [];
    const parentPath = pageDesc.path;

    for (let i = pageDesc.start; i <= pageDesc.end; i++) {
        const elemName = `[${pageDesc.lower + i}]`;

        if (pageDesc.hasRelation) {
            const arrayPath = parentPath.concat([{
                nodeType: eNodeType.StructArray,
                name: elemName,
                accessId: i,
                softdatatype: vte.softdatatype,
                vte
            }]);
            const desc = {
                t: 'struct',
                path: arrayPath,
                tiRelId: pageDesc.relationId,
                arrayIndex: i
            };
            nodes.push(publicNode(
                encodeNodeId(desc),
                elemName,
                'struct',
                true,
                resolveTypeName(cache, pageDesc.relationId, vte.softdatatype),
                false
            ));
        } else {
            const tcomSize = getSizeOfDatatype(vte);
            const arrayPath = parentPath.concat([{
                nodeType: eNodeType.Array,
                name: elemName,
                accessId: i,
                softdatatype: vte.softdatatype,
                vte,
                arrayAdrOffsetOpt: i * tcomSize,
                arrayAdrOffsetNonOpt: i * tcomSize
            }]);
            if (isSoftdatatypeSupported(vte.softdatatype)) {
                const leafDesc = { t: 'leaf', path: arrayPath };
                nodes.push(publicNode(
                    encodeNodeId(leafDesc),
                    elemName,
                    'leaf',
                    false,
                    softdatatypeName(vte.softdatatype),
                    true
                ));
            } else {
                nodes.push(publicNode(
                    encodeNodeId({ t: 'unsupported', path: arrayPath }),
                    elemName,
                    'unsupported',
                    false,
                    softdatatypeName(vte.softdatatype),
                    false
                ));
            }
        }
    }
    return nodes;
}

function listChildren(desc, cache) {
    switch (desc.t) {
        case 'block':
        case 'struct': {
            const typeOb = desc.tiRelId ? cache.get(desc.tiRelId) || null : null;
            if (!typeOb) return [];
            const parentPath = desc.path || [];
            return listMembersForTypeInfo(typeOb, parentPath, cache);
        }
        case 'array':
            return listArrayPages(desc, cache);
        case 'arrpage':
            return listArrayElements(desc, cache);
        default:
            return [];
    }
}

function resolveLeaf(desc) {
    if (desc.t === 'unsupported') throw new Error('Datatype not supported for symbolic access');
    if (desc.t !== 'leaf') throw new Error('Node is not a leaf symbol');
    const name = pathNames(desc.path);
    const address = pathAccess(desc.path);
    const sd = desc.path[desc.path.length - 1].softdatatype;

    const crcMeta = buildCrcMeta(desc.path);

    return {
        name,
        address,
        datatype: softdatatypeName(sd),
        crcMeta
    };
}

// Robust accessor: works both on a live POffsetInfoType* instance (has
// getArrayLowerBounds method) and on a plain object recovered from
// JSON.stringify/parse (encodeNodeId path) where methods are lost but
// the underlying data field arrayLowerBounds survives. Without this
// fallback CRC computation for arrays whose lower bound differs from 0
// (e.g. TIA `Array[1..N]`) silently produces lowerBound=0 and the PLC
// rejects the read with 0x8009890012cbffef (CRC mismatch).
function oitLowerBound(oit) {
    if (!oit) return 0;
    if (typeof oit.getArrayLowerBounds === 'function') return oit.getArrayLowerBounds() | 0;
    if (typeof oit.arrayLowerBounds === 'number') return oit.arrayLowerBounds | 0;
    return 0;
}

function buildCrcMeta(path) {
    const STRUCT_SD = 17;
    const segments = [];

    for (let i = 1; i < path.length; i++) {
        const seg = path[i];
        const isArrayElem = seg.nodeType === eNodeType.Array
            || seg.nodeType === eNodeType.StructArray;

        if (isArrayElem) {
            const arraySeg = path[i - 1];
            const rawName = arraySeg.name.startsWith('.') ? arraySeg.name.slice(1) : arraySeg.name;
            const vte = arraySeg.vte;
            const oit = vte ? vte.offsetInfoType : null;
            const lower = oitLowerBound(oit);
            if (segments.length > 0 && segments[segments.length - 1].memberName === rawName) {
                segments[segments.length - 1] = {
                    memberName: rawName,
                    softdatatype: arraySeg.softdatatype,
                    isArray: true,
                    elementSoftdatatype: seg.softdatatype,
                    lowerBound: lower
                };
            } else {
                segments.push({
                    memberName: rawName,
                    softdatatype: arraySeg.softdatatype,
                    isArray: true,
                    elementSoftdatatype: seg.softdatatype,
                    lowerBound: lower
                });
            }
        } else if (seg.nodeType === eNodeType.Var) {
            const rawName = seg.name.startsWith('.') ? seg.name.slice(1) : seg.name;
            segments.push({
                memberName: rawName,
                softdatatype: seg.softdatatype,
                isArray: false,
                elementSoftdatatype: 0,
                lowerBound: 0
            });
        }
    }

    if (segments.length === 0) {
        return { memberName: '', softdatatype: 0, isArray: false, elementSoftdatatype: 0, lowerBound: 0, pathSegments: [] };
    }

    if (segments.length === 1) {
        return segments[0];
    }

    return { pathSegments: segments };
}

module.exports = {
    ARRAY_PAGE_SIZE,
    listBlockRoots,
    listChildren,
    resolveLeaf,
    resolveTypeName
};
