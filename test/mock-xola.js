// Fake Xola API for local testing: 3 locations, a few transactions per day, orders. Usage: node test/mock-xola.js 4010
const http = require('http');
const SELLERS = [{ id: 's1', name: 'Empire Downtown' }, { id: 's2', name: 'Empire Harbor' }, { id: 's3', name: 'Empire Uptown' }];
const days = (a, b) => { const o = []; for (let t = Date.parse(a); t <= Date.parse(b); t += 864e5) o.push(new Date(t).toISOString().slice(0, 10)); return o; };
function tx(seller, type, from, toExcl) {
  const rows = []; const last = new Date(Date.parse(toExcl) - 864e5).toISOString().slice(0, 10);
  days(from, last).forEach((d, i) => { for (let k = 0; k < (type === 'auto_payout' ? 1 : 3); k++) rows.push({ id: seller + type + d + k, type, seller: { id: seller }, createdAt: d + 'T10:00:00Z', currency: 'USD', items: [{ gross: 100 + k, net: 90 + k, orderItem: { product: 'Tour ' + k } }, { gross: 5, net: 4 }] }); });
  return rows;
}
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const q = u.searchParams;
  const out = (o, c) => { res.statusCode = c || 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (req.headers['x-api-key'] !== 'testkey') return out({ error: 'bad key' }, 401);
  if (u.pathname === '/sellers') return out({ data: SELLERS });
  const skip = +q.get('skip') || 0, limit = +q.get('limit') || 20;
  let all = [];
  if (u.pathname === '/transactions') {
    const s = q.get('seller'); if (!s) return out({ error: 'seller required' }, 400);
    all = tx(s, q.get('type') || 'purchase', q.get('createdAt[gte]'), q.get('createdAt[lt]'));
    const page = all.slice(skip, skip + limit);
    return out({ data: page, paging: skip + limit < all.length ? { next: '/api/transactions?' + [...q.entries()].filter(([k]) => k !== 'skip').map(([k, v]) => k + '=' + v).join('&') + '&skip=' + (skip + limit) } : {} });
  }
  if (u.pathname === '/orders') {
    const r = q.get('items.arrival[range]'); const [a, b] = r ? r.split(',') : [q.get('createdAt[gte]'), new Date(Date.parse(q.get('createdAt[lt]')) - 864e5).toISOString().slice(0, 10)];
    all = days(a, b).map(d => ({ id: q.get('seller') + 'o' + d, customerName: 'Guest ' + d, status: 'confirmed', items: [{ arrival: d, quantity: 2 }] }));
    return out({ data: all.slice(skip, skip + limit) });   // no paging.next on purpose: tests the skip fallback
  }
  out({ error: 'nf' }, 404);
}).listen(+process.argv[2] || 4010);
