'use strict';

function formatStatusText(payload) {
    const plc = payload && payload.plc;
    const conn = payload && payload.connection;
    const parts = [];
    if (plc && plc.deviceFamily) parts.push(plc.deviceFamily);
    if (plc && plc.firmware) parts.push(plc.firmware);
    if (conn && conn.endpointState) parts.push(conn.endpointState);
    return parts.length ? parts.join(' · ') : 'ok';
}

function stateChangeStatusShape(state, text) {
    switch (state) {
        case 'online':
            return { fill: 'green', shape: 'dot', text: text || 'online' };
        case 'connecting':
            return { fill: 'yellow', shape: 'dot', text: text || 'connecting' };
        case 'offline':
            return { fill: 'red', shape: 'dot', text: text || 'offline' };
        default:
            return { fill: 'grey', shape: 'ring', text: text || state || '' };
    }
}

function applyStateChangeMeta(payload, event) {
    payload.meta = Object.assign({}, payload.meta || {}, {
        event: 'stateChange',
        previousState: event && event.previousState != null ? event.previousState : null,
        changedAt: new Date().toISOString()
    });
    return payload;
}

module.exports = function (RED) {
    function S7ComPlusInfo(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        if (!node.endpoint) {
            node.error('Missing s7-plus endpoint configuration');
            return;
        }

        const stateChanges = config.stateChanges === true || config.stateChanges === 'true';
        let busy = false;

        async function emitStateChange(event) {
            let payload;
            try {
                if (event.state === 'online') {
                    payload = await node.endpoint.getSessionInfo({ refreshLimits: false });
                } else {
                    payload = node.endpoint.getConnectionStatePayload(event);
                }
            } catch (e) {
                payload = node.endpoint.getConnectionStatePayload(event);
            }
            applyStateChangeMeta(payload, event);
            node.status(stateChangeStatusShape(event.state, formatStatusText(payload)));
            node.send({ payload });
        }

        if (stateChanges) {
            node.endpoint.addStateListener(node.id, (event) => {
                emitStateChange(event).catch((err) => {
                    node.error(`State change emit failed: ${err.message}`);
                });
            });
            setImmediate(() => {
                emitStateChange({
                    state: node.endpoint.getStatus(),
                    previousState: null,
                    text: null
                }).catch((err) => {
                    node.error(`Initial state emit failed: ${err.message}`);
                });
            });
            node.on('close', () => {
                node.endpoint.removeStateListener(node.id);
            });
        }

        node.on('input', async (msg, send, done) => {
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) node.error(err, msg); };

            if (busy) {
                node.warn('Info request already in progress');
                node.status({ fill: 'yellow', shape: 'ring', text: 'skipped (busy)' });
                done();
                return;
            }

            busy = true;
            node.status({ fill: 'blue', shape: 'ring', text: 'fetching...' });
            const t0 = Date.now();
            const refreshLimits = !(msg && msg.refreshLimits === false);

            try {
                const payload = await node.endpoint.getSessionInfo({ refreshLimits });
                msg.payload = payload;
                const elapsed = Date.now() - t0;
                node.status({
                    fill: 'green',
                    shape: 'dot',
                    text: `${formatStatusText(payload)} (${elapsed}ms)`
                });
                send(msg);
                done();
            } catch (e) {
                const elapsed = Date.now() - t0;
                node.status({ fill: 'red', shape: 'dot', text: `${e.message} (${elapsed}ms)` });
                done(e);
            } finally {
                busy = false;
            }
        });
    }

    RED.nodes.registerType('s7-plus info', S7ComPlusInfo);
};
