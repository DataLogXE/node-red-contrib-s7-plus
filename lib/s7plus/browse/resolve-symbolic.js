'use strict';

/**
 * Resolve a symbolic PLC path (e.g. "DB1.readings[0]") by walking
 * the browse tree. Handles quoted DB names, arrays with index notation,
 * and struct nesting.
 */

/**
 * Parse a TIA-Portal-style symbol path into segments, splitting array
 * indices into separate segments.
 * "DB1.readings[0]"     -> ['DB1', 'readings', '[0]']
 * '"DB Name".struct.x'      -> ['DB Name', 'struct', 'x']
 * "DB1.arr[3].member"       -> ['DB1', 'arr', '[3]', 'member']
 */
function parseSymbolSegments(symbolPath) {
    const segments = [];
    let i = 0;
    while (i < symbolPath.length) {
        if (symbolPath[i] === '"') {
            const end = symbolPath.indexOf('"', i + 1);
            if (end === -1) {
                segments.push(symbolPath.slice(i + 1));
                break;
            }
            segments.push(symbolPath.slice(i + 1, end));
            i = end + 1;
            if (i < symbolPath.length && symbolPath[i] === '.') i++;
        } else if (symbolPath[i] === '[') {
            const end = symbolPath.indexOf(']', i);
            if (end === -1) {
                segments.push(symbolPath.slice(i));
                break;
            }
            segments.push(symbolPath.slice(i, end + 1));
            i = end + 1;
            if (i < symbolPath.length && symbolPath[i] === '.') i++;
        } else {
            let end = symbolPath.length;
            for (let j = i; j < symbolPath.length; j++) {
                if (symbolPath[j] === '.' || symbolPath[j] === '[') {
                    end = j;
                    break;
                }
            }
            const seg = symbolPath.slice(i, end);
            if (seg) segments.push(seg);
            i = end;
            if (i < symbolPath.length && symbolPath[i] === '.') i++;
        }
    }
    return segments;
}

/**
 * Navigate the browse tree to find a node by label among children,
 * transparently expanding arrpage nodes for array index segments.
 */
async function findChildByLabel(client, parentId, label) {
    const { nodes: children } = await client.browseChildren(parentId);

    const direct = children.find(n => n.label === label);
    if (direct) return direct;

    for (const child of children) {
        if (child.nodeKind === 'arrpage') {
            const { nodes: pageElements } = await client.browseChildren(child.id);
            const match = pageElements.find(n => n.label === label);
            if (match) return match;
        }
    }

    return null;
}

/**
 * Walk the browse tree along a symbolic path and resolve the leaf node.
 * @param {object} client - S7CommPlusClient instance
 * @param {string} symbolPath - e.g. "DB1.readings[0]"
 * @returns {Promise<{name, address, datatype, crcMeta}>}
 */
async function resolveSymbolicPath(client, symbolPath) {
    const segments = parseSymbolSegments(symbolPath);
    if (segments.length < 2) {
        throw new Error(`Invalid symbolic path: '${symbolPath}' (need at least DB.member)`);
    }

    const { nodes: roots } = await client.browseRoots();
    const rootNode = roots.find(n => n.label === segments[0]);
    if (!rootNode) {
        throw new Error(`Symbol root '${segments[0]}' not found among PLC roots`);
    }

    let current = rootNode;
    for (let i = 1; i < segments.length; i++) {
        if (!current.hasChildren) {
            throw new Error(
                `Symbol segment '${segments[i]}' not reachable — '${current.label}' has no children`
            );
        }
        const next = await findChildByLabel(client, current.id, segments[i]);
        if (!next) {
            throw new Error(
                `Symbol segment '${segments[i]}' not found in '${current.label}'`
            );
        }
        current = next;
    }

    if (!current.isLeaf) {
        throw new Error(`Symbol path '${symbolPath}' does not resolve to a readable leaf symbol`);
    }

    return client.browseResolve(current.id);
}

/**
 * Batch-resolve multiple symbolic paths sharing a single browseRootsCached()
 * call and the accumulated type-info cache. Each symbol is resolved
 * independently so a failure in one does not block the others.
 * @param {object} client - S7CommPlusClient instance
 * @param {string[]} symbolPaths - e.g. ["DB1.speed", "DB2.temp"]
 * @returns {Promise<Array<{name, address, datatype, crcMeta} | {error: string}>>}
 */
async function resolveSymbolicBatch(client, symbolPaths) {
    const { nodes: roots } = await client.browseRootsCached();
    const results = [];

    for (const symbolPath of symbolPaths) {
        try {
            const segments = parseSymbolSegments(symbolPath);
            if (segments.length < 2) {
                results.push({ error: `Invalid symbolic path: '${symbolPath}' (need at least DB.member)` });
                continue;
            }

            const rootNode = roots.find(n => n.label === segments[0]);
            if (!rootNode) {
                results.push({ error: `Symbol root '${segments[0]}' not found among PLC roots` });
                continue;
            }

            let current = rootNode;
            let failed = false;
            for (let i = 1; i < segments.length; i++) {
                if (!current.hasChildren) {
                    results.push({
                        error: `Symbol segment '${segments[i]}' not reachable — '${current.label}' has no children`
                    });
                    failed = true;
                    break;
                }
                const next = await findChildByLabel(client, current.id, segments[i]);
                if (!next) {
                    results.push({
                        error: `Symbol segment '${segments[i]}' not found in '${current.label}'`
                    });
                    failed = true;
                    break;
                }
                current = next;
            }
            if (failed) continue;

            if (!current.isLeaf) {
                results.push({
                    error: `Symbol path '${symbolPath}' does not resolve to a readable leaf symbol`
                });
                continue;
            }

            results.push(await client.browseResolve(current.id));
        } catch (e) {
            results.push({ error: e.message });
        }
    }

    return results;
}

module.exports = { resolveSymbolicPath, parseSymbolSegments, resolveSymbolicBatch };
