require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');

async function main() {
  const { ADMIN_NAME, ADMIN_PHONE, ADMIN_PASSWORD, ADMIN_DISTRICT_ID } = process.env;
  if (!ADMIN_NAME || !ADMIN_PHONE || !ADMIN_PASSWORD || !ADMIN_DISTRICT_ID) {
    throw new Error('Set ADMIN_NAME, ADMIN_PHONE, ADMIN_PASSWORD, and ADMIN_DISTRICT_ID before running this command');
  }
  const phone = ADMIN_PHONE.replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(phone)) throw new Error('ADMIN_PHONE must be a valid 10-digit Indian mobile number');
  if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{12,}$/.test(ADMIN_PASSWORD)) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters with uppercase, lowercase, and a number');
  }
  const districtId = ADMIN_DISTRICT_ID.trim().toUpperCase();
  const district = await pool.query('SELECT code FROM districts WHERE code=$1 AND active=TRUE', [districtId]);
  if (!district.rows.length) throw new Error('ADMIN_DISTRICT_ID must match an active district');
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const created = await pool.query(
    `INSERT INTO users(full_name,phone,password_hash,role,district_id,account_status,kyc_status)
     VALUES($1,$2,$3,'ADMIN',$4,'APPROVED','VERIFIED') RETURNING id`,
    [ADMIN_NAME.trim(), phone, passwordHash, districtId]
  );
  console.log(`Created admin account ${created.rows[0].id}.`);
}

main()
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
