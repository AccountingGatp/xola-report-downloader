// Shared helpers for the Xola Report Downloader (files starting with "_" are not exposed as API routes by Vercel).
const crypto = require('crypto');

const BASE = (process.env.XOLA_BASE || 'https://xola.com/api').replace(/\/$/, '');
const KEY = process.env.XOLA_API_KEY || '';
const LIMIT = 200;

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const send = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(obj)); };

// Checks method, team password and Xola key. Returns the parsed body, or null after having answered the request.
function guard(req, res) {
  if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }); return null; }
  const pw = process.env.APP_PASSWORD;
  if (!pw) { send(res, 503, { error: 'APP_PASSWORD is not set in Vercel. Add it under Settings > Environment Variables and redeploy.' }); return null; }
  if (!same(req.headers['x-app-key'] || '', pw)) { send(res, 401, { error: 'unauthorized' }); return null; }
  if (!KEY) { send(res, 503, { error: 'XOLA_API_KEY is not set in Vercel. Add it under Settings > Environment Variables and redeploy.' }); return null; }
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === 'object' ? b : {};
}

async function xget(path) {
  let p = path;
  if (/^https?:\/\//i.test(p)) { const u = new URL(p); p = u.pathname + u.search; }
  p = p.replace(/^\/api(?=\/)/, '');
  const r = await fetch(BASE + p, { headers: { 'X-API-KEY': KEY, accept: 'application/json' } });
  if (!r.ok) {
    const e = new Error('Xola answered ' + r.status + ' for ' + p.split('?')[0]);
    e.status = r.status === 401 || r.status === 403 ? 401 : (r.status === 429 ? 429 : 502);
    if (r.status === 401 || r.status === 403) e.message = 'Xola rejected the API key (' + r.status + '). Check XOLA_API_KEY in Vercel.';
    throw e;
  }
  return r.json();
}

// Reads every page of a list endpoint. Uses paging.next when Xola gives it, otherwise skip/limit.
async function allPages(path, maxPages = 60) {
  const rows = [];
  let cur = path + (path.includes('?') ? '&' : '?') + 'limit=' + LIMIT;
  let skip = 0, firstId = null;
  for (let page = 0; page < maxPages && cur; page++) {
    const j = await xget(cur);
    const data = Array.isArray(j) ? j : (j.data || []);
    if (page > 0 && data.length && data[0] && firstId != null && data[0].id === firstId) break;   // server ignored skip: stop, don't loop
    if (page === 0 && data.length) firstId = data[0].id;
    rows.push(...data);
    if (j.paging && j.paging.next) cur = j.paging.next;
    else if (data.length >= LIMIT) { skip += LIMIT; cur = path + (path.includes('?') ? '&' : '?') + 'limit=' + LIMIT + '&skip=' + skip; }
    else cur = '';
  }
  return rows;
}

const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
const dateVal = iso => process.env.XOLA_DATE_EPOCH === '1' ? String(Date.parse(iso + 'T00:00:00Z') / 1000) : iso;   // docs say createdAt is epoch; plain dates work too

// ---- flattening: one nested record -> flat { 'a.b.c': value } rows (one row per entry of `items`) ----
function flat(o, prefix, out) {
  if (o == null) return out;
  if (Array.isArray(o)) {
    if (o.every(v => v == null || typeof v !== 'object')) { out[prefix] = o.join('; '); return out; }
    o.slice(0, 8).forEach((v, i) => flat(v, prefix + '.' + i, out));
    return out;
  }
  if (typeof o === 'object') { Object.keys(o).forEach(k => flat(o[k], prefix ? prefix + '.' + k : k, out)); return out; }
  out[prefix] = o; return out;
}
function rowsOf(rec) {
  const items = Array.isArray(rec.items) && rec.items.length && rec.items.every(i => i && typeof i === 'object') ? rec.items : null;
  if (!items) return [flat(rec, '', {})];
  const base = Object.assign({}, rec); delete base.items;
  const head = flat(base, '', {});
  return items.map(it => Object.assign({}, head, flat(it, 'item', {})));
}

// ---- report catalogue ----
const REPORTS = {
  payouts:  { label: 'Payouts (money Xola sent to the bank)', src: 'transactions', types: ['auto_payout', 'payout', 'payout_adjust'], note: 'Same data as the Payouts report. Date = payout date.' },
  sales:    { label: 'Sales (purchases, deposits, balances)', src: 'transactions', types: ['purchase', 'purchase_affiliate', 'deposit', 'balance', 'modify'], note: 'Money taken from travelers. Date = transaction date.' },
  refunds:  { label: 'Refunds', src: 'transactions', types: ['refund'], note: 'Money returned to travelers. Date = refund date.' },
  all_tx:   { label: 'All transactions', src: 'transactions', types: null, note: 'Every transaction type in one file (sales, refunds, payouts, fees, subscriptions). Date = transaction date.' },
  bookings_arrival: { label: 'Bookings by arrival date', src: 'orders', dateField: 'items.arrival', note: 'Orders whose trip date falls in the period (who is arriving).' },
  bookings_created: { label: 'Bookings by booked date', src: 'orders', dateField: 'createdAt', note: 'Orders created in the period (when the sale was made).' }
};

async function fetchReport(key, seller, from, to) {
  const rep = REPORTS[key];
  const sid = encodeURIComponent(seller);
  const rows = [];
  if (rep.src === 'transactions') {
    const types = rep.types || [null];
    for (const t of types) {
      let q = '/transactions?seller=' + sid + (t ? '&type=' + t : '') + '&exclude=remoteTransactions' +
        '&createdAt[gte]=' + dateVal(from) + '&createdAt[lt]=' + dateVal(addDays(to, 1));
      const recs = await allPages(q);
      recs.forEach(r => { rowsOf(r).forEach(x => rows.push(x)); });
    }
  } else {
    const q = rep.dateField === 'items.arrival'
      ? '/orders?seller=' + sid + '&items.arrival[range]=' + from + ',' + to
      : '/orders?seller=' + sid + '&createdAt[gte]=' + dateVal(from) + '&createdAt[lt]=' + dateVal(addDays(to, 1));
    const recs = await allPages(q);
    recs.forEach(r => { rowsOf(r).forEach(x => rows.push(x)); });
  }
  return rows;
}

// ---- locations ----
async function listSellers() {
  const out = new Map();
  let source = '';
  if (process.env.XOLA_SELLERS) {                                   // {"Location name":"sellerId"}
    try { const m = JSON.parse(process.env.XOLA_SELLERS); Object.keys(m).forEach(n => out.set(m[n], n)); source = 'XOLA_SELLERS'; } catch (e) { /* ignore bad JSON, fall through */ }
  }
  if (!out.size) {
    try {
      const recs = await allPages('/sellers', 10);
      recs.forEach(s => { if (s && s.id) out.set(s.id, s.name || s.displayName || s.id); });
      if (out.size) source = 'sellers';
    } catch (e) { if (e.status === 401) throw e; }
  }
  if (!out.size) {                                                   // last resort: sellers seen on recent payouts
    const from = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    for (const t of ['auto_payout', 'payout']) {
      try {
        const recs = await allPages('/transactions?type=' + t + '&exclude=remoteTransactions&createdAt[gte]=' + from, 15);
        recs.forEach(r => { const id = r.seller && (typeof r.seller === 'object' ? r.seller.id : r.seller); if (id) out.set(id, out.get(id) || id); });
      } catch (e) { if (e.status === 401) throw e; }
    }
    for (const id of [...out.keys()]) {
      if (out.get(id) !== id) continue;
      try { const s = await xget('/sellers/' + encodeURIComponent(id)); out.set(id, s.name || s.displayName || id); } catch (e) { /* keep id */ }
    }
    if (out.size) source = 'payouts';
  }
  const sellers = [...out.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  return { sellers, source };
}

module.exports = { guard, send, REPORTS, fetchReport, listSellers, isDate, addDays, xget, allPages, dateVal };
