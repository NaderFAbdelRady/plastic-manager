'use strict';
// A scripted stand-in for Gemini so the capture flow can be tested without a key or network.
// Run:  node test/mock-gemini.js   then start the service with GEMINI_API_KEY=x GEMINI_BASE=http://localhost:8793
const http = require('http');
const ymd = d => d.toISOString().slice(0, 10);
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
function converse(text, audio, hasPending) {
  const t = audio ? 'اشتريت من هاني عيسي ٢٠٧٠ كيلو ABS بسعر ٢٧ ودفعت ٣٠ ألف' : text;
  const R = o => ({ transcript: t, confidence: 0.9, ...o });
  if (/آجل/.test(t) && hasPending) return R({ intent: 'record', draft: { type: 'purchase', fields: { party: 'هاني عيسي', material: 'ABS', qty: 2070, unit: 'كيلوجرام', price: 27, paid: 0 }, missing: [], question: '', reply: 'شراء ٢٠٧٠ كيلو ABS من هاني عيسي بسعر ٢٧ آجل بالكامل' } });
  if (/^(ايوه|أيوه|تمام|ابعت|ماشي)/.test(t)) return R({ intent: hasPending ? 'confirm' : 'chat', reply: 'مفيش حاجة معلّقة.' });
  if (/^(لأ|لا|الغي|إلغي)/.test(t)) return R({ intent: hasPending ? 'cancel' : 'chat', reply: 'تمام.' });
  if (/هاني عيسي ٣٠ ألف|هاني عيسي 30000/.test(t)) return R({ intent: 'clarify', confidence: 0.4, question: 'تقصد تسجّل دفعة لهاني ٣٠ ألف، ولا عايز تعرف حسابه؟' });
  if (/آجل/.test(t) && hasPending) return R({ intent: 'record', draft: { type: 'purchase', fields: { party: 'هاني عيسي', material: 'ABS', qty: 2070, unit: 'كيلوجرام', price: 27, paid: 0 }, missing: [], question: '', reply: 'شراء ٢٠٧٠ كيلو ABS من هاني عيسي بسعر ٢٧ آجل بالكامل' } });
  if (/سجّل.*وقولي/.test(t)) return R({ intent: 'both', draft: { type: 'purchase', fields: { party: 'جمال ابو الحسن', material: 'ABS', qty: 1000, unit: 'كيلوجرام', price: 40, paid: 0 }, missing: [], question: '', reply: 'شراء طن ABS من جمال آجل' }, query: { entity: 'balances', party: 'جمال ابو الحسن' } });
  if (/اشتريت/.test(t)) return R({ intent: 'record', draft: { type: 'purchase', fields: { date: ymd(new Date()), party: 'هاني عيسي', material: 'ABS', qty: 2070, unit: 'كيلوجرام', price: 27, paid: 30000, txExpenses: [{ desc: 'نقل', amount: 1000 }] }, missing: [], question: '', reply: 'شراء ٢٠٧٠ كيلو ABS من هاني عيسي بسعر ٢٧، مدفوع ٣٠ ألف' } });
  if (/صرفت|دفعت.*توكتوك/.test(t)) return R({ intent: 'record', draft: { type: 'expense', fields: { cat: 'نقل', amount: 350, desc: 'توكتوك' }, missing: [], question: '', reply: 'مصروف نقل ٣٥٠' } });
  if (/وجمال|و جمال/.test(t)) return R({ intent: 'query', query: { entity: 'balances', party: 'جمال ابو الحسن' } });
  if (/حساب\s+(\S+)/.test(t)) { const m = t.match(/حساب\s+(\S+(?:\s\S+)?)/)[1].replace(/\s?(كام|ايه|إيه)\??$/, '').replace('؟', ''); return R({ intent: 'query', query: { entity: 'balances', party: m } }); }
  if (/مين باع|باع/.test(t)) return R({ intent: 'query', query: { entity: 'deals', kinds: ['sale'], from: daysAgo(30), aggregate: 'group_party', sort: 'largest' } });
  if (/اشترينا من هاني.*ABS/.test(t)) return R({ intent: 'query', query: { entity: 'deals', kinds: ['purchase'], party: 'هاني عيسي', material: 'ABS', from: '2026-09-01', to: '2026-09-30', aggregate: 'sum' } });
  if (/اللي حصل/.test(t)) return R({ intent: 'query', query: { entity: 'all', from: '2026-10-13', to: '2026-10-15', aggregate: 'list', sort: 'newest', limit: 8 } });
  if (/مخزون|عندنا .* كام/.test(t)) return R({ intent: 'query', query: { entity: 'inventory' } });
  if (/الكاش|الخزنة|الربح/.test(t)) return R({ intent: 'query', query: { entity: 'all', aggregate: 'sum' }, reply: '' });
  return R({ intent: 'chat', reply: 'أهلاً! قولّي حركة أسجلها أو اسأل عن أي حاجة.' });
}
http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    try {
      const j = JSON.parse(b || '{}');
      if (/\/v1\/chat\/completions/.test(req.url)) {   // xAI / Grok (OpenAI-style) shape
        const msgs = j.messages || [], sysG = (msgs[0] || {}).content || '', lastG = (msgs[msgs.length - 1] || {}).content || '';
        let outG;
        if (/رجّع JSON فقط/.test(sysG)) outG = JSON.stringify(converse(lastG, false, /مسودة حركة معلّقة قدامه/.test(sysG)));
        else { const m = lastG.match(/النتيجة: (\{.*\})\sآخر تحديث: (.*)$/s); const Q = require('../query-engine'); let res = {}; try { res = JSON.parse(m[1]); } catch (e) {}
          res.entity = (lastG.match(/"entity":"(\w+)"/) || [])[1]; res.aggregate = (lastG.match(/"aggregate":"(\w+)"/) || [])[1] || 'list'; outG = Q.fallbackAnswer(res, m ? m[2] : ''); }
        res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + outG + '\n```' } }] }));
      }
      const last = (j.contents || []).slice(-1)[0] || { parts: [] };
      const text = last.parts.filter(p => p.text).map(p => p.text).join(' '), audio = last.parts.some(p => p.inlineData);
      const sys = ((j.systemInstruction || {}).parts || [{}])[0].text || '';
      const schema = j.generationConfig && j.generationConfig.responseSchema;
      let out;
      if (schema && schema.properties && schema.properties.intent) out = JSON.stringify(converse(text, audio, /مسودة حركة معلّقة قدامه/.test(sys)));
      else if (schema) out = JSON.stringify({ transcript: text, type: 'purchase', fields: {}, missing: [], question: '', reply: '' });
      else { // phrasing step: restate the already-computed result using the service's own template
        const m = text.match(/النتيجة: (\{.*\})\sآخر تحديث: (.*)$/s); const Q = require('../query-engine');
        let res = {}; try { res = JSON.parse(m[1]); } catch (e) {}
        res.entity = (text.match(/"entity":"(\w+)"/) || [])[1]; res.aggregate = (text.match(/"aggregate":"(\w+)"/) || [])[1] || 'list';
        out = Q.fallbackAnswer(res, m ? m[2] : ''); }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: out }] } }] }));
    } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: e.message } })); }
  });
}).listen(8793, () => console.log('mock gemini on :8793'));
