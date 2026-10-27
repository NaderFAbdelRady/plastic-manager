'use strict';
// Query engine over the field snapshot. The model only turns a spoken question into a structured query;
// every number in an answer is computed here, from the snapshot, never by the model.

const SCOPES = ['deals', 'money', 'expenses', 'inventory', 'finance'];
// A person who is not configured gets everything EXCEPT finance (cash, profit, partners): that has to be granted on purpose.
const DEFAULT_SCOPES = ['deals', 'money', 'expenses', 'inventory'];
const ENTITY_SCOPE = { deals: 'deals', money: 'money', balances: 'money', expenses: 'expenses', inventory: 'inventory', finance: 'finance' };

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
const scopeFor = (scopes, name) => scopes[name] || new Set(DEFAULT_SCOPES);

// '2026-10-24' -> 'السبت 24/10': a date that is read out or shown always carries its weekday (Friday and Saturday are different days).
const WEEKDAYS = ['الأحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'];
function dayLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  return `${WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]} ${+m[3]}/${+m[2]}`;
}

const KIND_AR = { purchase: 'شراء', sale: 'بيع', collection: 'تحصيل', supplierPay: 'دفعة لمورد', expense: 'مصروف' };

function rowsFor(entity, snap, allowed) {
  const out = [];
  const add = (scope, arr, map) => { if (allowed.has(scope)) (arr || []).forEach(r => out.push(map(r))); };
  const deal = r => ({ date: r.date, day: dayLabel(r.date), kind: r.kind, party: r.party, material: r.material, qty: r.qty, unit: r.unit, price: r.price, amount: r.net, paid: r.paid, remaining: r.remaining, text: r.text || '' });
  const money = r => ({ date: r.date, day: dayLabel(r.date), kind: r.kind, party: r.party, amount: r.amount, text: r.note || '' });
  const exp = r => ({ date: r.date, day: dayLabel(r.date), kind: 'expense', party: '', material: '', amount: r.amount, text: [r.cat, r.desc].filter(Boolean).join(' · ') });
  if (entity === 'deals' || entity === 'all') add('deals', snap.deals, deal);
  if (entity === 'money' || entity === 'all') add('money', snap.money, money);
  if (entity === 'expenses' || entity === 'all') add('expenses', snap.expenses, exp);
  return out;
}

function runQuery(q, snap, allowed) {
  q = q || {};
  snap = snap || {};
  const entity = ['deals', 'money', 'expenses', 'balances', 'inventory', 'finance', 'all'].includes(q.entity) ? q.entity : 'all';
  const need = ENTITY_SCOPE[entity];
  if (need && !allowed.has(need)) return { denied: true, entity };

  if (entity === 'finance') return runFinance(q, snap.finance);
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

// Finance answers come from the block the owner's app computed with its own accounting (cash, P&L, partners).
const r2 = n => Math.round((+n || 0) * 100) / 100;
function runFinance(q, f) {
  if (!f) return { entity: 'finance', noFinance: true };
  const topic = ['cash', 'profit', 'balance_sheet', 'distribution', 'partners', 'pl', 'closings'].includes(q.topic) ? q.topic : 'balance_sheet';
  const c = f.cash || {}, p = f.profit || {}, partners = f.partners || [];
  const base = { entity: 'finance', topic };
  if (topic === 'cash') return { ...base, count: 1, data: { cash: c.balance, ...(c.components || {}) } };
  if (topic === 'profit') return { ...base, count: 1, data: { ...p } };
  if (topic === 'balance_sheet') return { ...base, count: 1, data: { cash: c.balance, receivable: f.receivable, inventoryValue: f.inventoryValue, payable: f.payable, partnerLoans: f.partnerLoans, capital: f.capital, equity: f.equity } };
  if (topic === 'partners') return { ...base, count: partners.length, rows: partners };
  if (topic === 'closings') return { ...base, count: (f.closings || []).length, rows: (f.closings || []).slice(-12).reverse() };
  if (topic === 'pl') {
    const lo = isoDate(q.from) ? q.from.slice(0, 7) : null, hi = isoDate(q.to) ? q.to.slice(0, 7) : null;
    const rows = (f.pl || []).filter(m => (!lo || m.month >= lo) && (!hi || m.month <= hi));
    const t = rows.reduce((a, m) => ({ revenue: a.revenue + m.revenue, cogs: a.cogs + m.cogs, gross: a.gross + m.gross, expenses: a.expenses + m.expenses, net: a.net + m.net }), { revenue: 0, cogs: 0, gross: 0, expenses: 0, net: 0 });
    Object.keys(t).forEach(k => t[k] = r2(t[k]));
    return { ...base, count: rows.length, rows, data: t };
  }
  // distribution: what each partner would get if `amount` were distributed now (draws are absorbed first, like the app does)
  const amount = hasNum(q.amount) ? +q.amount : (p.availableProfit || 0);
  const totalPct = partners.reduce((a, x) => a + (+x.sharePct || 0), 0) || 1;
  const rows = partners.map(x => {
    const gross = r2(amount * (+x.sharePct || 0) / totalPct), absorbed = r2(Math.min(+x.draws || 0, gross));
    return { party: x.name, sharePct: x.sharePct, gross, draws: r2(x.draws), absorbed, net: r2(gross - absorbed), draws_left: r2((+x.draws || 0) - absorbed) };
  });
  const cashPaid = r2(rows.reduce((a, x) => a + x.net, 0)), cashAfter = r2((c.balance || 0) - cashPaid);
  return { ...base, count: rows.length, rows, data: { requested: r2(amount), availableProfit: p.availableProfit, cashBefore: c.balance, cashPaidOut: cashPaid, cashAfter, enoughProfit: amount <= (p.availableProfit || 0) + 0.5, cashStaysPositive: cashAfter >= 0 } };
}

const fmtN = n => Math.round(+n || 0).toLocaleString('en-US');
function fallbackAnswer(res, asOf) {
  const when = asOf ? ` (حسب آخر تحديث من المكتب: ${asOf})` : '';
  if (res.denied) return 'مش مسموح لك تشوف النوع ده من البيانات.';
  if (res.entity === 'finance') return financeAnswer(res, when);
  if (res.entity === 'inventory') return res.rows.length ? res.rows.slice(0, 6).map(r => `${r.material}: ${fmtN(r.stock)} ${r.unit || 'كجم'}`).join('، ') + when : 'مفيش مخزون بالاسم ده' + when;
  if (res.entity === 'balances') return res.rows.length ? res.rows.slice(0, 6).map(r => `${r.party}: ${balPhrase(r)}`).join('، ') + when : 'مفيش رصيد مطابق' + when;
  if (!res.count) return 'مفيش حركات مطابقة للسؤال ده' + when;
  if (res.aggregate === 'sum' || res.aggregate === 'count') return `${res.count} حركة، إجمالي ${fmtN(res.totalAmount)} جنيه${res.totalQty ? ` وإجمالي كمية ${fmtN(res.totalQty)}` : ''}${when}`;
  if (res.groups) return res.groups.slice(0, 5).map(g => `${g.key}: ${fmtN(g.amount)} جنيه (${g.count})`).join('، ') + when;
  const line = r => `${r.day || r.date} ${r.kindAr || r.kind}${r.party ? ' ' + r.party : ''}${r.material ? ' ' + r.material + (r.qty ? ' ' + fmtN(r.qty) : '') : ''} ${fmtN(r.amount)} جنيه`;
  const nTx = res.count === 1 ? 'حركة' : res.count === 2 ? 'حركتين' : res.count <= 10 ? `${res.count} حركات` : `${res.count} حركة`;
  return `لقيت ${nTx}، أحدثهم: ${res.rows.slice(0, 3).map(line).join('، ')}${when}`;
}
function financeAnswer(res, when) {
  if (res.noFinance) return 'المكتب لسه ما رفعش الماليات للميدان.' + when;
  const d = res.data || {};
  if (res.topic === 'cash') return `الخزنة دلوقتي ${fmtN(d.cash)} جنيه.` + when;
  if (res.topic === 'profit') return `صافي الربح ${fmtN(d.netProfit)}، اتوزع منه ${fmtN(d.distributed)}، والمتاح للتوزيع ${fmtN(d.availableProfit)} جنيه.` + when;
  if (res.topic === 'balance_sheet') return `الخزنة ${fmtN(d.cash)}، عند العملاء ${fmtN(d.receivable)}، المخزون ${fmtN(d.inventoryValue)}، علينا للموردين ${fmtN(d.payable)}، وحقوق الملكية ${fmtN(d.equity)} جنيه.` + when;
  if (res.topic === 'partners') return (res.rows || []).map(x => `${x.name} ${x.sharePct}% (سحوبات ${fmtN(x.draws)}${x.loan ? '، تمويل له ' + fmtN(x.loan) : ''})`).join('، ') + when;
  if (res.topic === 'closings') return (res.rows || []).slice(0, 3).map(x => `${x.date}: ربح ${fmtN(x.net)}، خزنة ${fmtN(x.cash)}`).join('، ') + when;
  if (res.topic === 'pl') return `في الفترة دي: مبيعات ${fmtN(d.revenue)}، مصروفات ${fmtN(d.expenses)}، صافي ${fmtN(d.net)} جنيه.` + when;
  return `لو وزعنا ${fmtN(d.requested)}: ` + (res.rows || []).map(x => `${x.party} يستلم ${fmtN(x.net)}${x.absorbed ? ' (بعد خصم سحوبات ' + fmtN(x.absorbed) + ')' : ''}`).join('، ') + `. الخزنة هتبقى ${fmtN(d.cashAfter)}${d.cashStaysPositive ? '' : ' (بالسالب!)'}.` + (d.enoughProfit ? '' : ' والمبلغ أكبر من المتاح للتوزيع.') + when;
}
// balance sign: customers → positive = he owes us; suppliers → positive = we owe him
function balPhrase(r) {
  const v = Math.round(r.balance);
  if (!v) return 'خالص';
  if (r.side === 'customers') return v > 0 ? `عليه ${fmtN(v)}` : `ليه علينا ${fmtN(-v)}`;
  return v > 0 ? `ليه علينا ${fmtN(v)}` : `ليه عندنا مقدم ${fmtN(-v)}`;
}
module.exports = { dayLabel, SCOPES, DEFAULT_SCOPES, parseScopes, scopeFor, runQuery, fallbackAnswer, balPhrase, norm, nameMatch, KIND_AR };
