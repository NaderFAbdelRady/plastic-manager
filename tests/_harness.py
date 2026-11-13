# -*- coding: utf-8 -*-
"""Shared plumbing for the browser tests: a tiny static server that serves ONLY plastic_manager.html
(never the real plastic_data_*.json files sitting beside it), a fresh headless Chrome profile per run,
and a minimal check/report helper (no pytest needed)."""
import http.server
import json
import os
import sys
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, 'plastic_manager.html')
PORT = int(os.environ.get('PM_TEST_PORT', '8831'))
URL = f'http://127.0.0.1:{PORT}/plastic_manager.html'

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


class _OneFile(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?')[0] != '/plastic_manager.html':
            self.send_error(404)
            return
        with open(APP, 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def serve():
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), _OneFile)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class Report:
    def __init__(self, title):
        self.title, self.ok, self.bad = title, 0, []

    def check(self, name, cond, detail=''):
        if cond:
            self.ok += 1
            print(f'  ok   {name}')
        else:
            self.bad.append(name)
            print(f'  FAIL {name} {detail}')
        return bool(cond)

    def near(self, name, got, want, tol=0.51):
        return self.check(name, got is not None and abs(got - want) <= tol, f'(got {got}, want {want})')

    def done(self):
        print(f'\n{self.title}: {self.ok} passed, {len(self.bad)} failed')
        for b in self.bad:
            print('   -', b)
        return 1 if self.bad else 0


def open_app(pw, width=1366, height=900, mobile=False, block_network=True):
    """A fresh profile (so localStorage starts empty) with the app loaded. Returns (browser, context, page, errors)."""
    browser = pw.chromium.launch(channel='chrome', headless=True)
    ctx = browser.new_context(viewport={'width': width, 'height': height}, locale='ar-EG', is_mobile=mobile,
                              device_scale_factor=2 if mobile else 1, has_touch=mobile)
    if block_network:   # the app must work offline; anything that is not our own page is refused unless a test routes it
        ctx.route('**/*', lambda route: route.continue_() if route.request.url.startswith(f'http://127.0.0.1:{PORT}/') else route.abort())
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
    page.on('dialog', lambda d: d.accept())
    page.goto(URL)
    page.wait_for_selector('#nav .nav-btn')
    return browser, ctx, page, errors


def load_ledger(page, ledger):
    ok = page.evaluate('t => loadJsonText(t, "synthetic")', json.dumps(ledger, ensure_ascii=False))
    assert ok, 'the synthetic ledger did not load'


def go(page, view):
    page.evaluate('v => { DB.view = v; render(); }', view)


def set_field(page, key, value):
    loc = page.locator(f'#modal-body [data-key="{key}"]').first
    tag = loc.evaluate('e => e.tagName')
    if tag == 'SELECT':
        loc.select_option(str(value))
    else:
        loc.fill(str(value))
