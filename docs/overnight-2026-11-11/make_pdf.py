# -*- coding: utf-8 -*-
"""Build GUIDE_AR.pdf / REPORT_AR.pdf from the HTML next to this file with headless Chrome (no network), with page numbers,
and (with --png DIR) render every page to PNG for a visual check.   python make_pdf.py [GUIDE_AR REPORT_AR] [--png DIR]"""
import os
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
png_dir = None
if '--png' in args:
    i = args.index('--png')
    png_dir = args[i + 1]
    args = args[:i] + args[i + 2:]
names = args or ['GUIDE_AR', 'REPORT_AR']
FOOTER = ('<div style="width:100%;font-size:8pt;color:#6b7a72;text-align:center;font-family:Segoe UI,Tahoma,sans-serif;direction:rtl">'
          'صفحة <span class="pageNumber"></span> من <span class="totalPages"></span></div>')
with sync_playwright() as pw:
    b = pw.chromium.launch(channel='chrome', headless=True)
    ctx = b.new_context(forced_colors='none', color_scheme='light')        # a Windows contrast theme must not repaint the PDF
    ctx.route('**/*', lambda r: r.continue_() if r.request.url.startswith('file:') else r.abort())
    for n in names:
        src = os.path.join(HERE, n + '.html')
        if not os.path.exists(src):
            continue
        p = ctx.new_page()
        p.goto('file:///' + src.replace('\\', '/'))
        p.wait_for_load_state('networkidle')
        broken = p.evaluate('[...document.images].filter(i => !i.complete || !i.naturalWidth).map(i => i.getAttribute("src"))')
        out = os.path.join(HERE, n + '.pdf')
        p.pdf(path=out, format='A4', print_background=True, prefer_css_page_size=True,
              display_header_footer=True, header_template='<span></span>', footer_template=FOOTER)
        print(n, 'pdf written; broken images:', broken)
        p.close()
        if png_dir:
            import fitz
            os.makedirs(png_dir, exist_ok=True)
            doc = fitz.open(out)
            for i, page in enumerate(doc):
                page.get_pixmap(dpi=60).save(os.path.join(png_dir, f'{n}_p{i + 1:02d}.png'))
            print(n, len(doc), 'pages rendered to', png_dir)
    b.close()
