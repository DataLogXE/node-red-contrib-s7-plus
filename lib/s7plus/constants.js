'use strict';

const Opcode = {
    Request: 0x31,
    Response: 0x32,
    Notification: 0x33,
    Response2: 0x02
};

const Functioncode = {
    Error: 0x04b1,
    Explore: 0x04bb,
    CreateObject: 0x04ca,
    DeleteObject: 0x04d4,
    SetVariable: 0x04f2,
    GetVariable: 0x04fc,
    SetMultiVariables: 0x0542,
    GetMultiVariables: 0x054c,
    GetVarSubStreamed: 0x0586,
    InitSsl: 0x05b3
};

const ProtocolVersion = {
    V1: 0x01,
    V2: 0x02,
    V3: 0x03,
    SystemEvent: 0xfe
};

const ElementID = {
    StartOfObject: 0xa1,
    TerminatingObject: 0xa2,
    Attribute: 0xa3,
    Relation: 0xa4,
    VartypeList: 0xab,
    VarnameList: 0xac
};

const Datatype = {
    Null: 0x00,
    Bool: 0x01,
    USInt: 0x02,
    UInt: 0x03,
    UDInt: 0x04,
    ULInt: 0x05,
    SInt: 0x06,
    Int: 0x07,
    DInt: 0x08,
    LInt: 0x09,
    Byte: 0x0a,
    Word: 0x0b,
    DWord: 0x0c,
    LWord: 0x0d,
    Real: 0x0e,
    LReal: 0x0f,
    Timestamp: 0x10,
    Timespan: 0x11,
    RID: 0x12,
    AID: 0x13,
    Blob: 0x14,
    WString: 0x15,
    Struct: 0x17
};

const Ids = {
    None: 0,
    ObjectRoot: 201,
    GetNewRIDOnServer: 211,
    ObjectVariableTypeName: 233,
    Block_BlockNumber: 2521,
    ASObjectES_Comment: 4288,
    NativeObjects_thePLCProgram_Rid: 3,
    ClassSubscriptions: 255,
    ClassOMSTypeInfoContainer: 534,
    ObjectOMSTypeInfoContainer: 537,
    TI_TComSize: 1502,
    // Subscription object class and attributes (see thomas-v2 Subscription.cs / Ids.cs).
    // ClassSubscriptions (255) is only the per-session container; ClassSubscription
    // (1001) is the actual subscription object created via CreateObject.
    ClassSubscription: 1001,
    SubscriptionMissedSendings: 1002,
    SubscriptionSubsystemError: 1003,
    SubscriptionRouteMode: 1040,
    SubscriptionActive: 1041,
    SubscriptionReferenceList: 1048,
    SubscriptionCycleTime: 1049,
    SubscriptionDisabled: 1051,
    SubscriptionCount: 1052,
    SubscriptionCreditLimit: 1053,
    SubscriptionTicks: 1054,
    SubscriptionFunctionClassId: 1082,
    PLCProgram_Class_Rid: 2520,
    DB_Class_Rid: 2574,
    ClassServerSessionContainer: 284,
    ObjectServerSessionContainer: 285,
    ClassServerSession: 287,
    ObjectNullServerSession: 288,
    ServerSessionClientRID: 300,
    ServerSessionRequest: 303,
    ServerSessionResponse: 304,
    ServerSessionVersion: 306,
    LID_SessionVersionSystemPAOMString: 319,
    SystemLimits: 1037,
    FreeItems: 1081,
    Legitimate: 1846,
    EffectiveProtectionLevel: 1842,
    ActiveProtectionLevel: 1843,
    ObjectQualifier: 1256,
    ParentRID: 1257,
    CompositionAID: 1258,
    KeyQualifier: 1259,
    DB_ValueActual: 2550,
    ControllerArea_ValueActual: 3736,
    NativeObjects_theS7Timers_Rid: 84,
    NativeObjects_theS7Counters_Rid: 83,
    NativeObjects_theIArea_Rid: 80,
    NativeObjects_theQArea_Rid: 81,
    NativeObjects_theMArea_Rid: 82,
    LID_LegitimationPayloadStruct: 40400,
    LID_LegitimationPayloadType: 40401,
    LID_LegitimationPayloadUsername: 40402,
    LID_LegitimationPayloadPassword: 40403
};

const AccessLevel = {
    FullAccess: 1
};

const S7Consts = {
    errTCPConnectionTimeout: 0x00010000,
    errTCPConnectionFailed: 0x00010001,
    errTCPDataReceive: 0x00010004,
    errTCPNotConnected: 0x00010007,
    errIsoConnect: 0x00020000,
    errIsoInvalidPDU: 0x00020001,
    errOpenSSL: 0x00030000,
    errCliInvalidParams: 0x00200000,
    errCliAccessDenied: 0x0020000f,
    errCliFirmwareNotSupported: 0x0020001a,
    errCliDeviceNotSupported: 0x0020001b,
    errCliNeedPassword: 0x0020000d
};

function errorText(code) {
    const map = {
        0: 'OK',
        [S7Consts.errTCPConnectionTimeout]: 'TCP: Connection Timeout',
        [S7Consts.errTCPConnectionFailed]: 'TCP: Connection Error',
        [S7Consts.errTCPDataReceive]: 'TCP: Data receive Timeout',
        [S7Consts.errTCPNotConnected]: 'CLI: Client not connected',
        [S7Consts.errIsoConnect]: 'ISO: Connection Error',
        [S7Consts.errIsoInvalidPDU]: 'ISO: Invalid PDU',
        [S7Consts.errOpenSSL]: 'TLS/SSL: Error',
        [S7Consts.errCliAccessDenied]: 'CPU: Access denied',
        [S7Consts.errCliFirmwareNotSupported]: 'CLI: Firmware not supported',
        [S7Consts.errCliDeviceNotSupported]: 'CLI: Device not supported',
        [S7Consts.errCliNeedPassword]: 'CPU: Password required'
    };
    return map[code] || `CLI: Unknown error (0x${(code >>> 0).toString(16)})`;
}

module.exports = {
    Opcode,
    Functioncode,
    ProtocolVersion,
    ElementID,
    Datatype,
    Ids,
    AccessLevel,
    S7Consts,
    errorText
};
