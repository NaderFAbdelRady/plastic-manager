# -*- coding: utf-8 -*-
"""Build GUIDE_AR.pdf / REPORT_AR.pdf from the HTML next to this file with headless Chrome (no network), and
render the first pages to PNG for a visual check.   python make_pdf.py [GUIDE_AR REPORT_AR]"""
import os
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
names = sys.argv[1:] or ['GUIDE_AR', 'REPORT_AR']
with sync_playwright() as pw:
    b = pw.chromium.launch(channel='chrome', headless=True)
    ctx = b.new_context()
    ctx.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    for n in names:
        src = os.path.join(HERE, n + '.html')
        if not os.path.exists(src):
            continue
        p = ctx.new_page()
        p.goto('file:///' + src.replace('\\', '/'))
        p.wait_for_load_state('networkidle')
        broken = p.evaluate('[...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => i.getAttribute("src"))')
        p.pdf(path=os.path.join(HERE, n + '.pdf'), format='A4', print_background=True, prefer_css_page_size=True)
        print(n, 'pdf written; broken images:', broken)
        p.close()
    b.close()
