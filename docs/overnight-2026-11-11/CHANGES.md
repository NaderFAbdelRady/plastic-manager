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
