// Troubleshooting only (page address ending in ?debug=1): lists the field names Xola really uses for one account,
// so the column mapping in api/_portal.js can be matched to them. Personal values (names, e-mails, phones, addresses) are hidden.
const { guard, send, xget, listOf } = require('./_xola');

const HIDE = /name|email|phone|address|street|city|zip|postal|passport|note|comment|ip$/i;
function walk(o, path, out, depth) {
  if (o == null || depth > 7) return;
  if (Array.isArray(o)) { if (!o.length) out.set(path + '[]', { t: 'array(empty)', ex: '' }); o.slice(0, 3).forEach(v => walk(v, path + '[]', out, depth + 1)); return; }
  if (typeof o === 'object') { Object.keys(o).forEach(k => walk(o[k], path ? path + '.' + k : k, out, depth + 1)); return; }
  const last = path.split('.').pop().replace('[]', '');
  const ex = HIDE.test(last) ? '(hidden)' : String(o).slice(0, 40);
  const cur = out.get(path);
  if (!cur) out.set(path, { t: typeof o, ex, n: 1 }); else cur.n = (cur.n || 1) + 1;
}
async function section(title, path) {
  try {
    const j = await xget(path), recs = listOf(j), out = new Map();
    recs.forEach(r => walk(r, '', out, 0));
    return '=== ' + title + ' (' + recs.length + ' records read) ===\n' + [...out.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([p, v]) => p + '  |  ' + v.t + '  |  ' + v.ex).join('\n');
  } catch (e) { return '=== ' + title + ' ===\nCould not read: ' + e.message; }
}
module.exports = async (req, res) => {
  try {
    const b = guard(req, res); if (!b) return;
    if (typeof b.seller !== 'string' || !/^[A-Za-z0-9_\-.]{1,64}$/.test(b.seller)) return send(res, 400, { error: 'Bad account id' });
    const sid = encodeURIComponent(b.seller);
    const parts = await Promise.all([
      section('ACCOUNT RECORD', '/sellers/' + sid),
      section('TRANSACTIONS', '/transactions?seller=' + sid + '&limit=8&exclude=remoteTransactions'),
      section('ORDERS', '/orders?seller=' + sid + '&limit=8')
    ]);
    send(res, 200, { text: parts.join('\n\n') });
  } catch (e) { send(res, e.status || 500, { error: e.message || 'Probe failed' }); }
};
