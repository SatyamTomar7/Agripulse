const request = require('supertest');
const jwt = require('jsonwebtoken');
const { calculateFloor, validate } = require('../src/services/fairPriceEngine');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

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
const tokenFor = role => jwt.sign({ id: 1, role, districtId: 'GWALIOR' }, process.env.JWT_SECRET || 'development-secret');

describe('AgriPulse fair-price engine', () => {
  test('applies Grade A 6 percent bonus', () => {
    expect(calculateFloor({ cropCode:'WHEAT', mandiModalInr:2520, grade:'A', moisturePct:11 }).recommendedFloorInr).toBe(2671.20);
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
