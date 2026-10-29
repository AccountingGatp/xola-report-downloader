// Returns the list of Xola locations (sellers) and the available report types. Also used as the login check.
const { guard, send, REPORTS, listSellers } = require('./_xola');

module.exports = async (req, res) => {
  try {
    const b = guard(req, res); if (!b) return;
    const { sellers, source } = await listSellers();
    const reports = Object.keys(REPORTS).map(k => ({ key: k, label: REPORTS[k].label, note: REPORTS[k].note }));
    const user = { name: process.env.XOLA_REPORT_NAME || '', email: process.env.XOLA_REPORT_EMAIL || '' };   // shown on the "Report Details" sheet
    send(res, 200, { sellers, reports, source, user });
  } catch (e) { send(res, e.status || 500, { error: e.message || 'Could not read locations from Xola' }); }
};
