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

## Run locally (no database, no keys)

```bash
cd drafts-service
npm install
node dev-start.js            # http://localhost:8790  — field codes: عز:1234, أحمد:5678, owner token: dev-owner-token
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
   | `GEMINI_API_KEY` | your Gemini key (server-side only) |
   | `GEMINI_MODEL` | `gemini-2.5-flash` (default) |

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
| field | POST | `/api/field/parse` `{text? audio? mime? conversation?}` | Gemini → structured draft + follow-up question |
| field | POST | `/api/field/drafts` | submit a draft (+ optional recording, ≤ 2 MB, ≤ 120 s) |
| field | GET | `/api/field/drafts` | the person's own drafts with status |
| owner | GET | `/api/owner/drafts?status=pending` | list drafts (no audio bytes) |
| owner | GET | `/api/owner/drafts/:id/audio` | the recording |
| owner | PATCH | `/api/owner/drafts/:id` | `{status, review, final, ledgerId, ledgerList}` |
| owner | PUT | `/api/owner/reference` | upload the name lists |

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
