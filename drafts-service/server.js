'use strict';
// Plastic Manager — drafts service
// ──────────────────────────────────────────────────────────────────────────────
// What this is: a very small web service that (1) serves the field capture page,
// (2) stores transaction DRAFTS captured in the field, and (3) proxies Gemini so the
// API key never reaches a phone. It knows nothing about the ledger: no cash, no
// stock, no customer balances. The owner's local app pulls pending drafts, approves
// them locally, and marks them here. Nothing is ever deleted — status changes only.
//
// Roles (both are just secrets in env vars — no accounts, no sessions):
//   • field user  → header  X-Field-Code: <code>     (FIELD_CODES="عز:1234,أحمد:5678")
//   • owner       → header  Authorization: Bearer <OWNER_TOKEN>
//
// Storage: Postgres when DATABASE_URL is set (Neon / Render), otherwise a JSON file
// (data/drafts.json) so the whole thing runs locally with zero setup.

const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');
const Q       = require('./query-engine');

const PORT              = +process.env.PORT || 8790;
const OWNER_TOKEN       = process.env.OWNER_TOKEN || '';
const FIELD_CODES       = parseCodes(process.env.FIELD_CODES || '');
const XAI_BASE          = (process.env.XAI_BASE || 'https://api.x.ai').replace(/\/+$/, '');   // override only for local tests
// The model settings can come from environment variables OR be set from the owner's app (stored encrypted in the
// database, which wins). Grok takes text only, so with Grok the capture page transcribes speech in the browser.
const ENV_AI = { provider: process.env.AI_PROVIDER || '', geminiKey: process.env.GEMINI_API_KEY || '', geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
                 xaiKey: process.env.XAI_API_KEY || '', xaiModel: process.env.XAI_MODEL || 'grok-3',
                 claudeKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '', claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
                 claudeBase: process.env.CLAUDE_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com' };
let GEMINI_API_KEY, GEMINI_MODEL, XAI_API_KEY, XAI_MODEL, CLAUDE_API_KEY, CLAUDE_MODEL, CLAUDE_BASE, PROVIDER, AI_ON, AUDIO_INPUT, AI_FROM_APP = false;
function applyAi(db) {
  db = db || {}; AI_FROM_APP = !!(db.provider || db.geminiKey || db.xaiKey || db.claudeKey || db.geminiModel || db.xaiModel || db.claudeModel || db.claudeBase);
  GEMINI_API_KEY = db.geminiKey || ENV_AI.geminiKey; GEMINI_MODEL = db.geminiModel || ENV_AI.geminiModel;
  XAI_API_KEY = db.xaiKey || ENV_AI.xaiKey; XAI_MODEL = db.xaiModel || ENV_AI.xaiModel;
  CLAUDE_API_KEY = db.claudeKey || ENV_AI.claudeKey; CLAUDE_MODEL = db.claudeModel || ENV_AI.claudeModel;
  CLAUDE_BASE = String(db.claudeBase || ENV_AI.claudeBase || 'https://api.anthropic.com').trim().replace(/\/+$/, '');
  const want = String(db.provider || ENV_AI.provider || (CLAUDE_API_KEY && !GEMINI_API_KEY && !XAI_API_KEY ? 'claude' : XAI_API_KEY && !GEMINI_API_KEY ? 'grok' : 'gemini')).toLowerCase();
  PROVIDER = want === 'grok' ? 'grok' : want === 'claude' ? 'claude' : 'gemini';
  AI_ON = PROVIDER === 'grok' ? !!XAI_API_KEY : PROVIDER === 'claude' ? !!CLAUDE_API_KEY : !!GEMINI_API_KEY;
  AUDIO_INPUT = PROVIDER === 'gemini';
}
applyAi();
const GEMINI_BASE       = (process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');   // override only for local tests
const FIELD_SCOPES      = Q.parseScopes(process.env.FIELD_SCOPES || '');   // "عز:deals+money,أحمد:all" — default: everything
const DATABASE_URL      = process.env.DATABASE_URL || '';
const DATA_FILE         = process.env.DATA_FILE || path.join(__dirname, 'data', 'drafts.json');
const MAX_STORED_AUDIO  = 2 * 1024 * 1024;   // bytes of the compressed recording we archive
const MAX_PARSE_AUDIO   = 8 * 1024 * 1024;   // bytes of the WAV sent to Gemini (never stored)
const MAX_AUDIO_SECONDS = 120;

const DRAFT_TYPES = ['purchase', 'sale', 'expense', 'collection', 'supplierPay'];
const EXPENSE_CATS_DEFAULT = ['إيجار', 'نقل', 'عمالة', 'كهرباء ومياه', 'صيانة', 'متفرقات'];

function parseCodes(s) {
  // "name:code,name:code" → {name: code}. Names may contain spaces; codes may not contain ',' or ':'.
  const out = {};
  String(s).split(',').map(x => x.trim()).filter(Boolean).forEach(pair => {
    const i = pair.lastIndexOf(':');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
  return out;
}
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

// ── Storage backends ──────────────────────────────────────────────────────────
const DRAFT_COLS = 'id, created_at, updated_at, submitted_by, source, transcript, type, fields, conversation, audio_mime, audio_seconds, (audio IS NOT NULL) AS has_audio, status, review, final, ledger_id, ledger_list';

class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    const local = /localhost|127\.0\.0\.1/.test(url);
    this.pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS drafts(
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      submitted_by TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'text',
      transcript TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      conversation JSONB NOT NULL DEFAULT '[]'::jsonb,
      audio BYTEA,
      audio_mime TEXT,
      audio_seconds REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      review JSONB,
      final JSONB,
      ledger_id TEXT,
      ledger_list TEXT)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS drafts_status_idx ON drafts(status, created_at DESC)`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS reference(id INT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS query_log(
      id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), asked_by TEXT NOT NULL, intent TEXT, question TEXT,
      query JSONB, answer TEXT, as_of TEXT, denied BOOLEAN NOT NULL DEFAULT false)`);
  }
  // The office snapshot lives in the same table as the name lists, under id 2.
  async getScopes() { const r = await this.pool.query(`SELECT data FROM reference WHERE id = 4`); return r.rows[0] ? r.rows[0].data : null; }
  async setScopes(data) { await this.pool.query(`INSERT INTO reference(id, data, updated_at) VALUES(4, $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [JSON.stringify(data)]); }
  async getAiSettings() { const r = await this.pool.query(`SELECT data FROM reference WHERE id = 3`); return r.rows[0] ? r.rows[0].data : null; }
  async setAiSettings(data) { await this.pool.query(`INSERT INTO reference(id, data, updated_at) VALUES(3, $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [JSON.stringify(data)]); }
  async getSnapshot() {
    const r = await this.pool.query(`SELECT data, updated_at FROM reference WHERE id = 2`);
    return r.rows[0] ? { data: r.rows[0].data, updatedAt: r.rows[0].updated_at } : null;
  }
  async setSnapshot(data) {
    await this.pool.query(`INSERT INTO reference(id, data, updated_at) VALUES(2, $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [JSON.stringify(data)]);
  }
  async logQuery(q) {
    await this.pool.query(`INSERT INTO query_log(asked_by, intent, question, query, answer, as_of, denied) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [q.askedBy, q.intent || null, q.question || '', q.query ? JSON.stringify(q.query) : null, q.answer || '', q.asOf || null, !!q.denied]);
  }
  async listQueries(limit = 100) {
    const r = await this.pool.query(`SELECT id, created_at, asked_by, intent, question, query, answer, as_of, denied FROM query_log ORDER BY created_at DESC LIMIT $1`, [limit]);
    return r.rows.map(x => ({ id: x.id, createdAt: x.created_at, askedBy: x.asked_by, intent: x.intent, question: x.question, query: x.query, answer: x.answer, asOf: x.as_of, denied: x.denied }));
  }
  async insertDraft(d) {
    const r = await this.pool.query(
      `INSERT INTO drafts(submitted_by, source, transcript, type, fields, conversation, audio, audio_mime, audio_seconds)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
      [d.submittedBy, d.source, d.transcript, d.type, JSON.stringify(d.fields), JSON.stringify(d.conversation),
       d.audio ? d.audio : null, d.audioMime || null, d.audioSeconds || null]);
    return { id: r.rows[0].id, createdAt: r.rows[0].created_at };
  }
  async listDrafts({ status, submittedBy, limit = 200 }) {
    const where = [], args = [];
    if (status && status !== 'all') { args.push(status); where.push(`status = $${args.length}`); }
    if (submittedBy) { args.push(submittedBy); where.push(`submitted_by = $${args.length}`); }
    args.push(limit);
    const r = await this.pool.query(`SELECT ${DRAFT_COLS} FROM drafts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${args.length}`, args);
    return r.rows.map(rowToDraft);
  }
  async getAudio(id) {
    const r = await this.pool.query(`SELECT audio, audio_mime FROM drafts WHERE id = $1`, [id]);
    return r.rows[0] && r.rows[0].audio ? { audio: r.rows[0].audio, mime: r.rows[0].audio_mime } : null;
  }
  async updateDraft(id, patch) {
    const r = await this.pool.query(
      `UPDATE drafts SET status = COALESCE($2, status), review = COALESCE($3, review), final = COALESCE($4, final),
         ledger_id = COALESCE($5, ledger_id), ledger_list = COALESCE($6, ledger_list), updated_at = now()
       WHERE id = $1 RETURNING ${DRAFT_COLS}`,
      [id, patch.status || null, patch.review ? JSON.stringify(patch.review) : null, patch.final ? JSON.stringify(patch.final) : null,
       patch.ledgerId != null ? String(patch.ledgerId) : null, patch.ledgerList || null]);
    return r.rows[0] ? rowToDraft(r.rows[0]) : null;
  }
  async getReference() {
    const r = await this.pool.query(`SELECT data, updated_at FROM reference WHERE id = 1`);
    return r.rows[0] ? { ...r.rows[0].data, updatedAt: r.rows[0].updated_at } : null;
  }
  async setReference(data) {
    await this.pool.query(`INSERT INTO reference(id, data, updated_at) VALUES(1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [JSON.stringify(data)]);
  }
}
function rowToDraft(r) {
  return { id: r.id, createdAt: r.created_at, updatedAt: r.updated_at, submittedBy: r.submitted_by, source: r.source,
           transcript: r.transcript, type: r.type, fields: r.fields || {}, conversation: r.conversation || [],
           hasAudio: !!r.has_audio, audioMime: r.audio_mime, audioSeconds: r.audio_seconds,
           status: r.status, review: r.review, final: r.final, ledgerId: r.ledger_id, ledgerList: r.ledger_list };
}

class FileStore {
  // Development / single-machine backend. Same shape as PgStore; audio kept base64 inside the JSON.
  constructor(file) { this.file = file; this.db = { nextId: 1, drafts: [], reference: null }; }
  async init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) { try { this.db = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { /* start fresh */ } }
    this.db.drafts = this.db.drafts || []; this.db.nextId = this.db.nextId || 1;
  }
  _save() { fs.writeFileSync(this.file, JSON.stringify(this.db)); }
  async insertDraft(d) {
    const now = new Date().toISOString();
    const rec = { id: this.db.nextId++, createdAt: now, updatedAt: now, submittedBy: d.submittedBy, source: d.source, transcript: d.transcript,
                  type: d.type, fields: d.fields, conversation: d.conversation, audioB64: d.audio ? d.audio.toString('base64') : null,
                  audioMime: d.audioMime || null, audioSeconds: d.audioSeconds || null, status: 'pending', review: null, final: null, ledgerId: null, ledgerList: null };
    this.db.drafts.push(rec); this._save();
    return { id: rec.id, createdAt: now };
  }
  _pub(r) { const { audioB64, ...rest } = r; return { ...rest, hasAudio: !!audioB64 }; }
  async listDrafts({ status, submittedBy, limit = 200 }) {
    return this.db.drafts.filter(r => (!status || status === 'all' || r.status === status) && (!submittedBy || r.submittedBy === submittedBy))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(r => this._pub(r));
  }
  async getAudio(id) { const r = this.db.drafts.find(x => x.id === id); return r && r.audioB64 ? { audio: Buffer.from(r.audioB64, 'base64'), mime: r.audioMime } : null; }
  async updateDraft(id, patch) {
    const r = this.db.drafts.find(x => x.id === id); if (!r) return null;
    if (patch.status) r.status = patch.status; if (patch.review) r.review = patch.review; if (patch.final) r.final = patch.final;
    if (patch.ledgerId != null) r.ledgerId = String(patch.ledgerId); if (patch.ledgerList) r.ledgerList = patch.ledgerList;
    r.updatedAt = new Date().toISOString(); this._save(); return this._pub(r);
  }
  async getReference() { return this.db.reference; }
  async setReference(data) { this.db.reference = { ...data, updatedAt: new Date().toISOString() }; this._save(); }
  async getScopes() { return this.db.scopes || null; }
  async setScopes(data) { this.db.scopes = data; this._save(); }
  async getAiSettings() { return this.db.aiSettings || null; }
  async setAiSettings(data) { this.db.aiSettings = data; this._save(); }
  async getSnapshot() { return this.db.snapshot || null; }
  async setSnapshot(data) { this.db.snapshot = { data, updatedAt: new Date().toISOString() }; this._save(); }
  async logQuery(q) { (this.db.queries = this.db.queries || []).push({ id: this.db.queries.length + 1, createdAt: new Date().toISOString(), ...q }); this._save(); }
  async listQueries(limit = 100) { return (this.db.queries || []).slice().reverse().slice(0, limit); }
}

// ── Gemini ────────────────────────────────────────────────────────────────────
const PARSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING', description: 'النص المنطوق كما قيل، بدون تعديل' },
    type: { type: 'STRING', enum: DRAFT_TYPES },
    fields: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING' }, party: { type: 'STRING' }, material: { type: 'STRING' }, color: { type: 'STRING' },
        qty: { type: 'NUMBER' }, unit: { type: 'STRING' }, price: { type: 'NUMBER' }, paid: { type: 'NUMBER' },
        amount: { type: 'NUMBER' }, cat: { type: 'STRING' }, desc: { type: 'STRING' }, note: { type: 'STRING' }, location: { type: 'STRING' },
        txExpenses: { type: 'ARRAY', items: { type: 'OBJECT', properties: { desc: { type: 'STRING' }, amount: { type: 'NUMBER' } }, required: ['desc', 'amount'] } },
      },
    },
    missing: { type: 'ARRAY', items: { type: 'STRING' } },
    question: { type: 'STRING', description: 'سؤال واحد قصير بالعامية لو في حاجة ناقصة، وإلا نص فاضي' },
    reply: { type: 'STRING', description: 'جملة واحدة تلخص اللي اتفهم' },
    confidence: { type: 'NUMBER' },
  },
  required: ['transcript', 'type', 'fields', 'missing', 'question', 'reply'],
};

function systemPrompt(ref, fieldName) {
  const today = new Date().toISOString().slice(0, 10);
  const list = (a) => (a && a.length) ? a.join('، ') : '(القائمة فاضية)';
  return `أنت مساعد محاسب لتجارة خامات بلاستيك في مصر. المتحدث اسمه ${fieldName} وبيتكلم عامية مصرية ويوصف حركة واحدة: شراء، بيع، مصروف، تحصيل من عميل، أو دفعة لمورد.
مهمتك: تطلع من كلامه مسودة حركة بصيغة JSON بالضبط حسب المخطط المطلوب. لا تخترع أي رقم أو اسم. لو حاجة مش واضحة اسأل عنها.

التاريخ النهارده: ${today}. لو ما ذكرش تاريخ استخدمه.
أنواع الحركات: purchase (اشترى/جاب بضاعة من مورد)، sale (باع لعميل/مصنع)، expense (مصروف عام: نقل، عمالة، إيجار...)، collection (قبض فلوس من عميل على حسابه)، supplierPay (دفع فلوس لمورد على حسابه).

الأسماء لازم تتطابق مع القوائم دي حرفياً لما تلاقي الاسم أو ما يشبهه:
- الموردون: ${list(ref && ref.suppliers)}
- العملاء: ${list(ref && ref.customers)}
- الخامات: ${list(ref && ref.materials)}
- فئات المصروفات: ${list((ref && ref.expenseCats) || EXPENSE_CATS_DEFAULT)}
لو الاسم مش في القائمة اكتبه زي ما اتقال وحطه في missing واسأل "تقصد مين؟" مع أقرب اسمين من القائمة.

قواعد الأرقام: حوّل الأرقام المنطوقة لأرقام (ألفين وسبعين = 2070، تلاتين ألف = 30000، سبعة وعشرين = 27). الوحدة الافتراضية كيلوجرام، والسعر للكيلو إلا لو قال للطن. qty هي الكمية بالوحدة اللي قالها. paid هو الكاش المدفوع في نفس الحركة؛ لو قال "آجل" أو "على الحساب" فهو 0؛ لو ما ذكرش الدفع خالص اسأل. txExpenses هي مصاريف الصفقة (نقل، عربية، عمال، إكرامية) لو ذكرها. location مكان التخزين لو ذكره.
للمصروف: cat من الفئات، desc البيان، amount المبلغ. للتحصيل والدفعة: party و amount و note.

الحقول الأساسية لكل نوع: purchase/sale: party, material, qty, price, paid. expense: cat, amount. collection/supplierPay: party, amount.
لو في حقل أساسي ناقص: حطه في missing، واكتب في question سؤال واحد قصير بالعامية عن أهم حاجة ناقصة. لو مفيش حاجة ناقصة: question نص فاضي و reply جملة واحدة بتلخص الحركة بالعامية علشان يأكد.
في المحادثة: الرسائل السابقة فيها فهمك القديم وإجابات المتحدث. ارجع المسودة كاملة محدّثة كل مرة، مش الفرق بس. transcript يفضل النص الأصلي الأول اللي اتقال.`;
}

// One call that decides what the person is doing: recording a transaction, asking a question, confirming,
// cancelling, answering a follow-up, or just chatting. Numbers in answers never come from here.
const QUERY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    entity: { type: 'STRING', enum: ['deals', 'money', 'expenses', 'balances', 'inventory', 'finance', 'all'] },
    topic: { type: 'STRING', enum: ['cash', 'profit', 'balance_sheet', 'distribution', 'partners', 'pl', 'closings'] },
    amount: { type: 'NUMBER' },
    kinds: { type: 'ARRAY', items: { type: 'STRING', enum: ['purchase', 'sale', 'collection', 'supplierPay', 'expense'] } },
    party: { type: 'STRING' }, material: { type: 'STRING' }, from: { type: 'STRING' }, to: { type: 'STRING' },
    minAmount: { type: 'NUMBER' }, maxAmount: { type: 'NUMBER' },
    aggregate: { type: 'STRING', enum: ['list', 'sum', 'count', 'group_party', 'group_day', 'group_material'] },
    sort: { type: 'STRING', enum: ['newest', 'oldest', 'largest'] },
    limit: { type: 'NUMBER' },
    balanceSide: { type: 'STRING', enum: ['customers', 'suppliers', 'both'] },
  },
};
const CONVERSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING' },
    intent: { type: 'STRING', enum: ['record', 'query', 'both', 'confirm', 'cancel', 'clarify', 'chat'] },
    confidence: { type: 'NUMBER' },
    draft: {
      type: 'OBJECT',
      properties: {
        type: { type: 'STRING', enum: DRAFT_TYPES }, fields: PARSE_SCHEMA.properties.fields,
        missing: { type: 'ARRAY', items: { type: 'STRING' } }, question: { type: 'STRING' }, reply: { type: 'STRING' },
      },
    },
    query: QUERY_SCHEMA,
    question: { type: 'STRING', description: 'سؤال توضيحي واحد قصير' },
    reply: { type: 'STRING', description: 'رد قصير للكلام العادي' },
  },
  required: ['transcript', 'intent'],
};

function conversePrompt({ ref, fieldName, allowed, pending, lastQuery, asOf }) {
  const today = new Date().toISOString().slice(0, 10);
  const list = a => (a && a.length) ? a.join('، ') : '(القائمة فاضية)';
  return `أنت مساعد في مكتب تجارة خامات بلاستيك في مصر. المتحدث ${fieldName} بيفتح الصفحة ويتكلم عامية مصرية، وأنت اللي بتفهم هو عايز إيه من غير ما يقولك:
- record: بيوصف حركة عملها (اشترى، باع، صرف، قبض من عميل، دفع لمورد) → طلّع draft.
- query: بيسأل عن حاجة (حساب فلان، مين باع/اشترى إيه، إيه اللي حصل امبارح، مخزون، آخر حركات، أكبر دين...) → طلّع query منظّم. أنت ما بتجاوبش بنفسك ولا بتحسب أرقام؛ الكود هو اللي بيجاوب.
- both: الاتنين في جملة واحدة.
- confirm: وافق على المسودة المعلّقة (أيوه، تمام، ابعت، ماشي، اعتمد).
- cancel: رفض المسودة المعلّقة أو عايز يبدأ من جديد (لأ، إلغي، سيبك).
- clarify: الكلام ممكن يتفهم بطريقتين (مثلاً "هاني عيسي تلاتين ألف": دفعة ولا بيسأل عن حسابه؟) أو ثقتك فيه واطية → اكتب سؤال واحد قصير في question.
- chat: تحية أو كلام مالوش علاقة → reply قصير ولطيف.
لو جملة فيها سؤال بصيغة "كام/مين/إيه" فهو query. لو فيها فعل ماضي بيصف حاجة حصلت فهو record. السؤال عمره ما يتحول لتسجيل.

التاريخ النهارده: ${today}. "امبارح"، "الأسبوع ده"، "الشهر ده" تتحول لتواريخ from/to بصيغة YYYY-MM-DD.
آخر تحديث للبيانات من المكتب: ${asOf || 'لسه ما اترفعتش بيانات'}.
الأنواع المسموح للمتحدث يسأل عنها: ${[...allowed].join('، ')}.

الأسماء لازم تتطابق مع القوائم حرفياً لما تلاقي الاسم أو ما يشبهه:
- الموردون: ${list(ref && ref.suppliers)}
- العملاء: ${list(ref && ref.customers)}
- الخامات: ${list(ref && ref.materials)}
- فئات المصروفات: ${list((ref && ref.expenseCats) || EXPENSE_CATS_DEFAULT)}

للماليات (لو مسموح): entity=finance مع topic: cash (الخزنة/السيولة)، profit (الأرباح وصافي الربح والمتاح للتوزيع)، balance_sheet (الميزانية: خزنة وذمم ومخزون وحقوق ملكية)، distribution (توزيع الأرباح: لو ذكر مبلغ حطه في amount، وإلا هيتحسب على المتاح للتوزيع)، partners (الشركاء ونسبهم وسحوباتهم وتمويلهم)، pl (الأرباح والخسائر بالشهور، مع from/to)، closings (التقفيلات). 
للـ query: entity = deals للمشتريات والمبيعات، money للتحصيلات ودفعات الموردين، expenses للمصروفات، balances للأرصدة (balanceSide: customers = اللي علينا عندهم، suppliers = اللي لهم علينا)، inventory للمخزون، all لـ"إيه اللي حصل". kinds لو حدد نوع. party/material بالأسماء من القوائم. aggregate: list لقائمة، sum لإجمالي، count لعدد، group_party/group_day/group_material للتجميع. sort: newest افتراضي، largest لـ"أكبر". "حساب فلان" = entity balances و party فلان.
${lastQuery ? `آخر سؤال في المحادثة كان: ${JSON.stringify(lastQuery)} — لو الجملة الحالية متابعة ("وجمال؟" "والشهر اللي قبله؟") عدّل عليه بس.` : ''}
${pending ? `في مسودة حركة معلّقة قدامه دلوقتي: ${JSON.stringify(pending)}. لو بيصلّح فيها ("لأ خليها آجل") رجّع intent=record بالمسودة كاملة محدّثة. لو بيوافق intent=confirm. لو بيرفض intent=cancel.` : 'مفيش مسودة معلّقة: confirm و cancel مالهمش معنى، استخدم clarify أو chat.'}

لـ record: قواعد الأرقام: حوّل الأرقام المنطوقة لأرقام (ألفين وسبعين = 2070، تلاتين ألف = 30000). الوحدة الافتراضية كيلوجرام والسعر للكيلو. paid هو الكاش المدفوع في نفس الحركة؛ "آجل" أو "على الحساب" = 0؛ لو ما ذكرش الدفع اسأل. txExpenses مصاريف الصفقة. الحقول الأساسية: purchase/sale: party, material, qty, price, paid. expense: cat, amount. collection/supplierPay: party, amount. لو في حقل أساسي ناقص حطه في draft.missing واكتب draft.question سؤال واحد بالعامية. لو مفيش ناقص: draft.question نص فاضي و draft.reply جملة بتلخص الحركة علشان يأكد. لا تخترع أرقام أو أسماء.
transcript = النص المنطوق كما قيل بدون تعديل.`;
}

// JSON Schema (lower-case types) from the Gemini-style schema above — Grok gets it as an instruction, not a hard constraint.
const jsonSchemaOf = x => Array.isArray(x) ? x.map(jsonSchemaOf) : (x && typeof x === 'object')
  ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === 'type' && typeof v === 'string' ? v.toLowerCase() : jsonSchemaOf(v)])) : x;
async function grokCall({ system, turns, json, maxTokens = 2048 }) {
  const messages = [{ role: 'system', content: system }, ...turns.map(t => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: t.text }))];
  const body = { model: XAI_MODEL, messages, temperature: 0.2, max_tokens: maxTokens, ...(json ? { response_format: { type: 'json_object' } } : {}) };
  const r = await fetch(`${XAI_BASE}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + XAI_API_KEY }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || (j.code ? String(j.code) : `Grok HTTP ${r.status}`));
  return String(((((j.choices || [])[0] || {}).message || {}).content) || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
}
// Anthropic Messages API (also works behind a gateway: both x-api-key and Authorization are sent).
async function claudeCall({ system, turns, maxTokens = 2048 }) {
  const msgs = [];
  for (const t of turns) {   // the API wants strictly alternating roles, starting with the user
    const role = t.role === 'assistant' ? 'assistant' : 'user';
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += '\n' + t.text; else msgs.push({ role, content: t.text });
  }
  if (!msgs.length || msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: '.' });
  const r = await fetch(`${CLAUDE_BASE}/v1/messages`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, Authorization: 'Bearer ' + CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages: msgs }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || j.message || `Claude HTTP ${r.status}`);
  return String((j.content || []).filter(b => b.type === 'text').map(b => b.text).join('')).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
}
const textCall = args => PROVIDER === 'claude' ? claudeCall(args) : grokCall(args);
const modelName = () => PROVIDER === 'claude' ? CLAUDE_MODEL : PROVIDER === 'grok' ? XAI_MODEL : GEMINI_MODEL;
const providerLabel = () => PROVIDER === 'claude' ? 'Claude' : PROVIDER === 'grok' ? 'Grok' : 'Gemini';
async function geminiConverse({ text, audio, mime, conversation, ctx }) {
  const turns = (conversation || []).slice(-12).map(m => ({ role: m.role, text: String(m.text || '').trim() })).filter(t => t.text);
  let raw;
  if (PROVIDER !== 'gemini') {
    if (audio) { const e = new Error('نظام الفهم اتغيّر وبقى بياخد نص بس — جدّدت الصفحة، اضغط الميكروفون وقول تاني'); e.needText = true; throw e; }
    if (!text) throw new Error('مفيش صوت ولا نص');
    const system = conversePrompt(ctx) + '\n\nرجّع JSON فقط (من غير أي كلام تاني) بالشكل ده:\n' + JSON.stringify(jsonSchemaOf(CONVERSE_SCHEMA));
    raw = await textCall({ system, turns: [...turns, { role: 'user', text: String(text) }], json: true });
  } else {
    const contents = turns.map(t => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] }));
    const parts = [];
    if (audio) parts.push({ inlineData: { mimeType: mime || 'audio/wav', data: audio } });
    if (text) parts.push({ text: String(text) });
    if (!parts.length) throw new Error('مفيش صوت ولا نص');
    contents.push({ role: 'user', parts });
    raw = await geminiCall({ systemInstruction: { parts: [{ text: conversePrompt(ctx) }] }, contents,
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: CONVERSE_SCHEMA, maxOutputTokens: 2048 } });
  }
  let out; try { out = JSON.parse(raw); } catch (e) { const m = raw.match(/\{[\s\S]*\}/); try { out = JSON.parse(m && m[0]); } catch (e2) { throw new Error('رد النموذج مش JSON'); } }
  if (!['record', 'query', 'both', 'confirm', 'cancel', 'clarify', 'chat'].includes(out.intent)) out.intent = 'clarify';
  return out;
}
async function geminiCall(body) {
  const url = `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `Gemini HTTP ${r.status}`);
  return ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || '').join('');
}
// Phrase the already-computed result. The model may only restate these numbers; if it fails we use a template.
async function phraseAnswer(question, query, result, asOf) {
  const fallback = Q.fallbackAnswer(result, asOf);
  if (result.denied || !AI_ON) return fallback;
  try {
    const compact = { count: result.count, totalAmount: result.totalAmount, totalQty: result.totalQty, topic: result.topic, data: result.data, rows: (result.rows || []).slice(0, 15), groups: (result.groups || []).slice(0, 10) };
    const sys = 'أنت بترد على موظف ميداني في تجارة بلاستيك بالعامية المصرية في جملتين تلاتة بالكتير. استخدم الأرقام اللي في النتيجة بالحرف ولا تحسب ولا تخمّن أي رقم جديد. لو النتيجة فاضية قول كده. الأرقام بالجنيه. في الآخر اذكر آخر تحديث للبيانات. للأرصدة: customers والرقم موجب = العميل عليه فلوس لنا، suppliers والرقم موجب = إحنا علينا فلوس للمورد، السالب العكس. رد نص عادي من غير markdown.';
    const usr = `السؤال: ${question}\nالاستعلام: ${JSON.stringify(query)}\nالنتيجة: ${JSON.stringify(compact)}\nآخر تحديث: ${asOf || 'غير معروف'}`;
    const txt = PROVIDER !== 'gemini'
      ? await textCall({ system: sys, turns: [{ role: 'user', text: usr }], json: false, maxTokens: 400 })
      : await geminiCall({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: usr }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 400 } });
    const a = String(txt || '').trim();
    return a || fallback;
  } catch (e) { return fallback; }
}

async function geminiParse({ text, audio, mime, conversation, reference, fieldName }) {
  const contents = [];
  for (const m of (conversation || []).slice(-12)) {
    const t = String(m.text || '').trim(); if (!t) continue;
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: t }] });
  }
  const parts = [];
  if (audio) parts.push({ inlineData: { mimeType: mime || 'audio/wav', data: audio } });
  if (text) parts.push({ text: String(text) });
  if (!parts.length) throw new Error('مفيش صوت ولا نص');
  contents.push({ role: 'user', parts });
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt(reference, fieldName) }] },
    contents,
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: PARSE_SCHEMA, maxOutputTokens: 2048 },
  };
  const url = `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `Gemini HTTP ${r.status}`);
  const txt = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || '').join('');
  let out; try { out = JSON.parse(txt); } catch (e) { throw new Error('رد النموذج مش JSON'); }
  if (!DRAFT_TYPES.includes(out.type)) out.type = 'purchase';
  out.fields = (out.fields && typeof out.fields === 'object') ? out.fields : {};
  out.missing = Array.isArray(out.missing) ? out.missing : [];
  out.question = String(out.question || '').trim();
  out.reply = String(out.reply || '').trim();
  out.transcript = String(out.transcript || text || '').trim();
  return out;
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));
app.use((req, res, next) => {
  // Token-based auth, no cookies → a permissive CORS policy is safe and lets the owner's local app call us.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Field-Code');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// tiny in-memory rate limit for the login + AI endpoints (per IP per minute)
const hits = new Map();
function limit(max) {
  return (req, res, next) => {
    const k = `${req.ip}|${req.path}|${Math.floor(Date.now() / 60000)}`;
    const n = (hits.get(k) || 0) + 1; hits.set(k, n);
    if (hits.size > 5000) hits.clear();
    if (n > max) return res.status(429).json({ error: 'محاولات كتير — استنى دقيقة' });
    next();
  };
}
function fieldAuth(req, res, next) {
  const code = req.get('x-field-code') || '';
  const name = Object.keys(FIELD_CODES).find(n => safeEq(FIELD_CODES[n], code));
  if (!name) return res.status(401).json({ error: 'كود الدخول غلط' });
  req.fieldName = name; next();
}
function ownerAuth(req, res, next) {
  const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!OWNER_TOKEN || !safeEq(t, OWNER_TOKEN)) return res.status(401).json({ error: 'رمز المالك غلط' });
  next();
}
const wrap = fn => (req, res) => fn(req, res).catch(e => { if (!e.needText) console.error(e); res.status(e.needText ? 409 : 500).json({ error: e.message || 'خطأ', ...(e.needText ? { needText: true } : {}) }); });
const b64ToBuf = (s, max) => {
  if (!s) return null;
  const buf = Buffer.from(String(s).replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (buf.length > max) throw new Error('التسجيل أكبر من المسموح');
  return buf;
};

let store;
let SCOPES_DB = {};   // {name: [scope,...]} set from the owner's app; wins over the FIELD_SCOPES env var
const scopesOf = name => SCOPES_DB[name] ? new Set(SCOPES_DB[name].filter(x => Q.SCOPES.includes(x))) : Q.scopeFor(FIELD_SCOPES, name);

app.get('/api/health', wrap(async (req, res) => res.json({ ok: true, store: DATABASE_URL ? 'postgres' : 'file', ai: AI_ON, provider: PROVIDER, audioInput: AUDIO_INPUT, fieldUsers: Object.keys(FIELD_CODES).length, snapshot: !!(await store.getSnapshot()) })));

// ── field endpoints ──
const asOfText = rec => rec && rec.updatedAt ? new Date(rec.updatedAt).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' }) : '';
app.post('/api/field/login', limit(20), wrap(async (req, res) => {
  const code = (req.body && req.body.code) || '';
  const name = Object.keys(FIELD_CODES).find(n => safeEq(FIELD_CODES[n], code));
  if (!name) return res.status(401).json({ error: 'كود الدخول غلط' });
  const snap = await store.getSnapshot();
  res.json({ name, ai: AI_ON, audioInput: AUDIO_INPUT, scopes: [...scopesOf(name)], snapshotAt: snap ? snap.updatedAt : null, asOf: asOfText(snap) });
}));
app.get('/api/field/reference', fieldAuth, wrap(async (req, res) => {
  const ref = (await store.getReference()) || { suppliers: [], customers: [], materials: [], expenseCats: EXPENSE_CATS_DEFAULT };
  res.json(ref);
}));
app.post('/api/field/parse', fieldAuth, limit(30), wrap(async (req, res) => {
  if (!AI_ON || PROVIDER !== 'gemini') return res.status(503).json({ error: 'الذكاء الاصطناعي مش متفعّل على الخدمة — املأ الحقول يدوياً' });
  const { text, audio, mime, conversation } = req.body || {};
  const audioB64 = audio ? b64ToBuf(audio, MAX_PARSE_AUDIO).toString('base64') : null;
  const reference = await store.getReference();
  const result = await geminiParse({ text, audio: audioB64, mime, conversation, reference, fieldName: req.fieldName });
  res.json({ ok: true, result });
}));
// The single entry point for the capture page: the person just talks; the model decides record / query / confirm / ...
app.post('/api/field/converse', fieldAuth, limit(40), wrap(async (req, res) => {
  if (!AI_ON) return res.status(503).json({ error: 'الذكاء الاصطناعي مش متفعّل على الخدمة' });
  const { text, audio, mime, conversation, pending, lastQuery } = req.body || {};
  const audioB64 = audio ? b64ToBuf(audio, MAX_PARSE_AUDIO).toString('base64') : null;
  const [reference, snapRec] = await Promise.all([store.getReference(), store.getSnapshot()]);
  const allowed = scopesOf(req.fieldName), asOf = asOfText(snapRec);
  const u = await geminiConverse({ text, audio: audioB64, mime, conversation, ctx: { ref: reference, fieldName: req.fieldName, allowed, pending: pending || null, lastQuery: lastQuery || null, asOf } });
  const out = { kind: u.intent, transcript: String(u.transcript || text || '').trim(), confidence: u.confidence };
  if ((u.intent === 'record' || u.intent === 'both') && u.draft && DRAFT_TYPES.includes(u.draft.type)) {
    const d = u.draft;
    out.record = { type: d.type, fields: (d.fields && typeof d.fields === 'object') ? d.fields : {}, missing: Array.isArray(d.missing) ? d.missing : [], question: String(d.question || '').trim(), reply: String(d.reply || '').trim() };
  } else if (u.intent === 'record' || u.intent === 'both') { out.kind = u.intent === 'both' ? 'query' : 'clarify'; out.question = 'مش فاهم الحركة قصدك إيه، ممكن تعيدها؟'; }
  if ((u.intent === 'query' || u.intent === 'both') && u.query) {
    const result = snapRec ? Q.runQuery(u.query, snapRec.data, allowed) : { entity: u.query.entity || 'all', rows: [], count: 0, noSnapshot: true };
    out.query = { structured: u.query, result, asOf };
    out.answer = snapRec ? await phraseAnswer(out.transcript, u.query, result, asOf) : 'لسه المكتب ما رفعش بيانات للميدان.';
    store.logQuery({ askedBy: req.fieldName, intent: u.intent, question: out.transcript, query: u.query, answer: out.answer, asOf, denied: !!result.denied }).catch(e => console.error('log', e.message));
  }
  if (u.intent === 'clarify') out.question = String(u.question || 'ممكن توضّح أكتر؟').trim();
  if (u.intent === 'chat') out.reply = String(u.reply || 'أهلاً! قولّي حركة تسجلها أو اسأل عن أي حاجة.').trim();
  res.json(out);
}));
// Deterministic query (no AI) — used for testing and as a fallback behind the same scope checks.
app.post('/api/field/query', fieldAuth, limit(60), wrap(async (req, res) => {
  const snapRec = await store.getSnapshot();
  if (!snapRec) return res.status(404).json({ error: 'لسه المكتب ما رفعش بيانات للميدان' });
  const allowed = scopesOf(req.fieldName), asOf = asOfText(snapRec);
  const result = Q.runQuery((req.body && req.body.query) || {}, snapRec.data, allowed);
  const answer = Q.fallbackAnswer(result, asOf);
  store.logQuery({ askedBy: req.fieldName, intent: 'query', question: String((req.body && req.body.question) || '(استعلام مباشر)'), query: req.body && req.body.query, answer, asOf, denied: !!result.denied }).catch(() => {});
  res.json({ result, answer, asOf });
}));
app.post('/api/field/drafts', fieldAuth, wrap(async (req, res) => {
  const b = req.body || {};
  if (!DRAFT_TYPES.includes(b.type)) return res.status(400).json({ error: 'نوع الحركة مش معروف' });
  if (!b.fields || typeof b.fields !== 'object') return res.status(400).json({ error: 'الحقول ناقصة' });
  if (b.audioSeconds && b.audioSeconds > MAX_AUDIO_SECONDS + 5) return res.status(400).json({ error: 'التسجيل أطول من المسموح' });
  const audio = b64ToBuf(b.audio, MAX_STORED_AUDIO);
  const out = await store.insertDraft({
    submittedBy: req.fieldName, source: audio ? 'voice' : 'text', transcript: String(b.transcript || '').slice(0, 4000), type: b.type,
    fields: b.fields, conversation: Array.isArray(b.conversation) ? b.conversation.slice(0, 40).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: String(m.text || '').slice(0, 2000) })) : [],
    audio, audioMime: audio ? String(b.mime || 'audio/webm') : null, audioSeconds: audio ? +b.audioSeconds || null : null,
  });
  res.status(201).json(out);
}));
app.get('/api/field/drafts', fieldAuth, wrap(async (req, res) => {
  const rows = await store.listDrafts({ submittedBy: req.fieldName, limit: 30 });
  res.json(rows.map(d => ({ id: d.id, createdAt: d.createdAt, type: d.type, transcript: d.transcript, fields: d.fields, status: d.status, reviewNote: d.review && d.review.note || '' })));
}));

// ── owner endpoints ──
app.get('/api/owner/drafts', ownerAuth, wrap(async (req, res) => {
  const rows = await store.listDrafts({ status: req.query.status || 'pending', limit: Math.min(+req.query.limit || 200, 500) });
  res.json(rows);
}));
app.get('/api/owner/drafts/:id/audio', ownerAuth, wrap(async (req, res) => {
  const a = await store.getAudio(+req.params.id);
  if (!a) return res.status(404).json({ error: 'مفيش تسجيل' });
  res.setHeader('Content-Type', a.mime || 'audio/webm'); res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(a.audio);
}));
app.patch('/api/owner/drafts/:id', ownerAuth, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.status && !['pending', 'approved', 'rejected'].includes(b.status)) return res.status(400).json({ error: 'حالة غير معروفة' });
  const d = await store.updateDraft(+req.params.id, { status: b.status, review: b.review, final: b.final, ledgerId: b.ledgerId, ledgerList: b.ledgerList });
  if (!d) return res.status(404).json({ error: 'المسودة مش موجودة' });
  res.json(d);
}));
// ── AI settings, managed from the owner's app ──
// API keys are encrypted at rest (AES-256-GCM, key derived from OWNER_TOKEN) and never sent back: the app only sees a mask.
const aesKey = () => crypto.createHash('sha256').update('ai-settings|' + OWNER_TOKEN).digest();
const seal = t => { if (!t) return ''; const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', aesKey(), iv); const ct = Buffer.concat([c.update(String(t), 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64'); };
const unseal = b => { try { const raw = Buffer.from(String(b || ''), 'base64'); if (raw.length < 29) return ''; const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), raw.subarray(0, 12)); d.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'); } catch (e) { return ''; } };
const mask = k => k ? (k.length > 10 ? k.slice(0, 3) + '…' + k.slice(-4) : '•••') : '';
async function loadAiFromStore() {
  const st = await store.getAiSettings();
  applyAi(st ? { provider: st.provider, geminiModel: st.geminiModel, xaiModel: st.xaiModel, claudeModel: st.claudeModel, claudeBase: st.claudeBase, geminiKey: unseal(st.geminiKey), xaiKey: unseal(st.xaiKey), claudeKey: unseal(st.claudeKey) } : null);
}
const aiStatus = () => ({ provider: PROVIDER, ai: AI_ON, audioInput: AUDIO_INPUT, fromApp: AI_FROM_APP, geminiModel: GEMINI_MODEL, xaiModel: XAI_MODEL, claudeModel: CLAUDE_MODEL, claudeBase: CLAUDE_BASE,
  geminiKey: mask(GEMINI_API_KEY), xaiKey: mask(XAI_API_KEY), claudeKey: mask(CLAUDE_API_KEY) });
app.get('/api/owner/ai', ownerAuth, wrap(async (req, res) => res.json(aiStatus())));
app.put('/api/owner/ai', ownerAuth, wrap(async (req, res) => {
  const b = req.body || {}, cur = (await store.getAiSettings()) || {};
  const next = { provider: cur.provider || '', geminiModel: cur.geminiModel || '', xaiModel: cur.xaiModel || '', claudeModel: cur.claudeModel || '', claudeBase: cur.claudeBase || '', geminiKey: cur.geminiKey || '', xaiKey: cur.xaiKey || '', claudeKey: cur.claudeKey || '' };
  if (b.provider != null) { if (!['gemini', 'grok', 'claude'].includes(b.provider)) return res.status(400).json({ error: 'المزوّد لازم يكون gemini أو grok أو claude' }); next.provider = b.provider; }
  const model = x => String(x || '').trim().slice(0, 80);
  if (b.geminiModel != null) next.geminiModel = model(b.geminiModel);
  if (b.xaiModel != null) next.xaiModel = model(b.xaiModel);
  if (b.claudeModel != null) next.claudeModel = model(b.claudeModel);
  if (b.claudeBase != null) {
    const u = String(b.claudeBase).trim();
    if (u && !/^https?:\/\/[^\s]+$/i.test(u)) return res.status(400).json({ error: 'الـ Base URL لازم يبدأ بـ https://' });
    next.claudeBase = u;
  }
  if (typeof b.claudeKey === 'string' && b.claudeKey.trim()) next.claudeKey = seal(b.claudeKey.trim());
  if (b.clearClaudeKey) next.claudeKey = '';
  if (typeof b.geminiKey === 'string' && b.geminiKey.trim()) next.geminiKey = seal(b.geminiKey.trim());
  if (typeof b.xaiKey === 'string' && b.xaiKey.trim()) next.xaiKey = seal(b.xaiKey.trim());
  if (b.clearGeminiKey) next.geminiKey = ''; if (b.clearXaiKey) next.xaiKey = '';
  await store.setAiSettings(next); await loadAiFromStore();
  res.json(aiStatus());
}));
app.post('/api/owner/ai/test', ownerAuth, wrap(async (req, res) => {
  if (!AI_ON) return res.json({ ok: false, provider: PROVIDER, error: `مفيش مفتاح لـ ${providerLabel()}` });
  const t0 = Date.now();
  try {
    const reply = PROVIDER !== 'gemini'
      ? await textCall({ system: 'رد بكلمة واحدة بس.', turns: [{ role: 'user', text: 'قول: جاهز' }], json: false, maxTokens: 20 })
      : await geminiCall({ contents: [{ role: 'user', parts: [{ text: 'رد بكلمة واحدة بس: جاهز' }] }], generationConfig: { maxOutputTokens: 20 } });
    res.json({ ok: true, provider: PROVIDER, model: modelName(), ms: Date.now() - t0, reply: String(reply).slice(0, 80) });
  } catch (e) { res.json({ ok: false, provider: PROVIDER, model: modelName(), error: String(e.message || e).slice(0, 240) }); }
}));
app.put('/api/owner/snapshot', ownerAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const arr = x => Array.isArray(x) ? x.filter(r => r && typeof r === 'object').slice(0, 20000) : [];
  const bal = b.balances && typeof b.balances === 'object' ? b.balances : {};
  const data = { deals: arr(b.deals), money: arr(b.money), expenses: arr(b.expenses), inventory: arr(b.inventory), balances: { customers: arr(bal.customers), suppliers: arr(bal.suppliers) } };
  if (b.finance && typeof b.finance === 'object') {   // optional: only present when the owner chose to share the finances
    const f = b.finance, n = v => Number.isFinite(+v) ? Math.round(+v * 100) / 100 : 0, obj = o => (o && typeof o === 'object') ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, n(v)])) : {};
    data.finance = { cash: { balance: n(f.cash && f.cash.balance), components: obj(f.cash && f.cash.components) }, profit: obj(f.profit),
      receivable: n(f.receivable), payable: n(f.payable), inventoryValue: n(f.inventoryValue), partnerLoans: n(f.partnerLoans), capital: n(f.capital), equity: n(f.equity),
      partners: arr(f.partners).map(x => ({ name: String(x.name || ''), sharePct: n(x.sharePct), draws: n(x.draws), loan: n(x.loan) })),
      pl: arr(f.pl).map(m => ({ month: String(m.month || ''), revenue: n(m.revenue), cogs: n(m.cogs), gross: n(m.gross), expenses: n(m.expenses), net: n(m.net) })),
      closings: arr(f.closings).map(c => ({ date: String(c.date || ''), net: n(c.net), cash: n(c.cash) })) };
  }
  await store.setSnapshot(data);
  res.json({ ok: true, deals: data.deals.length, money: data.money.length, expenses: data.expenses.length, inventory: data.inventory.length, finance: !!data.finance });
}));
app.get('/api/owner/scopes', ownerAuth, wrap(async (req, res) => {
  res.json({ available: Q.SCOPES, people: Object.keys(FIELD_CODES).map(name => ({ name, scopes: [...scopesOf(name)], fromApp: !!SCOPES_DB[name] })) });
}));
app.put('/api/owner/scopes', ownerAuth, wrap(async (req, res) => {
  const b = (req.body && req.body.people) || {}; const next = { ...SCOPES_DB };
  Object.keys(b).forEach(name => { if (FIELD_CODES[name] !== undefined && Array.isArray(b[name])) next[name] = b[name].filter(x => Q.SCOPES.includes(x)); });
  await store.setScopes(next); SCOPES_DB = next;
  res.json({ available: Q.SCOPES, people: Object.keys(FIELD_CODES).map(name => ({ name, scopes: [...scopesOf(name)], fromApp: !!SCOPES_DB[name] })) });
}));
app.get('/api/owner/queries', ownerAuth, wrap(async (req, res) => { res.json(await store.listQueries(Math.min(+req.query.limit || 100, 500))); }));
app.put('/api/owner/reference', ownerAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const names = a => Array.isArray(a) ? a.map(x => String(x).trim()).filter(Boolean).slice(0, 2000) : [];
  await store.setReference({ suppliers: names(b.suppliers), customers: names(b.customers), materials: names(b.materials), expenseCats: names(b.expenseCats).length ? names(b.expenseCats) : EXPENSE_CATS_DEFAULT });
  res.json({ ok: true });
}));

// ── static: the field capture page ──
app.use(express.static(path.join(__dirname, 'public'), { index: 'capture.html', extensions: ['html'] }));
app.get('/capture', (req, res) => res.sendFile(path.join(__dirname, 'public', 'capture.html')));

(async () => {
  store = DATABASE_URL ? new PgStore(DATABASE_URL) : new FileStore(DATA_FILE);
  await store.init();
  await loadAiFromStore().catch(e => console.error('ai settings', e.message));
  SCOPES_DB = (await store.getScopes().catch(() => null)) || {};
  if (!OWNER_TOKEN) console.warn('⚠ OWNER_TOKEN is not set — owner endpoints are disabled');
  if (!Object.keys(FIELD_CODES).length) console.warn('⚠ FIELD_CODES is empty — nobody can log in to the capture page');
  if (!AI_ON) console.warn(`⚠ no API key for provider "${PROVIDER}" — set it from the app (🧠 settings) or as an environment variable; the capture page falls back to manual entry`);
  else console.log(`AI provider: ${PROVIDER} (${modelName()}), audio input: ${AUDIO_INPUT}`);
  app.listen(PORT, () => console.log(`drafts service on :${PORT} (${DATABASE_URL ? 'postgres' : 'file store ' + DATA_FILE})`));
})().catch(e => { console.error('startup failed', e); process.exit(1); });
