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

function parseStatement(format, content, opts = {}) {
  if (format === 'qif') return parseQIF(content, !!opts.dayFirst);
  if (format === 'ofx' || format === 'qfx') return parseOFX(content);
  throw new Error(`Unsupported import format: ${format}`);
}

module.exports = { parseQIF, parseOFX, parseStatement };
