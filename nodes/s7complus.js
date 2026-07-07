'use strict';

module.exports = function (RED) {
    require('./s7complus-endpoint')(RED);
    require('./s7complus-in')(RED);
    require('./s7complus-out')(RED);
    require('./s7complus-subscribe')(RED);
    require('./s7complus-explore')(RED);
    require('./s7complus-info')(RED);
};

module.exports.nodeType = 's7complus';
