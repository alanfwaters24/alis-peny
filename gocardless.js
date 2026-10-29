// gocardless.js — talks to GoCardless "Bank Account Data" (formerly Nordigen),
// a free, read-only open banking API for UK/EU banks. PENY never has write
// access to your bank; it can only read balances and past transactions.
//
// To use this, you need your own free GoCardless Bank Account Data account:
// 1. Sign up at https://bankaccountdata.gocardless.com/
// 2. Create a "User secret" (secret_id + secret_key) in the developer portal
// 3. Put those in your .env file (see .env.example) as GOCARDLESS_SECRET_ID
//    and GOCARDLESS_SECRET_KEY — PENY reads them from there, they're never
//    hardcoded or sent anywhere except GoCardless's API.

const fetch = require('node-fetch');

const BASE_URL = 'https://bankaccountdata.gocardless.com/api/v2';
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const secretId = process.env.GOCARDLESS_SECRET_ID;
  const secretKey = process.env.GOCARDLESS_SECRET_KEY;
  if (!secretId || !secretKey) {
    throw new Error('Bank sync isn\'t set up yet. Add GOCARDLESS_SECRET_ID and GOCARDLESS_SECRET_KEY to your .env file — see Settings > Bank Sync in the app for instructions.');
  }

  const res = await fetch(`${BASE_URL}/token/new/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret_id: secretId, secret_key: secretKey }),
  });
  if (!res.ok) throw new Error(`GoCardless auth failed: ${res.status}`);
  const data = await res.json();
  cachedToken = data.access;
  tokenExpiry = Date.now() + (data.access_expires - 60) * 1000;
  return cachedToken;
}

async function gcFetch(path, opts = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GoCardless request failed (${res.status}): ${body}`);
  }
  return res.json();
}

// Search for a bank ("institution") by country code, e.g. "GB"
async function listInstitutions(country = 'GB') {
  return gcFetch(`/institutions/?country=${country}`);
}

// Start a bank connection. Returns a link the user opens in their browser
// to log into their bank and approve read-only, time-limited access.
async function createRequisition(institutionId, redirectUrl) {
  return gcFetch('/requisitions/', {
    method: 'POST',
    body: JSON.stringify({
      redirect: redirectUrl,
      institution_id: institutionId,
      reference: `peny-${Date.now()}`,
      user_language: 'EN',
    }),
  });
}

async function getRequisition(requisitionId) {
  return gcFetch(`/requisitions/${requisitionId}/`);
}

async function getAccountBalances(accountId) {
  return gcFetch(`/accounts/${accountId}/balances/`);
}

async function getAccountTransactions(accountId) {
  return gcFetch(`/accounts/${accountId}/transactions/`);
}

async function getAccountDetails(accountId) {
  return gcFetch(`/accounts/${accountId}/details/`);
}

module.exports = {
  listInstitutions,
  createRequisition,
  getRequisition,
  getAccountBalances,
  getAccountTransactions,
  getAccountDetails,
};
