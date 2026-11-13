# -*- coding: utf-8 -*-
"""Round 2 (2026-11-13) regression tests: one or more checks per defect fixed in the second review, plus the customer
credit-limit feature. Headless Chrome on the synthetic ledger; the network is blocked and every "service" or "model" is a
route answered inside the test.

    python tests/e2e_round2.py
"""
import copy
import datetime as dt
import json
import re
import sys

from playwright.sync_api import sync_playwright

import synthetic_ledger
from _harness import Report, go, load_ledger, open_app, serve, set_field

GEMINI = 'https://generativelanguage.googleapis.com/**'


def py_customer_balance(db, cid):
    """Independent of the app: what a customer owes = sales (qty x price - discount - cash paid in the deal) - collections."""
    s = sum(r['qty'] * r['price'] - (r.get('discount') or 0) - r['paid'] for r in db['sales'] if r['customerId'] == cid)
    return round(s - sum(r['amount'] for r in db['collections'] if r['customerId'] == cid), 2)


def model_reply(route_list, make_text):
    """A scripted Gemini: make_text(items_sent) -> the JSON text the 'model' answers."""
    def handler(route):
        body = route.request.post_data or ''
        route_list.append(body)
        items = json.loads(json.loads(body)['contents'][0]['parts'][0]['text'])['البنود']
        route.fulfill(status=200, content_type='application/json',
                      body=json.dumps({'candidates': [{'content': {'parts': [{'text': make_text(items)}]}, 'finishReason': 'STOP'}]}, ensure_ascii=False))
    return handler


def main():
    rep = Report('e2e_round2')
    today = dt.date.today()
    ledger = synthetic_ledger.build(today)
    C = [c['id'] for c in ledger['customers']]
    srv = serve()
    with sync_playwright() as pw:
        browser, ctx, page, errors = open_app(pw)
        load_ledger(page, ledger)

        # ── R2-02: an AI sentence written this morning must not survive a change in the books ──
        go(page, 'followup')
        page.evaluate('''id => { FU.brief = {day: today(), at: new Date().toISOString(), provider: "gemini", model: "x",
            headline: "حصّل ٥٦٬٠٠٠ من ورشة أولاد رزق الأول.", order: [], tips: {["rec:" + id]: "حصّل الـ ٥٦٬٠٠٠ النهارده قبل أي شراء."}, dropped: 0};
            render(); }''', C[1])
        sel = f'.fu-item[data-id="rec:{C[1]}"] .fu-rec'
        rep.check('R2-02 a model sentence that still matches the books is shown', '✨' in page.inner_text(sel) and '٥٦٬٠٠٠' in page.inner_text('#fu-headline'))
        page.evaluate('id => { DB.collections = [...DB.collections, {id: uid(), date: today(), customerId: id, amount: 10000, note: ""}]; render(); }', C[1])
        tip_after = page.inner_text(sel)
        rep.check('R2-02 after a 10,000 collection the old sentence (56,000) is replaced by the computed advice', '💡' in tip_after and '٥٦٬٠٠٠' not in tip_after, tip_after)
        rep.check('R2-02 the old AI headline quoting 56,000 is replaced by the computed one', '٥٦٬٠٠٠' not in page.inner_text('#fu-headline') and 'أهم حاجة' in page.inner_text('#fu-headline'), page.inner_text('#fu-headline'))
        page.evaluate('(() => { FU.brief = null; fuSave(); })()')
        load_ledger(page, ledger)

        # ── R2-03: names hidden from the model come back as the right names (طرف-12 is not طرف-1 + "2") ──
        big = copy.deepcopy(ledger)
        letters = ['ألف', 'باء', 'تاء', 'ثاء', 'جيم', 'حاء', 'خاء', 'دال', 'ذال', 'راء', 'زاي']
        extra = [('مكتب حسن الكبير', 900000), ('مكتب حسن', 880000)] + [(f'تاجر {x}', 800000 - i * 1000) for i, x in enumerate(letters)]
        for i, (name, amt) in enumerate(extra):
            cid = 5000 + i
            big['customers'].append({'id': cid, 'name': name, 'phone': '', 'city': ''})
            big['sales'].append({'id': 6000 + i, 'date': (today - dt.timedelta(days=120)).isoformat(), 'customerId': cid, 'purchaseId': None, 'material': 'HDPE',
                                 'color': '', 'qty': 1, 'unit': 'كيلوجرام', 'price': amt, 'paid': 0, 'waste': 0, 'txExpenses': [], 'actualQty': None,
                                 'billOn': 'contract', 'discount': 0, 'discountPct': None, 'discountNote': '', 'fromLocations': []})
        load_ledger(page, big)
        go(page, 'followup')
        sent = []
        picked = {}

        def make_text(items):
            aliased = [(x['id'], re.search(r'طرف-(\d+)', x['الوصف'])) for x in items]
            hi = max((m for _, m in aliased if m), key=lambda m: int(m.group(1)))
            picked['id'], picked['alias'] = [i for i, m in aliased if m is hi][0], hi.group(0)
            return json.dumps({'headline': 'ابدأ بالتحصيل.', 'order': [], 'tips': {picked['id']: f'كلّم {picked["alias"]} النهارده.'}}, ensure_ascii=False)
        ctx.route(GEMINI, model_reply(sent, make_text))
        page.evaluate('(() => { AI.keys.gemini = "test-key"; AI.provider = "gemini"; AI.anonymize = true; render(); })()')
        page.click('#fu-ai-btn')
        page.wait_for_function('FU.brief && !FU.busy')
        text_sent = json.loads(sent[0])['contents'][0]['parts'][0]['text']
        rep.check('R2-03 at least ten names were hidden (aliases up to طرف-10 or more)', int(picked['alias'].split('-')[1]) >= 10, picked)
        rep.check('R2-03 a name that contains another name is hidden whole (no "طرف-n الكبير")', 'الكبير' not in text_sent and 'مكتب حسن' not in text_sent)
        want = page.evaluate('id => fuNow().items.find(x => x.id === id).name', picked['id'])
        got = page.inner_text(f'.fu-item[data-id="{picked["id"]}"] .fu-rec')
        rep.check(f'R2-03 the model\'s «{picked["alias"]}» is shown as the right name', got.strip() == f'✨ كلّم {want} النهارده.', f'{got!r} vs {want!r}')
        ctx.unroute(GEMINI)
        page.evaluate('(() => { FU.brief = null; AI.keys.gemini = ""; AI.anonymize = false; fuSave(); aiSave(); })()')
        load_ledger(page, ledger)

        # ── R2-04: a credit-days value of 0 is refused instead of silently becoming the default ──
        page.evaluate('openModal("customer")')
        set_field(page, 'name', 'عميل اختبار المهلة')
        set_field(page, 'creditDays', '0')
        page.click('#save-btn')
        rep.check('R2-04 credit days 0 is refused with a message, nothing saved', page.evaluate('DB.modal') == 'customer' and 'من 1 لـ 365' in page.inner_text('#modal-body')
                  and not page.evaluate('DB.customers.some(c => c.name === "عميل اختبار المهلة")'))
        rep.check('R2-01 the error is tied to its field for screen readers (aria-invalid + aria-describedby)',
                  page.evaluate('(() => { const i = document.querySelector("#modal-body [data-key=creditDays]"); const d = document.getElementById(i.getAttribute("aria-describedby") || "x"); return i.getAttribute("aria-invalid") === "true" && !!d && d.textContent.includes("365") && i.labels.length === 1; })()'))
        page.evaluate('closeModal()')

        # ── R2-05: a refused owner token stops the background pulls (the service would lock the whole address out) ──
        hits = []
        state = {'status': 401}
        ctx.route('http://svc.r2.test/**', lambda r: (hits.append(r.request.url), r.fulfill(status=state['status'], content_type='application/json',
                                                     body=json.dumps({'error': 'رمز المالك غلط'} if state['status'] != 200 else []))))
        page.evaluate('(() => { DS.url = "http://svc.r2.test"; DS.token = "old-token"; DS.autoPull = true; DS.authPaused = false; })()')
        page.evaluate('dsPull(true)'); page.wait_for_function('!DS.busy'); page.wait_for_timeout(200)
        rep.check('R2-05 a background pull refused with 401 pauses the background pulls and says why', page.evaluate('DS.authPaused') is True and 'وقف' in page.inner_text('#toast-msg'))
        for _ in range(3):
            page.evaluate('document.dispatchEvent(new Event("visibilitychange"))')
        page.evaluate('dsPushSnapshot(true)')
        page.wait_for_timeout(300)
        rep.check('R2-05 while paused, returning to the tab or saving sends nothing more with the refused token', len(hits) == 1, hits)
        state['status'] = 200
        page.evaluate('dsPull()'); page.wait_for_function('!DS.busy'); page.wait_for_timeout(200)
        rep.check('R2-05 a pull by hand that works resumes the background pulls', page.evaluate('DS.authPaused') is False and len(hits) == 2)
        page.evaluate('(() => { DS.url = ""; DS.token = ""; DS.autoPull = false; dsSave(); })()')

        # ── R2-06: the impact panel follows the customer picked in the sale form (it compared with the first customer) ──
        page.evaluate('openModal("sale")')
        page.locator('#modal-body [data-key="customerId"]').select_option(str(C[3]))
        set_field(page, 'qty', '1')
        set_field(page, 'price', '1000')
        set_field(page, 'paid', '0')
        page.wait_for_timeout(250)
        party = page.inner_text('#impact-panel .imp-party')
        b3 = py_customer_balance(ledger, C[3])
        nums0 = lambda v: f'{round(v):,}'.replace(',', '٬').translate(str.maketrans('0123456789', '٠١٢٣٤٥٦٧٨٩'))
        rep.check(f'R2-06 after picking another customer the panel shows HIS balance before ({b3:,.0f}) and +1,000 after',
                  f'كان: {nums0(b3)}' in party and nums0(b3 + 1000) in party and '▲' in party and 'قلّ' not in party, party)
        page.locator('#modal-body [data-key="material"]').select_option('PP')
        page.wait_for_timeout(250)
        rep.check('R2-06 after picking another material the stock line moves by the sold quantity only',
                  page.evaluate('(() => { const r = [...document.querySelectorAll("#impact-panel .imp-row")].find(x => x.textContent.includes("مخزون PP")); return !!r && /قلّ\\s*1\\s/.test(r.textContent.replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d))); })()'),
                  page.inner_text('#impact-panel')[:400])
        page.evaluate('closeModal()')

        # ── F1: customer credit limit ──
        hostile = copy.deepcopy(ledger)
        hostile['customers'][0]['creditLimit'] = 'abc'
        hostile['customers'][1]['creditLimit'] = -5
        hostile['customers'][2]['creditLimit'] = '0'
        hostile['customers'][3]['creditLimit'] = 50000
        hostile['customers'][4]['creditLimit'] = None
        load_ledger(page, hostile)
        lims = page.evaluate('DB.customers.map(c => c.creditLimit)')
        rep.check('F1 a credit limit that is text or negative is dropped on load, "0" means cash only, a file without it is unchanged', lims[:6] == [None, None, 0, 50000, None, None] and 'creditLimit' not in page.evaluate('DB.customers[5]'), lims)
        bal3 = py_customer_balance(ledger, C[3])
        go(page, 'followup')
        item = page.locator(f'.fu-item[data-id="limit:{C[3]}"]')
        title = item.locator('.fu-title').inner_text() if item.count() else ''
        nums = lambda v: f'{round(v):,}'.replace(',', '٬').translate(str.maketrans('0123456789', '٠١٢٣٤٥٦٧٨٩'))
        rep.check(f'F1 a customer above his limit is an urgent follow-up item with the right figures (owes {bal3:,.0f}, limit 50,000)',
                  item.count() == 1 and nums(bal3) in title and nums(50000) in title and 'عاجل' in title and nums(bal3 - 50000) in item.locator('.fu-detail').inner_text(), title)
        rep.check('F1 a customer under his limit (or with no limit) gets no limit item', page.locator('.fu-item[data-id^="limit:"]').count() == (1 + (1 if py_customer_balance(ledger, C[2]) > 0.5 else 0)))
        # the form: save a limit, edit it back, refuse a bad one
        page.evaluate(f'openEditModal("customer", DB.customers.find(c => c.id === {C[0]}))')
        set_field(page, 'creditLimit', '-10')
        page.click('#save-btn')
        rep.check('F1 a negative limit is refused in the form', page.evaluate('DB.modal') == 'customer' and 'حد الائتمان' in page.inner_text('#modal-body'))
        set_field(page, 'creditLimit', '0')
        page.click('#save-btn')
        rep.check('F1 a limit of 0 (cash only) is saved as 0', page.evaluate(f'DB.customers.find(c => c.id === {C[0]}).creditLimit') == 0 and not page.evaluate('DB.modal'))
        page.evaluate(f'openEditModal("customer", DB.customers.find(c => c.id === {C[0]}))')
        rep.check('F1 editing that customer shows "0", not an empty box (saving again keeps the limit)', page.locator('#modal-body [data-key="creditLimit"]').input_value() == '0')
        set_field(page, 'creditLimit', '')
        page.click('#save-btn')
        rep.check('F1 emptying the box removes the limit', page.evaluate(f'DB.customers.find(c => c.id === {C[0]}).creditLimit') is None)
        # the sale form warns before a credit sale goes over the limit, and about late debts
        page.evaluate('openModal("sale")')
        set_field(page, 'customerId', str(C[3]))
        set_field(page, 'qty', '1')
        set_field(page, 'price', '10000')
        set_field(page, 'paid', '0')
        page.wait_for_timeout(250)
        warn = page.inner_text('#impact-panel')
        rep.check('F1 the sale form warns that this credit sale takes the customer over his limit, with the amounts', 'فوق حد الائتمان' in warn and '٥٠٬٠٠٠' in warn, warn[:300])
        set_field(page, 'paid', '10000000')
        page.wait_for_timeout(250)
        rep.check('F1 a sale paid in full (nothing added to the account) gives no limit warning', 'فوق حد الائتمان' not in page.inner_text('#impact-panel'))
        page.evaluate('closeModal()')
        page.evaluate('openModal("sale")')
        set_field(page, 'customerId', str(C[1]))
        set_field(page, 'qty', '1')
        set_field(page, 'price', '1000')
        set_field(page, 'paid', '0')
        page.wait_for_timeout(250)
        rep.check('F1 a credit sale to a customer with late debts says how much is late and since when', 'فات ميعادها' in page.inner_text('#impact-panel') and '٥٦٬٠٠٠' in page.inner_text('#impact-panel'), page.inner_text('#impact-panel')[:300])
        page.evaluate('closeModal()')
        # saved in the ledger file and back
        payload = page.evaluate('JSON.stringify(buildPayload())')
        load_ledger(page, json.loads(payload))
        rep.check('F1 the limit is saved in the data file and read back', page.evaluate(f'DB.customers.find(c => c.id === {C[3]}).creditLimit') == 50000)
        errors = [e for e in errors if 'status of 401' not in e]      # the refused token above is the browser's own log line, expected
        rep.check('no script errors in the round-2 checks', not errors, str(errors[:3]))
        browser.close()
    srv.shutdown()
    return rep.done()


if __name__ == '__main__':
    sys.exit(main())
