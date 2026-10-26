'use strict';
// Smoke test of the avatar link: SSO token, the service API (converse / brief / drafts) and the pages, against the scripted Gemini stand-in.
//   node test/avatar-smoke.js
const os = require('os'), path = require('path'), crypto = require('crypto'), assert = require('assert');
process.env.PORT = '8795';
process.env.OWNER_TOKEN = 'smoke-owner-token';
process.env.FIELD_CODES = 'عز:1234,أحمد:5678';
process.env.FIELD_SCOPES = 'أحمد:deals+money';
process.env.DATA_FILE = path.join(os.tmpdir(), `pm-avatar-smoke-${process.pid}.json`);
process.env.GEMINI_API_KEY = 'mock'; process.env.GEMINI_BASE = 'http://localhost:8793';
process.env.FIELD_MATRIX_URL = 'https://matrix.example'; process.env.FIELD_MATRIX_PK = 'pk_test'; process.env.FIELD_MATRIX_SECRET = 'sk_secret_for_test';
process.env.FIELD_SERVICE_KEY = 'k'.repeat(24);
require('./mock-gemini.js');
require('../server.js');

const B = 'http://127.0.0.1:8795', KEY = { 'X-Service-Key': 'k'.repeat(24) }, OWNER = { Authorization: 'Bearer smoke-owner-token' };
const call = async (p, body, headers, method) => {
  const r = await fetch(B + p, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; }
  return { s: r.status, j };
};
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await wait(1200);
  // 1. the avatar's address is public, the secret is not
  let r = await call('/api/field/avatar'); assert.deepStrictEqual(r.j, { avatar: { url: 'https://matrix.example', pk: 'pk_test' } });
  // 2. login hands back a signed sign-in that Matrix can verify with the deployment's secret
  r = await call('/api/field/login', { code: '1234' }, {}); assert.strictEqual(r.s, 200); assert.strictEqual(r.j.name, 'عز');
  const [h, b, sig] = r.j.sso_token.split('.');
  const want = crypto.createHmac('sha256', 'sk_secret_for_test').update(`${h}.${b}`).digest('base64url');
  assert.strictEqual(sig, want); assert.strictEqual(JSON.parse(Buffer.from(b, 'base64url')).sub, 'عز');
  assert.strictEqual((await call('/api/field/login', { code: 'nope' }, {})).s, 401);
  // 3. the service API refuses a missing key and an unknown person
  assert.strictEqual((await call('/api/service/brief', { person: 'عز' })).s, 401);
  assert.strictEqual((await call('/api/service/brief', { person: 'x' }, KEY)).s, 403);
  // 4. brief
  r = await call('/api/service/brief', { person: 'أحمد' }, KEY); assert.strictEqual(r.s, 200);
  assert.ok(/أهلاً أحمد/.test(r.j.speech) && /الصفقات/.test(r.j.speech) && !/المصروفات/.test(r.j.speech), r.j.speech);       // أحمد may not ask about expenses
  // 5. a spoken purchase is read back, held, and filed after "yes"
  r = await call('/api/service/converse', { person: 'عز', text: 'اشتريت من هاني عيسي ألفين كيلو ABS' }, KEY); assert.strictEqual(r.s, 200, JSON.stringify(r.j));
  assert.strictEqual(r.j.records.length, 1); assert.ok(/هسجّل: شراء/.test(r.j.speech), r.j.speech); console.log('   readback:', r.j.speech);
  const rec = r.j.records;
  r = await call('/api/service/converse', { person: 'عز', text: 'أيوه', pending: rec }, KEY); assert.strictEqual(r.j.kind, 'confirm'); assert.strictEqual(r.j.speech, '');
  r = await call('/api/service/drafts', { person: 'عز', records: rec, transcript: 'اشتريت' }, KEY); assert.strictEqual(r.s, 201); assert.strictEqual(r.j.ids.length, 1);
  r = await call('/api/owner/drafts?status=pending', undefined, OWNER); assert.ok(r.j.some(d => d.submittedBy === 'عز'));
  assert.strictEqual((await call('/api/service/drafts', { person: 'عز', records: [] }, KEY)).s, 400);
  // 6. a question over the snapshot comes back with a table for the avatar's screen
  const snap = { deals: [{ kind: 'sale', date: '2026-10-24', party: 'فلكس', material: 'ABS', qty: 500, net: 25000 }], money: [], expenses: [], balances: { customers: [], suppliers: [] },
    inventory: [{ material: 'ABS', stock: 1200, unit: 'كجم' }, { material: 'PP', stock: 300, unit: 'كجم' }] };
  r = await call('/api/owner/snapshot', snap, OWNER, 'PUT'); assert.strictEqual(r.s, 200);
  r = await call('/api/service/converse', { person: 'عز', text: 'المخزون كام' }, KEY); assert.strictEqual(r.s, 200, JSON.stringify(r.j));
  assert.ok(r.j.board, 'an inventory list comes with a table'); assert.strictEqual(r.j.board.blocks[0].type, 'table'); assert.strictEqual(r.j.board.blocks[0].rows.length, 2); assert.ok(/الجدول/.test(r.j.speech));
  console.log('   table:', r.j.board.blocks[0].title, r.j.board.blocks[0].rows.length, 'rows;', r.j.speech);
  // a person without the inventory scope is refused, and no table leaks
  r = await call('/api/service/converse', { person: 'أحمد', text: 'المخزون كام' }, KEY); assert.ok(!r.j.board, 'no table for a denied question'); console.log('   denied:', r.j.speech);
  // 6b. "the last sales and the last purchases" in one sentence: the newest rows are all sales, but the purchases must still be answered (split per kind)
  const deals = [1, 2, 3].map(i => ({ kind: 'sale', date: `2026-10-2${i}`, party: 'عميل' + i, material: 'ABS', qty: 100, net: 1000 * i })).concat([1, 2].map(i => ({ kind: 'purchase', date: `2026-10-1${i}`, party: 'مورد' + i, material: 'PP', qty: 50, net: 500 * i })));
  assert.strictEqual((await call('/api/owner/snapshot', { ...snap, deals }, OWNER, 'PUT')).s, 200);
  r = await call('/api/service/converse', { person: 'عز', text: 'آخر المبيعات وآخر المشتريات' }, KEY); assert.strictEqual(r.s, 200, JSON.stringify(r.j));
  assert.strictEqual(r.j.queries.length, 2, 'one query per kind'); assert.deepStrictEqual(r.j.queries.map(q => q.structured.kinds[0]), ['sale', 'purchase']);
  assert.ok(r.j.queries[1].result.rows.every(x => x.kind === 'purchase') && r.j.queries[1].result.count === 2, 'the purchases are not pushed out by the newer sales');
  assert.ok(/المبيعات/.test(r.j.answer) && /المشتريات/.test(r.j.answer), r.j.answer); assert.strictEqual(r.j.board.blocks.length, 2); assert.deepStrictEqual(r.j.board.blocks.map(b => b.id), ['t1', 't2']);
  console.log('   both kinds:', r.j.board.blocks.map(b => b.title + ' ' + b.rows.length + ' rows').join(' | '));
  // 7. pages: the avatar's door, and the classic page one click away
  const home = await fetch(B + '/').then(x => x.text()), classic = await fetch(B + '/classic').then(x => x.text());
  assert.ok(home.includes('pickClassic'), 'the door has the choice'); assert.ok(classic.includes('pm_field_code') && !classic.includes('pickClassic'), 'the classic page is the original');
  console.log('avatar smoke: all good'); process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
