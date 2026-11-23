const { query } = require('../config/db');
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map();
const inflight = new Map();

async function getPrice(districtId, cropCode) {
  const key = `${districtId}:${cropCode}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) return cached.value;
  if (inflight.has(key)) return inflight.get(key);
  const promise = query(
    'SELECT modal_price_inr, msp_inr FROM mandi_prices WHERE district_id=$1 AND crop_code=$2',
    [districtId, cropCode]
  ).then(result => {
    if (!result.rows.length) throw Object.assign(new Error('Mandi price not found'), { status: 404, code: 'PRICE_NOT_FOUND' });
    const value = { mandiModalInr: Number(result.rows[0].modal_price_inr), mspInr: Number(result.rows[0].msp_inr) };
    cache.set(key, { value, cachedAt: Date.now() });
    return value;
  }).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

module.exports = { getPrice, _cache: cache, _inflight: inflight, CACHE_TTL_MS };
