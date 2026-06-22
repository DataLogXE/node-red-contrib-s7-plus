'use strict';

const S7p = require('./s7p');
const { Ids } = require('./constants');

class ItemAddress {
    constructor(accessAreaOrString, accessSubArea) {
        this.symbolCrc = 0;
        this.lid = [];
        if (typeof accessAreaOrString === 'string') {
            const parts = accessAreaOrString.split('.');
            const ids = parts.map(p => parseInt(p, 16));
            this.accessArea = ids[0];
            if (this.accessArea >= 0x8a0e0000) {
                this.accessSubArea = Ids.DB_ValueActual;
            } else if ([
                Ids.NativeObjects_theS7Timers_Rid,
                Ids.NativeObjects_theS7Counters_Rid,
                Ids.NativeObjects_theIArea_Rid,
                Ids.NativeObjects_theQArea_Rid,
                Ids.NativeObjects_theMArea_Rid
            ].includes(this.accessArea)) {
                this.accessSubArea = Ids.ControllerArea_ValueActual;
            } else {
                this.accessSubArea = accessSubArea ?? Ids.DB_ValueActual;
            }
            for (let i = 1; i < ids.length; i++) this.lid.push(ids[i]);
        } else {
            this.accessArea = accessAreaOrString ?? 0;
            this.accessSubArea = accessSubArea ?? Ids.DB_ValueActual;
        }
    }

    getNumberOfFields() {
        return 4 + this.lid.length;
    }

    serialize(buf) {
        let n = 0;
        n += S7p.encodeUInt32Vlq(buf, this.symbolCrc);
        n += S7p.encodeUInt32Vlq(buf, this.accessArea >>> 0);
        n += S7p.encodeUInt32Vlq(buf, this.lid.length + 1);
        n += S7p.encodeUInt32Vlq(buf, this.accessSubArea >>> 0);
        for (const id of this.lid) n += S7p.encodeUInt32Vlq(buf, id >>> 0);
        return n;
    }

    getAccessString() {
        let s = this.accessArea.toString(16).toUpperCase();
        for (const i of this.lid) s += `.${i.toString(16).toUpperCase()}`;
        return s;
    }
}

module.exports = ItemAddress;
