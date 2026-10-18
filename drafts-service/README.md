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
`FIELD_SCOPES="أحمد:deals+money"` limits a person to those groups (`deals`, `money`, `expenses`, `inventory`, or `all`).
A person not listed can ask about everything. Out-of-scope questions are refused and logged.

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

## API

| who | method | path | purpose |
|---|---|---|---|
| anyone | GET | `/api/health` | liveness, store type, AI on/off |
| field | POST | `/api/field/login` `{code}` | returns the person's name |
| field | GET | `/api/field/reference` | names of suppliers / customers / materials / expense categories |
| field | POST | `/api/field/converse` `{text? audio? mime? conversation? pending? lastQuery?}` | the one entry point: record / query / both / confirm / cancel / clarify / chat |
| field | POST | `/api/field/query` `{query}` | deterministic query (no AI), same scope checks |
| field | POST | `/api/field/parse` `{text? audio? mime? conversation?}` | Gemini → structured draft + follow-up question |
| field | POST | `/api/field/drafts` | submit a draft (+ optional recording, ≤ 2 MB, ≤ 120 s) |
| field | GET | `/api/field/drafts` | the person's own drafts with status |
| owner | GET | `/api/owner/drafts?status=pending` | list drafts (no audio bytes) |
| owner | GET | `/api/owner/drafts/:id/audio` | the recording |
| owner | PATCH | `/api/owner/drafts/:id` | `{status, review, final, ledgerId, ledgerList}` |
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
