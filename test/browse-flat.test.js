'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildFlatSymbolList } = require('../lib/s7plus/browse/flat-browser');
const { S7CommPlusClient } = require('../lib/s7plus/client');
const { Ids } = require('../lib/s7plus/constants');

function mockVte(lid, softdatatype, oit) {
    return {
        lid,
        symbolCrc: 0,
        softdatatype,
        attributeFlags: 0,
        bitoffsetinfoFlags: 0,
        offsetInfoType: oit
    };
}

function mockTypeOb(relId, names, elements) {
    return {
        relationId: relId,
        varnameList: { names },
        vartypeList: { elements },
        getAttribute: () => null,
        getObjects: () => []
    };
}

describe('browse-flat buildFlatSymbolList', () => {
    it('lists leaf member under a DB root', () => {
        const dbRel = 0x8a0e0001;
        const tiRel = 0x100;
        const oitLeaf = {
            is1Dim: () => false,
            isMDim: () => false,
            hasRelation: () => false,
            optimizedAddress: 0,
            nonoptimizedAddress: 4
        };
        const typeOb = mockTypeOb(tiRel, ['speed'], [
            mockVte(10, 8, oitLeaf)
        ]);
        const dbList = [{
            db_block_relid: dbRel,
            db_name: 'Data',
            db_number: 1,
            db_block_ti_relid: tiRel
        }];
        const result = buildFlatSymbolList(dbList, [typeOb]);
        const symbols = result.symbols;
        assert.equal(symbols.length, 1);
        assert.equal(symbols[0].name, 'Data.speed');
        assert.equal(symbols[0].accessSequence, '8A0E0001.A');
        assert.equal(symbols[0].softdatatypeName, 'Real');
    });

    it('expands 1D array of primitives', () => {
        const tiRel = 0x200;
        const oitArr = {
            is1Dim: () => true,
            isMDim: () => false,
            hasRelation: () => false,
            getArrayLowerBounds: () => 0,
            getArrayElementCount: () => 2,
            optimizedAddress: 0,
            nonoptimizedAddress: 0
        };
        const typeOb = mockTypeOb(tiRel, ['arr'], [mockVte(5, 8, oitArr)]);
        const dbList = [{
            db_block_relid: 0x8a0e0002,
            db_name: 'DB2',
            db_number: 2,
            db_block_ti_relid: tiRel
        }];
        const result = buildFlatSymbolList(dbList, [typeOb]);
        const symbols = result.symbols;
        assert.equal(symbols.length, 2);
        assert.equal(symbols[0].name, 'DB2.arr[0]');
        assert.equal(symbols[1].name, 'DB2.arr[1]');
    });

    it('nests struct members via relation id', () => {
        const tiRel = 0x300;
        const structRel = 0x301;
        const oitStruct = {
            is1Dim: () => false,
            isMDim: () => false,
            hasRelation: () => true,
            getRelationId: () => structRel,
            optimizedAddress: 0,
            nonoptimizedAddress: 0
        };
        const oitBool = {
            is1Dim: () => false,
            isMDim: () => false,
            hasRelation: () => false,
            optimizedAddress: 0,
            nonoptimizedAddress: 1
        };
        const dbType = mockTypeOb(tiRel, ['nested'], [mockVte(1, 17, oitStruct)]);
        const structType = mockTypeOb(structRel, ['flag'], [mockVte(2, 1, oitBool)]);
        const dbList = [{
            db_block_relid: 0x8a0e0003,
            db_name: 'S',
            db_number: 3,
            db_block_ti_relid: tiRel
        }];
        const result = buildFlatSymbolList(dbList, [dbType, structType]);
        const symbols = result.symbols;
        assert.equal(symbols.length, 1);
        assert.equal(symbols[0].name, 'S.nested.flag');
        assert.equal(symbols[0].accessSequence, '8A0E0003.1.2');
    });

    it('caps flat symbol count and sets limitExceeded when maxSymbols is reached', () => {
        const tiRel = 0x400;
        const oitArr = {
            is1Dim: () => true,
            isMDim: () => false,
            hasRelation: () => false,
            getArrayLowerBounds: () => 0,
            getArrayElementCount: () => 5,
            optimizedAddress: 0,
            nonoptimizedAddress: 0
        };
        const typeOb = mockTypeOb(tiRel, ['arr'], [mockVte(5, 8, oitArr)]);
        const dbList = [{
            db_block_relid: 0x8a0e0004,
            db_name: 'DB4',
            db_number: 4,
            db_block_ti_relid: tiRel
        }];
        const result = buildFlatSymbolList(dbList, [typeOb], { maxSymbols: 3 });
        assert.equal(result.symbols.length, 3);
        assert.equal(result.limitExceeded, true);
        assert.equal(result.maxSymbols, 3);
    });

    it('sets limitExceeded when a single array is larger than maxSymbols', () => {
        const tiRel = 0x500;
        const oitArr = {
            is1Dim: () => true,
            isMDim: () => false,
            hasRelation: () => false,
            getArrayLowerBounds: () => 0,
            getArrayElementCount: () => 10,
            optimizedAddress: 0,
            nonoptimizedAddress: 0
        };
        const typeOb = mockTypeOb(tiRel, ['big'], [mockVte(5, 8, oitArr)]);
        const dbList = [{
            db_block_relid: 0x8a0e0005,
            db_name: 'DB5',
            db_number: 5,
            db_block_ti_relid: tiRel
        }];
        const result = buildFlatSymbolList(dbList, [typeOb], { maxSymbols: 5 });
        assert.equal(result.limitExceeded, true);
        assert.equal(result.symbols.length, 5);
    });

    it('includes only selected areas when scope.everything is false', () => {
        const dbTi = 0x600;
        const areaTi = 0x90010000;
        const oitLeaf = {
            is1Dim: () => false,
            isMDim: () => false,
            hasRelation: () => false,
            optimizedAddress: 0,
            nonoptimizedAddress: 0
        };
        const dbType = mockTypeOb(dbTi, ['dbVal'], [mockVte(1, 5, oitLeaf)]);
        const areaType = mockTypeOb(areaTi, ['inVal'], [mockVte(2, 5, oitLeaf)]);
        const dbList = [{
            db_block_relid: 0x8a0e0006,
            db_name: 'DB6',
            db_number: 6,
            db_block_ti_relid: dbTi
        }];
        const scope = { everything: false, dbs: ['DB6'], areas: ['IArea'] };
        const result = buildFlatSymbolList(dbList, [dbType, areaType], { scope });
        const names = result.symbols.map(s => s.name);
        assert.ok(names.includes('DB6.dbVal'));
        assert.ok(names.includes('IArea.inVal'));
        assert.ok(!names.some(n => n.startsWith('QArea.')));
        assert.ok(!names.some(n => n.startsWith('MArea.')));
    });
});

describe('client _explorePlcProgramRequest', () => {
    it('requests only ObjectVariableTypeName in explore addressList', async () => {
        const client = new S7CommPlusClient();
        let captured = null;
        client._requestResponse = async (req) => {
            captured = req;
            return {
                objects: [{
                    classId: Ids.PLCProgram_Class_Rid,
                    getObjects: () => []
                }]
            };
        };
        await client._explorePlcProgramRequest();
        assert.ok(captured, 'should send explore request');
        assert.deepEqual(captured.addressList, [Ids.ObjectVariableTypeName]);
        assert.equal(captured.exploreId, Ids.NativeObjects_thePLCProgram_Rid);
        assert.equal(captured.exploreChildsRecursive, 1);
    });
});

describe('client browseFull', () => {
    it('runs Explore PLC program, ReadValues, Explore type-info container', async () => {
        const client = new S7CommPlusClient();
        client._connected = true;
        const steps = [];

        client._explorePlcProgramRequest = async () => {
            steps.push('explorePlc');
            return {
                objects: [{
                    classId: Ids.PLCProgram_Class_Rid,
                    getObjects: () => [{
                        classId: Ids.DB_Class_Rid,
                        relationId: 0x8a0e0001,
                        getAttribute: (id) => id === Ids.ObjectVariableTypeName
                            ? { toJs: () => 'Data' }
                            : null
                    }]
                }]
            };
        };

        client._readTiRelIdsForDbs = async (data) => {
            steps.push('readLid1');
            data[0].db_block_ti_relid = 0x100;
            return data;
        };

        client._fetchTypeInfoContainerChildren = async () => {
            steps.push('exploreContainer');
            const oit = {
                is1Dim: () => false,
                isMDim: () => false,
                hasRelation: () => false,
                optimizedAddress: 0,
                nonoptimizedAddress: 0
            };
            const child = mockTypeOb(0x100, ['x'], [mockVte(1, 5, oit)]);
            return { containerChildren: [child], allObjects: [child] };
        };

        client._seedBrowseStateFromFullBrowse = () => {
            steps.push('seed');
        };

        const result = await client.browseFull();
        assert.deepEqual(steps, ['explorePlc', 'readLid1', 'exploreContainer', 'seed']);
        assert.ok(result.symbols.length >= 1);
        assert.equal(result.meta.dbCount, 1);
        assert.ok(result.meta.symbolCount > 0);
        assert.ok(result.meta.durationMs >= 0);
    });

    it('returns partial browse result with limit metadata when symbol cap is hit', async () => {
        const client = new S7CommPlusClient();
        client._connected = true;
        let cleared = false;

        client._explorePlcProgramRequest = async () => ({
            objects: [{
                classId: Ids.PLCProgram_Class_Rid,
                getObjects: () => [{
                    classId: Ids.DB_Class_Rid,
                    relationId: 0x8a0e0001,
                    getAttribute: (id) => id === Ids.ObjectVariableTypeName
                        ? { toJs: () => 'Data' }
                        : null
                }]
            }]
        });
        client._readTiRelIdsForDbs = async (data) => {
            data[0].db_block_ti_relid = 0x100;
            return data;
        };
        client._fetchTypeInfoContainerChildren = async () => {
            const oitArr = {
                is1Dim: () => true,
                isMDim: () => false,
                hasRelation: () => false,
                getArrayLowerBounds: () => 0,
                getArrayElementCount: () => 5,
                optimizedAddress: 0,
                nonoptimizedAddress: 0
            };
            const child = mockTypeOb(0x100, ['arr'], [mockVte(1, 8, oitArr)]);
            return { containerChildren: [child], allObjects: [child] };
        };
        client.clearBrowseState = () => { cleared = true; };

        const result = await client.browseFull({ maxSymbols: 2 });
        assert.equal(result.symbols.length, 2);
        assert.equal(result.meta.limitExceeded, true);
        assert.equal(result.meta.maxSymbols, 2);
        assert.match(result.meta.limitMessage, /Symbol limit exceeded/);
        assert.equal(cleared, false);
    });

    it('filters DB list and includes scope in meta when partial scope is set', async () => {
        const client = new S7CommPlusClient();
        client._connected = true;
        let readInput = null;
        let scopedRoots = null;
        let usedFullContainer = false;

        client._explorePlcProgramRequest = async () => ({
            objects: [{
                classId: Ids.PLCProgram_Class_Rid,
                getObjects: () => [
                    {
                        classId: Ids.DB_Class_Rid,
                        relationId: 0x8a0e0001,
                        getAttribute: (id) => id === Ids.ObjectVariableTypeName
                            ? { toJs: () => 'KeepMe' }
                            : null
                    },
                    {
                        classId: Ids.DB_Class_Rid,
                        relationId: 0x8a0e0002,
                        getAttribute: (id) => id === Ids.ObjectVariableTypeName
                            ? { toJs: () => 'SkipMe' }
                            : null
                    }
                ]
            }]
        });
        client._readTiRelIdsForDbs = async (data) => {
            readInput = data.map(d => d.db_name);
            data.forEach((d, i) => { d.db_block_ti_relid = 0x100 + i; });
            return data;
        };
        // A scoped browse must use the per-root type-info fetch, NOT the
        // full container download.
        client._fetchTypeInfoContainerChildren = async () => {
            usedFullContainer = true;
            return { containerChildren: [], allObjects: [] };
        };
        client._fetchTypeInfoForRoots = async (rootTiRelIds) => {
            scopedRoots = rootTiRelIds;
            const oit = {
                is1Dim: () => false,
                isMDim: () => false,
                hasRelation: () => false,
                optimizedAddress: 0,
                nonoptimizedAddress: 0
            };
            return [mockTypeOb(0x100, ['x'], [mockVte(1, 5, oit)])];
        };
        client._seedBrowseStateFromScopedBrowse = () => {};

        const scope = { everything: false, dbs: ['KeepMe'], areas: [] };
        const result = await client.browseFull({ scope });
        assert.deepEqual(readInput, ['KeepMe']);
        assert.equal(usedFullContainer, false, 'scoped browse must not fetch the full type-info container');
        assert.deepEqual(scopedRoots, [0x100], 'scoped browse fetches only the scoped DB type relId');
        assert.equal(result.meta.dbCount, 1);
        assert.equal(result.meta.symbolCount, 1);
        assert.deepEqual(result.meta.scope, {
            everything: false,
            dbs: ['KeepMe'],
            areas: []
        });
    });

    it('fetches only scoped memory-area type relIds in addition to scoped DBs', async () => {
        const client = new S7CommPlusClient();
        client._connected = true;
        let scopedRoots = null;

        client._explorePlcProgramRequest = async () => ({
            objects: [{
                classId: Ids.PLCProgram_Class_Rid,
                getObjects: () => [{
                    classId: Ids.DB_Class_Rid,
                    relationId: 0x8a0e0001,
                    getAttribute: (id) => id === Ids.ObjectVariableTypeName
                        ? { toJs: () => 'KeepMe' }
                        : null
                }]
            }]
        });
        client._readTiRelIdsForDbs = async (data) => {
            data.forEach((d) => { d.db_block_ti_relid = 0x100; });
            return data;
        };
        client._fetchTypeInfoForRoots = async (rootTiRelIds) => {
            scopedRoots = rootTiRelIds;
            return [];
        };
        client._seedBrowseStateFromScopedBrowse = () => {};

        // IArea -> tiRelId 0x90010000 (see browse/areas.js MEMORY_AREAS).
        const scope = { everything: false, dbs: ['KeepMe'], areas: ['IArea'] };
        await client.browseFull({ scope });
        assert.deepEqual(scopedRoots, [0x100, 0x90010000]);
    });
});
