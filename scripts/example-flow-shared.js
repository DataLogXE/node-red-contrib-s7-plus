'use strict';

// Shared PLC endpoint and global-config ids for all example flows.
// Using the same node ids lets Node-RED reuse one config node when multiple
// example flows are imported into the same workspace.
const EP = 'example_plc_ep';
const GLOBAL_CONFIG_ID = '69768f9f5a51add5';
const PLC_ADDRESS = '192.168.0.1';
const PLC_TIMEOUT = 10000;
const DEFAULT_OUTPUT_FORMAT = 'object';

function endpointNode() {
    return {
        id: EP,
        type: 's7-plus endpoint',
        name: 'PLC',
        address: PLC_ADDRESS,
        timeout: PLC_TIMEOUT
    };
}

function globalConfigNode(packageVersion) {
    return {
        id: GLOBAL_CONFIG_ID,
        type: 'global-config',
        env: [],
        modules: {
            'node-red-contrib-s7-plus': packageVersion
        }
    };
}

module.exports = {
    EP,
    GLOBAL_CONFIG_ID,
    DEFAULT_OUTPUT_FORMAT,
    endpointNode,
    globalConfigNode
};
