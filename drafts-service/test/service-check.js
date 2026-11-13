'use strict';
// service-check — the drafts service without a model or a database: the query engine on a synthetic snapshot, the field and
// owner API against the scripted model stand-in, and the safety limits (wrong codes, oversized drafts, bad ids, headers).
//   node test/service-check.js            (SERVICE_PORT / MOCK_AI_PORT to run beside another copy)
const os = require('os'), path = require('path'), assert = require('assert');
process.env.PORT = process.env.SERVICE_PORT || '8797';
process.env.HOST = '127.0.0.1';
process.env.OWNER_TOKEN = 'check-owner-token';
process.env.FIELD_CODES = 'عز:1234,أحمد:5678';
process.env.FIELD_SCOPES = 'أحمد:deals+money';
process.env.MAX_AUTH_FAILS = '6';
process.env.DATA_FILE = path.join(os.tmpdir(), `pm-service-check-${process.pid}.json`);
process.env.GEMINI_API_KEY = 'mock'; process.env.GEMINI_BASE = 'http://127.0.0.1:' + (process.env.MOCK_AI_PORT || '8793');
delete process.env.DATABASE_URL;
require('./mock-gemini.js');
require('../server.js');
const Q = require('../query-engine');

const B = 'http://127.0.0.1:' + process.env.PORT, OWNER = { Authorization: 'Bearer check-owner-token' }, EZZ = { 'X-Field-Code': '1234' }, AHMED = { 'X-Field-Code': '5678' };
const call = async (p, body, headers, method) => {
  const r = await fetch(B + p, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; }
  return { s: r.status, j, h: r.headers };
};
let ok = 0; const fails = [];
const check = (name, cond, detail) => { if (cond) { ok++; console.log('  ok  ', name); } else { fails.push(name); console.log('  FAIL', name, detail === undefined ? '' : JSON.stringify(detail)); } };

const snap = {
  deals: [{ kind: 'sale', date: '2026-10-24', party: 'مصنع الأمل للعبوات', material: 'HDPE', qty: 3000, net: 153000 }],
  money: [], expenses: [], inventory: [{ material: 'HDPE', stock: 1200, unit: 'كيلوجرام' }],
  balances: {
    customers: [{ name: 'ورشة أولاد رزق', balance: 117000, oldest: '2026-08-03', overdue: 56000, terms: 30 },
                { name: 'مصنع الأمل للعبوات', balance: 111500, oldest: '2026-09-24', overdue: 39500, terms: 30 },
                { name: 'مصنع البركة للأكياس', balance: 109150, oldest: '2026-11-01', overdue: 0, terms: 30 }],
    suppliers: [{ name: 'وليد أبو زهرة', balance: 90000, oldest: '2026-09-02', overdue: 90000, terms: 30 },
                { name: 'مصنع النور للبلاستيك', balance: -2500, linked: 'مصنع النور للبلاستيك' }],
  },
};

(async () => {
  await new Promise(r => setTimeout(r, 1200));
  const all = new Set(Q.SCOPES);
  console.log('query engine');
  let r = Q.runQuery({ entity: 'balances', overdueOnly: true, balanceSide: 'customers', today: '2026-11-11' }, snap, all);
  check('who is late: only balances past their credit days, largest first', r.count === 2 && r.rows[0].party === 'ورشة أولاد رزق' && r.rows[0].days === 100 && r.totalOverdue === 95500, r);
  check('the answer quotes the overdue amounts and the age with the weekday', /متأخرين بإجمالي 95,500/.test(Q.fallbackAnswer(r, '')) && /الاتنين 3\/8، من 100 يوم/.test(Q.fallbackAnswer(r, '')), Q.fallbackAnswer(r, ''));
  r = Q.runQuery({ entity: 'balances', overdueOnly: true, balanceSide: 'suppliers', today: '2026-11-11' }, snap, all);
  check('who we are late with: the suppliers side', r.count === 1 && r.rows[0].overdue === 90000 && r.rows[0].days === 70, r);
  r = Q.runQuery({ entity: 'balances', overdueOnly: true }, { ...snap, balances: { customers: [{ name: 'x', balance: 5 }], suppliers: [] } }, all);
  check('an older snapshot without ages says so instead of "nobody is late"', /أعمار الديون/.test(Q.fallbackAnswer(r, '')), Q.fallbackAnswer(r, ''));
  check('who is late needs the money scope', Q.runQuery({ entity: 'balances', overdueOnly: true }, snap, new Set(['deals'])).denied === true);
  r = Q.runQuery({ entity: 'balances', party: 'مصنع النور' }, snap, all);
  check('a supplier we overpaid now owes us: the wording says so', /لينا عنده 2,500/.test(Q.fallbackAnswer(r, '')), Q.fallbackAnswer(r, ''));
  r = Q.runQuery({ entity: 'balances', party: 'ورشة' }, snap, all);
  check('a plain balance question still answers as before', /ورشة أولاد رزق: عليه 117,000/.test(Q.fallbackAnswer(r, '')), Q.fallbackAnswer(r, ''));

  console.log('API');
  r = await call('/api/health');
  check('health: file store, mock model on', r.s === 200 && r.j.store === 'file' && r.j.ai === true, r.j);
  check('security headers are sent', r.h.get('x-content-type-options') === 'nosniff' && r.h.get('referrer-policy') === 'no-referrer' && !r.h.get('x-powered-by'));
  check('owner endpoints need the token', (await call('/api/owner/drafts')).s === 401);
  r = await call('/api/owner/snapshot', snap, OWNER, 'PUT');
  check('the office uploads a snapshot with ages', r.s === 200 && r.j.deals === 1, r.j);
  r = await call('/api/field/converse', { text: 'مين متأخر في السداد؟' }, EZZ);
  check('the field asks "who is late?" and gets the computed list', r.s === 200 && r.j.query && r.j.query.result.overdueOnly && r.j.query.result.count === 2 && /95,500/.test(r.j.answer), r.j);
  r = await call('/api/field/converse', { text: 'مين متأخر من الموردين؟' }, AHMED);
  check('a person with the money scope can ask about the suppliers side', r.s === 200 && r.j.query.result.count === 1, r.j);
  r = await call('/api/field/converse', { text: 'x'.repeat(50000) }, EZZ);
  check('a 50,000-character message is cut, not refused or sent whole', r.s === 200 && r.j.transcript.length <= 4000, r.j.transcript && r.j.transcript.length);
  r = await call('/api/field/drafts', { type: 'expense', fields: { amount: 100, desc: 'y'.repeat(30000) } }, EZZ);
  check('an oversized draft is refused (413)', r.s === 413, r);
  r = await call('/api/field/drafts', { type: 'expense', fields: [1, 2] }, EZZ);
  check('a draft whose fields are a list is refused', r.s === 400, r);
  r = await call('/api/field/drafts', { type: 'expense', fields: { cat: 'نقل', amount: 350, desc: 'توكتوك' } }, EZZ);
  check('a normal draft is filed', r.s === 201 && r.j.id > 0, r);
  r = await call('/api/owner/drafts/abc', { status: 'approved' }, OWNER, 'PATCH');
  check('a draft id that is not a number is a 404, not a server error', r.s === 404, r);
  r = await call('/api/owner/drafts/abc/audio', undefined, OWNER);
  check('the same for the recording', r.s === 404, r);
  r = await call('/api/owner/drafts?status=pending', undefined, OWNER);
  check('the owner sees the filed draft', r.s === 200 && r.j.length === 1 && r.j[0].submittedBy === 'عز');

  console.log('wrong codes');
  let codes = [];                                      // MAX_AUTH_FAILS=6 and the owner check above already spent one
  for (let i = 0; i < 6; i++) codes.push((await call('/api/field/reference', undefined, { 'X-Field-Code': String(1000 + i) })).s);
  check('wrong field codes on a data endpoint are refused, then the address is locked', codes.join() === '401,401,401,401,401,429', codes);
  r = await call('/api/field/reference', undefined, { 'X-Field-Code': '1234' });
  check('after too many wrong codes even the right one waits (429): codes cannot be guessed through any endpoint', r.s === 429, r);
  r = await call('/api/field/login', { code: '1234' });
  check('the login is locked too', r.s === 429, r);
  r = await call('/api/owner/drafts', undefined, OWNER);
  check('and the owner endpoints from the same address', r.s === 429, r);

  console.log(`\nservice-check: ${ok} passed, ${fails.length} failed`);
  fails.forEach(f => console.log('   -', f));
  try { require('fs').unlinkSync(process.env.DATA_FILE); } catch (e) {}
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
