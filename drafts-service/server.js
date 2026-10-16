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

const PORT              = +process.env.PORT || 8790;
const OWNER_TOKEN       = process.env.OWNER_TOKEN || '';
const FIELD_CODES       = parseCodes(process.env.FIELD_CODES || '');
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL      = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
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
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: e.message || 'خطأ' }); });
const b64ToBuf = (s, max) => {
  if (!s) return null;
  const buf = Buffer.from(String(s).replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (buf.length > max) throw new Error('التسجيل أكبر من المسموح');
  return buf;
};

let store;

app.get('/api/health', (req, res) => res.json({ ok: true, store: DATABASE_URL ? 'postgres' : 'file', ai: !!GEMINI_API_KEY, fieldUsers: Object.keys(FIELD_CODES).length }));

// ── field endpoints ──
app.post('/api/field/login', limit(20), (req, res) => {
  const code = (req.body && req.body.code) || '';
  const name = Object.keys(FIELD_CODES).find(n => safeEq(FIELD_CODES[n], code));
  if (!name) return res.status(401).json({ error: 'كود الدخول غلط' });
  res.json({ name, ai: !!GEMINI_API_KEY });
});
app.get('/api/field/reference', fieldAuth, wrap(async (req, res) => {
  const ref = (await store.getReference()) || { suppliers: [], customers: [], materials: [], expenseCats: EXPENSE_CATS_DEFAULT };
  res.json(ref);
}));
app.post('/api/field/parse', fieldAuth, limit(30), wrap(async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(503).json({ error: 'الذكاء الاصطناعي مش متفعّل على الخدمة — املأ الحقول يدوياً' });
  const { text, audio, mime, conversation } = req.body || {};
  const audioB64 = audio ? b64ToBuf(audio, MAX_PARSE_AUDIO).toString('base64') : null;
  const reference = await store.getReference();
  const result = await geminiParse({ text, audio: audioB64, mime, conversation, reference, fieldName: req.fieldName });
  res.json({ ok: true, result });
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
  if (!OWNER_TOKEN) console.warn('⚠ OWNER_TOKEN is not set — owner endpoints are disabled');
  if (!Object.keys(FIELD_CODES).length) console.warn('⚠ FIELD_CODES is empty — nobody can log in to the capture page');
  if (!GEMINI_API_KEY) console.warn('⚠ GEMINI_API_KEY is not set — the capture page falls back to manual entry');
  app.listen(PORT, () => console.log(`drafts service on :${PORT} (${DATABASE_URL ? 'postgres' : 'file store ' + DATA_FILE})`));
})().catch(e => { console.error('startup failed', e); process.exit(1); });
