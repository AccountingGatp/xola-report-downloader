// End-to-end test of the API layer against the mock Xola server.
const { spawn } = require('child_process');
const assert = require('assert');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const env = Object.assign({}, process.env, { APP_PASSWORD: 'pw', XOLA_API_KEY: 'testkey', XOLA_BASE: 'http://localhost:4010' });
const procs = [spawn('node', ['test/mock-xola.js', '4010'], { env }), spawn('node', ['dev-server.js', '3100'], { env })];
const call = (name, body, key) => fetch('http://localhost:3100/api/' + name, { method: 'POST', headers: { 'content-type': 'application/json', 'x-app-key': key === undefined ? 'pw' : key }, body: JSON.stringify(body || {}) }).then(async r => ({ s: r.status, j: await r.json() }));
(async () => {
  try {
    await sleep(800);
    let r = await call('sellers', {}, 'wrong'); assert.strictEqual(r.s, 401, 'wrong password must be 401');
    r = await call('sellers'); assert.strictEqual(r.s, 200); assert.strictEqual(r.j.sellers.length, 3); assert.strictEqual(r.j.reports.length, 6);
    console.log('sellers ok:', r.j.sellers.map(s => s.name).join(', '), '| source:', r.j.source);
    // 3 days of sales, one location: 3 tx/day x 5 types x 2 items = 90 rows
    r = await call('report', { report: 'sales', seller: 's1', from: '2026-09-01', to: '2026-09-03' });
    assert.strictEqual(r.s, 200); console.log('sales rows:', r.j.count); assert.strictEqual(r.j.count, 3 * 3 * 5 * 2);
    assert.ok('item.net' in r.j.rows[0] && 'item.orderItem.product' in r.j.rows[0], 'items flattened');
    // pagination: 31 days x 3 x 2 = 186 for one type... all_tx has one type (null->purchase in mock) = 186 < 200; use sales to cross the 200 page limit
    r = await call('report', { report: 'sales', seller: 's2', from: '2026-09-01', to: '2026-09-30' });
    assert.strictEqual(r.j.count, 30 * 3 * 5 * 2); console.log('paged sales rows:', r.j.count);
    r = await call('report', { report: 'payouts', seller: 's3', from: '2026-09-01', to: '2026-09-30' });
    console.log('payout rows:', r.j.count); assert.strictEqual(r.j.count, 30 * (1 + 3 + 3) * 2);   // mock: auto_payout 1/day, payout and payout_adjust 3/day, 2 items each
    r = await call('report', { report: 'bookings_arrival', seller: 's1', from: '2026-09-01', to: '2026-09-30' });
    assert.strictEqual(r.j.count, 30); console.log('orders (skip fallback paging) rows:', r.j.count);
    r = await call('report', { report: 'bookings_arrival', seller: 's1', from: '2026-01-01', to: '2026-10-29' });
    assert.strictEqual(r.j.count, 302); console.log('orders across 302 days:', r.j.count);
    r = await call('report', { report: 'nope', seller: 's1', from: '2026-09-01', to: '2026-09-03' }); assert.strictEqual(r.s, 400);
    r = await call('report', { report: 'sales', seller: 's1', from: '2026-09-09', to: '2026-09-01' }); assert.strictEqual(r.s, 400);
    r = await call('report', { report: 'sales', seller: 's1/../x', from: '2026-09-01', to: '2026-09-02' }); assert.strictEqual(r.s, 400);
    console.log('ALL API TESTS PASSED');
    // Xola refuses the account list (403): accounts must still be found from recent payouts, and nothing may report "bad key"
    const env2 = Object.assign({}, env, { XOLA_BASE: 'http://localhost:4011', MOCK_DENY_SELLERS: '1' });
    procs.push(spawn('node', ['test/mock-xola.js', '4011'], { env: env2 }), spawn('node', ['dev-server.js', '3101'], { env: env2 }));
    await sleep(800);
    const call2 = (name, body) => fetch('http://localhost:3101/api/' + name, { method: 'POST', headers: { 'content-type': 'application/json', 'x-app-key': 'pw' }, body: JSON.stringify(body || {}) }).then(async r => ({ s: r.status, j: await r.json() }));
    r = await call2('sellers'); assert.strictEqual(r.s, 200, 'account list must fall back to payouts, got ' + r.s + ' ' + JSON.stringify(r.j));
    assert.strictEqual(r.j.sellers.length, 3); assert.strictEqual(r.j.source, 'payouts'); console.log('403 on /sellers -> accounts found from payouts:', r.j.sellers.map(s => s.id).join(', '));
    r = await call2('portal', { report: 'purchaseitems', seller: 's1', from: '2026-09-01', to: '2026-09-02' });
    assert.strictEqual(r.s, 200); assert.ok((r.j.missing || []).some(m => /Time zone/.test(m)), 'time zone warning when the account record is unreadable'); console.log('403 on account record -> report still runs, time-zone warning:', r.j.missing.filter(m => /Time zone/.test(m))[0]);
    console.log('ALL FALLBACK TESTS PASSED');
  } catch (e) { console.error('TEST FAILED:', e.message); process.exitCode = 1; }
  procs.forEach(p => p.kill());
})();
