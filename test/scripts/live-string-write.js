'use strict';

/**
 * Live test: writing String / WString with a declared length (String[n]).
 * Needs the test program from plc/ (DB_CharacterStrings, DB_Integers).
 * Writes to the *_Len4_Test and *_write variables and restores them.
 *
 * Usage: node test/scripts/live-string-write.js <host>
 */
const path = require('path');
const HOST = process.env.S7_HOST || process.argv[2];
if (!HOST) { console.error('Usage: node test/scripts/live-string-write.js <host>'); process.exit(1); }
const R = path.join(__dirname, '..', '..');
const { S7CommPlusClient, ItemAddress } = require(path.join(R, 'lib/s7plus/client'));
const { decodeReadValue } = require(path.join(R, 'lib/s7plus/pvalue-codec'));
const { writeTagsEncoded } = require(path.join(R, 'lib/s7plus/write-tags'));
let pass = 0, fail = 0;
const ok = (c, label, info = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${label}${c ? '' : '  -> ' + info}`); };
const short = (v) => JSON.stringify(v.length > 20 ? v.slice(0, 12) + '...(' + v.length + ')' : v);
(async () => {
  const c = new S7CommPlusClient();
  await c.connect(HOST, '', '', 10000, 102);
  const { nodes: roots } = await c.browseRoots();
  const leaves = {};
  const wanted = [
    ['DB_CharacterStrings', ['String_Len4_Test', 'WString_Len4_Test', 'String_write', 'WString_write']],
    ['DB_Integers', ['Int_write']]
  ];
  for (const [db, names] of wanted) {
    const { nodes } = await c.browseChildren(roots.find(r => r.label === db).id);
    for (const n of names) leaves[n] = await c.browseResolve(nodes.find(x => x.label === n).id);
  }
  let reads = 0;
  const cli = { readValues: (a) => { reads++; return c.readValues(a); }, writeValues: (a, v) => c.writeValues(a, v) };
  const cache = new Map();
  const tag = (n, value) => ({ name: n, address: leaves[n].address, datatype: leaves[n].datatype, value });
  const write = (tags, ch = cache) => writeTagsEncoded(cli, tags, tags.map(t => new ItemAddress(t.address)), { stringLenCache: ch });
  const read = async (n) => {
    const { values, errors } = await c.readValues([new ItemAddress(leaves[n].address)]);
    if (errors[0]) throw new Error('read err');
    return { val: decodeReadValue(values[0], leaves[n].datatype), raw: values[0].toJs() };
  };
  const orig = {};
  for (const n of Object.keys(leaves)) orig[n] = (await read(n)).val;
  console.log('originals', JSON.stringify(orig));

  const good = async (n, v) => {
    const res = await write([tag(n, v)]);
    const rb = await read(n);
    ok(res[n].status === 'ok' && rb.val === v && rb.raw[1] === v.length && rb.raw.slice(2 + v.length).every(x => x === 0),
      `${n} <- ${short(v)}`, JSON.stringify(res[n]) + ' rb=' + JSON.stringify(rb.val).slice(0, 60));
  };
  const bad = async (n, v, re) => {
    const before = await read(n);
    const res = await write([tag(n, v)]);
    const rb = await read(n);
    ok(res[n].status === 'error' && re.test(res[n].error) && res[n].value === null && rb.val === before.val,
      `${n} rejects ${short(v)}: ${res[n].error}`, JSON.stringify(res[n]) + ' rb=' + rb.val);
  };

  console.log('String[4]');
  for (const v of ['Test', '', 'a', 'ab', 'abc', 'wxyz', 'äöüß', 'x', 'Test']) await good('String_Len4_Test', v);
  await bad('String_Len4_Test', 'abcde', /5 characters.*String\[4\]/);
  await bad('String_Len4_Test', 'x'.repeat(300), /String\[4\]/);
  await bad('String_Len4_Test', '5€', /not representable/);
  await bad('String_Len4_Test', 'ΣΛ', /not representable/);
  console.log('WString[4]');
  for (const v of ['Test', '', 'a', 'ab', 'ΣΛΔ', 'ä€Σz', '\u{1F600}', '\u{1F600}\u{1F601}', 'x', 'Test']) await good('WString_Len4_Test', v);
  await bad('WString_Len4_Test', 'abcde', /5 characters.*WString\[4\]/);
  await bad('WString_Len4_Test', 'a\u{1F600}\u{1F601}', /WString\[4\]/);
  console.log('String (254)');
  for (const v of ['', 'Hello S7', 'Mötörhead', 'L'.repeat(254), 'short']) await good('String_write', v);
  await bad('String_write', 'L'.repeat(255), /255 characters.*String\[254\]/);
  await bad('String_write', '€', /not representable/);
  console.log('WString (254)');
  for (const v of ['', 'Hallo Welt', 'Test Greek ΣΛΔ end.', 'Ω'.repeat(254), 'short']) await good('WString_write', v);
  await bad('WString_write', 'Ω'.repeat(255), /255 characters.*WString\[254\]/);

  console.log('cache / multi-tag');
  const r0 = reads;
  await write([tag('String_Len4_Test', 'c1'), tag('WString_Len4_Test', 'c2'), tag('String_write', 'c3'), tag('WString_write', 'c4')]);
  ok(reads === r0, 'no extra read once lengths are cached', `reads ${reads - r0}`);
  ok(cache.get(leaves.String_Len4_Test.address) === 4 && cache.get(leaves.WString_Len4_Test.address) === 4
    && cache.get(leaves.String_write.address) === 254 && cache.get(leaves.WString_write.address) === 254,
    'cached lengths 4/4/254/254', JSON.stringify([...cache]));
  const fresh = new Map();
  const r1 = reads;
  let res = await write([tag('Int_write', 1234), tag('String_Len4_Test', 'm1'), tag('WString_Len4_Test', 'toolong'),
    tag('String_write', 'multi'), tag('WString_write', 'mΣ')], fresh);
  ok(reads === r1 + 1, 'fresh cache: exactly one length read for 4 strings', `reads ${reads - r1}`);
  ok(res.Int_write.status === 'ok' && res.String_Len4_Test.status === 'ok' && res.WString_Len4_Test.status === 'error'
    && res.String_write.status === 'ok' && res.WString_write.status === 'ok', 'mixed write: 4 ok, 1 per-tag error', JSON.stringify(res));
  ok((await read('Int_write')).val === 1234 && (await read('String_Len4_Test')).val === 'm1'
    && (await read('WString_Len4_Test')).val === 'c2' && (await read('String_write')).val === 'multi'
    && (await read('WString_write')).val === 'mΣ', 'mixed write: readback correct, rejected tag untouched');
  ok(Object.keys(res).join() === 'Int_write,String_Len4_Test,WString_Len4_Test,String_write,WString_write', 'result order preserved');

  console.log('stale cache self-heal');
  for (const [n, wrong] of [['String_Len4_Test', 10], ['WString_Len4_Test', 254], ['String_write', 4], ['WString_write', 80]]) {
    const st = new Map([[leaves[n].address, wrong]]);
    res = await write([tag(n, 'heal')], st);
    const rb = await read(n);
    ok(res[n].status === 'ok' && rb.val === 'heal' && st.get(leaves[n].address) === rb.raw[0],
      `${n}: stale cached length ${wrong} corrected to ${rb.raw[0]}`, JSON.stringify(res[n]));
  }
  const st = new Map([[leaves.String_Len4_Test.address, 10]]);
  res = await write([tag('String_Len4_Test', 'sixsix')], st);
  ok(res.String_Len4_Test.status === 'error' && /String\[4\]/.test(res.String_Len4_Test.error)
    && (await read('String_Len4_Test')).val === 'heal', 'stale cache + text too long for real length -> clean per-tag error', JSON.stringify(res));

  console.log('CRC-secured address');
  for (const n of ['String_Len4_Test', 'WString_Len4_Test']) {
    const crc = leaves[n].symbolCrc || (leaves[n].crcMeta && leaves[n].crcMeta.symbolCrc);
    if (!crc) { console.log('  (no symbolCrc on resolve result: ' + JSON.stringify(leaves[n]) + ')'); continue; }
    const mk = (crcVal) => { const a = new ItemAddress(leaves[n].address); a.symbolCrc = crcVal >>> 0; return a; };
    let r = await writeTagsEncoded(cli, [tag(n, 'crc')], [mk(crc)], { stringLenCache: new Map() });
    ok(r[n].status === 'ok' && (await read(n)).val === 'crc', `${n}: write with correct CRC`, JSON.stringify(r));
    r = await writeTagsEncoded(cli, [tag(n, 'bad')], [mk(crc ^ 0x5555)], { stringLenCache: new Map() });
    ok(r[n].status === 'error' && /12cbffef/i.test(r[n].error) && (await read(n)).val === 'crc',
      `${n}: wrong CRC rejected with CRC error code (${r[n].error})`, JSON.stringify(r));
  }

  console.log('restore');
  res = await write(Object.keys(orig).map(n => tag(n, orig[n])));
  let allBack = Object.values(res).every(x => x.status === 'ok');
  for (const n of Object.keys(orig)) allBack = allBack && (await read(n)).val === orig[n];
  ok(allBack, 'original values restored', JSON.stringify(res));
  await c.disconnect();
  console.log(`\nRESULT ${HOST}: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
