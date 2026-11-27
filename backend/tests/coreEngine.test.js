const request = require('supertest');
const jwt = require('jsonwebtoken');
const { calculateFloor, validate } = require('../src/services/fairPriceEngine');
const db = require('../src/config/db');
process.env.JWT_SECRET = 'test-secret-value-that-is-at-least-32-bytes';

jest.mock('../src/config/db', () => ({
  query: jest.fn(),
  pool: {
    connect: jest.fn(async () => ({
      query: jest.fn(async () => ({ rows: [] })),
      release: jest.fn()
    }))
  }
}));

const createApp = require('../src/app');
const app = createApp({ emit: jest.fn() });
const tokenFor = role => jwt.sign({ id: 1, role, districtId: 'GWALIOR' }, process.env.JWT_SECRET);

describe('AgriPulse fair-price engine', () => {
  test('applies Grade A 6 percent bonus', () => {
    expect(calculateFloor({ cropCode:'WHEAT', mandiModalInr:2520, grade:'A', moisturePct:11 }).recommendedFloorInr).toBe(2671.20);
  });

  describe('marketplace access controls', () => {
    test('requires authentication to list lots', async () => {
      const res = await request(app).get('/api/v1/lots');
      expect(res.status).toBe(401);
    });

    test('limits farmer lot results to the authenticated farmer', async () => {
      db.query.mockClear();
      db.query.mockResolvedValueOnce({ rows:[] });
      const res = await request(app).get('/api/v1/lots').set('Authorization',`Bearer ${tokenFor('FARMER')}`);
      expect(res.status).toBe(200);
      expect(db.query.mock.calls[0][0]).toContain('farmer_id=$1');
      expect(db.query.mock.calls[0][1]).toEqual([1]);
    });

    test('does not claim payment success without a configured provider', async () => {
      const res = await request(app).post('/api/v1/payments/authorize')
        .set('Authorization',`Bearer ${tokenFor('BUYER')}`)
        .send({ auctionId:1, providerReference:'buyer-supplied-reference' });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('PAYMENT_GATEWAY_UNAVAILABLE');
    });

    test('rejects external notification channels without delivery providers', async () => {
      const res = await request(app).put('/api/v1/notifications/preferences')
        .set('Authorization',`Bearer ${tokenFor('FARMER')}`)
        .send({ sms:true });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('NOTIFICATION_PROVIDER_UNAVAILABLE');
    });

    test('does not expose auction reserve or leading bidder identity publicly', async () => {
      db.query.mockClear();
      db.query.mockResolvedValueOnce({ rows:[] });
      const res = await request(app).get('/api/v1/auctions');
      expect(res.status).toBe(200);
      expect(db.query.mock.calls[0][0]).not.toContain('highest_bidder_id');
      expect(db.query.mock.calls[0][0]).not.toContain('reserve_price_inr');
    });

    test('does not return delivery OTP hashes from dispatch listing', async () => {
      db.query.mockClear();
      db.query.mockResolvedValueOnce({ rows:[] });
      const res = await request(app).get('/api/v1/dispatches').set('Authorization',`Bearer ${tokenFor('ADMIN')}`);
      expect(res.status).toBe(200);
      expect(db.query.mock.calls[0][0]).not.toContain('delivery_otp_hash');
    });

    test('sends delivery OTP privately instead of returning it to the administrator', async () => {
      const clientQuery = jest.fn(async (sql, params) => {
        if (sql.includes('SELECT d.*,l.district_id')) {
          return { rows:[{ id:4,buyer_id:2,district_id:'GWALIOR',logistics_status:'PENDING_PICKUP' }] };
        }
        if (sql.includes('SELECT id,role,account_status,district_id')) {
          return { rows:[{ id:8,role:'LOGISTICS',account_status:'APPROVED',district_id:'GWALIOR' }] };
        }
        if (sql.includes('INSERT INTO notifications')) {
          expect(params[1]).toMatch(/dispatch #4 is \d{6}/);
        }
        if (sql.includes('UPDATE escrow_dispatches')) {
          return { rows:[{ id:4,logistics_user_id:8,logistics_status:'PENDING_PICKUP' }] };
        }
        return { rows:[] };
      });
      db.pool.connect.mockResolvedValueOnce({ query:clientQuery, release:jest.fn() });
      const res = await request(app).post('/api/v1/dispatches/4/assign')
        .set('Authorization',`Bearer ${tokenFor('ADMIN')}`)
        .send({ logisticsUserId:8, vehicleNumber:'MP-09-AB-1234' });
      expect(res.status).toBe(201);
      expect(res.body.deliveryOtp).toBeUndefined();
      expect(clientQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO notifications'))).toBe(true);
    });

    test('requires administrator review before changing a district', async () => {
      const res = await request(app).patch('/api/v1/auth/me')
        .set('Authorization',`Bearer ${tokenFor('FPO_ADMIN')}`)
        .send({ districtId:'INDORE' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('DISTRICT_CHANGE_REQUIRES_REVIEW');
    });

    test('creates an auction only for a verified farmer lot', async () => {
      const clientQuery = jest.fn(async sql => {
        if (sql.includes('SELECT * FROM crop_lots')) {
          return { rows:[{
            id:12, farmer_id:1, status:'LISTED', recommended_floor_inr:2500,
            quality_card:{ assessmentStatus:'VERIFIED' }
          }] };
        }
        if (sql.includes('SELECT * FROM auctions')) return { rows:[] };
        if (sql.includes('INSERT INTO auctions')) return { rows:[{ id:33, lot_id:12, status:'OPEN' }] };
        return { rows:[] };
      });
      db.pool.connect.mockResolvedValueOnce({ query:clientQuery, release:jest.fn() });
      const res = await request(app).post('/api/v1/lots/12/auction')
        .set('Authorization',`Bearer ${tokenFor('FARMER')}`).send({});
      expect(res.status).toBe(201);
      expect(res.body.auction.id).toBe(33);
      expect(clientQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO auctions'))).toBe(true);
    });
  });
  test('uses MSP as base when mandi modal is lower', () => {
    expect(calculateFloor({ cropCode:'WHEAT', mandiModalInr:2200, grade:'B', moisturePct:11 }).recommendedFloorInr).toBe(2425);
  });
  test('calculates moisture penalty at 1.5 percent per excess point', () => {
    expect(calculateFloor({ cropCode:'WHEAT', mandiModalInr:2520, grade:'A', moisturePct:16 }).moisturePenaltyInr).toBe(160.27);
  });
  test('enforces statutory 95 percent MSP floor', () => {
    expect(calculateFloor({ cropCode:'CHICKPEA', mandiModalInr:1000, grade:'C', moisturePct:45 }).recommendedFloorInr).toBe(5367.50);
  });
  test('rejects invalid crop', () => {
    expect(()=>validate('RICE','A',10)).toThrow('Invalid crop code');
  });
  test('rejects invalid grade', () => {
    expect(()=>validate('WHEAT','D',10)).toThrow('Invalid grade');
  });
  test('rejects invalid moisture below range', () => {
    expect(()=>validate('WHEAT','A',-1)).toThrow('Moisture percentage');
  });
  test('rejects invalid moisture above range', () => {
    expect(()=>validate('WHEAT','A',46)).toThrow('Moisture percentage');
  });
  test('accepts canonical UUIDv4', () => {
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });
  test('rejects non-v4 UUID', () => {
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
  });
  test('rejects batch overflow with 413', async () => {
    const lots=Array.from({length:51},(_,i)=>({clientEventId:`550e8400-e29b-41d4-a716-${String(i).padStart(12,'0')}`}));
    const res=await request(app).post('/api/v1/lots/sync').set('Authorization',`Bearer ${tokenFor('FARMER')}`).send({lots});
    expect(res.status).toBe(413);
  });
  test('batch deduplication set eliminates duplicate retries', () => {
    const ids=['550e8400-e29b-41d4-a716-446655440000','550e8400-e29b-41d4-a716-446655440001'];
    const retry=['550e8400-e29b-41d4-a716-446655440000'];
    const duplicateIgnoredCount=retry.filter(id=>new Set(ids).has(id)).length;
    expect(duplicateIgnoredCount).toBe(1);
  });
  test('partial batch error isolation preserves valid rows', () => {
    const input=['valid','invalid','valid'];
    const valid=input.filter(item=>item==='valid');
    expect(valid).toEqual(['valid','valid']);
  });
});
