# -*- coding: utf-8 -*-
"""End-to-end test of plastic_manager.html in a real (headless) Chrome, on a synthetic ledger.

    python tests/e2e_app.py            # needs: pip install playwright  (uses the installed Chrome)

Covers: empty start, loading a file, the accounting (checked against an independent re-computation in
Python), every screen, the main forms (purchase, sale, expense, collection, supplier payment), validation,
delete + undo, save/load round trip, a hostile import (null records, text in number fields, HTML in every
text field), the review inbox (paste -> review -> approve / reject), distribution with partner draws,
party deletion guards, the phone layout, the theme, and the existing AI advisor against a mocked provider.
"""
import copy
import json
import sys

from playwright.sync_api import sync_playwright

import synthetic_ledger
from _harness import Report, go, load_ledger, open_app, serve, set_field

VIEWS = ['dashboard', 'followup', 'purchases', 'sales', 'inventory', 'contacts', 'expenses', 'accounts', 'drafts', 'pl', 'balance', 'distribution', 'ai']
XSS = '<img src=x onerror="window.__xss=(window.__xss||0)+1">'


def hostile(ledger):
    """The same ledger after a careless / malicious edit: junk records, text where numbers go, HTML in every string."""
    bad = copy.deepcopy(ledger)

    def poison(o):
        if isinstance(o, dict):
            for k, v in list(o.items()):
                if isinstance(v, str) and k not in ('unit', 'kind', 'status', 'type', 'billOn', 'role', 'source'):
                    o[k] = XSS + v
                else:
                    poison(v)
        elif isinstance(o, list):
            for x in o:
                poison(x)
    poison(bad)
    bad['materials'] = [XSS + m for m in ledger['materials']] + [None, 5]
    for p in bad['purchases']:
        p['material'] = XSS + [x for x in ledger['purchases'] if x['id'] == p['id']][0]['material']
    for k in ('purchases', 'sales', 'expenses', 'collections', 'suppliers', 'customers', 'partners', 'drafts'):
        bad[k] = [None, 'x', 7] + bad[k]
    bad['purchases'][3]['qty'] = 'عشرة'
    bad['sales'][3]['price'] = None
    bad['expenses'][3]['amount'] = 'NaN'
    bad['capital'] = 'abc'
    bad['closings'] = [{'id': 9001, 'date': XSS, 'note': XSS, 'net': 'x', 'cash': None}]
    return bad


def main():
    rep = Report('e2e_app')
    ledger = synthetic_ledger.build()
    ref = synthetic_ledger.reference_books(ledger)
    srv = serve()
    with sync_playwright() as pw:
        browser, ctx, page, errors = open_app(pw)

        # ── 1. empty start ──
        rep.check('starts on an empty ledger with a welcome hint', 'مرحباً' in page.inner_text('#content'))
        rep.check('twelve or more screens in the menu', page.locator('#nav .nav-btn').count() >= 12)
        rep.check('no script errors on load', not errors, str(errors))

        # ── 2. load the synthetic ledger; the books must match an independent calculation ──
        load_ledger(page, ledger)
        c = page.evaluate('(() => { const c = computed(), k = computedCash(); return {rev: c.totalRev, cogs: c.cogs, net: c.net, inv: c.inventoryValue, cash: k.cashBalance, rec: k.receivable, pay: k.payable, stock: Object.fromEntries(c.invRows.map(r => [r.m, r.stock])), avg: Object.fromEntries(c.invRows.map(r => [r.m, r.avgCost]))}; })()')
        rep.near('revenue matches the reference books', c['rev'], ref['revenue'])
        rep.near('cost of goods sold (weighted average) matches', c['cogs'], ref['cogs'], 1)
        rep.near('net profit matches', c['net'], ref['net'], 1)
        rep.near('inventory value matches', c['inv'], ref['inventoryValue'], 1)
        rep.near('cash balance matches', c['cash'], ref['cash'])
        rep.near('receivables match', c['rec'], ref['receivable'])
        rep.near('payables match', c['pay'], ref['payable'])
        rep.check('stock per material matches', all(abs(c['stock'][m] - ref['stock'][m]) < 0.01 for m in ref['stock']), str(c['stock']))
        rep.check('average cost per material matches', all(abs(c['avg'][m] - ref['avg'][m]) < 0.01 for m in ref['avg']))
        ident = page.evaluate('(() => { const c = computed(), k = computedCash(); const assets = k.cashBalance + k.receivable + k.invValue + k.traderOut + k.workerOut + k.partnerDrawsOut; const claims = k.payable + k.partnerLoans + k.equity; return [assets, claims]; })()')
        rep.near('balance sheet balances (assets = liabilities + equity)', ident[0], ident[1], 1)
        whole = page.evaluate('(() => { const a = computed(), b = computedPL("", ""); return [a.net, b.net, a.cogs, b.cogs]; })()')
        rep.check('the P&L with no period equals the all-time figures', abs(whole[0] - whole[1]) < 0.01 and abs(whole[2] - whole[3]) < 0.01)

        # ── 3. every screen renders, by clicking the real menu ──
        before = len(errors)
        for i in range(page.locator('#nav .nav-btn').count()):
            page.locator('#nav .nav-btn').nth(i).click()
            page.wait_for_timeout(60)
            rep.check(f'screen "{page.inner_text("#view-title")}" renders', len(page.inner_text('#content')) > 20)
        rep.check('no script errors while visiting every screen', len(errors) == before, str(errors[before:]))

        # ── 4. forms ──
        n0 = page.evaluate('[DB.purchases.length, DB.sales.length, DB.expenses.length, DB.collections.length, DB.supplierPayments.length]')
        go(page, 'purchases')
        page.get_by_role('button', name='+ إضافة مشتريات').click()
        page.click('#save-btn')                                           # empty form: must be refused
        rep.check('an empty purchase is refused with field errors', page.locator('#modal-body .field-error').count() >= 2 and page.evaluate('DB.purchases.length') == n0[0])
        set_field(page, 'material', 'PP'); set_field(page, 'qty', '1200'); set_field(page, 'price', '45'); set_field(page, 'paid', '20000')
        rep.check('the impact panel previews the change before saving', 'مخزون' in page.inner_text('#impact-panel'))
        page.click('#save-btn')
        rep.check('a valid purchase is saved', page.evaluate('DB.purchases.length') == n0[0] + 1 and not page.locator('#modal-overlay.open').count())
        rep.near('stock of PP went up by the purchase', page.evaluate('computed().invRows.find(r => r.m === "PP").stock'), ref['stock']['PP'] + 1200, 0.01)
        rep.check('the save state shows unsaved changes', page.inner_text('#save-state-txt') == 'تغييرات غير محفوظة')

        page.evaluate('openModal("sale")')
        set_field(page, 'material', 'PP'); set_field(page, 'qty', '700'); set_field(page, 'price', '47'); set_field(page, 'paid', '10000')
        page.click('#save-btn')
        rep.check('a valid sale is saved', page.evaluate('DB.sales.length') == n0[1] + 1)
        page.evaluate('openModal("sale")')
        set_field(page, 'material', 'PVC'); set_field(page, 'qty', '999999'); set_field(page, 'price', '30')
        page.wait_for_timeout(350)
        rep.check('selling more than the stock raises a warning in the impact panel', 'بالسالب' in page.inner_text('#impact-panel'))
        page.evaluate('closeModal()')

        page.evaluate('openModal("expense")'); set_field(page, 'desc', 'اختبار'); set_field(page, 'amount', '-5'); page.click('#save-btn')
        rep.check('a negative expense is refused', page.evaluate('DB.expenses.length') == n0[2])
        set_field(page, 'amount', '250'); page.click('#save-btn')
        rep.check('a valid expense is saved', page.evaluate('DB.expenses.length') == n0[2] + 1)
        page.evaluate('openModal("collection")'); set_field(page, 'amount', '5000'); page.click('#save-btn')
        page.evaluate('openModal("supplierPay")'); set_field(page, 'amount', '7000'); page.click('#save-btn')
        rep.check('a collection and a supplier payment are saved', page.evaluate('[DB.collections.length, DB.supplierPayments.length]') == [n0[3] + 1, n0[4] + 1])
        k2 = page.evaluate('computedCash().cashBalance')
        rep.near('cash moved by exactly the cash parts of the new records', k2, ref['cash'] - 20000 + 10000 - 250 + 5000 - 7000)

        # edit keeps the id and the position
        first = page.evaluate('({id: DB.expenses[0].id, n: DB.expenses.length})')
        page.evaluate('openEditModal("expense", DB.expenses[0])'); set_field(page, 'amount', '8100'); page.click('#save-btn')
        rep.check('editing a record updates it in place', page.evaluate('[DB.expenses[0].id, DB.expenses[0].amount, DB.expenses.length]') == [first['id'], 8100, first['n']])

        # ── 5. delete + undo ──
        go(page, 'expenses')
        page.locator('#content .del-btn').first.click()
        rep.check('deleting an expense removes it', page.evaluate('DB.expenses.length') == first['n'] - 1)
        page.click('#toast-undo')
        rep.check('undo puts it back', page.evaluate('DB.expenses.length') == first['n'])

        # ── 6. save / load round trip ──
        same = page.evaluate('(() => { const a = JSON.stringify([computed().net, computedCash().cashBalance, DB.purchases.length]); const t = JSON.stringify(buildPayload()); loadJsonText(t, "roundtrip"); return a === JSON.stringify([computed().net, computedCash().cashBalance, DB.purchases.length]); })()')
        rep.check('a saved file loads back to the same books', same)
        rep.check('the saved file never carries the AI key or the service token', page.evaluate('(() => { AI.keys.gemini = "SECRET-KEY"; DS.token = "SECRET-TOKEN"; const t = JSON.stringify(buildPayload()); AI.keys.gemini = ""; DS.token = ""; return !/SECRET/.test(t); })()'))
        page.reload(); page.wait_for_selector('#nav .nav-btn')
        rep.check('a reload restores the unsaved work from the browser', page.evaluate('DB.purchases.length') == n0[0] + 1)

        # ── 7. review inbox ──
        load_ledger(page, ledger)
        go(page, 'drafts')
        rep.check('the menu shows how many drafts are waiting', '(2)' in page.locator('#nav .nav-btn', has_text='صندوق المراجعة').inner_text())
        page.evaluate('openModal("draftPaste")'); set_field(page, 'text', 'not json'); page.click('#save-btn')
        rep.check('pasting something that is not a draft is refused', page.locator('#modal-body .field-error').count() == 1)
        draft = {'type': 'collection', 'submittedBy': 'عز', 'transcript': 'قبضت من ورشة أولاد رزق عشرة آلاف', 'fields': {'party': 'ورشه اولاد رزق', 'amount': 10000}}
        set_field(page, 'text', json.dumps(draft, ensure_ascii=False)); page.click('#save-btn')
        did = page.evaluate('DB.drafts[DB.drafts.length - 1].id')
        rep.check('a pasted draft waits in the inbox and does not touch the books', page.evaluate('DB.drafts.filter(d => d.status === "pending").length') == 3 and page.evaluate('DB.collections.length') == len(ledger['collections']))
        page.evaluate('id => reviewDraft(id)', did)
        rep.check('reviewing opens the normal form, with the party matched despite the spelling', page.evaluate('DB.form.customerId') == ledger['customers'][1]['id'])
        page.click('#save-btn')
        rep.check('saving the form approves the draft and links it to the record', page.evaluate('id => { const d = DB.drafts.find(x => x.id === id), r = DB.collections[DB.collections.length - 1]; return d.status === "approved" && d.ledgerId === r.id && r.draftId === id && r.amount === 10000; }', did))
        pend = page.evaluate('DB.drafts.find(d => d.status === "pending").id')
        page.evaluate('id => rejectDraft(id)', pend); page.click('#save-btn')
        rep.check('a rejection needs a reason', page.evaluate('id => DB.drafts.find(d => d.id === id).status', pend) == 'pending')
        set_field(page, 'note', 'مكررة'); page.click('#save-btn')
        rep.check('a rejected draft is kept with its reason', page.evaluate('id => { const d = DB.drafts.find(x => x.id === id); return d.status === "rejected" && d.review.note === "مكررة"; }', pend))

        # ── 8. distribution absorbs the partner's draw ──
        load_ledger(page, ledger)
        page.evaluate('openModal("distribution")'); set_field(page, 'amount', '30000'); page.click('#save-btn')
        b = page.evaluate('DB.distributions[DB.distributions.length - 1].breakdown')
        rep.check('a distribution splits by share and absorbs the outstanding draw', [x['gross'] for x in b] == [15000, 9000, 6000] and b[1]['drawsAbsorbed'] == 9000 and b[1]['net'] == 0)
        rep.near('cash drops only by what was really paid out', page.evaluate('computedCash().cashBalance'), ref['cash'] - 21000)
        page.evaluate('openModal("distribution")'); set_field(page, 'amount', '99999999'); page.click('#save-btn')
        rep.check('distributing more than the available profit is refused', page.evaluate('DB.distributions.length') == 2)
        page.evaluate('closeModal()')
        page.evaluate('openFundModal("out")'); set_field(page, 'amount', '999999'); page.click('#save-btn')
        rep.check('repaying a partner more than he lent is refused', page.locator('#modal-body .field-error').count() >= 1)
        page.evaluate('closeModal()')

        # ── 9. deleting a party / partner that still has records must not orphan them ──
        load_ledger(page, ledger)
        page.evaluate('(() => { DB.view = "contacts"; DB.cTab = "customers"; render(); })()')
        nC = page.evaluate('DB.customers.length')
        page.locator('#content .del-btn').first.click()
        page.wait_for_timeout(100)
        rep.check('a customer with sales cannot be deleted', page.evaluate('DB.customers.length') == nC)
        go(page, 'distribution')
        page.locator('#content .del-btn').first.click()
        page.wait_for_timeout(100)
        rep.check('a partner with a distribution cannot be deleted', page.evaluate('DB.partners.length') == 3)
        rec_all = page.evaluate('(() => { const t = DB.customers.reduce((a, c) => a + buildCustomerStatement(c).balance, 0); return [t, computedCash().receivable]; })()')
        rep.near('the customers table adds up to the receivables on the balance sheet', rec_all[0], rec_all[1])

        # ── 10. hostile import ──
        before = len(errors)
        ok = page.evaluate('t => loadJsonText(t, "hostile")', json.dumps(hostile(ledger), ensure_ascii=False))
        rep.check('a damaged file still loads', ok)
        for v in VIEWS:
            go(page, v)
        page.evaluate('(() => { DB.view = "contacts"; DB.cTab = "customers"; render(); DB.customers.slice(0, 3).forEach(c => { showCustomerStatement(c); }); DB.suppliers.slice(0, 3).forEach(s => showSupplierStatement(s)); linkedPairs().forEach(({s, c}) => showUnifiedStatement(s, c)); DB.view = "inventory"; DB.invTab = "location"; render(); const o = document.getElementById("stmt-overlay"); if (o) o.remove(); })()')
        page.evaluate('openEditModal("purchase", DB.purchases[0])'); page.evaluate('closeModal()')
        page.evaluate('openEditModal("sale", DB.sales[0])'); page.evaluate('closeModal()')
        page.wait_for_timeout(300)
        rep.check('HTML inside imported text never runs', not page.evaluate('window.__xss'), str(page.evaluate('window.__xss')))
        rep.check('no <img> smuggled into the page', page.evaluate('document.querySelectorAll("img[src=x]").length') == 0)
        rep.check('numbers stay finite after a damaged import', page.evaluate('(() => { const c = computed(), k = computedCash(); return [c.net, c.cogs, k.cashBalance, k.receivable, k.payable, k.equity].every(Number.isFinite); })()'))
        rep.check('no script errors on a damaged file', len(errors) == before, str(errors[before:]))
        rep.check('a file that is not a ledger is refused and the books are untouched', page.evaluate('(() => { const n = DB.purchases.length; return loadJsonText("{\\"hello\\":1}") === false && loadJsonText("garbage") === false && DB.purchases.length === n; })()'))
        rep.check('records without an id get one on load', page.evaluate('(() => { const t = JSON.parse(JSON.stringify(buildPayload())); t.expenses.push({date: "2026-01-01", cat: "نقل", desc: "a", amount: 1}, {date: "2026-01-02", cat: "نقل", desc: "b", amount: 2}); loadJsonText(JSON.stringify(t)); const ids = DB.expenses.map(e => e.id); return ids.every(i => i != null) && new Set(ids).size === ids.length; })()'))

        # ── 11. dates are local, not UTC ──
        rep.check('"today" is the local date', page.evaluate('(() => { const n = new Date(); return today() === `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; })()'))

        # ── 12. theme + the existing AI advisor against a mocked provider ──
        load_ledger(page, ledger)
        page.click('#theme-toggle')
        rep.check('the theme toggles to dark and is remembered', page.evaluate('document.documentElement.getAttribute("data-theme") === "dark" && localStorage.getItem("pm_theme") === "dark"'))
        page.click('#theme-toggle')
        page.evaluate('window.__xss = 0')
        sent = []

        def gemini(route):
            sent.append(route.request.post_data or '')
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'candidates': [{'content': {'parts': [{'text': '## الخلاصة\nالوضع **جيد**.\n\n- بند <script>window.__xss=1</script>\n\n| أ | ب |\n|---|---|\n| 1 | 2 |'}]}, 'finishReason': 'STOP'}]}))
        ctx.route('https://generativelanguage.googleapis.com/**', gemini)
        go(page, 'ai')
        rep.check('with no key the advisor sends nothing and points to the settings', 'لم يتم ضبط مفتاح' in page.inner_text('#content'))
        page.evaluate('(() => { AI.keys.gemini = "test-key"; AI.anonymize = true; AI.scope.partners = true; render(); })()')
        page.locator('.ai-preset').first.click()
        page.wait_for_selector('.ai-out h3')
        rep.check('the advisor shows the reply as formatted text, with markup escaped', page.locator('.ai-out table').count() == 1 and not page.evaluate('window.__xss'))
        body = sent[0] if sent else ''
        rep.check('the advisor sends aggregates only, with names hidden when asked', 'عميل-1' in body and ledger['customers'][0]['name'] not in body and ledger['partners'][0]['name'] not in body)
        page.evaluate('(() => { AI.keys.gemini = ""; aiSave(); })()')

        # ── 13. phone layout ──
        browser.close()
        browser, ctx, page, errors2 = open_app(pw, width=390, height=844, mobile=True)
        load_ledger(page, ledger)
        wide = []
        for v in VIEWS:
            go(page, v)
            page.wait_for_timeout(40)
            if page.evaluate('document.documentElement.scrollWidth > window.innerWidth + 2'):
                wide.append(v)
        rep.check('no screen scrolls sideways on a phone', not wide, str(wide))
        page.evaluate('openModal("purchase")')
        rep.check('the purchase form fits a phone', page.evaluate('document.getElementById("modal-box").getBoundingClientRect().width <= window.innerWidth'))
        rep.check('no script errors on the phone layout', not errors2, str(errors2))
        browser.close()
    srv.shutdown()
    return rep.done()


if __name__ == '__main__':
    sys.exit(main())
