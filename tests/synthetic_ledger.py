# -*- coding: utf-8 -*-
"""A synthetic ledger for tests, screenshots and demos.

Every name, phone number and amount here is invented. Dates are relative to "today" so the ledger always
looks alive: receivables of different ages, a slow-moving material, a rising purchase price, a sale under
cost, thin cash against supplier credit, a partner draw, partner funding and drafts waiting for review.

    python tests/synthetic_ledger.py out.json      # write the JSON (import it with the app's "تحميل" button)

Never point tests at the real plastic_data_*.json files.
"""
import datetime as _dt
import json
import sys

KG = 'كيلوجرام'


def build(today=None):
    today = today or _dt.date.today()
    d = lambda n: (today - _dt.timedelta(days=n)).isoformat()
    ids = iter(range(101, 10_000))
    nid = lambda: next(ids)

    suppliers = [
        {'id': nid(), 'name': 'شركة الدلتا للبوليمرات', 'phone': '01000000101', 'city': 'العاشر من رمضان', 'linkedCustomerId': None},
        {'id': nid(), 'name': 'الحاج سمير البنهاوي', 'phone': '01000000102', 'city': 'بنها', 'linkedCustomerId': None},
        {'id': nid(), 'name': 'مؤسسة الفيروز للخامات', 'phone': '01000000103', 'city': 'الإسكندرية', 'linkedCustomerId': None},
        {'id': nid(), 'name': 'وليد أبو زهرة', 'phone': '01000000104', 'city': 'شبرا الخيمة', 'linkedCustomerId': None},
        {'id': nid(), 'name': 'مصنع النور للبلاستيك', 'phone': '01000000105', 'city': 'العبور', 'linkedCustomerId': None},
    ]
    customers = [
        {'id': nid(), 'name': 'مصنع الأمل للعبوات', 'phone': '01000000201', 'city': '6 أكتوبر'},
        {'id': nid(), 'name': 'ورشة أولاد رزق', 'phone': '01000000202', 'city': 'باسوس'},
        {'id': nid(), 'name': 'شركة سيناء للمواسير', 'phone': '01000000203', 'city': 'السادات'},
        {'id': nid(), 'name': 'مصنع البركة للأكياس', 'phone': '01000000204', 'city': 'قليوب'},
        {'id': nid(), 'name': 'الحاج فتحي القليوبي', 'phone': '', 'city': 'القناطر'},
        {'id': nid(), 'name': 'مصنع النور للبلاستيك', 'phone': '01000000105', 'city': 'العبور'},
    ]
    S = [s['id'] for s in suppliers]
    C = [c['id'] for c in customers]
    suppliers[4]['linkedCustomerId'] = C[5]           # the same factory sells to us and buys from us

    def deal(day, mat, qty, price, paid, **kw):
        r = {'id': nid(), 'date': d(day), 'material': mat, 'color': kw.get('color', ''), 'qty': qty, 'unit': KG, 'price': price,
             'paid': paid, 'waste': kw.get('waste', 0), 'txExpenses': kw.get('tx', []), 'actualQty': kw.get('actual'),
             'billOn': 'contract', 'discount': kw.get('discount', 0), 'discountPct': None, 'discountNote': kw.get('discNote', '')}
        return r

    def buy(day, s, mat, qty, price, paid, locs=None, **kw):
        r = deal(day, mat, qty, price, paid, **kw)
        r['supplierId'] = S[s]
        r['locations'] = locs or []
        return r

    def sell(day, c, mat, qty, price, paid, **kw):
        r = deal(day, mat, qty, price, paid, **kw)
        r['customerId'] = C[c]
        r['purchaseId'] = None
        r['fromLocations'] = []
        return r

    loc = lambda name, sub, qty: {'loc': name, 'sub': sub, 'qty': qty, 'desc': ''}
    purchases = [
        buy(140, 0, 'HDPE', 5000, 41, 205000, [loc('مخزن العبور', 'عنبر 1', 5000)], tx=[{'desc': 'نقل', 'amount': 1800}]),
        buy(130, 1, 'LDPE', 3000, 46, 138000, [loc('مخزن العبور', 'عنبر 2', 3000)]),
        buy(120, 2, 'PP', 4000, 38, 152000, [loc('مخزن شبرا', '', 4000)], tx=[{'desc': 'نقل', 'amount': 1500}]),
        buy(110, 3, 'PET', 3000, 33, 99000, color='شفاف'),
        buy(105, 4, 'PVC', 2500, 29, 72500, [loc('مخزن شبرا', 'الدور الأرضي', 2500)]),
        buy(100, 4, 'ABS', 2070, 62, 128340, actual=2085, color='أسود', tx=[{'desc': 'عتالة', 'amount': 600}]),
        buy(95, 1, 'HDPE', 4000, 43, 100000, [loc('مخزن العبور', 'عنبر 1', 4000)]),
        buy(70, 3, 'LDPE', 3500, 48, 80000, waste=40),
        buy(60, 2, 'PP', 4500, 40, 90000, [loc('مخزن شبرا', '', 4500)], tx=[{'desc': 'نقل', 'amount': 1700}]),
        buy(40, 0, 'HDPE', 6000, 45, 120000, [loc('مخزن العبور', 'عنبر 1', 3500), loc('مخزن العبور', 'عنبر 3', 2500)], discount=2000, discNote='تقريب'),
        buy(35, 3, 'PET', 2000, 36, 30000, color='أزرق'),
        buy(28, 0, 'ABS', 1500, 66, 40000, color='أسود'),
        buy(20, 1, 'LDPE', 2500, 49, 50000),
        buy(12, 2, 'HDPE', 3000, 47.5, 0, tx=[{'desc': 'نقل', 'amount': 1400}]),
        buy(9, 4, 'PP', 5000, 44.5, 60000, [loc('مخزن شبرا', '', 5000)]),
    ]
    sales = [
        sell(125, 0, 'HDPE', 3000, 47, 141000),
        sell(115, 2, 'LDPE', 2500, 52, 130000, tx=[{'desc': 'نقل', 'amount': 900}]),
        sell(105, 3, 'PP', 3500, 43, 150500),
        sell(100, 1, 'HDPE', 2000, 48, 40000),
        sell(90, 4, 'PET', 2500, 37, 92500, color='شفاف'),
        sell(85, 2, 'ABS', 1800, 71, 60000, color='أسود'),
        sell(80, 0, 'HDPE', 3500, 49, 100000, tx=[{'desc': 'نقل', 'amount': 1200}]),
        sell(55, 4, 'LDPE', 3000, 53.5, 60000),
        sell(50, 2, 'HDPE', 2500, 50, 60000),
        sell(48, 0, 'PP', 4000, 44.5, 100000),
        sell(30, 5, 'PP', 500, 45, 22500),
        sell(25, 0, 'HDPE', 3000, 51, 80000, discount=1000, discNote='خصم كمية'),
        sell(18, 5, 'PET', 1500, 33.5, 20000, color='أزرق'),
        sell(15, 1, 'LDPE', 1500, 54, 20000),
        sell(10, 3, 'ABS', 700, 72, 0, color='أسود'),
        sell(6, 3, 'HDPE', 1500, 52.5, 0, tx=[{'desc': 'نقل', 'amount': 800}]),
    ]
    expenses = []
    for m in range(5):
        base = 135 - 30 * m
        expenses += [
            {'id': nid(), 'date': d(base), 'cat': 'إيجار', 'desc': 'إيجار المخزنين', 'amount': 8000},
            {'id': nid(), 'date': d(base - 3), 'cat': 'عمالة', 'desc': 'يوميات العمال', 'amount': 6000},
            {'id': nid(), 'date': d(base - 6), 'cat': 'كهرباء ومياه', 'desc': 'فاتورة الكهرباء', 'amount': 1500},
        ]
    expenses += [
        {'id': nid(), 'date': d(88), 'cat': 'نقل', 'desc': 'عربية نص نقل للعبور', 'amount': 1600},
        {'id': nid(), 'date': d(52), 'cat': 'صيانة', 'desc': 'صيانة الميزان', 'amount': 2200},
        {'id': nid(), 'date': d(33), 'cat': 'نقل', 'desc': 'مشوار تحصيل', 'amount': 450},
        {'id': nid(), 'date': d(14), 'cat': 'متفرقات', 'desc': 'شاي وضيافة', 'amount': 380},
        {'id': nid(), 'date': d(4), 'cat': 'نقل', 'desc': 'توكتوك مشوار بنك', 'amount': 150},
    ]
    collections = [
        {'id': nid(), 'date': d(60), 'customerId': C[0], 'amount': 50000, 'note': 'دفعة على الحساب'},
        {'id': nid(), 'date': d(40), 'customerId': C[2], 'amount': 40000, 'note': 'شيك'},
        {'id': nid(), 'date': d(30), 'customerId': C[4], 'amount': 50000, 'note': 'كاش'},
        {'id': nid(), 'date': d(10), 'customerId': C[0], 'amount': 60000, 'note': 'تحويل'},
        {'id': nid(), 'date': d(3), 'customerId': C[3], 'amount': 20000, 'note': 'كاش'},
    ]
    supplier_payments = [
        {'id': nid(), 'date': d(80), 'supplierId': S[1], 'amount': 50000, 'note': 'دفعة'},
        {'id': nid(), 'date': d(50), 'supplierId': S[3], 'amount': 40000, 'note': 'كاش'},
        {'id': nid(), 'date': d(45), 'supplierId': S[2], 'amount': 50000, 'note': 'تحويل'},
        {'id': nid(), 'date': d(20), 'supplierId': S[0], 'amount': 80000, 'note': 'شيك'},
        {'id': nid(), 'date': d(5), 'supplierId': S[1], 'amount': 30000, 'note': 'كاش'},
    ]
    partners = [
        {'id': nid(), 'name': 'حسن الدمنهوري', 'sharePct': 50},
        {'id': nid(), 'name': 'كريم السويفي', 'sharePct': 30},
        {'id': nid(), 'name': 'مجدي الطحان', 'sharePct': 20},
    ]
    P = [p['id'] for p in partners]
    distributions = [{'id': nid(), 'date': d(58), 'note': 'توزيع أول', 'amount': 20000, 'breakdown': [
        {'partnerId': P[0], 'gross': 10000, 'drawsAbsorbed': 0, 'net': 10000},
        {'partnerId': P[1], 'gross': 6000, 'drawsAbsorbed': 0, 'net': 6000},
        {'partnerId': P[2], 'gross': 4000, 'drawsAbsorbed': 0, 'net': 4000}]}]
    worker_liquidity = [
        {'id': nid(), 'date': d(25), 'name': 'كريم السويفي', 'desc': 'سحب شخصي', 'amount': 10000, 'returned': False, 'partnerId': P[1]},
        {'id': nid(), 'date': d(44), 'name': 'عم صابر', 'desc': 'عهدة مشتريات صغيرة', 'amount': 3000, 'returned': False, 'partnerId': None},
    ]
    trader_advances = [{'id': nid(), 'date': d(70), 'name': 'تاجر خردة المرج', 'desc': 'عربون بضاعة لسه ما جاتش', 'amount': 15000, 'settled': False}]
    partner_funding = [
        {'id': nid(), 'date': d(30), 'partnerId': P[0], 'kind': 'in', 'amount': 100000, 'note': 'سيولة مؤقتة لصفقة PP'},
        {'id': nid(), 'date': d(8), 'partnerId': P[0], 'kind': 'out', 'amount': 40000, 'note': 'رد جزء'},
    ]
    iso = lambda n: _dt.datetime.combine(today - _dt.timedelta(days=n), _dt.time(10, 30)).isoformat() + 'Z'
    drafts = [
        {'id': nid(), 'remoteId': None, 'createdAt': iso(4), 'receivedAt': iso(4), 'submittedBy': 'عز', 'source': 'text', 'status': 'pending',
         'transcript': 'بعت لمصنع الأمل ألف كيلو HDPE بخمسين ودفع عشرين ألف', 'type': 'sale',
         'fields': {'date': d(4), 'party': 'مصنع الأمل للعبوات', 'material': 'HDPE', 'qty': 1000, 'unit': KG, 'price': 50, 'paid': 20000},
         'conversation': [], 'review': None, 'ledgerList': None, 'ledgerId': None, 'final': None},
        {'id': nid(), 'remoteId': None, 'createdAt': iso(0), 'receivedAt': iso(0), 'submittedBy': 'أحمد', 'source': 'text', 'status': 'pending',
         'transcript': 'دفعت ٣٥٠ جنيه توكتوك مشوار تحصيل', 'type': 'expense',
         'fields': {'date': d(0), 'cat': 'نقل', 'desc': 'توكتوك مشوار تحصيل', 'amount': 350},
         'conversation': [], 'review': None, 'ledgerList': None, 'ledgerId': None, 'final': None},
        {'id': nid(), 'remoteId': None, 'createdAt': iso(21), 'receivedAt': iso(21), 'submittedBy': 'عز', 'source': 'text', 'status': 'rejected',
         'transcript': 'اشتريت من وليد طن PET', 'type': 'purchase', 'fields': {'date': d(21), 'party': 'وليد أبو زهرة', 'material': 'PET', 'qty': 1000, 'unit': KG},
         'conversation': [], 'review': {'at': iso(20), 'note': 'السعر مش مكتوب والصفقة ما تمتش'}, 'ledgerList': None, 'ledgerId': None, 'final': None},
    ]
    return {
        'version': 2, 'savedAt': iso(1),
        'suppliers': suppliers, 'customers': customers, 'purchases': purchases, 'sales': sales, 'expenses': expenses,
        'materials': ['HDPE', 'LDPE', 'PP', 'PET', 'PVC', 'PS', 'ABS', 'مواد مختلطة'],
        'capital': 700000, 'traderAdvances': trader_advances, 'workerLiquidity': worker_liquidity, 'partnerFunding': partner_funding,
        'closings': [], 'collections': collections, 'supplierPayments': supplier_payments, 'partners': partners,
        'distributions': distributions, 'drafts': drafts,
    }


def reference_books(db):
    """An independent re-computation of the headline numbers (plain Python, no shared code with the app)."""
    net_amt = lambda r: r['qty'] * r['price'] - (r.get('discount') or 0)
    phys = lambda r: r['actualQty'] if r.get('actualQty') else r['qty']
    tx = lambda r: sum(e['amount'] for e in r.get('txExpenses') or [])
    cost, qty_in, qty_out = {}, {}, {}
    for p in db['purchases']:
        cost[p['material']] = cost.get(p['material'], 0) + net_amt(p)
        qty_in[p['material']] = qty_in.get(p['material'], 0) + phys(p) - (p.get('waste') or 0)
    for s in db['sales']:
        qty_out[s['material']] = qty_out.get(s['material'], 0) + phys(s)
    avg = {m: cost[m] / qty_in[m] for m in cost}
    revenue = sum(net_amt(s) for s in db['sales'])
    cogs = sum(qty_out.get(m, 0) * avg[m] for m in avg)
    opex = sum(e['amount'] for e in db['expenses'])
    tx_exp = sum(tx(r) for r in db['purchases'] + db['sales'])
    net = revenue - cogs - opex - tx_exp
    stock = {m: qty_in[m] - qty_out.get(m, 0) for m in qty_in}
    inv_value = sum(stock[m] * avg[m] for m in stock)
    coll = sum(x['amount'] for x in db['collections'])
    spay = sum(x['amount'] for x in db['supplierPayments'])
    draws = sum(w['amount'] for w in db['workerLiquidity'] if not w['returned'])
    advances = sum(a['amount'] for a in db['traderAdvances'] if not a['settled'])
    dist_paid = sum(x['amount'] - sum(b['drawsAbsorbed'] for b in x['breakdown']) for x in db['distributions'])
    fund = sum(f['amount'] * (1 if f['kind'] == 'in' else -1) for f in db['partnerFunding'])
    cash = (db['capital'] + sum(s['paid'] for s in db['sales']) + coll - sum(p['paid'] for p in db['purchases']) - spay
            - opex - tx_exp - draws - advances - dist_paid + fund)
    receivable = sum(net_amt(s) - s['paid'] for s in db['sales']) - coll
    payable = sum(net_amt(p) - p['paid'] for p in db['purchases']) - spay
    return {'revenue': revenue, 'cogs': cogs, 'net': net, 'inventoryValue': inv_value, 'cash': cash, 'receivable': receivable,
            'payable': payable, 'stock': stock, 'avg': avg}


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'synthetic_ledger.json'
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(build(), f, ensure_ascii=False, indent=1)
    print('wrote', out)
