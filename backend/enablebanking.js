// enablebanking.js — read-only open banking via Enable Banking
// (https://enablebanking.com). Replaces GoCardless Bank Account Data, which
// stopped accepting new sign-ups in July 2025.
//
// How it works for a normal person (no server editing needed):
//  1. They make a free Enable Banking login and register an "application"
//     in Production. Enable Banking gives them an Application ID and a
//     private key file (.pem).
//  2. They link their own bank accounts to that application in Enable
//     Banking's control panel ("restricted mode" — free, own accounts only).
//  3. In P.E.N.Y > More > Bank Sync they paste the Application ID and pick
//     the .pem file. P.E.N.Y stores both (encrypted) for that user only.
//
// P.E.N.Y can only ever READ balances and transactions — open banking
// "account information" access cannot move money.

const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');

const BASE_URL = process.env.EB_BASE_URL || 'https://api.enablebanking.com'; // override only for testing

function makeToken(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 },
    privateKeyPem,
    { algorithm: 'RS256', header: { typ: 'JWT', alg: 'RS256', kid: appId }, noTimestamp: true }
  );
}

async function ebFetch(creds, path, opts = {}) {
  if (!creds || !creds.appId || !creds.privateKey) {
    throw new Error('Bank sync is not set up yet. Go to More > Bank Sync and follow the setup steps.');
  }
  let token;
  try { token = makeToken(creds.appId, creds.privateKey); }
  catch (e) { throw new Error('The key file does not look right. Pick the .pem file Enable Banking gave you when you registered your application.'); }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = { message: text }; }
  if (!res.ok) {
    const detail = (body && (body.message || body.error || body.detail)) || text || '';
    const err = new Error(friendlyError(res.status, detail));
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return body;
}

function friendlyError(status, detail) {
  const d = String(typeof detail === 'string' ? detail : JSON.stringify(detail));
  if (status === 401 || status === 403) {
    if (/expired|revoked|consent|session/i.test(d)) return 'Your bank connection has expired. Reconnect your bank in More > Bank Sync.';
    return 'Enable Banking did not accept your Application ID and key file. Check you picked the .pem file that matches this Application ID. (' + d.slice(0, 160) + ')';
  }
  if (status === 422 && /redirect/i.test(d)) return 'The return address is not on your Enable Banking application\'s list of redirect URLs. Add it there exactly as shown in P.E.N.Y, then try again.';
  if (status === 429) return 'Your bank has limited how often it can be checked. Try again in a few hours.';
  return `Enable Banking request failed (${status}): ${d.slice(0, 200)}`;
}

// Banks available in a country, e.g. 'GB'. Restricted-mode applications can
// still list every bank, but can only open sessions for accounts linked in
// the Enable Banking control panel.
async function listBanks(creds, country = 'GB') {
  const data = await ebFetch(creds, `/aspsps?country=${encodeURIComponent(country)}&psu_type=personal`);
  return (data.aspsps || []).map(a => ({
    name: a.name,
    country: a.country,
    logo: a.logo || null,
    maxConsentDays: a.maximum_consent_validity ? Math.floor(a.maximum_consent_validity / 86400) : 90,
  }));
}

// Starts the bank login. Returns the URL to open (the bank's own page).
async function startAuth(creds, { bankName, country, redirectUrl, state, days = 90 }) {
  const validUntil = new Date(Date.now() + days * 86400000).toISOString();
  return ebFetch(creds, '/auth', {
    method: 'POST',
    body: JSON.stringify({
      access: { valid_until: validUntil },
      aspsp: { name: bankName, country },
      state,
      redirect_url: redirectUrl,
      psu_type: 'personal',
    }),
  });
}

// Swaps the one-time code from the bank's redirect for a session + account list.
async function createSession(creds, code) {
  return ebFetch(creds, '/sessions', { method: 'POST', body: JSON.stringify({ code }) });
}

async function deleteSession(creds, sessionId) {
  try { await ebFetch(creds, `/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }); } catch (_) { /* best effort */ }
}

async function getBalances(creds, accountUid) {
  const data = await ebFetch(creds, `/accounts/${encodeURIComponent(accountUid)}/balances`);
  return data.balances || [];
}

// All booked transactions since dateFrom (YYYY-MM-DD), following pagination.
async function getTransactions(creds, accountUid, dateFrom) {
  const all = [];
  let continuationKey = null;
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams();
    if (dateFrom) qs.set('date_from', dateFrom);
    if (continuationKey) qs.set('continuation_key', continuationKey);
    const data = await ebFetch(creds, `/accounts/${encodeURIComponent(accountUid)}/transactions?${qs.toString()}`);
    (data.transactions || []).forEach(t => all.push(t));
    continuationKey = data.continuation_key;
    if (!continuationKey) break;
  }
  return all;
}

// Turns one Enable Banking transaction into P.E.N.Y's shape.
// Amounts come as positive strings; credit_debit_indicator says which way.
function toPenyTransaction(t) {
  const raw = parseFloat((t.transaction_amount && t.transaction_amount.amount) || '0');
  const amount = t.credit_debit_indicator === 'DBIT' ? -Math.abs(raw) : Math.abs(raw);
  const date = t.booking_date || t.value_date || t.transaction_date;
  const counterparty = amount < 0 ? (t.creditor && t.creditor.name) : (t.debtor && t.debtor.name);
  const remittance = Array.isArray(t.remittance_information) ? t.remittance_information.join(' ') : (t.remittance_information || '');
  const payee = (counterparty || remittance || t.note || 'Bank transaction').trim().slice(0, 200);
  const ref = t.entry_reference || t.transaction_id || `${date}|${amount}|${remittance}`;
  return { date, amount, payee, notes: remittance && remittance !== payee ? remittance.slice(0, 500) : '', externalId: `eb:${ref}`, status: t.status };
}

// Picks the most useful balance figure the bank offers.
function pickBalance(balances) {
  const order = ['CLBD', 'ITBD', 'CLAV', 'ITAV', 'XPCD', 'OTHR'];
  const sorted = [...balances].sort((a, b) => {
    const ia = order.indexOf(a.balance_type); const ib = order.indexOf(b.balance_type);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const b = sorted[0];
  return b && b.balance_amount ? parseFloat(b.balance_amount.amount) : null;
}

module.exports = { listBanks, startAuth, createSession, deleteSession, getBalances, getTransactions, toPenyTransaction, pickBalance, makeToken };
