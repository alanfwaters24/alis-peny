// importers.js — reads the file formats Microsoft Money (and most other
// finance software) can export to: QIF and OFX. This is the "own your
// data, no lock-in" promise in practice — your dad's old MS Money export
// files can come straight into P.E.N.Y.

// ---------- QIF (Quicken Interchange Format) ----------
// MS Money could export QIF from File > Export. Records look like:
//   D07/15/2026
//   T-45.50
//   PTesco
//   LGroceries
//   ^
function parseQIF(text, dayFirst = false) {
  const lines = text.split(/\r?\n/);
  const records = [];
  let current = {};
  for (const line of lines) {
    if (!line) continue;
    if (line[0] === '^') { if (Object.keys(current).length) records.push(current); current = {}; continue; }
    if (line.startsWith('!')) continue; // header line, e.g. !Type:Bank
    const code = line[0];
    const value = line.slice(1).trim();
    if (code === 'D') current.date = normalizeQifDate(value, dayFirst);
    else if (code === 'T' || code === 'U') current.amount = parseFloat(value.replace(/,/g, ''));
    else if (code === 'P') current.payee = value;
    else if (code === 'M') current.memo = value;
    else if (code === 'L') current.category = value;
  }
  if (Object.keys(current).length) records.push(current);
  return records.filter(r => r.date && r.amount !== undefined);
}

function normalizeQifDate(value, dayFirst) {
  // Handles MM/DD/YYYY, DD/MM/YYYY, and MM/DD'YY style QIF dates
  const m = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-']?(\d{2,4})$/);
  if (!m) return value;
  let [, a, b, y] = m;
  if (y.length === 2) y = (Number(y) > 50 ? '19' : '20') + y;
  const [month, day] = dayFirst ? [b, a] : [a, b];
  return `${y}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// ---------- OFX (Open Financial Exchange) ----------
// Also supported by MS Money's export/import. OFX is SGML-like — tags
// often aren't closed, so we extract with simple pattern matching rather
// than a full XML parser.
function parseOFX(text) {
  const parts = text.split(/<STMTTRN>/i).slice(1); // first chunk before any STMTTRN is header noise
  return parts.map(block => {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}>([^<\r\n]+)`, 'i'));
      return m ? m[1].trim() : '';
    };
    const dtposted = get('DTPOSTED');
    const date = dtposted && dtposted.length >= 8
      ? `${dtposted.slice(0, 4)}-${dtposted.slice(4, 6)}-${dtposted.slice(6, 8)}`
      : '';
    const amount = parseFloat(get('TRNAMT'));
    const payee = get('NAME') || get('PAYEE');
    const memo = get('MEMO');
    const fitid = get('FITID');
    return { date, amount, payee, memo, externalId: fitid };
  }).filter(r => r.date && !isNaN(r.amount));
}


// ---------- CSV (any UK bank's "download statement" file) ----------
// Every UK bank lets you download transactions as CSV from online banking,
// but each uses its own columns. Rather than ask people to map columns,
// P.E.N.Y finds the header row and works out which column is which.
// Covers layouts like Barclays, HSBC, Lloyds/Halifax/Bank of Scotland,
// NatWest/RBS, Santander, Nationwide, Monzo, Starling, Chase, Revolut,
// first direct, TSB and Co-op — and most others, as they follow the same ideas.

function splitCSVLine(line, delim) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(c => c.trim());
}

function parseCSVRows(text) {
  const clean = text.replace(/^﻿/, '');
  const firstLines = clean.split(/\r?\n/).slice(0, 15).join('\n');
  const delim = (firstLines.match(/;/g) || []).length > (firstLines.match(/,/g) || []).length ? ';'
    : (firstLines.match(/\t/g) || []).length > (firstLines.match(/,/g) || []).length ? '\t' : ',';
  // Join lines that sit inside a quoted value
  const rows = []; let buf = '';
  for (const line of clean.split(/\r?\n/)) {
    buf = buf ? buf + '\n' + line : line;
    if (((buf.match(/"/g) || []).length % 2) === 0) { if (buf.trim()) rows.push(splitCSVLine(buf, delim)); buf = ''; }
  }
  if (buf.trim()) rows.push(splitCSVLine(buf, delim));
  return rows;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

// UK banks put the day first, so 03/04/2026 is 3 April.
function parseUKDate(v) {
  if (!v) return null;
  const s = String(v).trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?.*$/, '');
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/))) return iso(m[3], m[2], m[1]);
  if ((m = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3,4})[A-Za-z]*[\s\-,]+(\d{2,4})$/))) {
    const mon = MONTHS[m[2].toLowerCase()]; if (mon) return iso(m[3], mon, m[1]);
  }
  if ((m = s.match(/^([A-Za-z]{3,4})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const mon = MONTHS[m[1].toLowerCase()]; if (mon) return iso(m[3], mon, m[2]);
  }
  return null;
}
function iso(y, mo, d) {
  y = String(y); if (y.length === 2) y = (Number(y) > 50 ? '19' : '20') + y;
  const mm = Number(mo), dd = Number(d);
  if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

// "£1,234.56", "-12.30", "(12.30)", "12.30 DR", "12.30CR" → number
function parseMoney(v) {
  if (v === undefined || v === null) return null;
  let s = String(v).trim();
  if (!s || s === '-') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/\bDR$/i.test(s) || /DR$/i.test(s)) { neg = true; s = s.replace(/DR$/i, ''); }
  s = s.replace(/CR$/i, '');
  s = s.replace(/[£$€\s,]/g, '').replace(/GBP/i, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  return neg ? -n : n;
}

const COLS = {
  date: [/^(transaction\s*)?date$/i, /^date\s*(posted|of transaction)?$/i, /booking\s*date/i, /posting\s*date/i, /^completed\s*date$/i, /^started\s*date$/i, /^date$/i, /date/i],
  payee: [/^name$/i, /^payee$/i, /counter\s*party/i, /^merchant/i, /^transaction\s*description$/i, /^description$/i, /^details$/i, /^narrative$/i, /description/i],
  memo: [/^reference$/i, /^memo$/i, /^notes?$/i, /^subcategory$/i, /^type$/i, /^transaction\s*type$/i, /^category$/i],
  amount: [/^amount(\s*\(gbp\))?$/i, /^value$/i, /^amount$/i, /^transaction\s*amount$/i, /amount/i],
  out: [/paid\s*out/i, /money\s*out/i, /^debit(\s*amount)?$/i, /^debits?$/i, /withdrawal/i, /^out$/i, /spent/i],
  in: [/paid\s*in/i, /money\s*in/i, /^credit(\s*amount)?$/i, /^credits?$/i, /deposit/i, /^in$/i, /received/i],
};
const SKIP_PAYEE = [/balance/i, /sort\s*code/i, /account\s*(number|name)/i];

function findCol(header, patterns, used, skip = []) {
  for (const re of patterns) {
    const i = header.findIndex((h, idx) => !used.has(idx) && re.test(h) && !skip.some(s => s.test(h)));
    if (i >= 0) return i;
  }
  return -1;
}

function detectCSV(rows) {
  // Find the header row in the first 20 lines (Nationwide etc. put account info first)
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const header = rows[r].map(h => h.replace(/^"|"$/g, '').trim());
    const used = new Set();
    const date = findCol(header, COLS.date, used); if (date < 0) continue; used.add(date);
    const amount = findCol(header, COLS.amount, used, [/balance/i, /debit/i, /credit/i, /local/i, /paid/i, /money/i, /fee/i]);
    if (amount >= 0) used.add(amount);
    const out = amount < 0 ? findCol(header, COLS.out, used) : -1; if (out >= 0) used.add(out);
    const inn = amount < 0 ? findCol(header, COLS.in, used) : -1; if (inn >= 0) used.add(inn);
    if (amount < 0 && out < 0 && inn < 0) continue;
    const payee = findCol(header, COLS.payee, used, SKIP_PAYEE); if (payee >= 0) used.add(payee);
    const memo = findCol(header, COLS.memo, used, SKIP_PAYEE);
    return { headerRow: r, header, cols: { date, amount, out, in: inn, payee, memo } };
  }
  // No header (HSBC and some others): date, description, amount [, balance]
  const sample = rows.slice(0, 5);
  if (sample.length && sample.every(row => parseUKDate(row[0]) && row.length >= 3)) {
    const amountCol = parseMoney(sample[0][2]) !== null ? 2 : sample[0].length - 1;
    return { headerRow: -1, header: null, cols: { date: 0, payee: 1, amount: amountCol, out: -1, in: -1, memo: -1 } };
  }
  return null;
}

function parseCSV(text) {
  const rows = parseCSVRows(text);
  const det = detectCSV(rows);
  if (!det) throw new Error('Could not find the Date and Amount columns in this CSV file. Check it is a transactions download from your online banking.');
  const { cols } = det;
  const records = [];
  for (let r = det.headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const date = parseUKDate(row[cols.date]);
    if (!date) continue;
    let amount = null;
    if (cols.amount >= 0) amount = parseMoney(row[cols.amount]);
    else {
      const o = cols.out >= 0 ? parseMoney(row[cols.out]) : null;
      const i = cols.in >= 0 ? parseMoney(row[cols.in]) : null;
      if (o !== null && o !== 0) amount = -Math.abs(o);
      else if (i !== null) amount = Math.abs(i);
      else if (o === 0) amount = 0;
    }
    if (amount === null || isNaN(amount)) continue;
    let payee = cols.payee >= 0 ? (row[cols.payee] || '') : '';
    let memo = cols.memo >= 0 ? (row[cols.memo] || '') : '';
    if (!payee && memo) { payee = memo; memo = ''; }   // e.g. Barclays keeps the description in "Memo"
    payee = payee.replace(/\s{2,}/g, ' ').trim();
    records.push({ date, amount, payee: payee.slice(0, 200), memo: memo.slice(0, 500) });
  }
  return { records, detected: describeDetection(det) };
}

function describeDetection(det) {
  if (!det.header) return 'No header row — read as Date, Description, Amount';
  const h = det.header; const c = det.cols;
  const parts = [`Date = "${h[c.date]}"`];
  if (c.amount >= 0) parts.push(`Amount = "${h[c.amount]}"`);
  else { if (c.out >= 0) parts.push(`Money out = "${h[c.out]}"`); if (c.in >= 0) parts.push(`Money in = "${h[c.in]}"`); }
  if (c.payee >= 0) parts.push(`Description = "${h[c.payee]}"`);
  return parts.join(', ');
}

// Works out the file type from its name and contents, so people don't have to.
function detectFormat(filename, content) {
  const name = (filename || '').toLowerCase();
  const head = String(content || '').slice(0, 2000);
  if (/<OFX>|OFXHEADER|<STMTTRN>/i.test(head) || /\.(ofx|qfx)$/.test(name)) return 'ofx';
  if (/^\s*!Type:/im.test(head) || /\.qif$/.test(name)) return 'qif';
  return 'csv';
}

function parseStatement(format, content, opts = {}) {
  if (format === 'qif') return parseQIF(content, !!opts.dayFirst);
  if (format === 'ofx' || format === 'qfx') return parseOFX(content);
  if (format === 'csv') return parseCSV(content).records;
  throw new Error(`Unsupported import format: ${format}`);
}

module.exports = { parseQIF, parseOFX, parseCSV, parseStatement, detectFormat, parseUKDate, parseMoney };
