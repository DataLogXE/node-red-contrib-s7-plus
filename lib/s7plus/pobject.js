'use strict';

const S7p = require('./s7p');
const { ElementID } = require('./constants');
const { PVartypeList, PVarnameList } = require('./pvar-lists');

class PObject {
    constructor(rid = 0, clsid = 0, aid = 0) {
        this.relationId = rid;
        this.classId = clsid;
        this.classFlags = 0;
        this.attributeId = aid;
        this.attributes = new Map();
        this.objects = [];
        this.relations = new Map();
        this.vartypeList = null;
        this.varnameList = null;
    }

    addAttribute(id, value) {
        this.attributes.set(id, value);
    }

    getAttribute(id) {
        return this.attributes.get(id);
    }

    addObject(obj) {
        this.objects.push(obj);
    }

    getObjects() {
        return this.objects;
    }

    getObjectByRelationId(relId) {
        return this.objects.find(o => o.relationId === relId) || null;
    }

    serialize(buf) {
        let ret = 0;
        ret += S7p.encodeByte(buf, ElementID.StartOfObject);
        ret += S7p.encodeUInt32(buf, this.relationId >>> 0);
        ret += S7p.encodeUInt32Vlq(buf, this.classId >>> 0);
        ret += S7p.encodeUInt32Vlq(buf, this.classFlags >>> 0);
        ret += S7p.encodeUInt32Vlq(buf, this.attributeId >>> 0);
        for (const [k, v] of this.attributes) {
            ret += S7p.encodeByte(buf, ElementID.Attribute);
            ret += S7p.encodeUInt32Vlq(buf, k >>> 0);
            ret += v.serialize(buf);
        }
        for (const o of this.objects) ret += o.serialize(buf);
        for (const [k, v] of this.relations) {
            ret += S7p.encodeByte(buf, ElementID.Relation);
            ret += S7p.encodeUInt32Vlq(buf, k >>> 0);
            ret += S7p.encodeUInt32(buf, v >>> 0);
        }
        ret += S7p.encodeByte(buf, ElementID.TerminatingObject);
        return ret;
    }

    static decodeObjectList(buf) {
        const list = [];
        let tagId = buf.readByte();
        if (tagId === null) return list;
        buf.position -= 1;
        while (tagId === ElementID.StartOfObject) {
            list.push(PObject.decodeObject(buf, true));
            tagId = buf.readByte();
            if (tagId === null) break;
            buf.position -= 1;
        }
        return list;
    }

    static decodeObject(buf, asList = false) {
        let obj = null;
        let terminate = false;
        while (!terminate) {
            const tag = buf.readByte();
            if (tag === null) break;
            switch (tag) {
                case ElementID.StartOfObject: {
                    if (obj === null) {
                        obj = new PObject();
                        obj.relationId = S7p.decodeUInt32(buf).v;
                        obj.classId = S7p.decodeUInt32Vlq(buf).v;
                        obj.classFlags = S7p.decodeUInt32Vlq(buf).v;
                        obj.attributeId = S7p.decodeUInt32Vlq(buf).v;
                        if (!asList) {
                            PObject._decodeInner(buf, obj);
                            terminate = true;
                        }
                    } else {
                        const child = new PObject();
                        child.relationId = S7p.decodeUInt32(buf).v;
                        child.classId = S7p.decodeUInt32Vlq(buf).v;
                        child.classFlags = S7p.decodeUInt32Vlq(buf).v;
                        child.attributeId = S7p.decodeUInt32Vlq(buf).v;
                        PObject._decodeInner(buf, child);
                        obj.addObject(child);
                    }
                    break;
                }
                case ElementID.TerminatingObject:
                    terminate = true;
                    break;
                case ElementID.Attribute: {
                    const id = S7p.decodeUInt32Vlq(buf).v;
                    const val = require('./pvalue').deserialize(buf);
                    obj.addAttribute(id, val);
                    break;
                }
                case 0xaa: // StartOfTagDescription — skip (legacy 1200)
                    break;
                case ElementID.VartypeList: {
                    const typelist = new PVartypeList();
                    typelist.deserialize(buf);
                    obj.vartypeList = typelist;
                    break;
                }
                case ElementID.VarnameList: {
                    const namelist = new PVarnameList();
                    namelist.deserialize(buf);
                    obj.varnameList = namelist;
                    break;
                }
                case ElementID.Relation: {
                    const relId = S7p.decodeUInt32Vlq(buf).v;
                    const val = S7p.decodeUInt32(buf).v;
                    obj.relations.set(relId, val);
                    break;
                }
                default:
                    terminate = true;
                    buf.position -= 1;
                    break;
            }
        }
        return obj || new PObject();
    }

    static _decodeInner(buf, obj) {
        let terminate = false;
        while (!terminate) {
            const tag = buf.readByte();
            if (tag === null) break;
            switch (tag) {
                case ElementID.StartOfObject: {
                    buf.position -= 1;
                    obj.addObject(PObject.decodeObject(buf, true));
                    break;
                }
                case ElementID.TerminatingObject:
                    terminate = true;
                    break;
                case ElementID.Attribute: {
                    const id = S7p.decodeUInt32Vlq(buf).v;
                    const val = require('./pvalue').deserialize(buf);
                    obj.addAttribute(id, val);
                    break;
                }
                case 0xaa:
                    break;
                case ElementID.VartypeList: {
                    const typelist = new PVartypeList();
                    typelist.deserialize(buf);
                    obj.vartypeList = typelist;
                    break;
                }
                case ElementID.VarnameList: {
                    const namelist = new PVarnameList();
                    namelist.deserialize(buf);
                    obj.varnameList = namelist;
                    break;
                }
                case ElementID.Relation: {
                    const relId = S7p.decodeUInt32Vlq(buf).v;
                    const val = S7p.decodeUInt32(buf).v;
                    obj.relations.set(relId, val);
                    break;
                }
                default:
                    terminate = true;
                    buf.position -= 1;
                    break;
            }
        }
    }

    /** @deprecated use decodeObject */
    static decode(buf, asList = false) {
        return PObject.decodeObject(buf, asList);
    }
}

module.exports = PObject;
