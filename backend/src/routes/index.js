const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { validate: validateUuid, v4: uuidv4 } = require('uuid');
const { query, pool } = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { calculateFloor, validate: validatePrice } = require('../services/fairPriceEngine');
const priceCache = require('../services/priceCacheService');

const router = express.Router();
const tokenFor = user => jwt.sign(
  { id: user.id, phone: user.phone, role: user.role, districtId: user.district_id },
  process.env.JWT_SECRET || 'development-secret',
  { expiresIn: '12h' }
);
const publicUser = user => ({
  id: user.id,
  fullName: user.full_name,
  phone: user.phone,
  role: user.role,
  districtId: user.district_id
});
const isUuidV4 = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) && validateUuid(value);
const optionalAuth = (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  return verifyToken(req, res, next);
};

router.post('/auth/register', async (req, res, next) => {
  try {
    const { fullName, phone, password, role, districtId } = req.body;
    if (!fullName || !phone || !password || !role || !districtId) throw Object.assign(new Error('All registration fields are required'), { status: 400 });
    if (password.length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 });
    if (!['FARMER','FPO_ADMIN','BUYER','LOGISTICS'].includes(role)) throw Object.assign(new Error('Invalid role'), { status: 400 });
    const passwordHash = await bcrypt.hash(password, 12);
    let result;
    try {
      result = await query(
        'INSERT INTO users(full_name,phone,password_hash,role,district_id) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [fullName.trim(), phone.trim(), passwordHash, role, districtId.trim().toUpperCase()]
      );
    } catch (err) {
      if (err.code === '23505') throw Object.assign(new Error('A user with this phone number already exists'), { status: 409, code: 'PHONE_EXISTS' });
      throw err;
    }
    const user = result.rows[0];
    res.status(201).json({ token: tokenFor(user), user: publicUser(user) });
  } catch (err) { next(err); }
});

router.post('/auth/login', async (req, res, next) => {
  try {
    const { phone, password } = req.body;
    const result = await query('SELECT * FROM users WHERE phone=$1', [phone]);
    if (!result.rows.length) throw Object.assign(new Error('Invalid phone or password'), { status: 401, code: 'INVALID_CREDENTIALS' });
    const user = result.rows[0];
    if (!await bcrypt.compare(password, user.password_hash)) throw Object.assign(new Error('Invalid phone or password'), { status: 401, code: 'INVALID_CREDENTIALS' });
    res.json({ token: tokenFor(user), user: publicUser(user) });
  } catch (err) { next(err); }
});

router.get('/advisory/fair-price', async (req, res, next) => {
  try {
    const { cropCode, districtId, grade, moisturePct } = req.query;
    validatePrice(cropCode, grade, moisturePct);
    const price = await priceCache.getPrice(districtId, cropCode);
    const calculated = calculateFloor({ cropCode, mandiModalInr: price.mandiModalInr, grade, moisturePct });
    res.json({ cropCode, districtId, mandiModalInr: price.mandiModalInr, mspInr: calculated.mspInr,
      moisturePenaltyInr: calculated.moisturePenaltyInr, recommendedFloorInr: calculated.recommendedFloorInr });
  } catch (err) { next(err); }
});

router.post('/lots/sync', verifyToken, requireRole('FARMER','FPO_ADMIN'), async (req, res, next) => {
  const lots = req.body.lots;
  if (!Array.isArray(lots)) return next(Object.assign(new Error('lots must be an array'), { status: 400 }));
  if (lots.length > 50) return next(Object.assign(new Error('Maximum 50 lots can be synced per batch'), { status: 413, code: 'BATCH_TOO_LARGE' }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = lots.map(l => l.clientEventId);
    const duplicateResult = await client.query('SELECT client_event_id FROM crop_lots WHERE client_event_id = ANY($1::uuid[])', [ids]);
    const duplicates = new Set(duplicateResult.rows.map(r => r.client_event_id));
    const syncedLots = [], errors = [];
    for (const lot of lots) {
      try {
        if (!isUuidV4(lot.clientEventId)) throw Object.assign(new Error('Invalid UUIDv4 clientEventId'), { status: 400, code: 'INVALID_UUID' });
        validatePrice(lot.cropCode, lot.grade, lot.moisturePct);
        if (!Number.isFinite(Number(lot.quantityQuintals)) || Number(lot.quantityQuintals) <= 0 || Number(lot.quantityQuintals) > 2000) throw Object.assign(new Error('Invalid quantity'), { status: 400, code: 'INVALID_QUANTITY' });
        if (duplicates.has(lot.clientEventId)) continue;
        const districtPrice = await priceCache.getPrice(lot.districtId, lot.cropCode);
        const floor = calculateFloor({ cropCode: lot.cropCode, mandiModalInr: districtPrice.mandiModalInr, grade: lot.grade, moisturePct: lot.moisturePct });
        const lotCode = `LOT-${lot.clientEventId.replace(/-/g,'').slice(0,8).toUpperCase()}`;
        const insert = await client.query(
          `INSERT INTO crop_lots(lot_code,client_event_id,farmer_id,crop_code,quantity_quintals,moisture_pct,grade,district_id,recommended_floor_inr,quality_card,captured_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT(client_event_id) DO NOTHING RETURNING *`,
          [lotCode, lot.clientEventId, req.user.id, lot.cropCode, lot.quantityQuintals, lot.moisturePct, lot.grade, lot.districtId,
           floor.recommendedFloorInr, JSON.stringify(lot.qualityCard || {}), lot.capturedAt]
        );
        if (!insert.rows.length) continue;
        const created = insert.rows[0];
        await client.query(
          `INSERT INTO auctions(lot_id,floor_price_inr,current_highest_bid_inr,ends_at)
           VALUES($1,$2,$2,NOW()+INTERVAL '24 hours')`,
          [created.id, created.recommended_floor_inr]
        );
        syncedLots.push(created);
        req.app.get('io')?.emit('lot:created', created);
      } catch (err) {
        errors.push({ clientEventId: lot.clientEventId, message: err.message, code: err.code || 'LOT_ERROR' });
      }
    }
    await client.query('COMMIT');
    res.status(207).json({
      syncedCount: syncedLots.length,
      duplicateIgnoredCount: lots.length - syncedLots.length - errors.length,
      errorCount: errors.length,
      syncedLots,
      errors
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.get('/lots/export/csv', verifyToken, async (req, res, next) => {
  try {
    const result = await query('SELECT lot_code,crop_code,quantity_quintals,moisture_pct,grade,district_id,status,recommended_floor_inr FROM crop_lots ORDER BY id');
    const header = ['lotCode','cropCode','quantityQuintals','moisturePct','grade','districtId','status','recommendedFloorInr'];
    const rows = result.rows.map(r => [r.lot_code,r.crop_code,r.quantity_quintals,r.moisture_pct,r.grade,r.district_id,r.status,r.recommended_floor_inr]);
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="agripulse-lots.csv"');
    res.send('\uFEFF' + [header.join(','), ...rows.map(row => row.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(','))].join('\n'));
  } catch (err) { next(err); }
});

router.get('/lots', optionalAuth, async (req, res, next) => {
  try {
    const conditions = [], params = [];
    if (req.query.status) { params.push(req.query.status); conditions.push(`status=$${params.length}`); }
    if (req.query.districtId) { params.push(req.query.districtId); conditions.push(`district_id=$${params.length}`); }
    if (req.query.mine === 'true' && req.user?.id) { params.push(req.user.id); conditions.push(`farmer_id=$${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query(`SELECT * FROM crop_lots ${where} ORDER BY id DESC`, params);
    res.json({ lots: result.rows });
  } catch (err) { next(err); }
});

router.post('/lots/pool', verifyToken, requireRole('FPO_ADMIN'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { lotIds } = req.body;
    if (!Array.isArray(lotIds) || !lotIds.length) throw Object.assign(new Error('lotIds is required'), { status: 400 });
    const lots = await client.query('SELECT * FROM crop_lots WHERE id=ANY($1::int[]) FOR UPDATE', [lotIds]);
    const first = lots.rows[0];
    if (!first || new Set(lots.rows.map(l => l.crop_code)).size !== 1 || new Set(lots.rows.map(l => l.grade)).size !== 1) {
      throw Object.assign(new Error('Lots must have the same crop and grade'), { status: 400, code: 'POOL_MISMATCH' });
    }
    const quantity = lots.rows.reduce((sum, l) => sum + Number(l.quantity_quintals), 0);
    const floor = Math.max(...lots.rows.map(l => Number(l.recommended_floor_inr)));
    const districtId = lots.rows.map(l => l.district_id).join(',');
    const lotCode = `POOL-${Date.now().toString(36).toUpperCase()}`;
    const created = await client.query(
      `INSERT INTO crop_lots(lot_code,client_event_id,farmer_id,fpo_batch_id,crop_code,quantity_quintals,moisture_pct,grade,district_id,recommended_floor_inr,quality_card,captured_at,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}',$11,'IN_AUCTION') RETURNING *`,
      [lotCode, uuidv4(), req.user.id, first.id, first.crop_code, quantity, first.moisture_pct, first.grade, districtId, floor, new Date()]
    );
    await client.query('UPDATE crop_lots SET status=\'POOLED\', fpo_batch_id=$1 WHERE id=ANY($2::int[])', [created.rows[0].id, lotIds]);
    await client.query(`INSERT INTO auctions(lot_id,floor_price_inr,current_highest_bid_inr,ends_at) VALUES($1,$2,$2,NOW()+INTERVAL '24 hours')`, [created.rows[0].id, floor]);
    await client.query('COMMIT');
    res.status(201).json({ pooledLot: created.rows[0] });
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

router.get('/auctions', async (req, res, next) => {
  try {
    const result = await query(`SELECT a.*, l.lot_code,l.crop_code,l.quantity_quintals,l.moisture_pct,l.grade,l.district_id
      FROM auctions a JOIN crop_lots l ON l.id=a.lot_id WHERE a.status='OPEN' ORDER BY a.ends_at`);
    res.json({ auctions: result.rows });
  } catch (err) { next(err); }
});

router.post('/auctions/:auctionId/bids', verifyToken, requireRole('BUYER'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const auctionResult = await client.query('SELECT * FROM auctions WHERE id=$1 FOR UPDATE', [req.params.auctionId]);
    if (!auctionResult.rows.length) throw Object.assign(new Error('Auction not found'), { status: 404 });
    const auction = auctionResult.rows[0];
    if (auction.status !== 'OPEN') throw Object.assign(new Error('Auction is closed'), { status: 409, code: 'AUCTION_CLOSED' });
    if (new Date(auction.ends_at) <= new Date()) throw Object.assign(new Error('Auction has expired'), { status: 409, code: 'AUCTION_EXPIRED' });
    const amount = Number(req.body.bidAmountInr);
    const minimum = Number(auction.current_highest_bid_inr) + Number(auction.min_increment_inr);
    if (!Number.isFinite(amount) || amount < minimum) throw Object.assign(new Error(`Minimum bid is ₹${minimum}`), { status: 400, code: 'BID_TOO_LOW' });
    await client.query('UPDATE auctions SET current_highest_bid_inr=$1,highest_bidder_id=$2 WHERE id=$3', [amount, req.user.id, auction.id]);
    await client.query('INSERT INTO bids(auction_id,bidder_id,bid_amount_inr) VALUES($1,$2,$3)', [auction.id, req.user.id, amount]);
    await client.query('COMMIT');
    req.app.get('io')?.emit('bid:updated', { auctionId: auction.id, currentHighestBidInr: amount, highestBidderId: req.user.id });
    res.json({ success: true, auctionId: auction.id, currentHighestBidInr: amount });
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

router.post('/auctions/:auctionId/accept', verifyToken, requireRole('FARMER','FPO_ADMIN'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT a.*,l.farmer_id FROM auctions a JOIN crop_lots l ON l.id=a.lot_id WHERE a.id=$1 FOR UPDATE`, [req.params.auctionId]);
    if (!result.rows.length) throw Object.assign(new Error('Auction not found'), { status: 404 });
    const auction = result.rows[0];
    if (auction.status !== 'OPEN') throw Object.assign(new Error('Auction is closed'), { status: 409 });
    if (!auction.highest_bidder_id) throw Object.assign(new Error('No bid to accept'), { status: 400 });
    await client.query('UPDATE auctions SET status=\'CLOSED\' WHERE id=$1', [auction.id]);
    await client.query('UPDATE crop_lots SET status=\'SOLD\' WHERE id=$1', [auction.lot_id]);
    await client.query(`INSERT INTO escrow_dispatches(auction_id,buyer_id,farmer_id,total_amount_inr) VALUES($1,$2,$3,$4)
      ON CONFLICT(auction_id) DO NOTHING`, [auction.id, auction.highest_bidder_id, auction.farmer_id, auction.current_highest_bid_inr]);
    await client.query('COMMIT');
    req.app.get('io')?.emit('auction:closed', { auctionId: auction.id, lotId: auction.lot_id });
    res.json({ success: true, auctionId: auction.id, status: 'CLOSED' });
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

router.get('/dispatches', async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM escrow_dispatches ORDER BY id DESC');
    res.json({ dispatches: result.rows });
  } catch (err) { next(err); }
});

router.patch('/dispatches/:id/status', verifyToken, requireRole('LOGISTICS','FARMER','BUYER'), async (req, res, next) => {
  const transitions = { PENDING_PICKUP: 'IN_TRANSIT', IN_TRANSIT: 'DELIVERED' };
  try {
    const existing = await query('SELECT * FROM escrow_dispatches WHERE id=$1', [req.params.id]);
    if (!existing.rows.length) throw Object.assign(new Error('Dispatch not found'), { status: 404 });
    const current = existing.rows[0];
    if (req.body.logisticsStatus !== 'DELIVERED' && req.body.logisticsStatus !== 'IN_TRANSIT') {
      throw Object.assign(new Error('Invalid logistics status'), { status: 400 });
    }
    if (transitions[current.logistics_status] !== req.body.logisticsStatus) throw Object.assign(new Error('Invalid status transition'), { status: 409 });
    const delivered = req.body.logisticsStatus === 'DELIVERED';
    const result = await query(`UPDATE escrow_dispatches SET logistics_status=$1,vehicle_number=COALESCE($2,vehicle_number),
      current_lat=COALESCE($3,current_lat),current_lng=COALESCE($4,current_lng),escrow_status=$5,updated_at=NOW() WHERE id=$6 RETURNING *`,
      [req.body.logisticsStatus, req.body.vehicleNumber, req.body.currentLat, req.body.currentLng, delivered ? 'RELEASED' : 'LOCKED', req.params.id]);
    res.json({ dispatch: result.rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
