'use strict';
// Local development launcher: fills in throw-away secrets so the service runs with zero setup.
// Production (Render) sets the real values as environment variables and starts server.js directly.
process.env.PORT        = process.env.PORT        || '8790';
process.env.OWNER_TOKEN = process.env.OWNER_TOKEN || 'dev-owner-token';
process.env.FIELD_CODES = process.env.FIELD_CODES || 'عز:1234,أحمد:5678';
require('./server.js');
