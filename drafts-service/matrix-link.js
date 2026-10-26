'use strict';
// matrix-link — the field assistant's avatar (Matrix) and this service talk to each other here.
//
// Two things, both switched on by environment variables (never committed). With none of them set, nothing below is reachable
// and the page the people use is the classic one.
//
//  • SSO — after a person types a valid code, ssoToken() signs a short sign-in (HS256, 12 hours) that Matrix accepts as that person's
//    sign-in to ONE deployment of the avatar. The code itself never goes to Matrix.
//  • Service key — the avatar's server calls /api/service/* with a shared secret to understand a message, file drafts and read the briefing.
//    The person's name rides in the body; the key proves the call comes from the avatar's server and not from a browser.
//
//   FIELD_MATRIX_URL     https://your-matrix.onrender.com   where the avatar app lives
//   FIELD_MATRIX_PK      pk_…                               the deployment's public key
//   FIELD_MATRIX_SECRET  sk_…                               the deployment's secret (signs the sign-in)
//   FIELD_SERVICE_KEY    16+ random characters, the same as MATRIX_PLASTIC_SERVICE_KEY on the Matrix side

const crypto = require('crypto');

const TOKEN_TTL_S = 12 * 3600;
const env = n => String(process.env[n] || '').trim();
const b64 = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// {url, pk} when the avatar is wired up, otherwise null (the classic page is then used).
function avatarConfig() {
  const url = env('FIELD_MATRIX_URL').replace(/\/+$/, ''), pk = env('FIELD_MATRIX_PK'), secret = env('FIELD_MATRIX_SECRET');
  return /^https?:\/\//.test(url) && pk && secret ? { url, pk } : null;
}

// A signed sign-in for this person, or null when the avatar is not configured.
function ssoToken(name) {
  if (!avatarConfig()) return null;
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ sub: name, name, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S }));
  const sig = b64(crypto.createHmac('sha256', env('FIELD_MATRIX_SECRET')).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

// True when the caller sent the shared key (constant time). No key configured = the service API is closed.
function serviceKeyOk(given) {
  const want = env('FIELD_SERVICE_KEY');
  if (want.length < 16) return false;
  const a = Buffer.from(String(given || '')), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { avatarConfig, ssoToken, serviceKeyOk };
