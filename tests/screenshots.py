# -*- coding: utf-8 -*-
"""Screenshots for the user guide, on the SYNTHETIC ledger only, plus a live check of the app <-> drafts-service link.

    python tests/screenshots.py <out_dir>

Starts the drafts service in mock mode (no model, no database, DATABASE_URL removed) on 127.0.0.1, links the app to it,
pushes names + a snapshot, files a field draft and pulls it into the review inbox. Every process it starts is stopped.
Ports: PM_TEST_PORT (app, default 8831), PM_SERVICE_PORT (8837), MOCK_AI_PORT (8838).
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

import synthetic_ledger
from _harness import PORT, ROOT, Report, load_ledger, serve

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else 'screenshots')
SPORT = int(os.environ.get('PM_SERVICE_PORT', '8837'))
MPORT = os.environ.get('MOCK_AI_PORT', '8838')
SVC = f'http://127.0.0.1:{SPORT}'
os.makedirs(OUT, exist_ok=True)


def start_service(tmp):
    env = {k: v for k, v in os.environ.items() if k != 'DATABASE_URL'}
    env.update(PORT=str(SPORT), HOST='127.0.0.1', MOCK_AI_PORT=MPORT, DATA_FILE=os.path.join(tmp, 'drafts-shots.json'))
    for k in ('GEMINI_API_KEY', 'XAI_API_KEY', 'CLAUDE_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'FIELD_MATRIX_URL', 'FIELD_SERVICE_KEY'):
        env.pop(k, None)
    p = subprocess.Popen(['node', 'dev-start.js', '--mock'], cwd=os.path.join(ROOT, 'drafts-service'), env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            with urllib.request.urlopen(SVC + '/api/health', timeout=1) as r:
                return p, json.loads(r.read())
        except Exception:
            time.sleep(0.25)
    p.kill()
    raise SystemExit('drafts service did not start')


def main():
    rep = Report('screenshots + service link')
    tmp = os.path.join(OUT, '..', '_tmp')
    os.makedirs(tmp, exist_ok=True)
    proc, health = start_service(tmp)
    rep.check('the drafts service starts in mock mode with a file store', health.get('store') == 'file' and health.get('ai') is True, str(health))
    srv = serve()
    ledger = synthetic_ledger.build()
    shots = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel='chrome', headless=True)
            ctx = browser.new_context(viewport={'width': 1366, 'height': 860}, locale='ar-EG', device_scale_factor=1.5)
            # only this machine: the app, the service and nothing else
            ctx.route('**/*', lambda r: r.continue_() if r.request.url.startswith(('http://127.0.0.1:', 'http://localhost:')) else r.abort())
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT}/plastic_manager.html')
            page.wait_for_selector('#nav .nav-btn')
            load_ledger(page, ledger)
            page.evaluate('_hideToast()')

            def shot(name, js=None, wait=250, full=False, el=None):
                if js:
                    page.evaluate(js)
                page.wait_for_timeout(wait)
                page.evaluate('() => { try { _hideToast(); } catch (e) {} }')
                page.wait_for_timeout(450)                     # let the toast fade out
                path = os.path.join(OUT, name + '.png')
                if el:
                    page.locator(el).screenshot(path=path)
                else:
                    page.screenshot(path=path, full_page=full)
                shots.append(name)

            view = lambda v, extra='': f'(() => {{ {extra} DB.view = "{v}"; render(); window.scrollTo(0, 0); document.getElementById("content").scrollTop = 0; }})()'
            shot('01_dashboard', view('dashboard'))
            shot('02_followup_today', view('followup', 'FU.tab = "today";'))
            # AI wording against a scripted model (nothing leaves the machine)
            items = page.evaluate('buildInsights().items.map(x => x.id)')
            tips = {i: t for i, t in zip(items[:4], ['رتّب مكالمة النهارده واتفق على جدول دفعات، علشان التوريد ما يقفش.',
                                                     'كلّمه الصبح بدري وخد ميعاد سداد واضح، وما تبعتلوش بضاعة آجل قبلها.',
                                                     'ارفع سعر البيع للعميل الجاي، أو استنى لحد ما السعر يتحسن.',
                                                     'ابدأ بالتحصيل قبل ما تدفع، علشان الخزنة ما تنزلش تحت مصروف الشهر.'])}
            body = json.dumps({'candidates': [{'content': {'parts': [{'text': json.dumps({'headline': 'النهارده يوم تحصيل: ابدأ بأقدم الديون، وأجّل أي شراء جديد لحد ما الفلوس تدخل.', 'order': items[:4], 'tips': tips}, ensure_ascii=False)}]}, 'finishReason': 'STOP'}]}, ensure_ascii=False)
            ctx.route('https://generativelanguage.googleapis.com/**', lambda r: r.fulfill(status=200, content_type='application/json', body=body))
            page.evaluate('(() => { AI.keys.gemini = "demo"; AI.provider = "gemini"; AI.anonymize = true; render(); })()')
            page.click('#fu-ai-btn'); page.wait_for_function('FU.brief && !FU.busy')
            shot('03_followup_ai')
            page.evaluate('(() => { FU.brief = null; AI.keys.gemini = ""; AI.anonymize = false; fuSave(); aiSave(); render(); })()')
            shot('04_followup_aging', view('followup', 'FU.tab = "aging";'))
            shot('05_followup_margins', view('followup', 'FU.tab = "margins";'))
            cid = ledger['customers'][1]['id']
            page.evaluate(f'fuOpenMessage(DB.customers.find(c => c.id === {cid}))')
            shot('06_whatsapp_message', el='#stmt-overlay > div')
            page.keyboard.press('Escape')
            page.evaluate(f'(() => {{ DB.reminders = [{{id: 9001, date: addDays(today(), 0), text: "ميعاد شيك مصنع البركة", partyKind: "customer", partyId: {ledger["customers"][3]["id"]}, done: false}}, {{id: 9002, date: addDays(today(), 2), text: "وعد سداد من ورشة أولاد رزق ٣٠ ألف", partyKind: "customer", partyId: {cid}, done: false}}, {{id: 9003, date: addDays(today(), -3), text: "مكالمة مؤسسة الفيروز على السعر الجديد", partyKind: "supplier", partyId: {ledger["suppliers"][2]["id"]}, done: true, doneAt: today()}}]; }})()')
            shot('07_followup_reminders', view('followup', 'FU.tab = "reminders";'))
            shot('08_reminder_form', 'fuNewReminder("customer", DB.customers[0], "متابعة تحصيل مصنع الأمل", 3)', el='#modal-box')
            page.evaluate('closeModal()')
            shot('09_followup_settings', view('followup', 'FU.tab = "settings";'))
            shot('10_purchases', view('purchases'))
            page.evaluate('openModal("purchase")')
            for k, v in (('material', 'PP'), ('qty', '2000'), ('price', '45'), ('paid', '50000')):
                loc = page.locator(f'#modal-body [data-key="{k}"]').first
                loc.select_option(v) if loc.evaluate('e => e.tagName') == 'SELECT' else loc.fill(v)
            shot('11_purchase_form', wait=500)
            page.evaluate('closeModal()')
            shot('12_sales', view('sales'))
            shot('13_inventory_material', view('inventory', 'DB.invTab = "material";'))
            shot('14_inventory_location', view('inventory', 'DB.invTab = "location";'))
            shot('15_contacts', view('contacts', 'DB.cTab = "customers";'))
            shot('16_customer_form', f'openEditModal("customer", DB.customers.find(c => c.id === {ledger["customers"][3]["id"]}))', el='#modal-box')
            page.evaluate('closeModal()')
            shot('17_expenses', view('expenses'))
            shot('18_accounts', view('accounts'))
            page.evaluate(f'showCustomerStatement(DB.customers.find(c => c.id === {cid}))')
            shot('19_statement', el='#stmt-overlay > div')
            page.keyboard.press('Escape')

            # ── drafts service link, live ──
            page.evaluate(f'(() => {{ DS.url = "{SVC}"; DS.token = "dev-owner-token"; DS.autoPull = false; dsSave(); }})()')
            page.evaluate('dsPushReference()'); page.wait_for_timeout(500)
            ok = page.evaluate('dsPushSnapshot(true)')
            rep.check('the app pushes the field snapshot to the service', ok is True)
            req = urllib.request.Request(SVC + '/api/field/converse', data=json.dumps({'text': 'مين متأخر في السداد؟'}).encode(), headers={'Content-Type': 'application/json', 'X-Field-Code': '1234'})
            ans = json.loads(urllib.request.urlopen(req, timeout=5).read())
            rep.check('a field question "who is late?" is answered from the snapshot the app pushed', ans.get('query', {}).get('result', {}).get('count') == 4 and 'ورشة أولاد رزق' in ans.get('answer', ''), ans.get('answer'))
            draft = {'type': 'purchase', 'transcript': 'اشتريت من الحاج سمير ألفين كيلو LDPE بخمسين ودفعت عشرين ألف', 'fields': {'date': time.strftime('%Y-%m-%d'), 'party': 'الحاج سمير البنهاوي', 'material': 'LDPE', 'qty': 2000, 'unit': 'كيلوجرام', 'price': 50, 'paid': 20000}}
            req = urllib.request.Request(SVC + '/api/field/drafts', data=json.dumps(draft, ensure_ascii=False).encode(), headers={'Content-Type': 'application/json', 'X-Field-Code': '1234'})
            rid = json.loads(urllib.request.urlopen(req, timeout=5).read())['id']
            page.evaluate('DB.view = "drafts"; render();')
            page.evaluate('dsPull()'); page.wait_for_function('!DS.busy'); page.wait_for_timeout(300)
            rep.check('the app pulls the field draft into the review inbox', page.evaluate(f'DB.drafts.some(d => d.remoteId === "{rid}" && d.status === "pending")'))
            shot('20_drafts_inbox', view('drafts'))
            local = page.evaluate(f'DB.drafts.find(d => d.remoteId === "{rid}").id')
            page.evaluate(f'reviewDraft({local})')
            shot('21_draft_review', wait=500)
            page.click('#save-btn'); page.wait_for_timeout(800)
            with urllib.request.urlopen(urllib.request.Request(SVC + '/api/owner/drafts?status=approved', headers={'Authorization': 'Bearer dev-owner-token'}), timeout=5) as r:
                approved = json.loads(r.read())
            rep.check('approving it in the app writes the purchase and marks it approved on the service', any(str(d['id']) == str(rid) for d in approved) and page.evaluate('DB.purchases.some(p => p.draftId)'))
            shot('22_pl', view('pl'))
            shot('23_balance', view('balance'))
            shot('24_distribution', view('distribution'))
            shot('25_ai_advisor', view('ai', 'AI.tab = "analyze"; AI.keys.gemini = "demo"; AI.result = null;'))
            page.evaluate('(() => { AI.keys.gemini = ""; aiSave(); })()')
            page.evaluate('toggleTheme()')
            shot('26_dark_dashboard', view('dashboard'), wait=600)
            page.evaluate('toggleTheme()')
            rep.check('no script errors while taking the desktop screenshots', not errors, str(errors))
            browser.close()

            # ── phone: the app and the field capture page ──
            browser = pw.chromium.launch(channel='chrome', headless=True)
            mctx = browser.new_context(viewport={'width': 390, 'height': 844}, locale='ar-EG', is_mobile=True, has_touch=True, device_scale_factor=2)
            mctx.route('**/*', lambda r: r.continue_() if r.request.url.startswith(('http://127.0.0.1:', 'http://localhost:')) else r.abort())
            m = mctx.new_page()
            m.goto(f'http://127.0.0.1:{PORT}/plastic_manager.html'); m.wait_for_selector('#nav .nav-btn')
            load_ledger(m, ledger)
            m.evaluate('(() => { DB.view = "followup"; FU.tab = "today"; render(); _hideToast(); })()'); m.wait_for_timeout(300)
            m.screenshot(path=os.path.join(OUT, '27_mobile_followup.png')); shots.append('27_mobile_followup')
            m.goto(SVC + '/classic'); m.wait_for_selector('#code')
            m.screenshot(path=os.path.join(OUT, '28_field_login.png')); shots.append('28_field_login')
            m.fill('#code', '1234'); m.click('#loginBtn'); m.wait_for_selector('#text', state='visible')
            m.fill('#text', 'مين متأخر في السداد؟'); m.click('#sendText'); m.wait_for_timeout(1500)
            m.screenshot(path=os.path.join(OUT, '29_field_question.png')); shots.append('29_field_question')
            rep.check('the field page shows the computed answer', 'ورشة أولاد رزق' in m.inner_text('#chat'))
            m.fill('#text', 'اشتريت من هاني عيسي'); m.click('#sendText'); m.wait_for_timeout(1500)
            m.screenshot(path=os.path.join(OUT, '30_field_record.png')); shots.append('30_field_record')
            browser.close()
    finally:
        proc.kill()
        proc.wait(5)
        srv.shutdown()
    rep.check(f'{len(shots)} screenshots written', len(shots) >= 28)
    print('\n'.join(shots))
    return rep.done()


if __name__ == '__main__':
    sys.exit(main())
