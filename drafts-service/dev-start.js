'use strict';
// Local development launcher: fills in throw-away secrets so the service runs with zero setup.
// Production (Render) sets the real values as environment variables and starts server.js directly.
// With --mock (or DEV_MOCK_AI=1) it also starts the scripted Gemini stand-in so the voice flow can be tried offline.
process.env.PORT         = process.env.PORT         || '8790';
process.env.HOST         = process.env.HOST         || '127.0.0.1';   // local development stays on this machine (HOST=0.0.0.0 to try it from a phone on the same Wi-Fi)
process.env.OWNER_TOKEN  = process.env.OWNER_TOKEN  || 'dev-owner-token';
process.env.FIELD_CODES  = process.env.FIELD_CODES  || 'عز:1234,أحمد:5678';
process.env.FIELD_SCOPES = process.env.FIELD_SCOPES || 'أحمد:deals+money';   // أحمد can't ask about expenses or stock (shows the scope check)
if ((process.env.DEV_MOCK_AI === '1' || process.argv.includes('--mock'))) {
  require('./test/mock-gemini.js');
  const MOCK = 'http://127.0.0.1:' + (process.env.MOCK_AI_PORT || '8793');
  process.env.GEMINI_BASE = process.env.GEMINI_BASE || MOCK;
  process.env.XAI_BASE = process.env.XAI_BASE || MOCK;
  if (process.argv.includes('--grok')) process.env.XAI_API_KEY = process.env.XAI_API_KEY || 'mock';   // test the Grok path (text only)
  else process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'mock';
}
require('./server.js');
