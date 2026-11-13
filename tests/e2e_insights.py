# -*- coding: utf-8 -*-
"""End-to-end test of the follow-up centre (المتابعة والتنبيهات) in a real headless Chrome.

    python tests/e2e_insights.py

What it proves:
  * ages of debts, overdue amounts, idle stock, cost changes and free cash equal an independent calculation in Python;
  * thresholds, per-party credit days, snoozes and the owner's own follow-up dates behave and persist where they should
    (thresholds/snoozes on the device, follow-up dates in the ledger file);
  * the WhatsApp reminder is built from the account and never sent by the app;
  * the AI wording is optional: with no key nothing leaves the browser; with a (mocked) model the order and the
    sentences are used, but a sentence that quotes a number the code did not compute is refused.
"""
import datetime as dt
import json
import sys

from playwright.sync_api import sync_playwright

import synthetic_ledger
from _harness import Report, go, load_ledger, open_app, serve, set_field


def py_aging(db, kind, pid, today, terms=30):
    """The same rule as the app, written separately: cash inside a deal settles that deal; payments on account settle the oldest open deal first."""
    is_c = kind == 'customer'
    key = 'customerId' if is_c else 'supplierId'
    deals = sorted([r for r in db['sales' if is_c else 'purchases'] if r[key] == pid], key=lambda r: (r['date'], r['id']))
    pool = sum(r['amount'] for r in db['collections' if is_c else 'supplierPayments'] if r[key] == pid)
    lefts = []
    for r in deals:
        left = r['qty'] * r['price'] - (r.get('discount') or 0) - r['paid']
        if left < 0:
            pool += -left
            left = 0
        lefts.append([r['date'], left])
    open_ = []
    for date, left in lefts:
        use = min(pool, left)
        pool -= use
        if left - use > 0.005:
            open_.append((date, round(left - use, 2), (today - dt.date.fromisoformat(date)).days))
    return {'balance': round(sum(o[1] for o in open_) - pool, 2), 'overdue': round(sum(o[1] for o in open_ if o[2] > terms), 2),
            'oldestDays': open_[0][2] if open_ else 0, 'open': open_}


def main():
    rep = Report('e2e_insights')
    today = dt.date.today()
    ledger = synthetic_ledger.build(today)
    ref = synthetic_ledger.reference_books(ledger)
    C = [c['id'] for c in ledger['customers']]
    S = [s['id'] for s in ledger['suppliers']]
    srv = serve()
    with sync_playwright() as pw:
        browser, ctx, page, errors = open_app(pw)
        calls = []
        ctx.route('https://generativelanguage.googleapis.com/**', lambda route: (calls.append(route.request.post_data or ''), route.abort()))

        # ── empty ledger ──
        go(page, 'followup')
        rep.check('on an empty ledger the screen explains itself and shows no alerts', 'سجّل مشترياتك' in page.inner_text('#content') and page.locator('.fu-item').count() == 0)
        for t in ['aging', 'margins', 'reminders', 'settings', 'today']:
            page.locator(f'.tab-btn[data-tab="{t}"]').click()
        rep.check('every tab renders on an empty ledger', not errors, str(errors))

        load_ledger(page, ledger)
        go(page, 'followup')

        # ── 1. ages of debts against an independent calculation ──
        ok_all, detail = True, ''
        for kind, ids in (('customer', C), ('supplier', S)):
            for pid in ids:
                want = py_aging(ledger, kind, pid, today)
                got = page.evaluate('([k, id]) => { const p = (k === "customer" ? DB.customers : DB.suppliers).find(x => x.id === id); const a = partyAging(k, p); const st = k === "customer" ? buildCustomerStatement(p).balance : buildSupplierStatement(p).balance; return {balance: a.balance, overdue: a.overdue, oldestDays: a.oldestDays, n: a.open.length, st, buckets: a.buckets.reduce((x, y) => x + y, 0)}; }', [kind, pid])
                if not (abs(got['balance'] - want['balance']) < 0.01 and abs(got['overdue'] - want['overdue']) < 0.01 and got['oldestDays'] == want['oldestDays']
                        and got['n'] == len(want['open']) and abs(got['balance'] - got['st']) < 0.01 and abs(got['buckets'] - sum(o[1] for o in want['open'])) < 0.01):
                    ok_all, detail = False, f'{kind} {pid}: {got} vs {want}'
        rep.check('ages, overdue amounts and balances of all 11 parties match the reference and the statements', ok_all, detail)
        a2 = page.evaluate('id => partyAging("customer", DB.customers.find(c => c.id === id))', C[1])
        rep.check('worked example: the workshop owes 117,000, of which 56,000 is 100 days old', a2['balance'] == 117000 and a2['overdue'] == 56000 and a2['oldestDays'] == 100 and a2['buckets'] == [61000, 0, 0, 56000])
        a1 = page.evaluate('id => partyAging("customer", DB.customers.find(c => c.id === id)).open.map(o => [o.left, o.days])', C[0])
        rep.check('payments on account settle the oldest invoice first', a1 == [[39500, 48], [72000, 25]], str(a1))

        # ── 2. the list ──
        R = page.evaluate('(() => { const R = buildInsights(); return {ids: R.items.map(x => x.id), sev: R.items.map(x => x.sev), urgent: R.urgent, o: R.outlook, titles: Object.fromEntries(R.items.map(x => [x.id, x.title + " | " + x.detail + " | " + x.rec]))}; })()')
        ids = R['ids']
        rank = {'high': 0, 'med': 1, 'low': 2}
        rep.check('urgent items come first', [rank[s] for s in R['sev']] == sorted(rank[s] for s in R['sev']))
        rep.check('the four late customers are on the collection list, the two on time are not', all(f'rec:{C[i]}' in ids for i in (0, 1, 2, 4)) and f'rec:{C[3]}' not in ids and f'rec:{C[5]}' not in ids)
        rep.check('a debt older than 90 days is marked urgent', R['sev'][ids.index(f'rec:{C[1]}')] == 'high' and R['sev'][ids.index(f'rec:{C[0]}')] == 'med')
        rep.check('the three suppliers we are late with are listed; the two paid within their credit days are not', all(f'pay:{S[i]}' in ids for i in (0, 2, 3)) and f'pay:{S[1]}' not in ids and f'paysoon:{S[4]}' not in ids)
        rep.check('idle stock: the material never sold for 105 days', 'slow:PVC' in ids and '105' in R['titles']['slow:PVC'].translate(str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789')) and not any(i.startswith('slow:') and i != 'slow:PVC' for i in ids))
        rep.check('selling under cost is flagged for the right material only', 'loss:PET' in ids and [i for i in ids if i.startswith('loss:')] == ['loss:PET'])
        rep.check('a rising purchase price is flagged (PP, HDPE, ABS, PET) and a small move is not (LDPE)', {i for i in ids if i.startswith('costup:')} == {'costup:PP', 'costup:HDPE', 'costup:ABS', 'costup:PET'})
        pp = page.evaluate('materialStats().find(t => t.m === "PP")')
        rep.check('PP: last purchase 44.5 against a weighted 39.06 before it = +13.9%', abs(pp['lastCost'] - 44.5) < 1e-9 and abs(pp['prevCost'] - 332000 / 8500) < 1e-6 and pp['costChangePct'] == 13.9)
        rep.near('PP: margin = (average selling price - average cost) / selling price', pp['marginPct'], round((351000 / 8000 - ref['avg']['PP']) / (351000 / 8000) * 100, 1), 0.051)
        rep.check('housekeeping: drafts waiting, an old advance with a trader, an old float with a worker, a partner loan', all(x in ids for x in ['drafts']) and any(i.startswith('adv:') for i in ids) and any(i.startswith('wl:') for i in ids) and any(i.startswith('loan:') for i in ids))
        linked = R['titles'].get(f'pay:{S[4]}', '') + R['titles'].get(f'paysoon:{S[4]}', '')
        rep.check('no overdue item for a supplier paid within his credit days', linked == '')

        # ── 3. cash ──
        o = R['o']
        opex90 = sum(e['amount'] for e in ledger['expenses'] if (today - dt.date.fromisoformat(e['date'])).days <= 90) + sum(sum(x['amount'] for x in r['txExpenses']) for r in ledger['purchases'] + ledger['sales'] if (today - dt.date.fromisoformat(r['date'])).days <= 90)
        rep.check('overdue receivables and overdue payables add up', o['recOverdue'] == 238800 and o['payOverdue'] == 198000, str(o))
        rep.near('average monthly expenses = last 90 days / 3', o['monthlyOpex'], opex90 / 3, 1)
        avail = ref['net'] - 20000
        rep.near('free cash = cash - overdue supplier dues - one month of expenses', o['freeCash'], ref['cash'] - 198000 - opex90 / 3, 2)
        rep.near('safe distribution = the smaller of available profit and free cash, never below zero', o['safeDist'], max(0, min(avail, ref['cash'] - 198000 - opex90 / 3)), 2)
        rep.check('the distribution item says whether the profit is really in the till', 'dist' in ids)
        go(page, 'distribution')
        rep.check('the distribution screen quotes the same safe amount', page.locator('#fu-safe-dist').count() == 1 and page.evaluate('fuMoney(buildInsights().outlook.safeDist)') in page.inner_text('#fu-safe-dist'))
        page.evaluate('(() => { DB.capital = 700000 - (computedCash().cashBalance - 100000); render(); })()')        # leave exactly 100,000 in the till
        r2 = page.evaluate('(() => { const R = buildInsights(); return {ids: R.items.map(x => x.id), o: R.outlook}; })()')
        rep.check('with a thin till: cash below overdue supplier dues is the first, urgent item', r2['ids'][0] == 'cashgap' and r2['o']['gap'] == r2['o']['payOverdue'] - r2['o']['cash'] and r2['o']['safeDist'] == 0)
        page.evaluate('(() => { DB.capital = 700000; render(); })()')

        # ── 4. dashboard card + menu badge ──
        go(page, 'dashboard')
        badge = page.locator('#nav .nav-btn', has_text='المتابعة والتنبيهات').inner_text()
        rep.check('the menu badge counts the urgent and important items', f'({R["urgent"]})' in badge, badge)
        rep.check('the dashboard shows the top three items and a way to the full list', page.locator('.fu-dash .fu-item').count() == 3)
        page.locator('.fu-dash button', has_text='عرض الكل').click()
        rep.check('"show all" opens the follow-up screen', page.inner_text('#view-title') == 'المتابعة والتنبيهات' and page.locator('.fu-item').count() == len(ids))

        # ── 5. one-click actions ──
        page.locator(f'.fu-item[data-id="rec:{C[1]}"] button', has_text='+ تحصيل').click()
        rep.check('"+ تحصيل" opens the collection form on that customer', page.evaluate('DB.modal') == 'collection' and page.evaluate('DB.form.customerId') == C[1])
        page.evaluate('closeModal()')
        page.locator(f'.fu-item[data-id="rec:{C[1]}"] button', has_text='كشف الحساب').click()
        rep.check('"كشف الحساب" opens the statement', page.locator('#stmt-overlay').count() == 1)
        page.keyboard.press('Escape')

        # ── 6. WhatsApp reminder ──
        page.locator(f'.fu-item[data-id="rec:{C[1]}"] button', has_text='رسالة تذكير').click()
        msg = page.input_value('#fu-msg')
        rep.check('the reminder quotes the balance, the overdue part and the oldest invoice date from the account', 'ورشة أولاد رزق' in msg and '١١٧٬٠٠٠' in msg and '٥٦٬٠٠٠' in msg and f'{(today - dt.timedelta(days=100)).day}/' in msg, msg)
        href = page.get_attribute('#fu-wa', 'href')
        rep.check('the WhatsApp link uses the Egyptian number in international form and opens in a new tab', href.startswith('https://wa.me/201000000202?text=') and page.get_attribute('#fu-wa', 'target') == '_blank')
        page.fill('#fu-msg', 'نص معدّل')
        rep.check('editing the text updates what the link will open', 'text=%D9%86%D8%B5' in page.get_attribute('#fu-wa', 'href'))
        page.locator('#stmt-overlay button', has_text='سجّل ميعاد متابعة').click()
        rep.check('a follow-up date can be booked straight from the reminder', page.evaluate('DB.modal') == 'reminder' and page.evaluate('DB.form.party') == f'c:{C[1]}')
        page.click('#save-btn')
        rep.check('the follow-up date is saved on the customer, three days ahead', page.evaluate('(() => { const r = DB.reminders[0]; return r && r.partyKind === "customer" && r.done === false && r.date === addDays(today(), 3) ? r.partyId : null; })()') == C[1])
        page.evaluate('id => fuOpenMessage(DB.customers.find(c => c.id === id))', C[4])
        rep.check('a customer with no mobile number gets copy-only', page.locator('#fu-wa').count() == 0 and page.locator('#fu-msg').count() == 1)
        page.keyboard.press('Escape')
        rep.check('phone numbers: local, international and Arabic digits are understood, junk is not', page.evaluate('[fuPhone("01012345678"), fuPhone("+20 101 234 5678"), fuPhone("٠١٠١٢٣٤٥٦٧٨"), fuPhone("0020 1012345678"), fuPhone("12345"), fuPhone("")]') == ['201012345678', '201012345678', '201012345678', '201012345678', '', ''])

        # ── 7. the owner's own follow-up dates ──
        page.locator('.tab-btn[data-tab="reminders"]').click()
        page.get_by_role('button', name='+ ميعاد جديد').click()
        page.click('#save-btn')
        rep.check('a follow-up date needs a text', page.locator('#modal-body .field-error').count() == 1 and page.evaluate('DB.reminders.length') == 1)
        set_field(page, 'text', 'ميعاد شيك مصنع البركة'); set_field(page, 'date', today.isoformat()); set_field(page, 'party', f'c:{C[3]}')
        page.click('#save-btn')
        rid = page.evaluate('DB.reminders[1].id')
        ins = page.evaluate('buildInsights().items.map(x => [x.id, x.sev, x.title])')
        rep.check('a date due today is on top of the list as urgent; one due in three days is listed for information', [x for x in ins if x[0] == f'rem:{rid}'][0][1] == 'high' and 'ميعاد النهارده' in [x for x in ins if x[0] == f'rem:{rid}'][0][2] and [x for x in ins if x[0].startswith('rem:') and x[0] != f'rem:{rid}'][0][1] == 'low')
        saved = page.evaluate('JSON.stringify(buildPayload())')
        rep.check('follow-up dates are part of the saved file', len(json.loads(saved)['reminders']) == 2)
        page.locator('.tab-btn[data-tab="today"]').click()
        page.locator(f'.fu-item[data-id="rem:{rid}"] button', has_text='✓ تم').click()
        rep.check('"تم" closes it and takes it off the list', page.evaluate('id => DB.reminders.find(r => r.id === id).done', rid) is True and page.locator(f'.fu-item[data-id="rem:{rid}"]').count() == 0)
        page.locator('.tab-btn[data-tab="reminders"]').click()
        page.locator('#content .del-btn').first.click()
        n_after = page.evaluate('DB.reminders.length')
        page.click('#toast-undo')
        rep.check('deleting a follow-up date can be undone', n_after == 1 and page.evaluate('DB.reminders.length') == 2)
        rep.check('a file saved before this feature (no follow-up dates) loads cleanly', page.evaluate('t => { const d = JSON.parse(t); delete d.reminders; d.customers.forEach(c => delete c.creditDays); return loadJsonText(JSON.stringify(d)) && Array.isArray(DB.reminders) && DB.reminders.length === 0 && buildInsights().items.length > 5; }', saved))
        rep.check('a file with follow-up dates loads them back', page.evaluate('t => loadJsonText(t) && DB.reminders.length === 2 && DB.reminders.some(r => r.text === "ميعاد شيك مصنع البركة" && r.partyKind === "customer")', saved))

        # ── 8. a party's own credit days ──
        load_ledger(page, ledger)
        page.evaluate('id => openEditModal("customer", DB.customers.find(c => c.id === id))', C[3])
        set_field(page, 'creditDays', '999'); page.click('#save-btn')
        rep.check('credit days outside 0-365 are refused', page.locator('#modal-body .field-error').count() == 1)
        set_field(page, 'creditDays', '5'); page.click('#save-btn')
        a4 = page.evaluate('id => { const a = partyAging("customer", DB.customers.find(c => c.id === id)); return [a.terms, a.overdue]; }', C[3])
        rep.check('a customer on 5 days of credit is overdue after 5 days, not 30', a4 == [5, 109150] and page.evaluate('id => buildInsights().items.some(x => x.id === "rec:" + id)', C[3]))
        rep.check('the credit days travel with the saved file', page.evaluate('id => { loadJsonText(JSON.stringify(buildPayload())); return DB.customers.find(c => c.id === id).creditDays; }', C[3]) == 5)

        # ── 9. thresholds + snooze live on the device, not in the ledger ──
        load_ledger(page, ledger)
        go(page, 'followup')
        page.locator('.tab-btn[data-tab="settings"]').click()
        page.locator('input[data-fu="custDays"]').fill('120'); page.locator('input[data-fu="custDays"]').dispatch_event('change')
        rep.check('raising the customers\' credit days to 120 clears the collection list', page.evaluate('buildInsights().items.filter(x => x.id.startsWith("rec:")).length') == 0)
        page.locator('input[data-fu="slowDays"]').fill('0'); page.locator('input[data-fu="slowDays"]').dispatch_event('change')
        rep.check('a threshold outside its range is refused', page.evaluate('FU.slowDays') == 45)
        rep.check('thresholds are kept on this device and never written to the ledger file', page.evaluate('JSON.parse(localStorage.getItem("pm_followup")).custDays === 120 && !/custDays|snooze|pm_followup/.test(JSON.stringify(buildPayload()))'))
        page.get_by_role('button', name='رجّع القيم الافتراضية').click()
        page.locator('.tab-btn[data-tab="today"]').click()
        n = page.locator('.fu-item').count()
        first = page.locator('.fu-item').first.get_attribute('data-id')
        page.locator('.fu-item').first.locator('button', has_text='أجّل ٣ أيام').click()
        rep.check('snoozing hides the item', page.locator('.fu-item').count() == n - 1 and page.locator(f'.fu-item[data-id="{first}"]').count() == 0)
        page.reload(); page.wait_for_selector('#nav .nav-btn'); go(page, 'followup')
        rep.check('the snooze survives a reload', page.locator('.fu-item').count() == n - 1 and page.evaluate('buildInsights().snoozed') == 1)
        page.get_by_role('button', name='رجّعهم').click()
        rep.check('"رجّعهم" brings snoozed items back', page.locator('.fu-item').count() == n)

        # ── 10. aging + margins tables ──
        page.locator('.tab-btn[data-tab="aging"]').click()
        row = page.locator(f'table.fu-aging tr[data-id="{C[1]}"]').inner_text()
        tot = page.locator('table.fu-aging').first.locator('tr.fu-total').inner_text()
        rep.check('the aging table shows the buckets per customer and a total equal to the receivables', '٥٦٬٠٠٠' in row and '٦١٬٠٠٠' in row and '١١٧٬٠٠٠' in row and page.evaluate('fuMoney(computedCash().receivable)') in tot, row + ' / ' + tot)
        rep.check('both sides are shown: customers and suppliers', page.locator('table.fu-aging').count() == 2)
        page.locator('.tab-btn[data-tab="margins"]').click()
        rep.check('the margins table has one row per material with stock or movement', page.locator('table.fu-aging tbody tr').count() == 6 and '+١٣٫٩٪' in page.locator('table.fu-aging tr[data-m="PP"]').inner_text())

        # ── 11. AI wording ──
        page.locator('.tab-btn[data-tab="today"]').click()
        base_order = page.evaluate('buildInsights().items.map(x => x.id)')
        rule_head = page.inner_text('#fu-headline')
        rep.check('with no key the list is complete: a computed headline and a rule-based recommendation on every item', 'أهم حاجة النهارده' in rule_head and page.locator('.fu-rec').count() == n)
        page.click('#fu-ai-btn')
        page.wait_for_timeout(200)
        rep.check('with no key, asking for AI wording sends nothing and says where to add a key', not calls and 'مفتاح API' in page.inner_text('#content'))
        rep.check('number guard: a copied number passes, an invented one fails, Arabic and Latin digits are the same number', page.evaluate('[fuNumbersOk("حصّل ٥٦٬٠٠٠ النهارده", "عليه 56,000 جنيه"), fuNumbersOk("حصّل 60000", "عليه ٥٦٬٠٠٠"), fuNumbersOk("كلّمه النهارده", "عليه ٥٦٬٠٠٠"), fuNumbersOk("١٣٫٩٪", "طلع 13.9%"), fuNumbersOk("من 100 يوم", "من ١٠٠ يوم بتاريخ 3/8/2026")]') == [True, False, True, True, True])
        ctx.unroute('https://generativelanguage.googleapis.com/**')
        sent, reply = [], {}

        def model(route):
            sent.append(route.request.post_data or '')
            if reply.get('status'):
                return route.fulfill(status=reply['status'], content_type='application/json', body=json.dumps({'error': {'message': 'quota exceeded 429'}}))
            text = reply['text']
            if 'ALIAS_C2' in text:                    # the model only knows the workshop by the alias it was given
                import re
                items = json.loads(json.loads(sent[-1])['contents'][0]['parts'][0]['text'])['البنود']
                text = text.replace('ALIAS_C2', re.search(r'طرف-\d+', [x for x in items if x['id'] == f'rec:{C[1]}'][0]['الوصف']).group(0))
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'candidates': [{'content': {'parts': [{'text': text}]}, 'finishReason': 'STOP'}]}))
        ctx.route('https://generativelanguage.googleapis.com/**', model)
        page.evaluate('(() => { AI.keys.gemini = "test-key"; AI.provider = "gemini"; AI.anonymize = true; render(); })()')
        want_order = list(reversed(base_order[:4]))
        reply['text'] = '```json\n' + json.dumps({
            'headline': 'ابدأ بالتحصيل النهارده قبل أي شراء.',
            'order': want_order + ['not-a-real-id', want_order[0]],
            'tips': {f'rec:{C[1]}': 'كلّم ALIAS_C2 النهارده وخد ميعاد، المبلغ ٥٦٬٠٠٠ بقاله 100 يوم.',
                     f'rec:{C[2]}': 'اطلب منه 75000 جنيه فوراً.',
                     # no digit in this sentence: "__xss=1" quoted a number the item only had on some days (a date with a 1 in it),
                     # so the guard dropped the sentence on other days and the markup check never ran (found in round 2)
                     f'rec:{C[0]}': 'ابعت له <b>تذكير</b> <img src=x onerror="window.__xss=true"> ودّي.',
                     'not-a-real-id': 'كلام', 'slow:PVC': 12345}}, ensure_ascii=False) + '\n```'
        page.click('#fu-ai-btn')
        page.wait_for_function('FU.brief && !FU.busy')
        body = json.loads(sent[0])
        text_sent = json.dumps(body, ensure_ascii=False)
        user_part = json.loads(body['contents'][0]['parts'][0]['text'])
        rep.check('the model receives the computed items only (ids + descriptions), never raw records', len(user_part['البنود']) == min(14, n) and 'purchases' not in text_sent and 'supplierId' not in text_sent)
        rep.check('names are hidden from the model when the owner asked for it', 'طرف-' in text_sent and 'ورشة أولاد رزق' not in text_sent and 'مصنع الأمل' not in text_sent)
        shown = page.evaluate('fuOrdered(buildInsights()).map(x => x.id)')
        rep.check('the model\'s order is applied, unknown and repeated ids are ignored, the rest keep the computed order', shown[:4] == want_order and sorted(shown) == sorted(base_order) and shown[4:] == [i for i in base_order if i not in want_order])
        tip_ok = page.locator(f'.fu-item[data-id="rec:{C[1]}"] .fu-rec').inner_text()
        tip_bad = page.locator(f'.fu-item[data-id="rec:{C[2]}"] .fu-rec').inner_text()
        rep.check('a sentence that copies numbers from the item is shown, with the real name put back', '✨' in tip_ok and 'ورشة أولاد رزق' in tip_ok and '٥٦٬٠٠٠' in tip_ok)
        rep.check('a sentence with an invented number is refused and the rule-based recommendation stays', '💡' in tip_bad and '75000' not in tip_bad and page.evaluate('FU.brief.dropped') == 1)
        rep.check('markup in a model sentence is shown as text, never run', not page.evaluate('window.__xss') and page.locator('.fu-rec img').count() == 0 and '<b>' in page.locator(f'.fu-item[data-id="rec:{C[0]}"] .fu-rec').inner_text())
        rep.check('the model\'s headline is used when it quotes no foreign number', page.inner_text('#fu-headline') == 'ابدأ بالتحصيل النهارده قبل أي شراء.')
        rep.check('every figure on the cards is still the computed one', page.locator(f'.fu-item[data-id="rec:{C[2]}"] .fu-title').inner_text().count('٩٢٬٨٠٠') == 1)
        page.reload(); page.wait_for_selector('#nav .nav-btn'); go(page, 'followup')
        rep.check('today\'s wording is remembered on this device after a reload', page.inner_text('#fu-headline') == 'ابدأ بالتحصيل النهارده قبل أي شراء.')
        page.evaluate('(() => { AI.keys.gemini = "test-key"; AI.provider = "gemini"; render(); })()')
        reply['text'] = json.dumps({'headline': 'عندك 999 مشكلة', 'order': [], 'tips': {}}, ensure_ascii=False)
        page.click('#fu-ai-btn'); page.wait_for_function('FU.brief && !FU.busy && FU.brief.dropped === 1')
        rep.check('a headline with an invented number falls back to the computed headline', page.inner_text('#fu-headline') == rule_head)
        reply['text'] = 'آسف، مش قادر أساعد.'
        page.click('#fu-ai-btn'); page.wait_for_function('!FU.busy && FU.error')
        rep.check('a reply that is not the agreed JSON leaves the list as computed and says so', 'مش بالشكل المطلوب' in page.inner_text('#content') and page.locator('.fu-item').count() == n)
        reply['status'] = 429
        page.click('#fu-ai-btn'); page.wait_for_function('!FU.busy && /حد الاستخدام/.test(FU.error)')
        rep.check('a provider error is explained and the list stays', page.locator('.fu-item').count() == n)
        page.get_by_role('button', name='↺ الترتيب المحسوب').click()
        rep.check('"الترتيب المحسوب" drops the AI wording', page.evaluate('FU.brief === null && fuOrdered(buildInsights()).map(x => x.id).join() === buildInsights().items.map(x => x.id).join()'))
        page.evaluate('(() => { AI.keys.gemini = ""; AI.anonymize = false; aiSave(); })()')

        # ── 12. the field snapshot carries ages (for "مين متأخر؟"), still no average cost ──
        snap = page.evaluate('buildFieldSnapshot()')
        c2 = [b for b in snap['balances']['customers'] if b['name'] == 'ورشة أولاد رزق'][0]
        rep.check('the field snapshot carries the oldest open date and the overdue part of each balance', c2['oldest'] == (today - dt.timedelta(days=100)).isoformat() and c2['overdue'] == 56000 and c2['terms'] == 30)
        rep.check('the field snapshot still carries no cash, profit or average cost by default', 'finance' not in snap and 'avgCost' not in json.dumps(snap))

        # ── 13. hostile names + phone layout + midnight ──
        before = len(errors)
        bad = json.loads(json.dumps(ledger, ensure_ascii=False))
        for k in ('customers', 'suppliers', 'partners'):
            for r in bad[k]:
                r['name'] = '<img src=x onerror="window.__xss=2">' + r['name']
        bad['reminders'] = [{'id': 5001, 'date': today.isoformat(), 'text': '<img src=x onerror="window.__xss=3">', 'done': False, 'partyKind': 'customer', 'partyId': C[0]}, None, 'x']
        bad['traderAdvances'][0]['name'] = '<img src=x onerror="window.__xss=4">'
        page.evaluate('t => loadJsonText(t)', json.dumps(bad, ensure_ascii=False))
        go(page, 'dashboard')
        for t in ['today', 'aging', 'margins', 'reminders', 'settings']:
            page.evaluate('t => { DB.view = "followup"; FU.tab = t; render(); }', t)
        page.evaluate('fuOpenMessage(DB.customers[0])'); page.keyboard.press('Escape')
        page.wait_for_timeout(250)
        rep.check('HTML in names and follow-up texts never runs on the follow-up screens', not page.evaluate('window.__xss') and len(errors) == before, str(errors[before:]))
        browser.close()

        browser, ctx, page, errors2 = open_app(pw, width=390, height=844, mobile=True)
        load_ledger(page, ledger)
        wide = []
        for t in ['today', 'aging', 'margins', 'reminders', 'settings']:
            page.evaluate('t => { DB.view = "followup"; FU.tab = t; render(); }', t)
            if page.evaluate('document.documentElement.scrollWidth > window.innerWidth + 2'):
                wide.append(t)
        rep.check('the follow-up screens fit a phone without sideways scrolling', not wide and not errors2, str(wide) + str(errors2))
        browser.close()

        # 00:30 in Cairo is still "yesterday" in UTC: the app must use the local date
        browser = pw.chromium.launch(channel='chrome', headless=True)
        ctx = browser.new_context(timezone_id='Africa/Cairo', locale='ar-EG')
        page = ctx.new_page()
        if hasattr(page, 'clock'):
            page.clock.install(time=dt.datetime(2026, 11, 11, 22, 30, tzinfo=dt.timezone.utc))
            page.goto(f'http://127.0.0.1:{srv.server_address[1]}/plastic_manager.html')
            page.wait_for_selector('#nav .nav-btn')
            rep.check('half past midnight in Cairo: new records are dated today, not yesterday (UTC)', page.evaluate('[today(), new Date().toISOString().slice(0, 10), periodBounds("month")[0]]') == ['2026-11-12', '2026-11-11', '2026-11-01'])
        else:
            print('  skip midnight test (this playwright has no clock API)')
        browser.close()
    srv.shutdown()
    return rep.done()


if __name__ == '__main__':
    sys.exit(main())
