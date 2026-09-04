# 🌙 Overnight Autonomous Audit — Plastic Manager (تجارة البلاستيك)

> **✅ Post‑audit update:** the **top‑3 recommendations from §4 are now implemented & verified** —
> (1) **table search + column sort + pagination** on Purchases/Sales/Expenses (25/page, per‑table state,
> focus‑preserving search); (2) **self‑hosted fonts** — Cairo + Tajawal embedded as base64 woff2,
> **all Google Fonts requests removed** (0 external calls → fully offline & private); (3) **pagination**
> (shipped with #1). Verified: 0 render errors / 0 colour leaks across 3 data files × 10 views × both themes,
> a11y intact, accounting reconciles, data files untouched. File grew 155 KB → 277 KB (embedded fonts).

**Run date:** 2026‑07‑22 (overnight)
**Auditor role:** Lead QA Automation Engineer · Security Auditor · UX Expert
**Application:** `plastic_manager.html` — single‑file, client‑side, Arabic/RTL business‑management app (no backend)
**Method:** Live browser automation (drove the real app on `http://localhost:8791`) + direct source access. Every view, modal, form, and flow exercised programmatically and via real DOM events.

---

## 0. Executive summary

The application entered this audit already in strong shape from prior QA cycles. The overnight pass **confirmed that robustness across ~10 views, ~13 modals, and all core flows**, and found & fixed **one genuine crash‑class bug**, then hardened accessibility, resilience, and security.

| Phase | Outcome |
|---|---|
| **1 · Functional E2E** | **1 crash bug found & fixed** (malformed‑import null records). All edit/delete/undo/statement/print/import flows verified. 0 console errors. |
| **2 · Usability & A11y** | **9 accessibility fixes implemented** (dialog semantics, focus management, keyboard focus ring, landmarks, live regions, table scopes). |
| **3 · Performance & Security** | Sub‑10 ms renders, **0 memory/node leaks**, **XSS fully mitigated**, **no exposed secrets**. Added a **global error safety‑net**. |
| **4 · Deliverable** | This report. |

**Your data was never touched.** All three `plastic_data_*.json` files retain their original timestamps; the audit loads them **read‑only** with no linked file handle. (The 2026‑05‑13 file's newer date is *your own* save at 23:45.)

**To see these changes in your browser: one hard refresh (Ctrl+Shift+R)**, or reopen the file directly.

---

## 1. Bug Fixes Executed

### 🔴 BUG‑01 — Malformed import with `null` records crashes the whole app *(fixed)*

**Severity:** High (data‑loss‑adjacent: corrupts in‑memory state until reload)

**How it was found:** Phase 1 adversarial import battery. Feeding a JSON file containing `null` entries inside the record arrays, e.g.
```json
{ "suppliers": [null, {"id":1,"name":"S"}], "purchases": [null, {"id":2,"material":"HDPE","qty":5,"price":10}] }
```

**Root cause:** `loadJsonText()` validated only `Array.isArray(d.suppliers) && Array.isArray(d.purchases)` — an array *containing* `null` passes. The old `_sanitizeData()` **skipped** null records (`if(r){…}`) instead of **removing** them, so the nulls were assigned into `DB`, and the next `computed()`/`render()` threw `Cannot read properties of null (reading 'material')`. Worse, `loadJsonText` had already mutated `DB` before `render()` threw, leaving the app in a broken state that every subsequent interaction re‑crashed.

**Fix applied** — `_sanitizeData()` now *filters* every array to valid objects (and materials to strings) before coercing numbers:
```js
const RECORD_ARRAYS = ['suppliers','customers','purchases','sales','expenses','traderAdvances',
                       'workerLiquidity','closings','collections','supplierPayments','partners','distributions'];
RECORD_ARRAYS.forEach(k=>{
  d[k] = Array.isArray(d[k]) ? d[k].filter(r => r && typeof r === 'object') : [];
});
if(!Array.isArray(d.materials)) d.materials = [];
else d.materials = d.materials.filter(m => typeof m === 'string');
// …then coerce qty/price/amount/etc. via num() on the cleaned records,
//    and filter txExpenses / distribution breakdown to valid objects too.
```

**Re‑test:** null records now stripped → file loads, all views render, no crash. **Backward‑compat confirmed:** all 3 real files load with identical net figures and 0 NaN.

---

### ✅ Flows tested with NO defects found

Exhaustive Phase‑1 coverage that passed clean (documented for completeness):

- **Edit flows** (previously under‑tested): editing purchases/sales/expenses/suppliers/customers/partners/distributions/trader‑advances/worker‑liquidity all **preserve `id`, `txExpenses`, `waste`, partner links, and toggle state**; totals recompute correctly.
- **Delete + Undo** across all 10 record types → restores at the **original array index** (deal numbers `#001…` stay intact); clear‑all fully undoable; undo window expires cleanly at 9 s.
- **Confirm‑then‑undo** on purchases/sales, incl. the linked‑sales orphan warning.
- **Empty states** — all 10 views + 3 contact sub‑tabs + all 13 modals render with zero data, no throw.
- **Adversarial imports** — empty string, non‑JSON, `{}`, wrong‑shape, string numbers, unknown material, huge/negative numbers: all handled gracefully; app recovers.
- **Real DOM interactions** — sidebar nav (10), P&L filter chips + date inputs, statement overlay open/close (Esc), print generation (emerald‑branded), inventory row expand, theme toggle (incl. rapid double‑toggle), modal Esc.
- **Layout** — a 3× brutally‑long customer name causes **no horizontal page overflow**; tables wrap in scroll containers.
- **Accounting integrity** — COGS + inventory value reconciles to total purchases **exactly (delta 0)**; no NaN.

---

## 2. Usability Review (Nielsen heuristics + target‑audience fit)

**Target audience:** a plastic‑trading business owner/bookkeeper (Arabic‑first, likely not a "power" software user). The app should feel like a ledger, not an ERP.

### What works well (keep it)
- **Visibility of system status** — save‑state pill (محفوظ / تغييرات غير محفوظة with a pulsing dot), toasts, inline validation. Strong.
- **Error prevention & recovery** — confirm on money deletes + **undo everywhere** (incl. clear‑all) is an excellent, forgiving pattern; the linked‑sales warning prevents silent orphaning.
- **Match to real world** — Arabic labels, ج.م currency, deal numbers, "كشف حساب" statements mirror how the business actually thinks.
- **Consistency & standards** — one token‑based design system, uniform buttons/badges/cards across all views; light/dark parity.
- **Help users recognise** — empty‑state guidance ("ابدأ بـ…"), the inventory‑source drill‑down, the P&L↔balance cross‑reference note.
- **Aesthetic & minimalist** — the emerald/gold gallery theme is calm and legible for dense financial tables.

### Friction points (documented; see §4 for prioritised fixes)
1. **No search / filter / sort on the transaction tables.** Purchases & sales grow unbounded; finding "that deal with عزبة أبو حشيش" means eyeballing. Highest‑value usability gap.
2. **No pagination.** All rows render at once (fine now; see perf §3.4).
3. **Flat 10‑item sidebar.** No grouping — a newcomer can't tell "operations" (مشتريات/مبيعات/مخزون) from "accounting" (أرباح/ميزانية/توزيع). Cognitive load on first use.
4. **Static dashboard.** Four KPI tiles + recent lists, but **no trend/at‑a‑glance chart** (e.g., monthly profit sparkline). A business owner's first question is "am I up or down this month?"
5. **Numeral mismatch.** Inputs accept Western digits (`1500`) but the UI displays Arabic‑Indic (`١٬٥٠٠`). Minor but a recurring double‑take.
6. **No `Ctrl+S`.** The hero action is Save; a keyboard shortcut would suit a daily‑use ledger.
7. **`file://` save caveat.** Opened directly (double‑click), the silent linked‑file save degrades to a JSON *download* (the File System Access API needs http(s)). Not a bug, but a workflow surprise worth surfacing in‑app.

### Accessibility (WCAG) — fixes implemented this session
| Fix | WCAG criterion |
|---|---|
| `role="dialog"` / `alertdialog` + `aria-modal` + `aria-labelledby`/`describedby` on modal & confirm | 4.1.2 Name/Role/Value |
| **Focus management** — move focus into dialog on open, **trap Tab within**, **restore to opener** on close | 2.4.3 Focus Order, 2.1.2 No Keyboard Trap |
| **Visible keyboard focus ring** (`:focus-visible`, 2.5 px emerald) on all interactive elements | 2.4.7 Focus Visible |
| `aria-current="page"` on the active nav item | 4.1.2 |
| `scope="col"` on **42 table headers** (auto + hand‑built), `aria-label` on action columns | 1.3.1 Info & Relationships |
| Landmarks — `role="main"`, `role="banner"`, native `<nav>` | 1.3.1, 2.4.1 |
| Toast as `role="status"` `aria-live="polite"` (announces the undo prompt to screen readers) | 4.1.3 Status Messages |
| `aria-label` on icon‑only buttons (close ✕, theme toggle) | 4.1.2 |
| `.sr-only` utility added for future needs | — |

Contrast (verified earlier this project): body ink 15–18:1, all accents ≥ 4.5:1 — **AA/AAA**.

**Remaining a11y gaps (lower priority):** statement overlay lacks a focus trap (Esc‑closable + escaped content, so low risk); no "skip to content" link; the color chips convey color by name text (not color‑only), which is fine.

---

## 3. Performance & Security Audit

### 3.1 XSS — ✅ fully mitigated
Injected `<img src=x onerror=…><script>…</script>` into **every free‑text field** (names, phone, city, color, notes, descriptions, material names) and rendered every view + the statement overlay + print output. Result: **script never executed, no live node entered the DOM, no render error.** The `esc()` layer covers every `innerHTML` interpolation, and the print document is escaped too.

### 3.2 Secrets / keys — ✅ none
Full‑source scan for `api_key|secret|token|password|bearer`: the single hit was the word **"tokens"** in the CSS comment *"DESIGN TOKENS"* — a false positive. As a backend‑less local app, there are legitimately no credentials.

### 3.3 Client‑side storage — ⚠️ plaintext (documented)
Business data is autosaved to `localStorage['plastic_manager_autosave']` (~1.6 KB) **in plaintext**. For a single‑user local app this is low risk, but on a **shared computer** any other user profile / any script on the same origin could read it. See §4 recommendation.

### 3.4 Performance — ✅ excellent at real scale
| Metric | Result |
|---|---|
| `render()` per view (avg, real data) | dashboard 0.35 ms · P&L 0.46 ms · balance 1.5 ms · sales/accounts ~4 ms · purchases 7.8 ms |
| DOM size | 643 nodes (accounts) / 801 whole doc — lean |
| **Memory/node leak** | **0‑node delta after 50 modal‑open/close + view‑switch cycles**; statement overlays self‑clean; single document‑level keydown listener (no accumulation) |
| Stress (synthetic 1000 rows) | 158 ms — *perceptible*; the app renders all rows with no pagination/virtualisation |

**Architecture note:** `render()` rebuilds the whole view's `innerHTML` each time. This is GC‑clean and instant at the expected scale (dozens–hundreds of records), but is **O(n) per interaction** — a business accumulating thousands of transactions over years would eventually feel it. See §4.

### 3.5 Network / assets — ⚠️ external Google Fonts (documented)
The only external requests are **Google Fonts** (Cairo + Tajawal, 1 CSS + ~8 woff2). Implications: (a) a **privacy** signal — Google sees the user's IP on each load; (b) **offline fragility** — mitigated, as the app falls back to Tahoma/Segoe if the CDN is unreachable. See §4 for self‑hosting.

### 3.6 Resilience — global error handler added *(new)*
There was no top‑level error trap, so an unexpected exception could leave a silently frozen UI. Added:
```js
window.addEventListener('error', e=>{ if(e && e.message){ console.error('Unhandled error:', e.message);
  showToast('⚠ حدث خطأ غير متوقع — بياناتك محفوظة. أعد تحميل الصفحة إن استمرت المشكلة.'); } });
window.addEventListener('unhandledrejection', e=>{ console.error('Unhandled rejection:', e.reason); });
```
Gated on `e.message` so font/resource load failures never trigger a spurious toast. Verified it fires and toasts on an uncaught error.

---

## 4. Actionable Recommendations (prioritised)

### 🔴 P0 — highest value, do next
1. **Table search + column sort on Purchases / Sales / Accounts.** A single debounced text filter (material/supplier/customer/date/amount) + click‑to‑sort headers. Biggest daily‑use quality‑of‑life win; low risk (view‑layer only).
2. **Self‑host the fonts** (embed Cairo/Tajawal woff2 as base64, or drop to a great system‑Arabic stack). Removes the Google dependency → true offline + privacy, and eliminates the font‑swap flash. Keeps the single‑file architecture.

### 🟠 P1 — strong ROI
3. **Pagination or windowing on transaction tables** (e.g., 50/page, or render‑on‑scroll) — future‑proofs the O(n) render as data grows into the thousands.
4. **Dashboard trend** — a small monthly net‑profit / cash sparkline or bar. Answers "how am I doing?" at a glance; pairs naturally with the new P&L period engine (`computedPL`).
5. **Group the sidebar** into sections — *العمليات* (مشتريات/مبيعات/مخزون), *الحسابات* (حسابات الأطراف/أرباح/ميزانية/توزيع), *الإعداد* (موردون وعملاء). Reduces first‑use cognitive load.

### 🟡 P2 — polish
6. **`Ctrl+S` → Save** (and maybe `Ctrl+K` → quick‑find once search exists).
7. **Optional passcode‑encrypt** the localStorage autosave (Web Crypto) for shared‑computer users — or a "clear local copy on close" toggle.
8. **CSV / Excel export** of any table and the P&L for a chosen period — accountants will ask for it.
9. **In‑app hint** when running from `file://` that Save downloads a copy (vs. silent linked‑file save on localhost) — removes the workflow surprise.

### 🟢 P3 — architectural / longer‑horizon
10. **De‑inline for a real CSP.** The app currently has ~51 inline event handlers + inline `<script>`/styles, so a meaningful `Content-Security-Policy` isn't feasible without externalising JS/CSS and replacing `onclick=` with `addEventListener`. Worth it only if the threat model grows (e.g., hosted multi‑user).
11. **Multi‑period compare** (this month vs last) and **partner‑statement print** to match the customer/supplier statements.
12. **Automated regression harness** — the JS probes written during this audit (empty‑state sweep, adversarial import battery, edit‑integrity, undo, XSS) could be saved as a `tests.js` the app loads with `?test=1`, so future edits self‑verify.

---

## 5. Change log (files touched this session)

| File | Change |
|---|---|
| `plastic_manager.html` | BUG‑01 import hardening; 9 accessibility fixes (dialog roles, focus trap/restore, focus ring, landmarks, `aria-current`, `scope`, live‑region toast, icon labels); global error handler. |
| `plastic_data_*.json` (×3) | **Untouched** — original timestamps preserved; loaded read‑only. |
| `OVERNIGHT_AUDIT_REPORT.md` | This report (new). |

**Verification after all fixes:** full regression sweep across 10 views + 3 sub‑tabs + 13 modals = **0 errors**; accounting reconciles to **0**; validation/undo/confirm intact; **0 colour leaks in both themes**; only console output is the intentional synthetic error from testing the new handler.

*— End of report. Everything above is live in `plastic_manager.html`; hard‑refresh to load it.*
