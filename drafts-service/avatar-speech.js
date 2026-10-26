'use strict';
// What the avatar says and shows for one /api/field/converse result. Every figure comes from the draft the person described or from the
// query engine over the snapshot — never from a model. Dates carry their weekday (a day is read with its weekday: Friday and Saturday are different days).

const Q = require('./query-engine');

const WEEKDAYS = ['الأحد', 'الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت'];      // Date#getUTCDay(): Sunday = 0
const TYPE_LABEL = { purchase: 'شراء', sale: 'بيع', expense: 'مصروف', collection: 'تحصيل', supplierPay: 'دفعة لمورد' };
const fmtN = n => Math.round(+n || 0).toLocaleString('en-US');

// '2026-10-24' -> 'السبت 24/10'
function dayLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${WEEKDAYS[d.getUTCDay()]} ${+m[3]}/${+m[2]}`;
}

// Spoken text: no emoji, bullets or line breaks.
const plain = t => String(t || '').replace(/[☀-➿\u{1f300}-\u{1faff}⭐️]/gu, '').replace(/\s*\n+\s*/g, '. ').replace(/•/g, '').replace(/\s+/g, ' ').trim();

// One line that describes a draft, in the words of the person who dictated it.
function describeRecord(rec) {
  const f = rec.fields || {}, bits = [TYPE_LABEL[rec.type] || rec.type];
  if (f.date) bits.push(dayLabel(f.date));
  if (f.party) bits.push((rec.type === 'purchase' || rec.type === 'collection' ? 'من ' : 'لـ') + f.party);        // bought from / collected from; sold to / paid to
  if (rec.type === 'purchase' || rec.type === 'sale') {
    if (f.material) bits.push(`${f.material}${f.qty ? ' ' + fmtN(f.qty) + ' ' + (f.unit || 'كيلو') : ''}`);
    if (f.price) bits.push(`بسعر ${fmtN(f.price)}`);
    if (f.qty && f.price) bits.push(`إجمالي ${fmtN(f.qty * f.price)}`);
    if (f.paid) bits.push(`مدفوع ${fmtN(f.paid)}`);
  } else {
    if (f.amount) bits.push(`${fmtN(f.amount)} جنيه`);
    if (f.cat) bits.push(f.cat);
    if (f.desc || f.note) bits.push(f.desc || f.note);
  }
  return bits.join('، ');
}

// The sentence to say for this result. `hadPending`: a draft was waiting when the person spoke.
function speechFor(out, hadPending) {
  const parts = [];
  if (out.kind === 'confirm') return hadPending ? '' : 'مفيش حركة معلّقة أبعتها. قولّي إيه اللي حصل.';
  if (out.kind === 'cancel') return 'تمام، لغيتها. قولّي من الأول.';
  const rec = out.record;
  if (rec) {
    if (rec.question) parts.push(rec.question);
    else parts.push(`هسجّل: ${describeRecord(rec)}. أبعتها للمراجعة؟`);
  }
  if (out.answer) parts.push(out.answer);
  if (out.board) parts.push('وده الجدول قدامك على الشاشة.');
  if (out.kind === 'chat' && out.reply) parts.push(out.reply);
  if (out.kind === 'clarify' && !parts.length) parts.push(out.question || 'ممكن توضّح أكتر؟');
  return plain(parts.join(' ')) || 'ممكن تعيد تاني؟';
}

// ── tables for the avatar's screen ──
const cell = v => ({ v: v == null || v === '' ? '—' : v, src: 'calc' });
const text = v => ({ v: v == null || v === '' ? '—' : String(v) });
const MAX_ROWS = 58;                                                              // the avatar's page holds 60 rows per table
const balText = x => { const v = Math.round(x.balance); if (!v) return 'خالص'; return Q.balPhrase(x); };
const FINANCE_LABEL = { cash: 'الخزنة', cashIn: 'مقبوض من البيع', collections: 'تحصيلات', boughtCash: 'مشتريات كاش', paidToSuppliers: 'دفعات موردين', expenses: 'مصروفات',
  partnerDraws: 'سحوبات شركاء', netProfit: 'صافي الربح', totalRevenue: 'المبيعات', cogs: 'تكلفة البضاعة', gross: 'مجمل الربح', distributed: 'اتوزع', availableProfit: 'المتاح للتوزيع',
  receivable: 'عند العملاء', inventoryValue: 'قيمة المخزون', payable: 'علينا للموردين', requested: 'المبلغ المطلوب توزيعه', cashBefore: 'الخزنة قبل', cashPaidOut: 'هيخرج كاش', cashAfter: 'الخزنة بعد' };

// A table block (the avatar's contract: columns, rows of {v, src}, total_row) for what the query returned, or null when one figure says it all.
function tableFor(res, id = 't', label = '') {
  if (!res || res.denied || res.noSnapshot || res.noFinance) return null;
  const tbl = (_id, title, columns, rows, note) => rows.length ? { type: 'table', id, title: label || title, columns, rows: rows.slice(0, MAX_ROWS), total_row: false, note: note || (rows.length > MAX_ROWS ? `أول ${MAX_ROWS} صف` : '') } : null;
  if (res.entity === 'finance') {
    if (res.topic === 'partners') return tbl('t', 'الشركاء', ['الشريك', 'النسبة', 'سحوبات', 'تمويل له'], (res.rows || []).map(x => [text(x.name), text(x.sharePct + '%'), cell(Math.round(x.draws)), cell(Math.round(x.loan))]));
    if (res.topic === 'closings') return tbl('t', 'التقفيلات', ['التقفيل', 'الربح', 'الخزنة'], (res.rows || []).map(x => [text(dayLabel(x.date)), cell(Math.round(x.net)), cell(Math.round(x.cash))]));
    if (res.topic === 'pl') return tbl('t', 'الأرباح والخسائر بالشهر', ['الشهر', 'مبيعات', 'مصروفات', 'صافي'], (res.rows || []).map(x => [text(x.month), cell(Math.round(x.revenue)), cell(Math.round(x.expenses)), cell(Math.round(x.net))]));
    if (res.topic === 'distribution') {
      const rows = (res.rows || []).map(x => [text(x.party), cell(Math.round(x.gross)), cell(Math.round(x.absorbed)), cell(Math.round(x.net))]);
      return tbl('t', 'لو وزعنا', ['الشريك', 'نصيبه', 'سحوبات مخصومة', 'يستلم'], rows);
    }
    const rows = Object.entries(res.data || {}).filter(([k, v]) => typeof v === 'number' && FINANCE_LABEL[k] !== undefined).map(([k, v]) => [text(FINANCE_LABEL[k]), cell(Math.round(v))]);
    return rows.length > 1 ? tbl('t', 'الماليات', ['البند', 'المبلغ'], rows) : null;
  }
  if (res.entity === 'balances') return (res.rows || []).length > 1 ? tbl('t', 'الأرصدة', ['الاسم', 'النوع', 'الرصيد'], res.rows.map(x => [text(x.party), text(x.side === 'customers' ? 'عميل' : 'مورد'), text(balText(x))])) : null;
  if (res.entity === 'inventory') return (res.rows || []).length > 1 ? tbl('t', 'المخزون', ['الخامة', 'المخزون'], res.rows.map(x => [text(x.material), text(`${fmtN(x.stock)} ${x.unit || 'كجم'}`)])) : null;
  if (res.groups && res.groups.length) {
    const first = res.aggregate === 'group_day' ? 'اليوم' : res.aggregate === 'group_material' ? 'الخامة' : 'الطرف';
    return tbl('t', 'الإجمالي', [first, 'الإجمالي', 'العدد'], res.groups.map(g => [text(res.aggregate === 'group_day' ? dayLabel(g.key) : g.key), cell(Math.round(g.amount)), cell(g.count)]));
  }
  if (res.rows && res.rows.length > 1) {
    return tbl('t', 'الحركات', ['اليوم', 'النوع', 'الطرف', 'التفاصيل', 'المبلغ'], res.rows.map(x => [text(dayLabel(x.date)), text(x.kindAr || x.kind), text(x.party),
      text(x.material ? `${x.material}${x.qty ? ' ' + fmtN(x.qty) : ''}` : (x.desc || x.note || '')), cell(Math.round(x.amount))]));
  }
  return null;
}

// A board (the avatar's notes pad) holding the table, or null.
function boardFor(out) {
  const qs = out.queries && out.queries.length ? out.queries : (out.query ? [out.query] : []);
  const blocks = qs.map((q, i) => tableFor(q.result, 't' + (i + 1), q.label ? 'آخر ' + q.label : '')).filter(Boolean);
  return blocks.length ? { title: blocks.length > 1 ? 'الإجابة' : blocks[0].title, blocks } : null;
}

module.exports = { dayLabel, describeRecord, speechFor, boardFor, tableFor, plain };
