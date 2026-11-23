const MSP = Object.freeze({
  WHEAT: 2425,
  PADDY_COMMON: 2369,
  SOYBEAN: 4892,
  MUSTARD: 5950,
  CHICKPEA: 5650
});
const GRADE_MULTIPLIERS = Object.freeze({ A: 1.06, B: 1.00, C: 0.92 });

function validate(cropCode, grade, moisturePct) {
  if (!Object.hasOwn(MSP, cropCode)) throw Object.assign(new Error('Invalid crop code'), { status: 400, code: 'INVALID_CROP' });
  if (!Object.hasOwn(GRADE_MULTIPLIERS, grade)) throw Object.assign(new Error('Invalid grade'), { status: 400, code: 'INVALID_GRADE' });
  const moisture = Number(moisturePct);
  if (!Number.isFinite(moisture) || moisture < 0 || moisture > 45) {
    throw Object.assign(new Error('Moisture percentage must be between 0 and 45'), { status: 400, code: 'INVALID_MOISTURE' });
  }
  return moisture;
}

function calculateFloor({ cropCode, mandiModalInr, grade, moisturePct }) {
  const moisture = validate(cropCode, grade, moisturePct);
  const msp = MSP[cropCode];
  const basePrice = Math.max(Number(mandiModalInr), msp) * GRADE_MULTIPLIERS[grade];
  const excessMoisture = Math.max(0, moisture - 12);
  const moisturePenaltyInr = Number((basePrice * (excessMoisture * 0.015)).toFixed(2));
  const recommendedFloorInr = Math.max(
    Number((basePrice - moisturePenaltyInr).toFixed(2)),
    Number((msp * 0.95).toFixed(2))
  );
  return { mspInr: msp, moisturePenaltyInr, recommendedFloorInr };
}

module.exports = { MSP, GRADE_MULTIPLIERS, validate, calculateFloor };
