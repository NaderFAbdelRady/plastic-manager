'use strict';
// Query engine over the field snapshot. The model only turns a spoken question into a structured query;
// every number in an answer is computed here, from the snapshot, never by the model.

const SCOPES = ['deals', 'money', 'expenses', 'inventory'];
const ENTITY_SCOPE = { deals: 'deals', money: 'money', balances: 'money', expenses: 'expenses', inventory: 'inventory' };

const norm = s => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[ً-ْ]/g, '').toLowerCase();
const nameMatch = (name, q) => { const a = norm(name), b = norm(q); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); };
const isoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null;
const hasNum = v => v != null && v !== '' && Number.isFinite(+v);

function parseScopes(s) {
  // "عز:deals+money,أحمد:all" → {عز:Set, أحمد:Set}. A person who is not listed gets everything.
  const out = {};
  String(s || '').split(',').map(x => x.trim()).filter(Boolean).forEach(pair => {
    const i = pair.lastIndexOf(':'); if (i <= 0) return;
    const name = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
    out[name] = v === 'all' ? new Set(SCOPES) : new Set(v.split('+').map(x => x.trim()).filter(x => SCOPES.includes(x)));
  });
  return out;
}
const scopeFor = (scopes, name) => scopes[name] || new Set(SCOPES);

const KIND_AR = { purchase: 'شراء', sale: 'بيع', collection: 'تحصيل', supplierPay: 'دفعة لمورد', expense: 'مصروف' };

function rowsFor(entity, snap, allowed) {
  const out = [];
  const add = (scope, arr, map) => { if (allowed.has(scope)) (arr || []).forEach(r => out.push(map(r))); };
  const deal = r => ({ date: r.date, kind: r.kind, party: r.party, material: r.material, qty: r.qty, unit: r.unit, price: r.price, amount: r.net, paid: r.paid, remaining: r.remaining, text: r.text || '' });
  const money = r => ({ date: r.date, kind: r.kind, party: r.party, amount: r.amount, text: r.note || '' });
  const exp = r => ({ date: r.date, kind: 'expense', party: '', material: '', amount: r.amount, text: [r.cat, r.desc].filter(Boolean).join(' · ') });
  if (entity === 'deals' || entity === 'all') add('deals', snap.deals, deal);
  if (entity === 'money' || entity === 'all') add('money', snap.money, money);
  if (entity === 'expenses' || entity === 'all') add('expenses', snap.expenses, exp);
  return out;
}

function runQuery(q, snap, allowed) {
  q = q || {};
  snap = snap || {};
  const entity = ['deals', 'money', 'expenses', 'balances', 'inventory', 'all'].includes(q.entity) ? q.entity : 'all';
  const need = ENTITY_SCOPE[entity];
  if (need && !allowed.has(need)) return { denied: true, entity };

  if (entity === 'inventory') {
    const rows = (snap.inventory || []).filter(r => !q.material || nameMatch(r.material, q.material)).sort((a, b) => b.stock - a.stock);
    return { entity, rows: rows.map(r => ({ material: r.material, stock: r.stock, unit: r.unit })), count: rows.length };
  }
  if (entity === 'balances') {
    const sides = q.balanceSide === 'suppliers' ? ['suppliers'] : q.balanceSide === 'customers' ? ['customers'] : ['customers', 'suppliers'];
    let rows = [];
    sides.forEach(sd => ((snap.balances && snap.balances[sd]) || []).forEach(b => rows.push({ party: b.name, side: sd, balance: b.balance, linked: b.linked || '' })));
    if (q.party) rows = rows.filter(r => nameMatch(r.party, q.party) || nameMatch(r.linked, q.party));
    if (hasNum(q.minAmount)) rows = rows.filter(r => Math.abs(r.balance) >= +q.minAmount);
    rows = rows.filter(r => Math.abs(r.balance) > 0.5 || q.party);
    rows.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
    const lim = Math.min(Math.max(+q.limit || 15, 1), 40);
    return { entity, rows: rows.slice(0, lim), count: rows.length };
  }

  let rows = rowsFor(entity, snap, allowed);
  const kinds = Array.isArray(q.kinds) ? q.kinds.filter(k => KIND_AR[k]) : [];
  if (kinds.length) rows = rows.filter(r => kinds.includes(r.kind));
  if (q.party) rows = rows.filter(r => nameMatch(r.party, q.party));
  if (q.material) rows = rows.filter(r => nameMatch(r.material, q.material));
  const from = isoDate(q.from), to = isoDate(q.to);
  if (from) rows = rows.filter(r => r.date >= from);
  if (to) rows = rows.filter(r => r.date <= to);
  if (hasNum(q.minAmount)) rows = rows.filter(r => Math.abs(r.amount) >= +q.minAmount);
  if (hasNum(q.maxAmount)) rows = rows.filter(r => Math.abs(r.amount) <= +q.maxAmount);

  const agg = ['list', 'sum', 'count', 'group_party', 'group_day', 'group_material'].includes(q.aggregate) ? q.aggregate : 'list';
  const sum = a => a.reduce((s, r) => s + (+r.amount || 0), 0);
  const qtySum = a => a.reduce((s, r) => s + (+r.qty || 0), 0);
  const base = { entity, count: rows.length, totalAmount: Math.round(sum(rows) * 100) / 100, totalQty: Math.round(qtySum(rows) * 1000) / 1000 };
  if (agg === 'sum' || agg === 'count') return { ...base, rows: [], aggregate: agg };
  if (agg.startsWith('group_')) {
    const key = agg === 'group_party' ? 'party' : agg === 'group_day' ? 'date' : 'material';
    const m = new Map();
    rows.forEach(r => { const k = r[key] || '—'; const g = m.get(k) || { key: k, count: 0, amount: 0, qty: 0 }; g.count++; g.amount += +r.amount || 0; g.qty += +r.qty || 0; m.set(k, g); });
    const groups = [...m.values()].map(g => ({ ...g, amount: Math.round(g.amount * 100) / 100, qty: Math.round(g.qty * 1000) / 1000 })).sort((a, b) => b.amount - a.amount);
    return { ...base, aggregate: agg, groupKey: key, groups: groups.slice(0, 25), rows: [] };
  }
  const dir = q.sort === 'oldest' ? 1 : -1;
  rows.sort((a, b) => q.sort === 'largest' ? Math.abs(b.amount) - Math.abs(a.amount) : String(a.date).localeCompare(String(b.date)) * dir);
  const lim = Math.min(Math.max(+q.limit || 10, 1), 30);
  return { ...base, aggregate: 'list', rows: rows.slice(0, lim).map(r => ({ ...r, kindAr: KIND_AR[r.kind] || r.kind })) };
}

const fmtN = n => Math.round(+n || 0).toLocaleString('en-US');
function fallbackAnswer(res, asOf) {
  const when = asOf ? ` (حسب آخر تحديث من المكتب: ${asOf})` : '';
  if (res.denied) return 'مش مسموح لك تشوف النوع ده من البيانات.';
  if (res.entity === 'inventory') return res.rows.length ? res.rows.slice(0, 6).map(r => `${r.material}: ${fmtN(r.stock)} ${r.unit || 'كجم'}`).join('، ') + when : 'مفيش مخزون بالاسم ده' + when;
  if (res.entity === 'balances') return res.rows.length ? res.rows.slice(0, 6).map(r => `${r.party}: ${balPhrase(r)}`).join('، ') + when : 'مفيش رصيد مطابق' + when;
  if (!res.count) return 'مفيش حركات مطابقة للسؤال ده' + when;
  if (res.aggregate === 'sum' || res.aggregate === 'count') return `${res.count} حركة، إجمالي ${fmtN(res.totalAmount)} جنيه${res.totalQty ? ` وإجمالي كمية ${fmtN(res.totalQty)}` : ''}${when}`;
  if (res.groups) return res.groups.slice(0, 5).map(g => `${g.key}: ${fmtN(g.amount)} جنيه (${g.count})`).join('، ') + when;
  return `لقيت ${res.count} حركة، دي أحدث ${res.rows.length}${when}`;
}
// balance sign: customers → positive = he owes us; suppliers → positive = we owe him
function balPhrase(r) {
  const v = Math.round(r.balance);
  if (!v) return 'خالص';
  if (r.side === 'customers') return v > 0 ? `عليه ${fmtN(v)}` : `ليه علينا ${fmtN(-v)}`;
  return v > 0 ? `ليه علينا ${fmtN(v)}` : `ليه عندنا مقدم ${fmtN(-v)}`;
}
module.exports = { SCOPES, parseScopes, scopeFor, runQuery, fallbackAnswer, balPhrase, norm, nameMatch, KIND_AR };
