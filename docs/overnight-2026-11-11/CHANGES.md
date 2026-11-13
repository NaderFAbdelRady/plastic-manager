# Overnight pass 2026-11-11: changed and added files

Nothing is committed. Originals of the two most-edited files are in `Archive/` (`plastic_manager_2026-11-11_before-overnight.html`,
`drafts-service_server_2026-11-11_before-overnight.js`). Line endings preserved per file (app LF, service files CRLF where they were).

## Changed

- `plastic_manager.html`: bug fixes B1-B5 (non-ledger JSON no longer wipes the books; escaped dates/closing notes; sanitised dates on import; parties with records cannot be deleted; local date instead of UTC; missing/duplicate ids repaired on load) and the new follow-up centre (`renderFollowup`, `buildInsights`, `partyAging`, `materialStats`, `cashOutlook`, AI wording with a number guard, WhatsApp message, follow-up dates `DB.reminders`, per-party `creditDays`, dashboard card, menu badge, safe-distribution line, debt ages in the field snapshot).
- `drafts-service/server.js`: wrong-code/token lockout on every endpoint (S1), `TRUST_PROXY`, `HOST`, nosniff/no-referrer headers, Cairo date in prompts (S2), input size limits and 404 for non-numeric ids (S4), `overdueOnly` in the query schema and prompt, the overdue list is read out exactly as computed.
- `drafts-service/query-engine.js`: `overdueOnly` balances query ("مين متأخر في السداد؟") with ages; wording fix for an overpaid supplier (S3).
- `drafts-service/avatar-speech.js`: table for the overdue list on the avatar's board.
- `drafts-service/dev-start.js`: binds 127.0.0.1 by default (`HOST`), mock model port from `MOCK_AI_PORT`.
- `drafts-service/test/mock-gemini.js`: port from `MOCK_AI_PORT`, binds 127.0.0.1, understands "متأخر".
- `drafts-service/test/avatar-smoke.js`: ports from `SMOKE_PORT` / `MOCK_AI_PORT` (defaults unchanged).
- `drafts-service/render.yaml`: `TRUST_PROXY=1`.
- `drafts-service/README.md`: `TRUST_PROXY`, `MAX_AUTH_FAILS`, service-check, the overdue question.
- `README.md`: follow-up screen row and a Tests section.

## Added

- `tests/synthetic_ledger.py`: invented ledger (names, phones, amounts) + an independent Python re-computation of the books.
- `tests/_harness.py`: one-file static server (never serves the real JSON files), fresh headless Chrome profile, check helper.
- `tests/e2e_app.py`: 74 checks over the whole app (accounting vs reference, every screen, forms, undo, save/load, hostile import, inbox, distribution, phone layout, advisor with a mocked model).
- `tests/e2e_insights.py`: 75 checks for the follow-up centre.
- `tests/screenshots.py`: guide screenshots + a live app <-> drafts-service (mock) link check (8 checks).
- `drafts-service/test/service-check.js`: 24 checks for the service (overdue query, limits, lockout, headers).
- `Archive/plastic_manager_2026-11-11_before-overnight.html`, `Archive/drafts-service_server_2026-11-11_before-overnight.js`: pre-edit copies.
- `docs/overnight-2026-11-11/GUIDE_AR.html|.pdf`: Egyptian-Arabic story guide covering every screen (new features badged).
- `docs/overnight-2026-11-11/REPORT_AR.html|.pdf`: readiness report.
- `docs/overnight-2026-11-11/screenshots/*.png`: 30 screenshots, synthetic data only.
- `docs/overnight-2026-11-11/make_pdf.py`: rebuilds the two PDFs offline with headless Chrome.
- `docs/overnight-2026-11-11/CHANGES.md`: this file.

# Round 2 (2026-11-13): second, independent review

Nothing is committed. Pre-edit copies: `Archive/plastic_manager_2026-11-13_before-round2.html`,
`Archive/drafts-service_capture_2026-11-13_before-round2.html`, `Archive/drafts-service_query-engine_2026-11-13_before-round2.js`.
Line endings kept per file (app LF; `capture.html` and `query-engine.js` CRLF). Tests before: 171/173 (e2e_insights 73/75, date-dependent
test). After: 224/224 + avatar smoke. Defect ids match REPORT_AR section 3/4 and the test names.

## Changed

- `plastic_manager.html`:
  - R2-01 `_labelFor` (new) used by `fld` / `fldX`: every form label is tied to its control, errors via `aria-describedby` + `aria-invalid`;
    `aria-label` on the follow-up settings inputs, new-material input, P&L dates, AI key/model, deal-expense inputs, WhatsApp text, service AI select.
  - R2-02 `fuItemNode`, `_fuTabToday`: a saved AI sentence/headline is shown only while every number in it is still in the item as computed now.
  - R2-03 `fuAiBrief`: names hidden longest-first; aliases mapped back by whole number (طرف-12 no longer becomes name-of-طرف-1 + "2").
  - R2-04 `validateForm`: credit days must be 1..365 (0 used to be saved silently as "default").
  - R2-05 `dsFetch` (error carries `status`), `dsPull`, `dsPushSnapshot`, `dsStartAutoPull`, link save: a 401/429 in the background pauses
    background pulls/pushes for the session (the service locks the whole address after 20 wrong tokens).
  - R2-06 `setF`: changing customer/supplier/material/unit/purchase deal re-takes the impact panel's "before" (it compared with the first party).
  - R2-07 `render`: `aria-pressed` on every `.tab-btn`.
  - Feature F1, customer credit limit (optional `creditLimit` on customers, 0 = cash only): `_sanitizeData`, `openModal`/`openEditModal`,
    `validateForm`, `saveModal`, customer form field, `impactWarnings` (sale over the limit, sale to a customer with overdue debts),
    `buildInsights` (urgent "limit:<id>" item). Old files without the field are unchanged.
- `drafts-service/public/capture.html`: R2-08 «مين متأخر؟» table shows the overdue part and oldest invoice; overpaid supplier reads «لينا عنده».
- `drafts-service/query-engine.js`: R2-09 `q.today` must be an ISO date, else Cairo today (no NaN ages from non-schema-bound models).
- `drafts-service/test/service-check.js`: check for R2-09 (25 checks).
- `tests/e2e_insights.py`: R2-10 the markup test sentence had a digit (`__xss=1`) that the number guard rightly refused on some dates.
- `tests/screenshots.py`: R2-11 contexts pinned to `forced_colors='none'`, light scheme; round-2 check for the classic field table;
  3 new screenshots (credit limit form, follow-up item, sale-form warning); 33 shots.
- `docs/overnight-2026-11-11/make_pdf.py`: page numbers in the footer, pinned colours, `--png DIR` renders every page for review.
- `docs/overnight-2026-11-11/GUIDE_AR.html|.pdf`: refreshed for round 2 (badge «جديد ٢»), screenshots re-taken.
- `docs/overnight-2026-11-11/REPORT_AR.html|.pdf`: rewritten as the two-round review document.
- `docs/overnight-2026-11-11/screenshots/*.png`: all 30 re-taken + 31-33 new (synthetic data).
- `README.md`: credit limit in the Contacts row; the two new test scripts.

## Added

- `tests/e2e_round2.py`: 25 checks, one or more per round-2 defect plus the credit-limit feature (fail on the pre-round-2 copy, pass now).
- `tests/walkthrough.py`: 15 checks over 123 stops (every screen, tab and form at 1366, 390 and dark): script errors, sideways overflow, RTL,
  accessible names of controls and buttons, `aria-pressed` on tabs.
- `Archive/*_2026-11-13_before-round2.*`: the three pre-edit copies above.
