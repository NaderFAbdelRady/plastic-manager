# تجارة البلاستيك — Plastic Manager

A single-file, fully client-side business-management app for a plastic-trading operation.
Arabic UI, right-to-left layout, no backend, no build step, no external network calls.

Open [`plastic_manager.html`](plastic_manager.html) in a browser and it runs.

## What it does

| View | Purpose |
|---|---|
| **Dashboard** (`renderDashboard`) | Headline figures for the business at a glance |
| **Purchases** (`renderPurchases`) | Supplier purchases, with search, column sort, period filter (last 2 weeks / month / 3 months / this month / custom range), page size (25/50/100/all), pagination |
| **Sales** (`renderSales`) | Customer sales, same table controls |
| **Expenses** (`renderExpenses`) | Operating costs |
| **Inventory** (`renderInventory`) | Stock by material, valued at weighted-average cost (AVCO) |
| **Accounts** (`renderAccounts`) | Supplier payments and customer collections (same table controls) |
| **Balance** (`renderBalance`) | Balance sheet — inventory carried as an asset |
| **P&L** (`renderPL`) | Profit and loss, COGS derived from AVCO |
| **Distribution** (`renderDistribution`) | Partner capital and profit distributions |
| **Partner funding** (card in `renderBalance`) | Temporary liquidity a partner lends the till (`partnerFunding`, kind `in`/`out`) — a liability, not capital; repayment is capped at what the partner is owed |
| **Contacts** (`renderContacts`) | Suppliers and customers |

State lives in the browser and is exported to / imported from JSON.

## Data files

The app's ledger lives in `plastic_data_*.json` snapshots — suppliers, customers,
purchases, sales, expenses, materials, capital, partner distributions, partner funding (loans).

**These are deliberately not in this repository.** They hold real business data and
are excluded by `.gitignore`. Keep them alongside `plastic_manager.html` locally and
load one through the app's import control; the app treats them read-only until you
explicitly save.

To start from nothing, just open the app — it begins with an empty ledger.

## Running it

Just open the file. For a local server (useful for testing import/export behaviour
under a real origin):

```bash
python -m http.server 8791
```

Then visit `http://localhost:8791/plastic_manager.html`.
The `.claude/launch.json` config starts exactly this.

## Design & implementation notes

- **Single file.** All HTML, CSS, and JS live in `plastic_manager.html` (~3.3k lines).
- **Offline by design.** Cairo and Tajawal are embedded as base64 woff2 — zero external
  requests, so the app works fully offline and leaks nothing about its use.
- **Tables.** `makeTable()` is the one list widget: pass `stateKey` + `searchText` / `sort` /
  `pageSize` / `dateKey` to get search, sortable headers, a period filter, a page-size picker and
  paging. Date tables default to newest-first. Period and page-size choices are a per-device
  convenience kept in `localStorage` (`pm_table_prefs`), never in the ledger file.
- **Theming.** Emerald/gold design tokens with a light/dark toggle; the theme is applied
  before first paint to avoid a flash of the wrong theme.
- **Accounting.** COGS on weighted-average cost; inventory is an asset on the balance sheet.
- **Cash.** `computedCash()` is the single cash formula (the Balance screen, closings, the impact
  panel and the AI snapshot all call it). Partner draws are cash out on their own date; a
  distribution subtracts only the net it actually paid (gross − draws absorbed); partner funding
  adds cash when lent and removes it when repaid.
- **Safety layer.** `validateForm` / `esc` / `num` guard every input path; a global error
  net catches anything that escapes.

## Audit

[`OVERNIGHT_AUDIT_REPORT.md`](OVERNIGHT_AUDIT_REPORT.md) records a full QA pass —
functional E2E, accessibility, performance, and security — including the crash-class
import bug it found and fixed, and the nine accessibility fixes that followed.
