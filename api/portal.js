// Portal-style data for ONE account (location) and ONE date range. The page calls this per account and per month.
const { guard, send, isDate } = require('./_xola');
const { PORTAL } = require('./_portal');

const MAX_BYTES = 3500000;   // Vercel limits a response to about 4.5 MB; above this the page splits the dates in half and asks again

module.exports = async (req, res) => {
  try {
    const b = guard(req, res); if (!b) return;
    if (!PORTAL[b.report]) return send(res, 400, { error: 'Unknown report type' });
    if (typeof b.seller !== 'string' || !/^[A-Za-z0-9_\-.]{1,64}$/.test(b.seller)) return send(res, 400, { error: 'Bad account id' });
    if (!isDate(b.from) || !isDate(b.to) || b.from > b.to) return send(res, 400, { error: 'Bad dates' });
    const out = await PORTAL[b.report](b.seller, b.from, b.to);
    const body = JSON.stringify(Object.assign({ count: out.rows.length }, out));
    if (body.length > MAX_BYTES && b.from < b.to) return send(res, 200, { split: true, count: out.rows.length });
    if (body.length > MAX_BYTES) return send(res, 413, { error: 'One day has too much data to send at once' });
    res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(body);
  } catch (e) { send(res, e.status || 500, { error: e.message || 'Xola request failed' }); }
};
