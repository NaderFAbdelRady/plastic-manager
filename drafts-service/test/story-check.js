'use strict';
// story-check — does a spoken story come out as the right drafts and answers? Ten scenarios through the avatar's service API against a synthetic office
// (names and numbers below, never the real ledger), with a REAL model. Nothing real is written: it uses a temporary store.
//
//   STORY_KEY=<key> node test/story-check.js                       # Groq: STORY_BASE defaults to https://api.groq.com/openai, STORY_MODEL to openai/gpt-oss-120b
//   AI_PROVIDER=gemini GEMINI_API_KEY=… node test/story-check.js   # or any provider the service itself supports (then leave STORY_KEY unset)
const os = require('os'), path = require('path');
process.env.PORT = process.env.PORT || '8796';
process.env.OWNER_TOKEN = 'story-owner-token';
process.env.FIELD_CODES = 'عز:1234';
process.env.DATA_FILE = path.join(os.tmpdir(), `pm-story-${process.pid}.json`);
process.env.FIELD_SERVICE_KEY = 'k'.repeat(24);
process.env.FIELD_MATRIX_URL = 'https://matrix.example'; process.env.FIELD_MATRIX_PK = 'pk_story'; process.env.FIELD_MATRIX_SECRET = 'sk_story_secret';
if (process.env.STORY_KEY) {                                   // Groq speaks the same dialect as the service's xAI path
  process.env.AI_PROVIDER = 'grok'; process.env.XAI_API_KEY = process.env.STORY_KEY;
  process.env.XAI_BASE = process.env.STORY_BASE || 'https://api.groq.com/openai'; process.env.XAI_MODEL = process.env.STORY_MODEL || 'openai/gpt-oss-120b';
}
require('../server.js');
const Q = require('../query-engine');

const B = `http://127.0.0.1:${process.env.PORT}`, KEY = { 'X-Service-Key': 'k'.repeat(24) }, OWNER = { Authorization: 'Bearer story-owner-token' };
const call = async (p, body, headers, method) => {
  const r = await fetch(B + p, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = { raw: t }; } return { s: r.status, j };
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const iso = n => { const d = new Date(Date.now() - n * 864e5); return d.toISOString().slice(0, 10); };
const lastWeekday = (name, from = 0) => { for (let i = from; i < 14; i++) if (Q.dayLabel(iso(i)).startsWith(name + ' ')) return iso(i); return null; };

const SNAP = {
  deals: [
    { kind: 'sale', date: iso(3), party: 'مصنع فلكس', material: 'مواد مختلطة', qty: 1333, unit: 'كيلوجرام', price: 40, net: 53320, paid: 0, remaining: 53320 },
    { kind: 'sale', date: iso(8), party: 'زكي ميخائيل', material: 'ABS', qty: 300, unit: 'كيلوجرام', price: 23, net: 6900, paid: 1100, remaining: 5800 },
    { kind: 'sale', date: iso(10), party: 'مصنع فلكس', material: 'PP', qty: 500, unit: 'كيلوجرام', price: 30, net: 15000, paid: 15000, remaining: 0 },
    { kind: 'purchase', date: iso(12), party: 'هاني عيسي', material: 'ABS', qty: 2070, unit: 'كيلوجرام', price: 27, net: 55890, paid: 30000, remaining: 25890 },
    { kind: 'purchase', date: iso(15), party: 'جمال أبو الحسن', material: 'PP', qty: 900, unit: 'كيلوجرام', price: 25, net: 22500, paid: 22500, remaining: 0 },
  ],
  money: [{ kind: 'collection', date: iso(5), party: 'زكي ميخائيل', amount: 2000, note: '' }, { kind: 'supplierPay', date: iso(6), party: 'هاني عيسي', amount: 10000, note: '' }],
  expenses: [{ date: iso(2), cat: 'نقل', desc: 'نقل بضاعة', amount: 800 }],
  balances: { customers: [{ name: 'مصنع فلكس', balance: 53320 }, { name: 'زكي ميخائيل', balance: 5800 }], suppliers: [{ name: 'هاني عيسي', balance: 15890 }, { name: 'جمال أبو الحسن', balance: 0 }] },
  inventory: [{ material: 'ABS', stock: 1770, unit: 'كجم' }, { material: 'PP', stock: 400, unit: 'كجم' }, { material: 'مواد مختلطة', stock: 0, unit: 'كجم' }],
};
const REF = { suppliers: ['هاني عيسي', 'جمال أبو الحسن'], customers: ['مصنع فلكس', 'زكي ميخائيل'], materials: ['ABS', 'PP', 'مشمع', 'مواد مختلطة'], expenseCats: ['إيجار', 'نقل', 'عمالة', 'كهرباء ومياه', 'صيانة', 'متفرقات'] };

const types = r => (r.records || []).map(x => x.type).join(',');
const SCENARIOS = [
  { id: 'P1', title: 'one purchase with a cash part', say: 'اشتريت من هاني عيسي ألفين كيلو ABS بسعر ٢٧ ودفعت ٣٠ ألف كاش',
    check: r => r.records.length === 1 && r.records[0].type === 'purchase' && +r.records[0].fields.qty === 2000 && +r.records[0].fields.price === 27 && +r.records[0].fields.paid === 30000 },
  { id: 'P2', title: 'a story: purchase + sale + supplier payment', say: 'النهارده اشتريت من هاني عيسي ألفين كيلو ABS بسعر ٢٧، وبعت لمصنع فلكس ألف كيلو PP بسعر ٤٠، ودفعت لجمال أبو الحسن ٢٠ ألف',
    check: r => ['purchase', 'sale', 'supplierPay'].every(t => types(r).includes(t)) && r.records.length === 3 },
  { id: 'P3', title: 'two purchases, two suppliers, two materials', say: 'اشتريت من هاني عيسي ٥٠٠ كيلو ABS بسعر ٢٧ ومن جمال أبو الحسن ٣٠٠ كيلو PP بسعر ٣٥',
    check: r => r.records.length === 2 && r.records.every(x => x.type === 'purchase') && new Set(r.records.map(x => x.fields.party)).size === 2 },
  { id: 'P4', title: 'three expenses in one breath', say: 'صرفنا النهارده نقل ٥٠٠ وعمالة ٣٠٠ وكهرباء ١٢٠٠',
    check: r => r.records.length === 3 && r.records.every(x => x.type === 'expense') && [500, 300, 1200].every(a => r.records.some(x => +x.fields.amount === a)) },
  { id: 'P5', title: 'a collection and a payment', say: 'قبضت من مصنع فلكس ١٥ ألف ودفعت لهاني عيسي ١٠ آلاف',
    check: r => r.records.length === 2 && types(r).includes('collection') && types(r).includes('supplierPay') },
  { id: 'P6', title: 'a purchase with the shipment cost INSIDE it', say: 'اشتريت من جمال أبو الحسن ٨٠٠ كيلو ABS بسعر ٢٦ ونقل الشحنة ٦٠٠ جنيه',
    check: r => r.records.length === 1 && r.records[0].type === 'purchase' && (r.records[0].fields.txExpenses || []).some(e => +e.amount === 600) },
  { id: 'P7', title: 'last sales AND last purchases', say: 'إيه آخر المبيعات وآخر المشتريات',
    check: r => r.queries && r.queries.length >= 2 && /مبيعات|بيع/.test(r.answer) && /مشتريات|شراء|اشترين/.test(r.answer) },
  { id: 'P8', title: 'two accounts in one sentence', say: 'حساب مصنع فلكس وحساب زكي ميخائيل كام',
    check: r => /فلكس/.test(r.answer) && /زكي/.test(r.answer) },
  { id: 'P9', title: 'a record and a question together', say: 'اشتريت من هاني عيسي ٢٠٠ كيلو ABS بسعر ٢٧ وقولي المخزون كام',
    check: r => (r.records || []).length === 1 && r.records[0].type === 'purchase' && /ABS/.test(r.answer || '') },
  { id: 'P10', title: 'weekdays: "last Thursday" and "Saturday"', say: 'يوم الخميس اللي فات اشتريت من هاني عيسي ٣٠٠ كيلو ABS بسعر ٢٧، ويوم السبت بعت لمصنع فلكس ١٠٠ كيلو PP بسعر ٤٠',
    check: r => { const d = r.records.map(x => x.fields.date), thu = lastWeekday('الخميس'), sat = lastWeekday('السبت'); return r.records.length === 2 && d.includes(thu) && d.includes(sat) && /الخميس \d+\/\d+/.test(r.speech) && /السبت \d+\/\d+/.test(r.speech); } },
];

(async () => {
  await wait(1500);
  await call('/api/owner/reference', REF, OWNER, 'PUT'); await call('/api/owner/snapshot', SNAP, OWNER, 'PUT');
  const only = process.argv.slice(2), results = [];
  for (const sc of SCENARIOS) {
    if (only.length && !only.includes(sc.id)) continue;
    process.stdout.write(`\n${'='.repeat(78)}\n${sc.id} ${sc.title}\n> ${sc.say}\n`);
    let r = await call('/api/service/converse', { person: 'عز', text: sc.say }, KEY);
    if (r.s === 429 || r.s === 502) { await wait(30000); r = await call('/api/service/converse', { person: 'عز', text: sc.say }, KEY); }
    if (r.s !== 200) { console.log('  ERROR', r.s, JSON.stringify(r.j).slice(0, 200)); results.push([sc.id, 'ERROR']); await wait(12000); continue; }
    const j = r.j;
    console.log(`  kind=${j.kind} records=${(j.records || []).length} queries=${(j.queries || (j.query ? [j.query] : [])).length} board=${j.board ? j.board.blocks.length + ' table(s)' : '-'}`);
    (j.records || []).forEach((x, i) => console.log(`   [${i + 1}] ${x.type} ${JSON.stringify(x.fields)}`));
    if (j.answer) console.log('   answer:', j.answer.slice(0, 260));
    console.log('   speech:', (j.speech || '').slice(0, 300));
    let ok = false; try { ok = !!sc.check(j); } catch (e) { ok = false; }
    console.log('  =>', ok ? 'PASS' : 'FAIL'); results.push([sc.id, ok ? 'PASS' : 'FAIL']);
    await wait(12000);
  }
  console.log('\nSUMMARY:', results.map(([i, s]) => `${i} ${s}`).join(' | '));
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
