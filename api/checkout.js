// Creates a Square hosted checkout for the shop bag and returns its URL.
// Prices are looked up here from shop/catalog.json, never trusted from the browser.
// Needs Vercel env vars: SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID
// Optional: SQUARE_ENV=sandbox, SHIPPING_FEE_CENTS (flat shipping added at checkout).
const crypto = require('crypto');
const CATALOG = require('../shop/catalog.json');
const BY = Object.fromEntries(CATALOG.map(p => [p.h, p]));

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method' }); }
  const token = process.env.SQUARE_ACCESS_TOKEN, location = process.env.SQUARE_LOCATION_ID;
  if (!token || !location) return res.status(503).json({ error: 'not_connected' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const items = body && Array.isArray(body.items) ? body.items.slice(0, 40) : [];
  const lines = [];
  for (const it of items) {
    const p = BY[it && it.h];
    if (!p || !Array.isArray(it.sel)) continue;
    const key = it.sel.join('-');
    if (!p.ok.includes(key)) continue;
    const qty = Math.max(1, Math.min(20, parseInt(it.q, 10) || 1));
    const variation = p.opts.map((o, i) => (o.v.length > 1 ? o.v[it.sel[i]].n : null)).filter(Boolean).join(' / ');
    lines.push({
      name: p.n,
      ...(variation ? { variation_name: variation } : {}),
      quantity: String(qty),
      base_price_money: { amount: p.vp[key] || p.base, currency: 'USD' },
    });
  }
  if (!lines.length) return res.status(400).json({ error: 'empty' });

  const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const ship = parseInt(process.env.SHIPPING_FEE_CENTS, 10);
  const api = process.env.SQUARE_ENV === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
  const r = await fetch(`${api}/v2/online-checkout/payment-links`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      order: { location_id: location, line_items: lines },
      checkout_options: {
        ask_for_shipping_address: true,
        redirect_url: `${origin}/shop?order=thanks`,
        ...(ship > 0 ? { shipping_fee: { name: 'Shipping', charge: { amount: ship, currency: 'USD' } } } : {}),
      },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.payment_link) {
    console.error('square', r.status, JSON.stringify(j.errors || j).slice(0, 500));
    return res.status(502).json({ error: 'square' });
  }
  res.status(200).json({ url: j.payment_link.url });
};
