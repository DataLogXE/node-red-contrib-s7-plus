'use strict';

const { run } = require('node:test');
const { spec } = require('node:test/reporters');
const fs = require('node:fs');
const path = require('node:path');

const testDir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(testDir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => path.join(testDir, f));

run({ files, concurrency: true })
    .on('test:fail', () => { process.exitCode = 1; })
    .compose(new spec())
    .pipe(process.stdout);
