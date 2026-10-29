// Builds the data for the two Xola PORTAL reports from the Xola API, in the portal's own columns:
//   cashflow       = portal "Cash Flow Report"  (file Xola_transactions_...xlsx: Report Details / Summary / Transactions)
//   purchaseitems  = portal "Purchase Items"    (file Xola_purchaseItems_...xlsx: Events / Reservations)
// The layout (sheets, columns, order, formats) comes from real portal exports. WHERE each value comes from in the Xola API
// is listed in the CANDIDATES tables below: the first path that has a value wins. If the API names a field differently, only
// these tables need changing. Columns that no row could fill are reported back as `missing` so nothing is silently wrong.
const { xget, allPages, addDays, dateVal } = require('./_xola');

const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const has = v => v !== undefined && v !== null && v !== '';
function pick(objs, paths) {
  for (const o of objs) for (const p of paths) { const v = o == null ? undefined : get(o, p); if (has(v)) return v; }
  return undefined;
}
const num = v => { if (!has(v)) return undefined; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? undefined : Math.round(n * 100) / 100; };
const idOf = v => (v && typeof v === 'object' ? v.id : v);

// ---- where each portal column comes from (first match wins). t = transaction, it = its item, o = order ----
const CF = {
  txId:        { t: ['id'] },
  purchaseId:  { t: ['order.id', 'order', 'orderId'] },
  confirm:     { t: ['order.confirmationCode', 'confirmationCode', 'order.code', 'order.confirmation'] },
  arrival:     { it: ['orderItem.arrivalDatetime', 'orderItem.arrivalDate', 'orderItem.arrival', 'arrival'], t: ['order.arrival', 'arrival'] },
  realized:    { it: ['realizedAt'] },
  pkg:         { it: ['orderItem.package.name', 'package.name'], t: ['package.name'] },
  item:        { it: ['orderItem.name', 'orderItem.experience.name', 'orderItem.product.name', 'product.name', 'name'], t: ['experience.name', 'product.name'] },
  customer:    { t: ['order.customerName', 'customerName', 'order.customer.name', 'customer.name'] },
  currency:    { t: ['currency', 'order.currency'] },
  gross:       { it: ['gross'], t: ['gross', 'amount'] },
  net:         { it: ['net'], t: ['net'] },
  processing:  { it: ['fees.processing', 'processingFee'], t: ['fees.processing', 'processingFee'] },
  service:     { it: ['fees.service', 'serviceFee'], t: ['fees.service', 'serviceFee'] },
  guestFee:    { it: ['fees.guest', 'guestFee'], t: ['fees.guest', 'guestFee'] },
  balance:     { t: ['balance'] },
  source:      { t: ['order.source.name', 'order.source', 'source.name', 'source'] },
  method:      { t: ['method', 'paymentMethod', 'payment.method'] },
  brand:       { t: ['cardBrand', 'card.brand', 'ccBrand', 'brand', 'cc.brand', 'payment.cardBrand'] },
  tags:        { t: ['order.tags', 'tags'] },
  payoutDate:  { t: ['payout.createdAt', 'payoutDate', 'payout.date'] },
  taxes:       { it: ['taxesAndFees', 'taxes', 'fees.taxes'], t: ['taxesAndFees', 'taxes'] },
  cardFee:     { it: ['fees.card', 'cardFee'], t: ['fees.card', 'cardFee'] }
};
const PI = {   // o = order, it = reservation (order item)
  resId:     { it: ['id'] },
  purchase:  { o: ['id'] },
  product:   { it: ['experience.name', 'name', 'product.name'], o: ['experience.name'] },
  arrival:   { it: ['arrivalDatetime', 'arrival', 'arrivalDate'] },
  arrTime:   { it: ['arrivalTime'] },
  name:      { o: ['customerName', 'customer.name'] },
  email:     { o: ['customerEmail', 'customer.email', 'email'] },
  base:      { it: ['base', 'baseAmount', 'subtotal'] },
  taxes:     { it: ['taxesAndFees', 'taxes', 'tax'] },
  cardFee:   { it: ['cardFee', 'fees.card'] },
  adjust:    { it: ['adjustments', 'adjustment'] },
  total:     { it: ['amount', 'total', 'totalValue'], o: ['amount', 'total'] },
  revenue:   { it: ['revenue', 'net'] },
  payStatus: { o: ['paymentStatus', 'payment.status', 'paidStatus'] },
  source:    { o: ['source.name', 'source'] },
  status:    { it: ['status'], o: ['status'] },
  guides:    { it: ['guides'], o: ['guides'] },
  guestStat: { it: ['guestStatus'], o: ['guestStatus'] },
  checkins:  { it: ['checkedIn', 'checkins'], o: ['checkedIn', 'checkins'] },
  created:   { o: ['createdAt'] },
  by:        { o: ['createdBy.name', 'createdByName', 'createdBy'] },
  tags:      { o: ['tags'] },
  confirm:   { o: ['confirmationCode', 'confirmation', 'code'] },
  demo:      { it: ['demographics', 'guests'] }
};
const val = (map, key, ctx) => {                        // ctx = { t, it, o }
  const m = map[key]; if (!m) return undefined;
  for (const slot of ['it', 'o', 't']) {
    if (!m[slot] || !ctx[slot]) continue;
    const v = pick([ctx[slot]], m[slot]); if (has(v)) return v;
  }
  return undefined;
};

// ---- time helpers: everything is shown in the location's own time zone, as the portal does ----
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtCache = {};
function wall(v, tz) {                                   // -> { d: 'YYYY-MM-DD', t: 'HH:MM:SS' } in tz, or null
  if (!has(v)) return null;
  let s = String(v).trim();
  if (/^\d{9,13}$/.test(s)) s = new Date(+s * (s.length <= 10 ? 1000 : 1)).toISOString();
  s = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { d: s, t: '00:00:00' };
  let m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);        // no zone given: already wall time
  if (m) return { d: m[1], t: m[2] + ':' + m[3] + ':' + (m[4] || '00') };
  const dt = new Date(s); if (isNaN(dt)) return null;
  let f = fmtCache[tz];
  if (!f) { try { f = fmtCache[tz] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); } catch (e) { f = fmtCache[tz] = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); } }
  const p = {}; f.formatToParts(dt).forEach(x => { p[x.type] = x.value; });
  return { d: p.year + '-' + p.month + '-' + p.day, t: p.hour + ':' + p.minute + ':' + p.second };
}
const dmy = d => d ? d.slice(8, 10) + '-' + MON[+d.slice(5, 7) - 1] + '-' + d.slice(0, 4) : undefined;          // 27-Oct-2026
const h12 = t => { const h = +t.slice(0, 2); return String((h % 12) || 12).padStart(2, '0') + ':' + t.slice(3, 5) + ' ' + (h < 12 ? 'AM' : 'PM'); };   // 08:00 PM
const localIso = w => w ? w.d + 'T' + w.t : undefined;                                                          // wall time, no zone

async function sellerInfo(id) {
  const tzEnv = process.env.XOLA_TIMEZONE || 'UTC';
  try { const s = await xget('/sellers/' + encodeURIComponent(id)); const tz = s.timezone || s.timeZone; return { name: s.name || s.displayName || id, tz: tz || tzEnv, tzKnown: !!(tz || process.env.XOLA_TIMEZONE) }; }
  catch (e) { return { name: id, tz: tzEnv, tzKnown: !!process.env.XOLA_TIMEZONE }; }   // not allowed to read the account record: keep going, but warn that dates may be off
}
const tzWarn = info => (info.tzKnown ? [] : ['Time zone (assumed UTC: set XOLA_TIMEZONE in Vercel)']);
const tagsOf = v => (Array.isArray(v) ? v.map(x => (x && typeof x === 'object' ? x.name || x.label || '' : x)).filter(Boolean).join(', ') : (has(v) ? String(v) : '')) || undefined;
const title = s => has(s) ? String(s).replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : undefined;
const confirmOf = v => { if (!has(v)) return undefined; const s = String(v); return /^\d+$/.test(s) && s.length < 16 ? Number(s) : s; };   // portal shows all-digit codes as numbers

// ======================= Cash Flow Report =======================
const CF_TYPES = ['purchase', 'purchase_affiliate', 'deposit', 'balance', 'refund', 'modify'];
const CF_KEY = ['Transaction ID', 'Purchase ID', 'Transaction Date', 'Item', 'Gross', 'Net', 'Method'];

async function cashflow(seller, from, to) {
  const info = await sellerInfo(seller), sid = encodeURIComponent(seller);
  const lists = await Promise.all(CF_TYPES.map(type => allPages('/transactions?seller=' + sid + '&type=' + type + '&exclude=remoteTransactions&createdAt[gte]=' + dateVal(addDays(from, -1)) + '&createdAt[lt]=' + dateVal(addDays(to, 2)))));
  const rows = [];
  lists.forEach(recs => recs.forEach(t => {
    const tw = wall(t.createdAt, info.tz);
    if (!tw || tw.d < from || tw.d > to) return;           // filter on the location's local day, exactly like the portal
    const items = Array.isArray(t.items) && t.items.length ? t.items : [null];
    items.forEach(it => {
      const c = { t, it };
      const arr = wall(val(CF, 'arrival', c), info.tz), real = wall(val(CF, 'realized', c), info.tz) || arr;
      const method = title(val(CF, 'method', c)), brand = val(CF, 'brand', c), pay = wall(val(CF, 'payoutDate', c), info.tz);
      rows.push({
        'Transaction ID': val(CF, 'txId', c), 'Purchase ID': idOf(val(CF, 'purchaseId', c)), 'Confirmation Code': confirmOf(val(CF, 'confirm', c)),
        'Transaction Date': localIso(tw), 'Arrival Date': arr ? dmy(arr.d) : undefined, 'Realized Date': localIso(real),
        'Package': val(CF, 'pkg', c), 'Item': val(CF, 'item', c), 'Customer Name': val(CF, 'customer', c), 'Currency': val(CF, 'currency', c),
        'Gross': num(val(CF, 'gross', c)), 'Processing Fee': num(val(CF, 'processing', c)), 'Service Fee': num(val(CF, 'service', c)), 'Guest Fee': num(val(CF, 'guestFee', c)),
        'Net': num(val(CF, 'net', c)), 'Balance': num(val(CF, 'balance', c)), 'Source': val(CF, 'source', c), 'Method': method, 'CC Brand': brand,
        'Tags': tagsOf(val(CF, 'tags', c)), 'Payout Date': pay ? localIso(pay) : undefined, 'Taxes & Fees': num(val(CF, 'taxes', c)), 'Card fee': num(val(CF, 'cardFee', c))
      });
    });
  }));
  const missing = CF_KEY.filter(k => rows.length && rows.every(r => !has(r[k]))).concat(rows.length ? tzWarn(info) : []);
  return { meta: { company: info.name, timezone: info.tz }, rows, missing };
}

// ======================= Purchase Items (Events + Reservations) =======================
const PI_KEY = ['Reservation ID', 'Purchase ID', 'Product', 'Arrival Date', 'Arrival Time', 'Name', 'Total Value'];

async function purchaseitems(seller, from, to) {
  const info = await sellerInfo(seller), sid = encodeURIComponent(seller);
  const orders = await allPages('/orders?seller=' + sid + '&items.arrival[range]=' + addDays(from, -1) + ',' + addDays(to, 1));
  const rows = [];
  orders.forEach(o => {
    const items = Array.isArray(o.items) && o.items.length ? o.items : [null];
    items.forEach(it => {
      const c = { o, it };
      let arr = wall(val(PI, 'arrival', c), info.tz);
      const at = val(PI, 'arrTime', c);
      if (arr && has(at) && /^\d{3,4}$/.test(String(at)) && arr.t === '00:00:00') { const s = String(at).padStart(4, '0'); arr = { d: arr.d, t: s.slice(0, 2) + ':' + s.slice(2) + ':00' }; }
      if (!arr || arr.d < from || arr.d > to) return;
      const demoRaw = val(PI, 'demo', c), demo = {};
      (Array.isArray(demoRaw) ? demoRaw : []).forEach(d => { const n = d && (d.label || d.name || (d.demographic && (d.demographic.label || d.demographic.name))); const q = d && num(d.quantity != null ? d.quantity : d.count); if (n && q !== undefined) demo[n] = (demo[n] || 0) + q; });
      const g = val(PI, 'guides', c), cr = wall(val(PI, 'created', c), info.tz);
      const gs = val(PI, 'guestStat', c);
      rows.push({
        'Reservation ID': val(PI, 'resId', c), 'Purchase ID': val(PI, 'purchase', c), 'Product': val(PI, 'product', c),
        'Arrival Date': dmy(arr.d), 'Arrival Time': h12(arr.t), '_sort': arr.d + 'T' + arr.t,
        'Name': val(PI, 'name', c), 'Email': val(PI, 'email', c), 'Demographics': demo,
        'Base Amount': num(val(PI, 'base', c)), 'Total Taxes & Fees': num(val(PI, 'taxes', c)), 'Card fee': num(val(PI, 'cardFee', c)),
        'Adjustments': num(val(PI, 'adjust', c)), 'Total Value': num(val(PI, 'total', c)), 'Revenue': num(val(PI, 'revenue', c)),
        'Payment Status': title(val(PI, 'payStatus', c)), 'Source': (() => { const s = val(PI, 'source', c); return s && typeof s === 'object' ? s.name : s; })(),
        'Status': title(val(PI, 'status', c)),
        'Guides': (Array.isArray(g) ? g.map(x => (x && typeof x === 'object' ? x.name || x.fullName || [x.firstName, x.lastName].filter(Boolean).join(' ') : x)).filter(Boolean).join(', ') : (has(g) ? String(g) : '')) || undefined,
        'Guest Status': has(gs) ? (/^arrived$/i.test(gs) ? 'Checked in' : title(gs)) : undefined,
        'Total Check-ins': num(val(PI, 'checkins', c)),
        'Purchase Date': cr ? dmy(cr.d) + ', ' + h12(cr.t) : undefined, 'Purchased By': (() => { const b = val(PI, 'by', c); return b && typeof b === 'object' ? b.name : b; })(),
        'Tags': tagsOf(val(PI, 'tags', c)), 'Confirmation Code': confirmOf(val(PI, 'confirm', c))
      });
    });
  });
  const missing = PI_KEY.filter(k => rows.length && rows.every(r => !has(r[k]))).concat(rows.length ? tzWarn(info) : []);
  return { meta: { company: info.name, timezone: info.tz }, rows, missing };
}

module.exports = { cashflow, purchaseitems, PORTAL: { cashflow, purchaseitems } };
