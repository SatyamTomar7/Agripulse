const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { validate: validateUuid, v4: uuidv4 } = require('uuid');
const { query, pool } = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { calculateFloor, validate: validatePrice } = require('../services/fairPriceEngine');
const priceCache = require('../services/priceCacheService');

const router = express.Router();
const authSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production' && !secret) throw Object.assign(new Error('Server authentication is not configured'), { status: 500, code: 'AUTH_CONFIG_ERROR' });
  return secret || 'development-secret';
};
const tokenFor = user => jwt.sign(
  { id: user.id, phone: user.phone, role: user.role, districtId: user.district_id },
  authSecret(),
  { expiresIn: '15m', jwtid: crypto.randomUUID() }
);
const refreshTokenFor = () => crypto.randomBytes(48).toString('hex');
const refreshTokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const issueRefreshToken = async (userId) => {
  const token = refreshTokenFor();
  await query(
    'INSERT INTO refresh_tokens(user_id, token_hash, expires_at) VALUES($1,$2,NOW()+INTERVAL \'7 days\')',
    [userId, refreshTokenHash(token)]
  );
  return token;
};
const authResponse = async user => ({
  token: tokenFor(user),
  refreshToken: await issueRefreshToken(user.id),
  user: publicUser(user)
});
const publicUser = user => ({
  id: user.id,
  fullName: user.full_name,
  phone: user.phone,
  role: user.role,
  districtId: user.district_id,
  stateName: user.state_name || 'Madhya Pradesh',
  village: user.village || '',
  address: user.address || '',
  bankAccountLast4: user.bank_account_last4 || '',
  kycStatus: user.kyc_status || 'PENDING',
  accountStatus: user.account_status || 'PENDING',
  preferredLang: user.preferred_lang || 'en'
});
const isUuidV4 = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) && validateUuid(value);
const optionalAuth = (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  return verifyToken(req, res, next);
};

router.get('/master-data', async (req, res, next) => {
  try {
    const [districtResult, cropResult] = await Promise.all([
      query('SELECT code,name,state_name FROM districts WHERE active=TRUE ORDER BY name'),
      query('SELECT code,name FROM crops WHERE active=TRUE ORDER BY name')
    ]);
    res.json({
      districts: districtResult.rows.map(row => ({ code: row.code, name: row.name, stateName: row.state_name })),
      crops: cropResult.rows.map(row => ({ code: row.code, name: row.name }))
    });
  } catch (err) { next(err); }
});

router.post('/auth/register', async (req, res, next) => {
  try {
    const { fullName, phone, password, role, districtId, stateName, village, address } = req.body;
    if (!fullName || !phone || !password || !role || !districtId) throw Object.assign(new Error('All registration fields are required'), { status: 400 });
    if (password.length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 });
    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(password)) throw Object.assign(new Error('Password must contain uppercase, lowercase, and a number'), { status: 400 });
    if (!/^[6-9]\d{9}$/.test(String(phone).replace(/\D/g, '').slice(-10))) throw Object.assign(new Error('Enter a valid 10-digit Indian mobile number'), { status: 400 });
    if (!['FARMER','FPO_ADMIN','BUYER','LOGISTICS'].includes(role)) throw Object.assign(new Error('Invalid role'), { status: 400 });
    const district = await query('SELECT code,state_name FROM districts WHERE code=$1 AND active=TRUE', [districtId.trim().toUpperCase()]);
    if (!district.rows.length) throw Object.assign(new Error('Select a valid district'), { status: 400, code: 'INVALID_DISTRICT' });
    const accountStatus = role === 'FARMER' ? 'APPROVED' : 'PENDING';
    const passwordHash = await bcrypt.hash(password, 12);
    let result;
    try {
      result = await query(
        `INSERT INTO users(full_name,phone,password_hash,role,district_id,state_name,village,address,account_status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [fullName.trim(), String(phone).replace(/\D/g, '').slice(-10), passwordHash, role, districtId.trim().toUpperCase(),
         stateName?.trim() || district.rows[0].state_name, village?.trim() || null, address?.trim() || null, accountStatus]
      );
    } catch (err) {
      if (err.code === '23505') throw Object.assign(new Error('A user with this phone number already exists'), { status: 409, code: 'PHONE_EXISTS' });
      throw err;
    }
    const user = result.rows[0];
    res.status(201).json(await authResponse(user));
  } catch (err) { next(err); }
});

router.post('/auth/login', async (req, res, next) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) throw Object.assign(new Error('Phone and password are required'), { status: 400 });
    const normalizedPhone = String(phone).replace(/\D/g, '').slice(-10);
    const result = await query('SELECT * FROM users WHERE phone=$1', [normalizedPhone]);
    if (!result.rows.length) throw Object.assign(new Error('Invalid phone or password'), { status: 401, code: 'INVALID_CREDENTIALS' });
    const user = result.rows[0];
    if (!await bcrypt.compare(password, user.password_hash)) throw Object.assign(new Error('Invalid phone or password'), { status: 401, code: 'INVALID_CREDENTIALS' });
    if (user.account_status === 'REJECTED') throw Object.assign(new Error('Your account registration was rejected'), { status: 403, code: 'ACCOUNT_REJECTED' });
    if (user.account_status === 'PENDING' && user.role !== 'FARMER') throw Object.assign(new Error('Your account is awaiting approval'), { status: 403, code: 'ACCOUNT_PENDING' });
    res.json(await authResponse(user));
  } catch (err) { next(err); }
});

router.post('/auth/refresh', async (req, res, next) => {
  try {
    const refreshToken = req.body.refreshToken;
    if (!refreshToken) throw Object.assign(new Error('Refresh token is required'), { status: 400 });
    const hash = refreshTokenHash(refreshToken);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT rt.id,rt.user_id,u.full_name,u.phone,u.role,u.district_id,u.state_name,u.village,u.address,
                u.bank_account_last4,u.kyc_status,u.account_status,u.preferred_lang
         FROM refresh_tokens rt JOIN users u ON u.id=rt.user_id
         WHERE rt.token_hash=$1 AND rt.revoked_at IS NULL AND rt.expires_at>NOW()
         FOR UPDATE`,
        [hash]
      );
      if (!result.rows.length) throw Object.assign(new Error('Refresh session is invalid or expired'), { status: 401, code: 'INVALID_REFRESH_TOKEN' });
      const row = result.rows[0];
      await client.query('UPDATE refresh_tokens SET revoked_at=NOW() WHERE id=$1', [row.id]);
      const user = { id:row.user_id, full_name:row.full_name, phone:row.phone, role:row.role, district_id:row.district_id,
        state_name:row.state_name, village:row.village, address:row.address, bank_account_last4:row.bank_account_last4,
        kyc_status:row.kyc_status, account_status:row.account_status, preferred_lang:row.preferred_lang };
      const token = tokenFor(user);
      const nextRefreshToken = refreshTokenFor();
      await client.query(
        'INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL \'7 days\')',
        [row.user_id, refreshTokenHash(nextRefreshToken)]
      );
      await client.query('COMMIT');
      res.json({ token, refreshToken: nextRefreshToken, user: publicUser(user) });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

router.post('/auth/logout', async (req, res, next) => {
  try {
    const refreshToken = req.body.refreshToken;
    if (refreshToken) await query('UPDATE refresh_tokens SET revoked_at=NOW() WHERE token_hash=$1', [refreshTokenHash(refreshToken)]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/auth/me', verifyToken, async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!result.rows.length) throw Object.assign(new Error('Account not found'), { status: 404 });
    res.json({ user: publicUser(result.rows[0]) });
  } catch (err) { next(err); }
});

router.patch('/auth/me', verifyToken, async (req, res, next) => {
  try {
    const fullName = req.body.fullName?.trim();
    const districtId = req.body.districtId?.trim().toUpperCase();
    const preferredLang = req.body.preferredLang?.toLowerCase();
    const stateName = req.body.stateName?.trim();
    const village = req.body.village?.trim();
    const address = req.body.address?.trim();
    const bankAccountLast4 = req.body.bankAccountLast4?.trim();
    const kycStatus = req.body.kycStatus;
    if (fullName !== undefined && (fullName.length < 2 || fullName.length > 120)) throw Object.assign(new Error('Full name must contain 2 to 120 characters'), { status: 400 });
    if (districtId !== undefined) {
      const district = await query('SELECT code FROM districts WHERE code=$1 AND active=TRUE', [districtId]);
      if (!district.rows.length) throw Object.assign(new Error('Invalid district'), { status: 400, code: 'INVALID_DISTRICT' });
    }
    if (preferredLang !== undefined && !['en', 'hi'].includes(preferredLang)) throw Object.assign(new Error('Unsupported language'), { status: 400 });
    if (bankAccountLast4 !== undefined && bankAccountLast4 && !/^\d{4}$/.test(bankAccountLast4)) throw Object.assign(new Error('Bank account suffix must contain exactly 4 digits'), { status: 400 });
    if (kycStatus !== undefined && kycStatus !== 'PENDING' && kycStatus !== 'SUBMITTED') throw Object.assign(new Error('Only KYC submission status may be set by a user'), { status: 403 });
    const result = await query(
      `UPDATE users SET
       full_name=COALESCE($1,full_name),
       district_id=COALESCE($2,district_id),
       preferred_lang=COALESCE($3,preferred_lang),
       state_name=COALESCE($4,state_name),
       village=COALESCE($5,village),
       address=COALESCE($6,address),
       bank_account_last4=COALESCE($7,bank_account_last4),
       kyc_status=COALESCE($8,kyc_status)
       WHERE id=$9 RETURNING *`,
      [fullName ?? null, districtId ?? null, preferredLang ?? null, stateName ?? null, village ?? null, address ?? null,
       bankAccountLast4 ?? null, kycStatus ?? null, req.user.id]
    );
    res.json({ user: publicUser(result.rows[0]) });
  } catch (err) { next(err); }
});

router.post('/auth/change-password', verifyToken, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) throw Object.assign(new Error('Current and new passwords are required'), { status: 400 });
    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(newPassword)) throw Object.assign(new Error('Password must contain uppercase, lowercase, and a number'), { status: 400 });
    const result = await query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!result.rows.length || !await bcrypt.compare(currentPassword, result.rows[0].password_hash)) throw Object.assign(new Error('Current password is incorrect'), { status: 401 });
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash=$1 WHERE id=$2', [passwordHash, req.user.id]);
    await query('UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL', [req.user.id]);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) { next(err); }
});

router.get('/admin/accounts', verifyToken, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id,full_name,phone,role,district_id,state_name,village,address,bank_account_last4,
              kyc_status,account_status,preferred_lang,created_at
       FROM users WHERE role!='ADMIN' ORDER BY created_at DESC`
    );
    res.json({ accounts: result.rows });
  } catch (err) { next(err); }
});

router.patch('/admin/accounts/:id/approval', verifyToken, requireRole('ADMIN'), async (req, res, next) => {
  try {
    if (!['APPROVED','REJECTED'].includes(req.body.accountStatus)) throw Object.assign(new Error('Invalid account status'), { status: 400 });
    const result = await query(
      'UPDATE users SET account_status=$1 WHERE id=$2 AND role!=\'ADMIN\' RETURNING id,full_name,role,account_status',
      [req.body.accountStatus, req.params.id]
    );
    if (!result.rows.length) throw Object.assign(new Error('Account not found'), { status: 404 });
    res.json({ account: result.rows[0] });
  } catch (err) { next(err); }
});

router.patch('/admin/accounts/:id/kyc', verifyToken, requireRole('ADMIN'), async (req, res, next) => {
  try {
    if (!['PENDING','SUBMITTED','VERIFIED','REJECTED'].includes(req.body.kycStatus)) throw Object.assign(new Error('Invalid KYC status'), { status: 400 });
    const result = await query(
      'UPDATE users SET kyc_status=$1 WHERE id=$2 AND role!=\'ADMIN\' RETURNING id,full_name,role,kyc_status',
      [req.body.kycStatus, req.params.id]
    );
    if (!result.rows.length) throw Object.assign(new Error('Account not found'), { status: 404 });
    res.json({ account: result.rows[0] });
  } catch (err) { next(err); }
});

router.get('/advisory/fair-price', async (req, res, next) => {
  try {
    const { cropCode, districtId, grade, moisturePct } = req.query;
    validatePrice(cropCode, grade, moisturePct);
    if (!districtId) throw Object.assign(new Error('districtId is required'), { status: 400 });
    const district = await query('SELECT code FROM districts WHERE code=$1 AND active=TRUE', [districtId]);
    if (!district.rows.length) throw Object.assign(new Error('Invalid district'), { status: 400, code: 'INVALID_DISTRICT' });
    const price = await priceCache.getPrice(districtId, cropCode);
    const calculated = calculateFloor({ cropCode, mandiModalInr: price.mandiModalInr, mspInr: price.mspInr, grade, moisturePct });
    res.json({ cropCode, districtId, mandiModalInr: price.mandiModalInr, mspInr: calculated.mspInr,
      moisturePenaltyInr: calculated.moisturePenaltyInr, recommendedFloorInr: calculated.recommendedFloorInr,
      arrivalQuintals: price.arrivalQuintals, priceUpdatedAt: price.updatedAt, source: price.source });
  } catch (err) { next(err); }
});

router.get('/advisory/nearby-prices', async (req, res, next) => {
  try {
    const { cropCode, districtId } = req.query;
    validatePrice(cropCode, 'A', 11);
    if (!districtId) throw Object.assign(new Error('districtId is required'), { status: 400 });
    const result = await query(
      `SELECT district_id,modal_price_inr,msp_inr,arrival_quintals,updated_at
       FROM mandi_prices WHERE crop_code=$1 ORDER BY ABS(arrival_quintals) DESC,updated_at DESC`,
      [cropCode]
    );
    res.json({
      cropCode,
      requestedDistrictId: districtId,
      prices: result.rows.map(row => ({
        districtId: row.district_id,
        mandiModalInr: Number(row.modal_price_inr),
        mspInr: Number(row.msp_inr),
        arrivalQuintals: Number(row.arrival_quintals),
        updatedAt: row.updated_at,
        source: 'AGMARKNET/Mandi data'
      }))
    });
  } catch (err) { next(err); }
});

router.put('/admin/mandi-prices/:districtId/:cropCode', verifyToken, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const { districtId, cropCode } = req.params;
    const { modalPriceInr, mspInr, arrivalQuintals, source } = req.body;
    const values = [modalPriceInr, mspInr, arrivalQuintals];
    if (values.some(value => !Number.isFinite(Number(value)) || Number(value) < 0)) throw Object.assign(new Error('Invalid mandi price values'), { status: 400 });
    validatePrice(cropCode, 'A', 11);
    const district = await query('SELECT code FROM districts WHERE code=$1 AND active=TRUE', [districtId]);
    if (!district.rows.length) throw Object.assign(new Error('Invalid district'), { status: 400, code: 'INVALID_DISTRICT' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO mandi_prices(district_id,crop_code,modal_price_inr,msp_inr,arrival_quintals,updated_at)
         VALUES($1,$2,$3,$4,$5,NOW())
         ON CONFLICT(district_id,crop_code) DO UPDATE SET modal_price_inr=EXCLUDED.modal_price_inr,
         msp_inr=EXCLUDED.msp_inr,arrival_quintals=EXCLUDED.arrival_quintals,updated_at=NOW()`,
        [districtId, cropCode, modalPriceInr, mspInr, arrivalQuintals || 0]
      );
      await client.query(
        `INSERT INTO mandi_price_history(district_id,crop_code,modal_price_inr,msp_inr,arrival_quintals,source,changed_by,effective_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [districtId, cropCode, modalPriceInr, mspInr, arrivalQuintals || 0, source?.trim() || 'ADMIN', req.user.id]
      );
      await client.query('COMMIT');
      priceCache._cache.clear();
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json({ success:true, districtId, cropCode, modalPriceInr:Number(modalPriceInr), mspInr:Number(mspInr), arrivalQuintals:Number(arrivalQuintals || 0) });
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
        const district = await client.query('SELECT code FROM districts WHERE code=$1 AND active=TRUE', [lot.districtId]);
        if (!district.rows.length) throw Object.assign(new Error('Invalid district'), { status: 400, code: 'INVALID_DISTRICT' });
        if (lot.capturedAt && Number.isNaN(Date.parse(lot.capturedAt))) throw Object.assign(new Error('Invalid capture timestamp'), { status: 400, code: 'INVALID_CAPTURE_DATE' });
        if (lot.captureLatitude != null && (Number(lot.captureLatitude) < -90 || Number(lot.captureLatitude) > 90)) throw Object.assign(new Error('Invalid capture latitude'), { status: 400, code: 'INVALID_LOCATION' });
        if (lot.captureLongitude != null && (Number(lot.captureLongitude) < -180 || Number(lot.captureLongitude) > 180)) throw Object.assign(new Error('Invalid capture longitude'), { status: 400, code: 'INVALID_LOCATION' });
        const qualityCard = lot.qualityCard || {};
        for (const key of ['foreignMatterPct','brokenGrainPct']) {
          if (qualityCard[key] != null && (!Number.isFinite(Number(qualityCard[key])) || Number(qualityCard[key]) < 0 || Number(qualityCard[key]) > 100)) {
            throw Object.assign(new Error(`Invalid ${key}`), { status: 400, code: 'INVALID_QUALITY_CARD' });
          }
        }
        if (typeof qualityCard.photoDataUrl === 'string' && qualityCard.photoDataUrl.length > 280000) {
          throw Object.assign(new Error('Attached photo is too large'), { status: 413, code: 'PHOTO_TOO_LARGE' });
        }
        if (duplicates.has(lot.clientEventId)) continue;
        const districtPrice = await priceCache.getPrice(lot.districtId, lot.cropCode);
        const floor = calculateFloor({ cropCode: lot.cropCode, mandiModalInr: districtPrice.mandiModalInr, grade: lot.grade, moisturePct: lot.moisturePct });
        const lotCode = `LOT-${lot.clientEventId.replace(/-/g,'').slice(0,8).toUpperCase()}`;
        const insert = await client.query(
          `INSERT INTO crop_lots(lot_code,client_event_id,farmer_id,crop_code,quantity_quintals,moisture_pct,grade,district_id,recommended_floor_inr,quality_card,captured_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT(client_event_id) DO NOTHING RETURNING *`,
          [lotCode, lot.clientEventId, req.user.id, lot.cropCode, lot.quantityQuintals, lot.moisturePct, lot.grade, lot.districtId,
           floor.recommendedFloorInr, JSON.stringify({ ...(lot.qualityCard || {}), assessmentStatus:'SUBMITTED' }), lot.capturedAt]
        );
        if (!insert.rows.length) continue;
        const created = insert.rows[0];
        await client.query(
          'INSERT INTO lot_status_history(lot_id,previous_status,new_status,changed_by,reason) VALUES($1,NULL,$2,$3,$4)',
          [created.id, created.status, req.user.id, 'Lot registered']
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
    const conditions = [];
    const params = [];
    if (req.user.role === 'FARMER') {
      params.push(req.user.id);
      conditions.push(`farmer_id=$${params.length}`);
    } else if (req.user.role === 'FPO_ADMIN') {
      params.push(req.user.districtId);
      conditions.push(`district_id=$${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await query(`SELECT lot_code,crop_code,quantity_quintals,moisture_pct,grade,district_id,status,recommended_floor_inr FROM crop_lots ${where} ORDER BY id`, params);
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

router.get('/lots/:lotId', verifyToken, async (req, res, next) => {
  try {
    const lotId = Number(req.params.lotId);
    if (!Number.isInteger(lotId) || lotId < 1) throw Object.assign(new Error('Invalid lot ID'), { status: 400 });
    const result = await query('SELECT * FROM crop_lots WHERE id=$1', [lotId]);
    if (!result.rows.length) throw Object.assign(new Error('Lot not found'), { status: 404 });
    const lot = result.rows[0];
    if (req.user.role === 'FARMER' && lot.farmer_id !== req.user.id) throw Object.assign(new Error('Forbidden'), { status: 403 });
    if (req.user.role === 'FPO_ADMIN' && lot.farmer_id !== req.user.id && lot.fpo_batch_id === null) throw Object.assign(new Error('Forbidden'), { status: 403 });
    const history = await query(
      'SELECT previous_status,new_status,changed_by,reason,changed_at FROM lot_status_history WHERE lot_id=$1 ORDER BY changed_at DESC',
      [lotId]
    );
    res.json({ lot, history: history.rows });
  } catch (err) { next(err); }
});

router.patch('/lots/:lotId', verifyToken, requireRole('FARMER','FPO_ADMIN'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lotId = Number(req.params.lotId);
    if (!Number.isInteger(lotId) || lotId < 1) throw Object.assign(new Error('Invalid lot ID'), { status: 400 });
    const lotResult = await client.query('SELECT * FROM crop_lots WHERE id=$1 FOR UPDATE', [lotId]);
    if (!lotResult.rows.length) throw Object.assign(new Error('Lot not found'), { status: 404 });
    const lot = lotResult.rows[0];
    if (lot.farmer_id !== req.user.id) throw Object.assign(new Error('You do not own this lot'), { status: 403 });
    if (!['DRAFT','LISTED'].includes(lot.status)) throw Object.assign(new Error(`Lot cannot be edited in ${lot.status} status`), { status: 409, code: 'LOT_LOCKED' });
    const quantity = req.body.quantityQuintals === undefined ? Number(lot.quantity_quintals) : Number(req.body.quantityQuintals);
    const moisture = req.body.moisturePct === undefined ? Number(lot.moisture_pct) : Number(req.body.moisturePct);
    const grade = req.body.grade === undefined ? lot.grade : req.body.grade;
    const cropCode = req.body.cropCode === undefined ? lot.crop_code : req.body.cropCode;
    validatePrice(cropCode, grade, moisture);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 2000) throw Object.assign(new Error('Invalid quantity'), { status: 400 });
    const district = await client.query('SELECT code FROM districts WHERE code=$1 AND active=TRUE', [req.body.districtId || lot.district_id]);
    if (!district.rows.length) throw Object.assign(new Error('Invalid district'), { status: 400 });
    const districtPrice = await priceCache.getPrice(req.body.districtId || lot.district_id, cropCode);
    const floor = calculateFloor({ cropCode, mandiModalInr:districtPrice.mandiModalInr, mspInr:districtPrice.mspInr, grade, moisturePct:moisture });
    const updated = await client.query(
      `UPDATE crop_lots SET crop_code=$1,quantity_quintals=$2,moisture_pct=$3,grade=$4,district_id=$5,recommended_floor_inr=$6
       WHERE id=$7 RETURNING *`,
      [cropCode, quantity, moisture, grade, req.body.districtId || lot.district_id, floor.recommendedFloorInr, lotId]
    );
    await client.query('COMMIT');
    res.json({ lot:updated.rows[0] });
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

router.post('/lots/:lotId/cancel', verifyToken, requireRole('FARMER','FPO_ADMIN'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lotId = Number(req.params.lotId);
    const result = await client.query('SELECT * FROM crop_lots WHERE id=$1 FOR UPDATE', [lotId]);
    if (!result.rows.length) throw Object.assign(new Error('Lot not found'), { status: 404 });
    const lot = result.rows[0];
    if (lot.farmer_id !== req.user.id) throw Object.assign(new Error('You do not own this lot'), { status: 403 });
    if (!['DRAFT','LISTED','POOLED'].includes(lot.status)) throw Object.assign(new Error('Lot cannot be canceled in its current status'), { status: 409 });
    await client.query('UPDATE crop_lots SET status=\'CANCELED\' WHERE id=$1', [lotId]);
    await client.query(
      'INSERT INTO lot_status_history(lot_id,previous_status,new_status,changed_by,reason) VALUES($1,$2,$3,$4,$5)',
      [lotId, lot.status, 'CANCELED', req.user.id, req.body.reason?.trim() || 'Canceled by owner']
    );
    await client.query('COMMIT');
    res.json({ success:true, lotId, status:'CANCELED' });
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

router.post('/lots/:lotId/relist', verifyToken, requireRole('FARMER','FPO_ADMIN'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lotId = Number(req.params.lotId);
    const result = await client.query('SELECT * FROM crop_lots WHERE id=$1 FOR UPDATE', [lotId]);
    if (!result.rows.length) throw Object.assign(new Error('Lot not found'), { status: 404 });
    const lot = result.rows[0];
    if (lot.farmer_id !== req.user.id) throw Object.assign(new Error('You do not own this lot'), { status: 403 });
    if (lot.status !== 'CANCELED') throw Object.assign(new Error('Only canceled lots can be relisted'), { status: 409 });
    await client.query('UPDATE crop_lots SET status=\'LISTED\' WHERE id=$1', [lotId]);
    await client.query(
      'INSERT INTO lot_status_history(lot_id,previous_status,new_status,changed_by,reason) VALUES($1,$2,$3,$4,$5)',
      [lotId, lot.status, 'LISTED', req.user.id, 'Relisted by owner']
    );
    await client.query('COMMIT');
    res.json({ success:true, lotId, status:'LISTED' });
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

router.post('/lots/:lotId/quality', verifyToken, requireRole('FARMER','FPO_ADMIN'), async (req, res, next) => {
  const lotId = Number(req.params.lotId);
  if (!Number.isInteger(lotId) || lotId < 1) throw Object.assign(new Error('Invalid lot ID'), { status: 400 });
  const lot = await query('SELECT * FROM crop_lots WHERE id=$1', [lotId]);
  if (!lot.rows.length) throw Object.assign(new Error('Lot not found'), { status: 404 });
  if (req.user.role === 'FARMER' && lot.rows[0].farmer_id !== req.user.id) throw Object.assign(new Error('You do not own this lot'), { status: 403 });
  const { moisturePct, grade, foreignMatterPct, brokenGrainPct, certificateNo, notes } = req.body;
  validatePrice(lot.rows[0].crop_code, grade, moisturePct);
  for (const value of [foreignMatterPct, brokenGrainPct]) {
    if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100) throw Object.assign(new Error('Quality percentages must be between 0 and 100'), { status: 400 });
  }
  const result = await query(
    `INSERT INTO quality_assessments(lot_id,assessor_id,moisture_pct,grade,foreign_matter_pct,broken_grain_pct,certificate_no,notes,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'SUBMITTED')
     ON CONFLICT(lot_id) DO UPDATE SET assessor_id=EXCLUDED.assessor_id,moisture_pct=EXCLUDED.moisture_pct,
       grade=EXCLUDED.grade,foreign_matter_pct=EXCLUDED.foreign_matter_pct,broken_grain_pct=EXCLUDED.broken_grain_pct,
       certificate_no=EXCLUDED.certificate_no,notes=EXCLUDED.notes,status='SUBMITTED',assessed_at=NOW(),verified_at=NULL
     RETURNING *`,
    [lotId, req.user.id, moisturePct, grade, foreignMatterPct, brokenGrainPct, certificateNo?.trim() || null, notes?.trim() || null]
  );
  await query(
    `UPDATE crop_lots SET quality_card=COALESCE(quality_card,'{}'::jsonb)||jsonb_build_object(
       'assessmentStatus','SUBMITTED','moisturePct',$1,'grade',$2,'foreignMatterPct',$3,'brokenGrainPct',$4)
     WHERE id=$5`,
    [moisturePct, grade, foreignMatterPct, brokenGrainPct, lotId]
  );
  res.status(201).json({ assessment: result.rows[0] });
});

router.patch('/lots/:lotId/quality/:status', verifyToken, requireRole('FPO_ADMIN'), async (req, res, next) => {
  const lotId = Number(req.params.lotId);
  const status = req.params.status.toUpperCase();
  if (!Number.isInteger(lotId) || lotId < 1) throw Object.assign(new Error('Invalid lot ID'), { status: 400 });
  if (!['VERIFIED','REJECTED'].includes(status)) throw Object.assign(new Error('Invalid verification status'), { status: 400 });
  const assessment = await query('SELECT * FROM quality_assessments WHERE lot_id=$1', [lotId]);
  if (!assessment.rows.length) throw Object.assign(new Error('Quality assessment not found'), { status: 404 });
  const result = await query(
    `UPDATE quality_assessments SET status=$1,verified_at=NOW(),assessor_id=COALESCE(assessor_id,$3) WHERE lot_id=$2 RETURNING *`,
    [status, lotId, req.user.id]
  );
  await query(
    `UPDATE crop_lots SET quality_card=COALESCE(quality_card,'{}'::jsonb)||jsonb_build_object('assessmentStatus',$1),
     moisture_pct=CASE WHEN $1='VERIFIED' THEN (SELECT moisture_pct FROM quality_assessments WHERE lot_id=$2) ELSE moisture_pct END,
     grade=CASE WHEN $1='VERIFIED' THEN (SELECT grade FROM quality_assessments WHERE lot_id=$2) ELSE grade END
     WHERE id=$2`,
    [status, lotId]
  );
  res.json({ assessment: result.rows[0] });
});

router.post('/lots/pool/preview', verifyToken, requireRole('FPO_ADMIN'), async (req, res, next) => {
  try {
    const { lotIds } = req.body;
    if (!Array.isArray(lotIds) || !lotIds.length) throw Object.assign(new Error('lotIds is required'), { status: 400 });
    const lots = await query('SELECT * FROM crop_lots WHERE id=ANY($1::int[])', [lotIds]);
    if (!lots.rows.length || lots.rows.length !== lotIds.length) throw Object.assign(new Error('One or more lots were not found'), { status: 404 });
    const first = lots.rows[0];
    const quantity = lots.rows.reduce((sum, lot) => sum + Number(lot.quantity_quintals), 0);
    const weightedMoisture = quantity ? lots.rows.reduce((sum, lot) => sum + Number(lot.moisture_pct) * Number(lot.quantity_quintals), 0) / quantity : 0;
    const weightedFloor = quantity ? lots.rows.reduce((sum, lot) => sum + Number(lot.recommended_floor_inr) * Number(lot.quantity_quintals), 0) / quantity : 0;
    const fpo = await query('SELECT fpo_min_load_quintals,fpo_pool_capacity_quintals FROM users WHERE id=$1', [req.user.id]);
    const minimum = Number(fpo.rows[0]?.fpo_min_load_quintals || 50);
    const capacity = Number(fpo.rows[0]?.fpo_pool_capacity_quintals || 5000);
    res.json({
      canPool:
        lots.rows.every(lot => lot.status === 'LISTED') &&
        lots.rows.every(lot => lot.quality_card?.assessmentStatus === 'VERIFIED') &&
        lots.rows.every(lot => lot.crop_code === first.crop_code) &&
        lots.rows.every(lot => lot.grade === first.grade) &&
        lots.rows.every(lot => lot.district_id === req.user.districtId) &&
        quantity >= minimum && quantity <= capacity,
      cropCode:first.crop_code,
      grade:first.grade,
      districtId:first.district_id,
      totalQuintals:quantity,
      minimumQuintals:minimum,
      capacityQuintals:capacity,
      weightedMoisturePct:Number(weightedMoisture.toFixed(2)),
      weightedFloorInr:Number(weightedFloor.toFixed(2)),
      lotCount:lots.rows.length
    });
  } catch (err) { next(err); }
});

router.post('/lots/pool', verifyToken, requireRole('FPO_ADMIN'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { lotIds } = req.body;
    if (!Array.isArray(lotIds) || !lotIds.length) throw Object.assign(new Error('lotIds is required'), { status: 400 });
    if (lotIds.length !== new Set(lotIds.map(Number)).size) throw Object.assign(new Error('Duplicate lot IDs are not allowed'), { status: 400 });
    const lots = await client.query('SELECT * FROM crop_lots WHERE id=ANY($1::int[]) FOR UPDATE', [lotIds]);
    const first = lots.rows[0];
    if (!first || lots.rows.length !== lotIds.length) throw Object.assign(new Error('One or more lots were not found'), { status: 404 });
    if (lots.rows.some(lot => lot.status !== 'LISTED')) throw Object.assign(new Error('Only listed lots can be pooled'), { status: 409, code: 'LOT_NOT_LISTED' });
    if (lots.rows.some(lot => lot.quality_card?.assessmentStatus !== 'VERIFIED')) throw Object.assign(new Error('All lots must have verified quality assessments'), { status: 409, code: 'QUALITY_NOT_VERIFIED' });
    if (new Set(lots.rows.map(l => l.crop_code)).size !== 1 || new Set(lots.rows.map(l => l.grade)).size !== 1) {
      throw Object.assign(new Error('Lots must have the same crop and grade'), { status: 400, code: 'POOL_MISMATCH' });
    }
    if (new Set(lots.rows.map(l => l.district_id)).size !== 1 || lots.rows[0].district_id !== req.user.districtId) {
      throw Object.assign(new Error('Lots must belong to the FPO district'), { status: 400, code: 'DISTRICT_MISMATCH' });
    }
    const quantity = lots.rows.reduce((sum, l) => sum + Number(l.quantity_quintals), 0);
    const weightedMoisture = quantity ? lots.rows.reduce((sum, l) => sum + Number(l.moisture_pct) * Number(l.quantity_quintals), 0) / quantity : 0;
    const weightedFloor = quantity ? lots.rows.reduce((sum, l) => sum + Number(l.recommended_floor_inr) * Number(l.quantity_quintals), 0) / quantity : 0;
    const floor = Number(weightedFloor.toFixed(2));
    const fpo = await client.query('SELECT fpo_min_load_quintals,fpo_pool_capacity_quintals FROM users WHERE id=$1', [req.user.id]);
    const minimum = Number(fpo.rows[0]?.fpo_min_load_quintals || 50);
    const capacity = Number(fpo.rows[0]?.fpo_pool_capacity_quintals || 5000);
    if (quantity < minimum) throw Object.assign(new Error(`Pool must contain at least ${minimum} quintals`), { status: 400, code: 'BELOW_MINIMUM_LOAD' });
    if (quantity > capacity) throw Object.assign(new Error(`Pool cannot exceed ${capacity} quintals`), { status: 400, code: 'OVER_POOL_CAPACITY' });
    const districtId = lots.rows[0].district_id;
    const lotCode = `POOL-${Date.now().toString(36).toUpperCase()}`;
    const created = await client.query(
      `INSERT INTO crop_lots(lot_code,client_event_id,farmer_id,fpo_batch_id,crop_code,quantity_quintals,moisture_pct,grade,district_id,recommended_floor_inr,quality_card,captured_at,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}',$11,'IN_AUCTION') RETURNING *`,
      [lotCode, uuidv4(), req.user.id, first.id, first.crop_code, quantity, weightedMoisture.toFixed(2), first.grade, districtId, floor,
       new Date()]
    );
    await client.query(
      `UPDATE crop_lots SET quality_card=jsonb_build_object('assessmentStatus','VERIFIED','poolSizeQuintals',$1,
       'weightedMoisturePct',$2,'weightedFloorInr',$3,'sourceLotIds',$4::text[])
       WHERE id=$5`,
      [quantity, weightedMoisture.toFixed(2), floor, lotIds.map(String), created.rows[0].id]
    );
    await client.query('UPDATE crop_lots SET status=\'POOLED\', fpo_batch_id=$1 WHERE id=ANY($2::int[])', [created.rows[0].id, lotIds]);
    await client.query(
      `INSERT INTO lot_status_history(lot_id,previous_status,new_status,changed_by,reason)
       SELECT id,'LISTED','POOLED',$1,'Included in FPO pool' FROM crop_lots WHERE id=ANY($2::int[])`,
      [req.user.id, lotIds]
    );
    await client.query(
      'INSERT INTO lot_status_history(lot_id,previous_status,new_status,changed_by,reason) VALUES($1,$2,$3,$4,$5)',
      [created.rows[0].id, 'LISTED', 'IN_AUCTION', req.user.id, 'FPO pool auction created']
    );
    const durationSeconds = Number.isInteger(Number(req.body.durationSeconds)) && Number(req.body.durationSeconds) >= 300
      ? Number(req.body.durationSeconds) : 86400;
    const minIncrement = Number(req.body.minIncrementInr) > 0 ? Number(req.body.minIncrementInr) : 25;
    const reservePrice = req.body.reservePriceInr != null && Number(req.body.reservePriceInr) > 0 ? Number(req.body.reservePriceInr) : floor;
    const autoExtendSeconds = Number.isInteger(Number(req.body.autoExtendSeconds)) && Number(req.body.autoExtendSeconds) >= 60
      ? Number(req.body.autoExtendSeconds) : 300;
    await client.query(
      `INSERT INTO auctions(lot_id,floor_price_inr,current_highest_bid_inr,min_increment_inr,reserve_price_inr,duration_seconds,auto_extend_seconds,ends_at)
       VALUES($1,$2,$2,$3,$4,$5,$6,NOW()+($5 * INTERVAL '1 second'))`,
      [created.rows[0].id, floor, minIncrement, reservePrice, durationSeconds, autoExtendSeconds]
    );
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

router.get('/auctions/owned', verifyToken, requireRole('FARMER','FPO_ADMIN'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT a.*,l.lot_code,l.crop_code,l.quantity_quintals,l.moisture_pct,l.grade,l.district_id
       FROM auctions a JOIN crop_lots l ON l.id=a.lot_id
       WHERE l.farmer_id=$1 AND a.status='CLOSED' AND a.highest_bidder_id IS NOT NULL
       ORDER BY a.ends_at DESC`,
      [req.user.id]
    );
    res.json({ auctions: result.rows });
  } catch (err) { next(err); }
});

router.post('/auctions/:auctionId/bids', verifyToken, requireRole('BUYER'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const auctionId = Number(req.params.auctionId);
    if (!Number.isInteger(auctionId) || auctionId < 1) throw Object.assign(new Error('Invalid auction ID'), { status: 400 });
    const auctionResult = await client.query('SELECT * FROM auctions WHERE id=$1 FOR UPDATE', [auctionId]);
    if (!auctionResult.rows.length) throw Object.assign(new Error('Auction not found'), { status: 404 });
    const auction = auctionResult.rows[0];
    if (auction.status !== 'OPEN') throw Object.assign(new Error('Auction is closed'), { status: 409, code: 'AUCTION_CLOSED' });
    if (new Date(auction.ends_at) <= new Date()) throw Object.assign(new Error('Auction has expired'), { status: 409, code: 'AUCTION_EXPIRED' });
    if (new Date(auction.starts_at) > new Date()) throw Object.assign(new Error('Auction has not started'), { status: 409, code: 'AUCTION_NOT_STARTED' });
    const amount = Number(req.body.bidAmountInr);
    const minimum = Number(auction.current_highest_bid_inr) + Number(auction.min_increment_inr);
    if (!Number.isFinite(amount) || amount < minimum) throw Object.assign(new Error(`Minimum bid is ₹${minimum}`), { status: 400, code: 'BID_TOO_LOW' });
    if (req.user.id === auction.highest_bidder_id) throw Object.assign(new Error('You already hold the highest bid'), { status: 409, code: 'ALREADY_HIGH_BIDDER' });
    if (auction.reserve_price_inr && amount < Number(auction.reserve_price_inr)) throw Object.assign(new Error(`Bid must meet the reserve price of ₹${auction.reserve_price_inr}`), { status: 400, code: 'RESERVE_NOT_MET' });
    let newEndsAt = auction.ends_at;
    const secondsRemaining = (new Date(auction.ends_at).getTime() - Date.now()) / 1000;
    if (secondsRemaining <= Number(auction.auto_extend_seconds || 300)) {
      newEndsAt = new Date(Date.now() + Number(auction.auto_extend_seconds || 300)).toISOString();
    }
    await client.query('UPDATE auctions SET current_highest_bid_inr=$1,highest_bidder_id=$2,ends_at=$3 WHERE id=$4', [amount, req.user.id, newEndsAt, auction.id]);
    await client.query('INSERT INTO bids(auction_id,bidder_id,bid_amount_inr) VALUES($1,$2,$3)', [auction.id, req.user.id, amount]);
    await client.query('COMMIT');
    req.app.get('io')?.emit('bid:updated', { auctionId: auction.id, currentHighestBidInr: amount, highestBidderId: req.user.id });
    res.json({ success: true, auctionId: auction.id, currentHighestBidInr: amount });
  } catch (err) { await client.query('ROLLBACK'); next(err); } finally { client.release(); }
});

router.get('/auctions/:auctionId/bids', verifyToken, async (req, res, next) => {
  try {
    const auctionId = Number(req.params.auctionId);
    if (!Number.isInteger(auctionId) || auctionId < 1) throw Object.assign(new Error('Invalid auction ID'), { status: 400 });
    const result = await query(
      `SELECT b.id,b.bid_amount_inr,b.created_at,u.full_name,u.id AS bidder_id
       FROM bids b JOIN users u ON u.id=b.bidder_id
       WHERE b.auction_id=$1
       ORDER BY b.bid_amount_inr DESC,b.created_at DESC`,
      [auctionId]
    );
    res.json({ bids: result.rows });
  } catch (err) { next(err); }
});

router.post('/auctions/:auctionId/accept', verifyToken, requireRole('FARMER','FPO_ADMIN'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const auctionId = Number(req.params.auctionId);
    if (!Number.isInteger(auctionId) || auctionId < 1) throw Object.assign(new Error('Invalid auction ID'), { status: 400 });
    const result = await client.query(`SELECT a.*,l.farmer_id,l.fpo_batch_id,l.status AS lot_status FROM auctions a JOIN crop_lots l ON l.id=a.lot_id WHERE a.id=$1 FOR UPDATE`, [auctionId]);
    if (!result.rows.length) throw Object.assign(new Error('Auction not found'), { status: 404 });
    const auction = result.rows[0];
    if (req.user.role === 'FARMER' && auction.farmer_id !== req.user.id) throw Object.assign(new Error('You do not own this lot'), { status: 403 });
    if (req.user.role === 'FPO_ADMIN' && auction.farmer_id !== req.user.id) throw Object.assign(new Error('Only the FPO that created this pool can accept it'), { status: 403 });
    if (!['OPEN','CLOSED'].includes(auction.status)) throw Object.assign(new Error('Auction is not available for acceptance'), { status: 409 });
    if (new Date(auction.ends_at) > new Date()) throw Object.assign(new Error('Auction cannot be accepted before it expires'), { status: 409, code: 'AUCTION_STILL_OPEN' });
    if (!auction.highest_bidder_id) throw Object.assign(new Error('No bid to accept'), { status: 400 });
    await client.query('UPDATE auctions SET status=\'CLOSED\' WHERE id=$1', [auction.id]);
    await client.query('UPDATE crop_lots SET status=\'SOLD\' WHERE id=$1', [auction.lot_id]);
    await client.query(
      'INSERT INTO lot_status_history(lot_id,previous_status,new_status,changed_by,reason) VALUES($1,$2,$3,$4,$5)',
      [auction.lot_id, auction.lot_status, 'SOLD', req.user.id, 'Winning bid accepted']
    );
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
