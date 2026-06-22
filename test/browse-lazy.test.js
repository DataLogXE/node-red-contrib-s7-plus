'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { encodeNodeId, decodeNodeId } = require('../lib/s7plus/browse/node-id');
const {
    listBlockRoots,
    listChildren,
    resolveLeaf,
    resolveTypeName,
    ARRAY_PAGE_SIZE
} = require('../lib/s7plus/browse/lazy');
const { S7CommPlusClient } = require('../lib/s7plus/client');
const { Ids } = require('../lib/s7plus/constants');
const { softdatatypeName } = require('../lib/s7plus/browse/datatypes');

describe('browse-node-id', () => {
    it('roundtrips block descriptor', () => {
        const desc = {
            t: 'block',
            path: [{ nodeType: 1, name: 'MyDB', accessId: 0x8a0e0001, tiRelId: 0x12345678 }],
            tiRelId: 0x12345678
        };
        const id = encodeNodeId(desc);
        const back = decodeNodeId(id);
        assert.equal(back.t, 'block');
        assert.equal(back.tiRelId, 0x12345678);
    });

    it('rejects invalid id', () => {
        assert.throws(() => decodeNodeId('not-valid!!!'), /Invalid browse node id/);
    });
});

describe('browse-lazy listChildren', () => {
    const mockTypeOb = {
        relationId: 0x100,
        varnameList: { names: ['speed', 'nested'] },
        vartypeList: {
            elements: [
                {
                    lid: 10,
                    softdatatype: 8,
                    offsetInfoType: {
                        is1Dim: () => false,
                        isMDim: () => false,
                        hasRelation: () => false
                    }
                },
                {
                    lid: 20,
                    softdatatype: 0,
                    offsetInfoType: {
                        is1Dim: () => false,
                        isMDim: () => false,
                        hasRelation: () => true,
                        getRelationId: () => 0x200
                    }
                }
            ]
        }
    };

    function mockAttr(value) {
        return { toJs: () => value };
    }

    const cache = new Map([[0x100, mockTypeOb], [0x200, {
        relationId: 0x200,
        varnameList: { names: ['x'] },
        vartypeList: {
            elements: [{
                lid: 1,
                softdatatype: 5,
                offsetInfoType: {
                    is1Dim: () => false,
                    isMDim: () => false,
                    hasRelation: () => false
                }
            }]
        },
        getAttribute: (id) => id === Ids.ObjectVariableTypeName ? mockAttr('MyUdt') : null
    }]]);

    it('lists block roots from db list', () => {
        const nodes = listBlockRoots([{
            db_name: 'Data',
            db_block_relid: 0x8a0e0001,
            db_block_ti_relid: 0x100
        }]);
        assert.ok(nodes.some(n => n.label === 'Data' && n.hasChildren));
        assert.ok(nodes.some(n => n.label === 'IArea'));
    });

    it('lists members for block without expanding arrays fully', () => {
        const blockDesc = {
            t: 'block',
            path: [{ nodeType: 1, name: 'Data', accessId: 0x8a0e0001, tiRelId: 0x100 }],
            tiRelId: 0x100
        };
        const nodes = listChildren(blockDesc, cache);
        assert.equal(nodes.length, 2);
        assert.ok(nodes.find(n => n.label === 'speed' && n.isLeaf));
        assert.ok(nodes.find(n => n.nodeKind === 'struct' && n.label === 'nested'));
    });

    it('resolves leaf access string', () => {
        const leafDesc = {
            t: 'leaf',
            path: [
                { nodeType: 1, name: 'Data', accessId: 0x8a0e0001 },
                { nodeType: 2, name: '.speed', accessId: 10, softdatatype: 8 }
            ]
        };
        const row = resolveLeaf(leafDesc);
        assert.equal(row.name, 'Data.speed');
        assert.equal(row.address, '8A0E0001.A');
        assert.equal(row.datatype, 'Real');
    });

    it('targets type info subtree with ExploreId=tiRelId, RequestId=None (matches C# reference)', async () => {
        const client = new S7CommPlusClient();
        const captured = [];
        client._requestResponse = async (req) => {
            captured.push({
                exploreId: req.exploreId,
                exploreRequestId: req.exploreRequestId,
                recursive: req.exploreChildsRecursive
            });
            return { objects: [{ relationId: req.exploreId, vartypeList: { elements: [] }, varnameList: { names: [] } }] };
        };
        await client._ensureTypeInfoLoaded(0x12345678);
        assert.equal(captured.length, 1, 'should send exactly one explore request when target is reachable');
        assert.equal(captured[0].exploreId, 0x12345678, 'ExploreId must carry the relation id');
        assert.equal(captured[0].exploreRequestId, Ids.None, 'ExploreRequestId must be None (matches C# GetTypeInformation)');
        assert.equal(captured[0].recursive, 1, 'recursive=1 (mirrors C# reference)');
    });

    it('marks itself disconnected when transport closes and rejects pending responses', async () => {
        const client = new S7CommPlusClient();
        client._connected = true;
        client._sessionId = 42;
        client._transport.on('close', (info) => client._onTransportClosed(info));
        // Register a pending response by seq, then close the transport.
        const pending = client._waitForResponse(1, 'test', 5000);
        client._transport.emit('close', { reason: 'socket-end' });
        await assert.rejects(pending, /Client not connected/);
        assert.equal(client._connected, false, 'connected flag must flip to false on transport close');
        assert.equal(client._sessionId, 0, 'session must be reset on stale close');
    });

    it('response timeout tears down transport immediately (no second 5s hang on next request)', async () => {
        const client = new S7CommPlusClient();
        client._connected = true;
        client._sessionId = 42;
        let transportDisconnects = 0;
        let emittedDisconnect = false;
        client._transport.disconnect = () => { transportDisconnects++; return 0; };
        client.on('disconnect', () => { emittedDisconnect = true; });

        const t0 = Date.now();
        await assert.rejects(client._waitForResponse(1, 'test', 40), /Data receive Timeout/);
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 200, `expected fast timeout, got ${elapsed}ms`);
        assert.equal(client._connected, false, 'response timeout must flip _connected to false');
        assert.equal(client._sessionId, 0, 'response timeout must drop session id');
        assert.ok(transportDisconnects >= 1, 'response timeout must tear down transport');
        assert.equal(emittedDisconnect, true, "client must emit 'disconnect' after response timeout");
    });

    it('forceDisconnect does NOT send DeleteObject (no 5s hang on dead socket)', async () => {
        const client = new S7CommPlusClient();
        client._connected = true;
        client._sessionId = 42;
        let sentRequests = 0;
        client._requestResponse = async () => { sentRequests++; return {}; };
        let transportDisconnects = 0;
        client._transport.disconnect = () => { transportDisconnects++; return 0; };

        const t0 = Date.now();
        client.forceDisconnect('test');
        const elapsed = Date.now() - t0;

        assert.equal(sentRequests, 0, 'forceDisconnect must NOT emit DeleteObject');
        assert.equal(transportDisconnects, 1, 'forceDisconnect must tear the transport down');
        assert.equal(client._connected, false);
        assert.equal(client._sessionId, 0);
        assert.equal(client._browseState, null);
        assert.ok(elapsed < 50, `forceDisconnect must be synchronous, got ${elapsed}ms`);
    });

    it('forceDisconnect is idempotent and does not double-emit disconnect', () => {
        const client = new S7CommPlusClient();
        client._connected = true;
        client._sessionId = 42;
        client._transport.disconnect = () => 0;
        let emissions = 0;
        client.on('disconnect', () => { emissions++; });

        client.forceDisconnect('a');
        client.forceDisconnect('b');
        client.forceDisconnect('c');

        assert.equal(emissions, 1, 'disconnect must be emitted exactly once across repeated forceDisconnect calls');
    });

    it('_teardownGraceful skips DeleteObject when socket is already gone', async () => {
        const client = new S7CommPlusClient();
        client._connected = true;
        client._sessionId = 42;
        client._transport._socket = null;
        let sentRequests = 0;
        client._requestResponse = async () => { sentRequests++; return {}; };
        client._transport.disconnect = () => 0;

        await client._teardownGraceful('graceful');
        assert.equal(sentRequests, 0, 'with dead socket the graceful path must not try DeleteObject');
        assert.equal(client._connected, false);
    });

    it('end-to-end stale-then-retry: second browseChildren after PDU timeout succeeds without piling up another 5s hang', async () => {
        const client = new S7CommPlusClient();
        client._connected = true;
        client._sessionId = 99;
        client._readTimeout = 40;
        let transportDisconnects = 0;
        client._transport.disconnect = () => { transportDisconnects++; return 0; };

        const blockNodeId = encodeNodeId({
            t: 'block',
            path: [{ nodeType: 1, name: 'Data', accessId: 0x8a0e0001, tiRelId: 0x100 }],
            tiRelId: 0x100
        });

        // First call: simulate dead PLC -> request never replies, _waitForPdu
        // must hit its timeout and proactively tear the transport down.
        client._sendRequest = () => { /* swallow request, never deliver a PDU */ };
        const t0 = Date.now();
        await assert.rejects(client.browseChildren(blockNodeId), /Data receive Timeout/);
        const firstElapsed = Date.now() - t0;
        assert.ok(firstElapsed < 250, `first attempt should fast-fail (~timeout), got ${firstElapsed}ms`);
        assert.equal(client._connected, false, 'after stale PDU read the client must be marked offline');
        assert.ok(transportDisconnects >= 1, 'transport must have been torn down');

        // Simulate the outer reconnect: a fresh connect would flip _connected
        // back to true and refresh the session.
        client._connected = true;
        client._sessionId = 100;
        let captured = [];
        client._requestResponse = async (req) => {
            captured.push({ exploreId: req.exploreId });
            return { objects: [{
                relationId: req.exploreId,
                vartypeList: { elements: [] },
                varnameList: { names: [] }
            }] };
        };

        const t1 = Date.now();
        const result = await client.browseChildren(blockNodeId);
        const secondElapsed = Date.now() - t1;
        assert.ok(secondElapsed < 250, `retry must be fast after reconnect, got ${secondElapsed}ms`);
        assert.equal(captured.length, 1, 'retry must issue exactly one explore request');
        assert.equal(captured[0].exploreId, 0x100, 'retry must target the block tiRelId');
        assert.deepEqual(result.nodes, [], 'mock returns no members -> empty children list');
    });

    it('paginates array children', () => {
        const arrayDesc = {
            t: 'array',
            path: [
                { nodeType: 1, name: 'Data', accessId: 0x8a0e0001 },
                {
                    nodeType: 2,
                    name: '.arr',
                    accessId: 5,
                    softdatatype: 7,
                    vte: {
                        softdatatype: 7,
                        offsetInfoType: {
                            is1Dim: () => true,
                            isMDim: () => false,
                            hasRelation: () => false,
                            getArrayElementCount: () => 100,
                            getArrayLowerBounds: () => 0
                        }
                    }
                }
            ],
            lower: 0,
            count: 100,
            hasRelation: false,
            relationId: 0
        };
        const pages = listChildren(arrayDesc, cache);
        assert.equal(pages.length, Math.ceil(100 / ARRAY_PAGE_SIZE));
        assert.match(pages[0].label, /\[0\.\./);
    });

    it('resolveTypeName returns UDT name from cache when available', () => {
        const name = resolveTypeName(cache, 0x200, 17);
        assert.equal(name, 'MyUdt');
    });

    it('resolveTypeName falls back to softdatatypeName when cache miss', () => {
        const name = resolveTypeName(cache, 0x999, 8);
        assert.equal(name, 'Real');
    });

    it('resolveTypeName falls back to softdatatypeName when getAttribute missing', () => {
        const bare = new Map([[0x300, { relationId: 0x300 }]]);
        const name = resolveTypeName(bare, 0x300, 17);
        assert.equal(name, 'Struct');
    });

    it('struct node shows resolved UDT type name instead of Softdatatype_17', () => {
        const blockDesc = {
            t: 'block',
            path: [{ nodeType: 1, name: 'Data', accessId: 0x8a0e0001, tiRelId: 0x100 }],
            tiRelId: 0x100
        };
        const nodes = listChildren(blockDesc, cache);
        const nested = nodes.find(n => n.label === 'nested');
        assert.ok(nested, 'nested struct node must exist');
        assert.equal(nested.datatype, 'MyUdt');
    });

    it('array-of-struct pages show resolved UDT type name', () => {
        const structArrayTypeOb = {
            relationId: 0x400,
            varnameList: { names: ['items'] },
            vartypeList: {
                elements: [{
                    lid: 30,
                    softdatatype: 17,
                    offsetInfoType: {
                        is1Dim: () => true,
                        isMDim: () => false,
                        hasRelation: () => true,
                        getRelationId: () => 0x200,
                        getArrayElementCount: () => 5,
                        getArrayLowerBounds: () => 0
                    }
                }]
            }
        };
        const arrCache = new Map([...cache, [0x400, structArrayTypeOb]]);
        const blockDesc = {
            t: 'block',
            path: [{ nodeType: 1, name: 'Data', accessId: 0x8a0e0001, tiRelId: 0x400 }],
            tiRelId: 0x400
        };
        const members = listChildren(blockDesc, arrCache);
        const arrNode = members.find(n => n.label === 'items');
        assert.ok(arrNode, 'array node must exist');
        assert.match(arrNode.datatype, /of MyUdt$/);
    });

    it('hardware leaf shows AOM_IDENT instead of Softdatatype_128', () => {
        const hwTypeOb = {
            relationId: 0x500,
            varnameList: { names: ['AOM_IDENT_0x1'] },
            vartypeList: {
                elements: [{
                    lid: 1,
                    softdatatype: 128,
                    offsetInfoType: {
                        is1Dim: () => false,
                        isMDim: () => false,
                        hasRelation: () => false
                    }
                }]
            }
        };
        const hwCache = new Map([[0x500, hwTypeOb]]);
        const blockDesc = {
            t: 'block',
            path: [{ nodeType: 1, name: 'HwTypesDB', accessId: 0x8a0e0099, tiRelId: 0x500 }],
            tiRelId: 0x500
        };
        const nodes = listChildren(blockDesc, hwCache);
        const leaf = nodes.find(n => n.label === 'AOM_IDENT_0x1');
        assert.ok(leaf, 'hardware leaf must exist');
        assert.equal(leaf.datatype, 'AOM_IDENT');
        assert.notEqual(leaf.datatype, 'Softdatatype_128');
    });
});

describe('browse-lazy DTL leaf classification', () => {
    // DTL (softdatatype 67) carries a type relation but must be treated as a
    // single packed leaf, not descended into as a struct.
    const dtlTypeOb = {
        relationId: 0x600,
        varnameList: { names: ['DTL_write'] },
        vartypeList: {
            elements: [{
                lid: 7,
                softdatatype: 67,
                offsetInfoType: {
                    is1Dim: () => false,
                    isMDim: () => false,
                    hasRelation: () => true,
                    getRelationId: () => 0x601
                }
            }]
        }
    };

    it('classifies a DTL member as a readable leaf (not struct)', () => {
        const cache = new Map([[0x600, dtlTypeOb]]);
        const blockDesc = {
            t: 'block',
            path: [{ nodeType: 1, name: 'DB_DateAndTime', accessId: 0x8a0e0001, tiRelId: 0x600 }],
            tiRelId: 0x600
        };
        const nodes = listChildren(blockDesc, cache);
        const dtl = nodes.find(n => n.label === 'DTL_write');
        assert.ok(dtl, 'DTL member must be listed');
        assert.equal(dtl.isLeaf, true, 'DTL must be a leaf');
        assert.equal(dtl.nodeKind, 'leaf');
        assert.equal(dtl.datatype, 'Dtl');
        assert.equal(dtl.hasChildren, false);
    });

    it('resolves the DTL leaf to an access string with datatype Dtl', () => {
        const cache = new Map([[0x600, dtlTypeOb]]);
        const blockDesc = {
            t: 'block',
            path: [{ nodeType: 1, name: 'DB_DateAndTime', accessId: 0x8a0e0001, tiRelId: 0x600 }],
            tiRelId: 0x600
        };
        const dtlNode = listChildren(blockDesc, cache).find(n => n.label === 'DTL_write');
        const row = resolveLeaf(decodeNodeId(dtlNode.id));
        assert.equal(row.name, 'DB_DateAndTime.DTL_write');
        assert.equal(row.address, '8A0E0001.7');
        assert.equal(row.datatype, 'Dtl');
    });
});

describe('softdatatypeName', () => {
    it('resolves hardware type AOM_IDENT (128)', () => {
        assert.equal(softdatatypeName(128), 'AOM_IDENT');
    });

    it('resolves hardware type DB_ANY (208)', () => {
        assert.equal(softdatatypeName(208), 'DB_ANY');
    });

    it('resolves CONN_R_ID and DB_DYN', () => {
        assert.equal(softdatatypeName(171), 'CONN_R_ID');
        assert.equal(softdatatypeName(210), 'DB_DYN');
    });

    it('falls back for unknown ids', () => {
        assert.equal(softdatatypeName(9999), 'Softdatatype_9999');
    });
});
