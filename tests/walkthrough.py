# -*- coding: utf-8 -*-
"""A walk through EVERY screen, every tab and every form of the app in headless Chrome, at desktop (1366) and phone (390)
width and in the dark theme, on the synthetic ledger. Nothing is mocked except the network (blocked).

    python tests/walkthrough.py

For each stop it checks: no script error, nothing wider than the screen (no sideways scrolling), the page is RTL, every
form control has an accessible name (a <label for>, aria-label or title; a placeholder alone does not count), every
button has a name, and tab buttons say which one is selected (aria-pressed).
"""
import sys

from playwright.sync_api import sync_playwright

import synthetic_ledger
from _harness import Report, go, load_ledger, open_app, serve

VIEWS = ['dashboard', 'followup', 'purchases', 'sales', 'inventory', 'contacts', 'expenses', 'accounts', 'drafts', 'pl', 'balance', 'distribution', 'ai']
MODALS = ['purchase', 'sale', 'expense', 'collection', 'supplierPay', 'traderAdv', 'workerLiq', 'partnerFund', 'supplier', 'customer',
          'partner', 'reminder', 'distribution', 'capital']

AUDIT = r'''(root) => {
  const R = document.querySelector(root) || document.body;
  const vis = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const named = e => (e.labels && e.labels.length) || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.getAttribute('title');
  const unl = [...R.querySelectorAll('input:not([type=hidden]):not([type=file]),select,textarea')].filter(vis).filter(e => !named(e))
               .map(e => e.dataset.key || e.dataset.fu || e.id || e.name || e.type);
  const nb = [...R.querySelectorAll('button')].filter(vis).filter(b => !(b.textContent.trim() || b.getAttribute('aria-label') || b.getAttribute('title'))).length;
  const tabs = [...R.querySelectorAll('.tab-btn')].filter(vis);
  const tabsBad = tabs.length ? tabs.filter(b => b.classList.contains('tab-active') !== (b.getAttribute('aria-pressed') === 'true')).length : 0;
  const sw = document.scrollingElement.scrollWidth, iw = window.innerWidth;
  return {unl, nb, tabsBad, over: sw - iw, rtl: getComputedStyle(document.body).direction === 'rtl'};
}'''


def main():
    rep = Report('walkthrough')
    ledger = synthetic_ledger.build()
    srv = serve()
    stops = 0
    with sync_playwright() as pw:
        for label, width, mobile, dark in (('desktop', 1366, False, False), ('phone', 390, True, False), ('dark', 1366, False, True)):
            browser, ctx, page, errors = open_app(pw, width=width, height=860, mobile=mobile)
            load_ledger(page, ledger)
            if dark:
                page.evaluate('document.documentElement.setAttribute("data-theme", "dark")')
            problems = []

            def audit(where, root='#app'):
                nonlocal stops
                stops += 1
                a = page.evaluate(AUDIT, root)
                if a['unl']: problems.append(f'{where}: unlabelled controls {a["unl"][:6]}')
                if a['nb']: problems.append(f'{where}: {a["nb"]} buttons without a name')
                if a['tabsBad']: problems.append(f'{where}: {a["tabsBad"]} tab buttons without aria-pressed')
                if a['over'] > 1: problems.append(f'{where}: {a["over"]}px wider than the screen')
                if not a['rtl']: problems.append(f'{where}: not RTL')

            for v in VIEWS:
                go(page, v)
                page.wait_for_timeout(60)
                audit(v, 'body')
                n = page.locator('#content .tab-btn').count()
                for i in range(n):
                    page.locator('#content .tab-btn').nth(i).click()
                    page.wait_for_timeout(40)
                    audit(f'{v} tab {i + 1}', 'body')
            go(page, 'dashboard')
            for m in MODALS:
                page.evaluate('t => openModal(t)', m)
                page.wait_for_timeout(40)
                audit(f'form {m}', '#modal-box')
                page.evaluate('closeModal()')
            # the statement overlay and the WhatsApp message
            page.evaluate('showCustomerStatement(DB.customers[0])')
            page.wait_for_timeout(40)
            audit('statement', '#stmt-overlay')
            page.evaluate('fuOpenMessage(DB.customers[1])')
            page.wait_for_timeout(40)
            audit('whatsapp message', '#stmt-overlay')
            page.evaluate('document.getElementById("stmt-overlay") && document.getElementById("stmt-overlay").remove()')
            rep.check(f'{label}: every screen, tab and form opens without a script error', not errors, str(errors[:3]))
            rep.check(f'{label}: no screen is wider than the window, everything RTL', not [p for p in problems if 'wider' in p or 'RTL' in p], str([p for p in problems if 'wider' in p or 'RTL' in p][:5]))
            rep.check(f'{label}: every form control has an accessible name', not [p for p in problems if 'unlabelled' in p], str([p for p in problems if 'unlabelled' in p][:6]))
            rep.check(f'{label}: every button has a name', not [p for p in problems if 'buttons without a name' in p], str([p for p in problems if 'buttons without a name' in p][:4]))
            rep.check(f'{label}: tab buttons say which one is selected', not [p for p in problems if 'aria-pressed' in p], str([p for p in problems if 'aria-pressed' in p][:6]))
            browser.close()
    srv.shutdown()
    print(f'  ({stops} stops audited)')
    return rep.done()


if __name__ == '__main__':
    sys.exit(main())
