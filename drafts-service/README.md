# Drafts service — field capture for Plastic Manager

A small Node service that lets people in the field record a purchase / sale / expense /
collection / supplier payment by **voice or text**, and parks it as a **draft** until the
owner reviews it in the local app. The service holds drafts and a list of names only.
It never sees the ledger: no cash, no stock, no balances.

```
field phone ──► capture page (this service) ──► drafts table (Neon Postgres)
                       │                               ▲
                       └── Gemini (key on server) ─────┘
owner laptop ──► plastic_manager.html ──► "صندوق المراجعة" pulls pending drafts,
                 approves locally, marks them approved/rejected here
```

## One page, one mic

The person opens the page and just talks. Gemini decides what they are doing — recording a transaction, asking a
question, confirming, cancelling, answering a follow-up, or chatting — so there is no "record" / "ask" switch.

* **Record** → a draft card (editable) appears; it is sent for review only after "ابعت" or a spoken «أيوه».
  A question can never write anything: at worst it is misread as a draft, which is still just a card.
* **Ask** → Gemini only turns the sentence into a structured query (entity, party, material, dates, aggregate).
  `query-engine.js` runs it over the **snapshot** and computes every number; Gemini then only phrases the result.
* **Unclear** (e.g. «هاني عيسي ٣٠ ألف» — payment or balance?) → one short clarifying question.
* Answers are shown with their rows and read aloud (browser speech synthesis); every question is logged for the owner.

### The snapshot
The local app uploads a snapshot (`PUT /api/owner/snapshot`): deals, collections/payments, expenses, party balances and
stock — **never** cash, profit, capital, partners or average cost. It refreshes on every file save (toggle in the app).
Every answer says "حسب آخر تحديث من المكتب: …".

### Scopes
Five groups: `deals`, `money` (collections, payments, balances), `expenses`, `inventory`, `finance` (cash, profit, balance
sheet, distribution, partners, monthly P&L, closings). A person who is not configured gets the first four **but not
`finance`**: that is granted on purpose. Set it per person from the app (🔑 صلاحيات ناس الميدان), or with
`FIELD_SCOPES="أحمد:deals+money,المدير:all"` (the app wins). Out-of-scope questions are refused and logged.

### Finance (opt-in)
Tick "ضيف الماليات للقطة" in the app and the snapshot also carries a `finance` block computed with the app's own accounting
(cash, net/available profit, receivables, payables, inventory value, equity, partners with draws and funding, monthly P&L,
closings). It is stored on the service, so it is off by default and only answered for people with the `finance` scope.
«لو وزعنا مية ألف» is computed by `query-engine.js` exactly as the app does (draws absorbed first) and reports the cash left
after paying out. The snapshot never includes average cost.

## Choosing the model (Gemini, Grok or Claude)
Set it **from the owner's app** (صندوق المراجعة ← ربط الخدمة ← 🧠 نموذج الذكاء الاصطناعي): provider, model, API key and, for
Claude, an optional Base URL (a gateway). Settings are stored encrypted (AES-256-GCM, key derived from `OWNER_TOKEN`) in
the database, win over environment variables, apply immediately and are never sent back (the app only sees a mask).
"اختبار الاتصال" makes a tiny call and reports the latency or the exact error. If `OWNER_TOKEN` changes, saved keys can no
longer be decrypted and the service falls back to environment variables.

* **Gemini** takes the recording directly (and archives it with the draft).
* **Grok / Claude** take text only, so the capture page transcribes speech in the phone's browser (Web Speech, Arabic;
  Chrome/Safari) and sends text. No recording is archived in that mode.
* Claude is called through the Messages API at `<base>/v1/messages`, sending both `x-api-key` and `Authorization: Bearer`
  so it also works behind gateways. The base URL must be reachable **from the service** (Render is on the public internet).

Environment fallbacks: `AI_PROVIDER`, `GEMINI_API_KEY`/`GEMINI_MODEL`, `XAI_API_KEY`/`XAI_MODEL`,
`CLAUDE_API_KEY` (or `ANTHROPIC_API_KEY`)/`CLAUDE_MODEL`/`CLAUDE_BASE_URL` (or `ANTHROPIC_BASE_URL`).
Everything else (intents, query engine, scopes, snapshot) is identical across providers.

## Run locally (no database, no keys)

```bash
cd drafts-service
npm install
node dev-start.js            # add --mock to also start a scripted Gemini stand-in (test/mock-gemini.js)
                             # http://localhost:8790  — field codes: عز:1234, أحمد:5678, owner token: dev-owner-token
```

Drafts go to `data/drafts.json`. The capture page works without a Gemini key (manual entry);
set `GEMINI_API_KEY` to enable the voice / free-text understanding.

## Deploy (Render + Neon)

1. **Neon** → create a project → copy the connection string (`postgresql://…?sslmode=require`).
2. **Render** → New → Web Service → this repo, root directory `drafts-service`, build
   `npm install --omit=dev`, start `node server.js`. Or use `render.yaml` as a Blueprint.
3. Environment variables on Render:

   | var | value |
   |---|---|
   | `DATABASE_URL` | the Neon string |
   | `OWNER_TOKEN` | a long random secret (Render can generate it) |
   | `FIELD_CODES` | `عز:482913,أحمد:775120` — one code per person |
   | `AI_PROVIDER` | `gemini` (default) or `grok` |
   | `GEMINI_API_KEY` | your Gemini key (server-side only) |
   | `XAI_API_KEY` / `XAI_MODEL` | for `AI_PROVIDER=grok` (model default `grok-3`) |
   | `GEMINI_MODEL` | `gemini-2.5-flash` (default) |
   | `FIELD_SCOPES` | optional, e.g. `أحمد:deals+money` |

4. Open `https://<service>.onrender.com/` on a phone → the capture page. Give each person the URL and their own code.
5. In the local app → **صندوق المراجعة → ربط خدمة المسودات**: paste the URL and the owner token,
   press **رفع قائمة الأسماء** once (and again whenever you add suppliers/customers/materials),
   then **جلب المسودات الجديدة** whenever you want to review.

The free Render instance sleeps after 15 minutes idle; the first request afterwards takes ~30 s.
Neon's free tier keeps the data (unlike Render's free Postgres, which expires after 90 days).

## Stories: several transactions in one message

The person usually tells a story, not one item at a time: «اشتريت من هاني ألفين كيلو ABS وبعت لفلكس ألف كيلو PP ودفعت لجمال ٢٠ ألف». `converse` returns **one draft per
transaction** (`records`; `record` is the first, for the classic page's single card): the classic page shows one card listing them with «ابعت الكل للمراجعة», the avatar reads
them back one by one. A draft always has a date (today when none was said) and the unit in the office's words, and the model is only allowed to stop the person for something
essential (party, material, quantity, price, amount) — not for the date or whether it was paid. One sentence can also ask for several things («آخر المبيعات وآخر المشتريات»):
each gets its own query, its own answer and its own table. Every date that is read out carries its weekday («الخميس 22/10»), and the prompt carries a 14-day calendar so
«الخميس اللي فات» resolves exactly. `node test/story-check.js` runs ten such stories through the service with a real model against a synthetic office.

## The avatar (Matrix) — optional

With the four variables below set, the page people open (`/`) shows a short choice after the code is accepted: **مساعدة المكتب (the avatar)** or **the classic page**
(`/classic`, the page described above, unchanged and with the same code). With none of them set, `/` is the classic page and nothing here is reachable.

The person types the code here; this service then signs a 12-hour sign-in for that person (`matrix-link.js`) and the page hands it to the avatar's frame, so the code never
goes to Matrix. The avatar's own server calls `/api/service/*` with `X-Service-Key` and the person's name: it uses the same understanding (`converse`), the same scopes, the
same snapshot and the same review inbox as the classic page. What the avatar says and the table it puts on the screen (`avatar-speech.js`) are written here from the draft or
from the query engine's rows — never by a model — and dates carry their weekday («السبت 24/10»).

| Variable | Value |
|---|---|
| `FIELD_MATRIX_URL` | the avatar app, e.g. `https://matrix-xxxx.onrender.com` |
| `FIELD_MATRIX_PK` / `FIELD_MATRIX_SECRET` | the deployment's public key and secret (Matrix → Deployments) |
| `FIELD_SERVICE_KEY` | a long random string (16+ characters); the same value as `MATRIX_PLASTIC_SERVICE_KEY` on Matrix |

On Matrix set `MATRIX_PLASTIC_URL` (this service's public address) and `MATRIX_PLASTIC_SERVICE_KEY`, and create a deployment for the persona «مساعدة المكتب» with this
service's address as its only allowed site and "require login" on. Try it without a model or a Matrix: `node test/avatar-smoke.js`.

## API

| who | method | path | purpose |
|---|---|---|---|
| anyone | GET | `/api/health` | liveness, store type, AI on/off |
| field | POST | `/api/field/login` `{code}` | returns the person's name (and, with the avatar configured, `sso_token`) |
| field | GET | `/api/field/reference` | names of suppliers / customers / materials / expense categories |
| field | POST | `/api/field/converse` `{text? audio? mime? conversation? pending? lastQuery?}` | the one entry point: record / query / both / confirm / cancel / clarify / chat |
| field | POST | `/api/field/query` `{query}` | deterministic query (no AI), same scope checks |
| field | POST | `/api/field/parse` `{text? audio? mime? conversation?}` | Gemini → structured draft + follow-up question |
| field | POST | `/api/field/drafts` | submit a draft (+ optional recording, ≤ 2 MB, ≤ 120 s) |
| field | GET | `/api/field/drafts` | the person's own drafts with status |
| avatar | POST | `/api/service/{converse,brief,drafts}` `{person, …}` | the avatar's server acting for one person (`X-Service-Key`) |
| anyone | GET | `/api/field/avatar` | where the avatar lives (`{url, pk}` or null) |
| owner | GET | `/api/owner/drafts?status=pending` | list drafts (no audio bytes) |
| owner | GET | `/api/owner/drafts/:id/audio` | the recording |
| owner | PATCH | `/api/owner/drafts/:id` | `{status, review, final, ledgerId, ledgerList}` |
| owner | GET/PUT | `/api/owner/scopes` | per-person scopes |
| owner | GET/PUT | `/api/owner/ai` | read / change the model settings (keys write-only) |
| owner | POST | `/api/owner/ai/test` | one tiny call to the configured model |
| owner | PUT | `/api/owner/reference` | upload the name lists |
| owner | PUT | `/api/owner/snapshot` | upload the field snapshot (deals, money, expenses, balances, inventory) |
| owner | GET | `/api/owner/queries` | log of what the field asked and what it was told |

Field requests carry `X-Field-Code: <code>`; owner requests carry `Authorization: Bearer <OWNER_TOKEN>`.
There is no delete endpoint by design — a draft only ever changes status.

## Draft shape

```json
{ "type": "purchase", "submittedBy": "عز", "createdAt": "2026-10-16T10:00:00Z",
  "transcript": "اشتريت من هاني عيسي ألفين وسبعين كيلو ABS بسبعة وعشرين…",
  "fields": { "date": "2026-10-16", "party": "هاني عيسي", "material": "ABS", "qty": 2070, "unit": "كيلوجرام",
              "price": 27, "paid": 30000, "txExpenses": [{ "desc": "نقل", "amount": 1000 }], "location": "مخزن 4" },
  "conversation": [{ "role": "assistant", "text": "المدفوع تلاتين ألف كاش والباقي على الحساب، صح؟" }, { "role": "user", "text": "أيوه" }] }
```

The same JSON can be pasted into the local app (**لصق مسودة**) when the service is unreachable.
