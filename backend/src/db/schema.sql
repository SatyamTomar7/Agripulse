CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(120) NOT NULL,
  phone VARCHAR(15) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) CHECK (role IN ('FARMER', 'FPO_ADMIN', 'BUYER', 'LOGISTICS', 'ADMIN')) NOT NULL,
  district_id VARCHAR(50) NOT NULL,
  state_name VARCHAR(50) DEFAULT 'Madhya Pradesh',
  village VARCHAR(120),
  address TEXT,
  bank_account_last4 VARCHAR(4),
  kyc_status VARCHAR(20) DEFAULT 'PENDING' CHECK (kyc_status IN ('PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED')),
  account_status VARCHAR(20) DEFAULT 'PENDING' CHECK (account_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  fpo_min_load_quintals NUMERIC(10,2) DEFAULT 50,
  fpo_pool_capacity_quintals NUMERIC(10,2) DEFAULT 5000,
  preferred_lang VARCHAR(10) DEFAULT 'en',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS state_name VARCHAR(50) DEFAULT 'Madhya Pradesh';
ALTER TABLE users ADD COLUMN IF NOT EXISTS village VARCHAR(120);
ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_account_last4 VARCHAR(4);
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) DEFAULT 'PENDING';
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) DEFAULT 'PENDING';
ALTER TABLE users ALTER COLUMN account_status SET DEFAULT 'PENDING';
ALTER TABLE users ADD COLUMN IF NOT EXISTS fpo_min_load_quintals NUMERIC(10,2) DEFAULT 50;
ALTER TABLE users ADD COLUMN IF NOT EXISTS fpo_pool_capacity_quintals NUMERIC(10,2) DEFAULT 5000;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_lang VARCHAR(10) DEFAULT 'en';

CREATE TABLE IF NOT EXISTS districts (
  code VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  state_name VARCHAR(50) NOT NULL,
  active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS crops (
  code VARCHAR(30) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  active BOOLEAN DEFAULT TRUE
);

INSERT INTO districts(code,name,state_name) VALUES
  ('GWALIOR','Gwalior','Madhya Pradesh'),('INDORE','Indore','Madhya Pradesh'),
  ('BHOPAL','Bhopal','Madhya Pradesh'),('JABALPUR','Jabalpur','Madhya Pradesh')
ON CONFLICT(code) DO NOTHING;

INSERT INTO crops(code,name) VALUES
  ('WHEAT','Wheat'),('PADDY_COMMON','Paddy (Common)'),('SOYBEAN','Soybean'),
  ('MUSTARD','Mustard'),('CHICKPEA','Chickpea')
ON CONFLICT(code) DO NOTHING;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mandi_prices (
  id SERIAL PRIMARY KEY,
  district_id VARCHAR(50) NOT NULL,
  crop_code VARCHAR(30) NOT NULL,
  modal_price_inr NUMERIC(10,2) NOT NULL,
  msp_inr NUMERIC(10,2) NOT NULL,
  arrival_quintals NUMERIC(10,2) DEFAULT 0,
  source VARCHAR(120) NOT NULL DEFAULT 'SEEDED SAMPLE DATA',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(district_id, crop_code)
);

ALTER TABLE mandi_prices ADD COLUMN IF NOT EXISTS source VARCHAR(120) NOT NULL DEFAULT 'SEEDED SAMPLE DATA';

CREATE TABLE IF NOT EXISTS mandi_price_history (
  id SERIAL PRIMARY KEY,
  district_id VARCHAR(50) NOT NULL,
  crop_code VARCHAR(30) NOT NULL,
  modal_price_inr NUMERIC(10,2) NOT NULL,
  msp_inr NUMERIC(10,2) NOT NULL,
  arrival_quintals NUMERIC(10,2) DEFAULT 0,
  source VARCHAR(120) DEFAULT 'ADMIN',
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  effective_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crop_lots (
  id SERIAL PRIMARY KEY,
  lot_code VARCHAR(24) UNIQUE NOT NULL,
  client_event_id UUID UNIQUE NOT NULL,
  farmer_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  fpo_batch_id INTEGER NULL,
  crop_code VARCHAR(30) NOT NULL,
  quantity_quintals NUMERIC(10,2) CHECK (quantity_quintals > 0 AND quantity_quintals <= 2000) NOT NULL,
  moisture_pct NUMERIC(5,2) CHECK (moisture_pct >= 0 AND moisture_pct <= 45) NOT NULL,
  grade CHAR(1) CHECK (grade IN ('A', 'B', 'C')) NOT NULL,
  district_id VARCHAR(50) NOT NULL,
  recommended_floor_inr NUMERIC(10,2) NOT NULL,
  quality_card JSONB DEFAULT '{}'::jsonb,
  status VARCHAR(25) DEFAULT 'LISTED' CHECK (status IN ('LISTED', 'POOLED', 'IN_AUCTION', 'SOLD', 'DISPATCHED', 'DELIVERED')),
  captured_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lot_status_history (
  id SERIAL PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES crop_lots(id) ON DELETE CASCADE,
  previous_status VARCHAR(25),
  new_status VARCHAR(25) NOT NULL,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  changed_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE crop_lots DROP CONSTRAINT IF EXISTS crop_lots_status_check;
ALTER TABLE crop_lots ADD CONSTRAINT crop_lots_status_check
  CHECK (status IN ('DRAFT','LISTED','POOLED','IN_AUCTION','SOLD','DISPATCHED','DELIVERED','CANCELED'));

CREATE TABLE IF NOT EXISTS quality_assessments (
  id SERIAL PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES crop_lots(id) ON DELETE CASCADE,
  assessor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  moisture_pct NUMERIC(5,2) CHECK (moisture_pct >= 0 AND moisture_pct <= 45) NOT NULL,
  grade CHAR(1) CHECK (grade IN ('A', 'B', 'C')) NOT NULL,
  foreign_matter_pct NUMERIC(5,2) CHECK (foreign_matter_pct >= 0 AND foreign_matter_pct <= 100) NOT NULL,
  broken_grain_pct NUMERIC(5,2) CHECK (broken_grain_pct >= 0 AND broken_grain_pct <= 100) NOT NULL,
  certificate_no VARCHAR(80),
  notes TEXT,
  status VARCHAR(20) DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED', 'VERIFIED', 'REJECTED')),
  assessed_at TIMESTAMPTZ DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  UNIQUE(lot_id)
);

CREATE TABLE IF NOT EXISTS auctions (
  id SERIAL PRIMARY KEY,
  lot_id INTEGER UNIQUE REFERENCES crop_lots(id) ON DELETE CASCADE,
  floor_price_inr NUMERIC(10,2) NOT NULL,
  current_highest_bid_inr NUMERIC(10,2) NOT NULL,
  min_increment_inr NUMERIC(10,2) DEFAULT 25.00,
  reserve_price_inr NUMERIC(10,2),
  duration_seconds INTEGER DEFAULT 86400,
  auto_extend_seconds INTEGER DEFAULT 300,
  starts_at TIMESTAMPTZ DEFAULT NOW(),
  highest_bidder_id INTEGER REFERENCES users(id) NULL,
  status VARCHAR(20) DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'SETTLED')),
  ends_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE auctions ADD COLUMN IF NOT EXISTS reserve_price_inr NUMERIC(10,2);
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS duration_seconds INTEGER DEFAULT 86400;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS auto_extend_seconds INTEGER DEFAULT 300;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS bids (
  id SERIAL PRIMARY KEY,
  auction_id INTEGER REFERENCES auctions(id) ON DELETE CASCADE,
  bidder_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  bid_amount_inr NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS escrow_dispatches (
  id SERIAL PRIMARY KEY,
  auction_id INTEGER UNIQUE REFERENCES auctions(id),
  buyer_id INTEGER REFERENCES users(id),
  farmer_id INTEGER REFERENCES users(id),
  logistics_user_id INTEGER REFERENCES users(id),
  total_amount_inr NUMERIC(12,2) NOT NULL,
  escrow_status VARCHAR(20) DEFAULT 'LOCKED' CHECK (escrow_status IN ('LOCKED', 'RELEASED', 'REFUNDED')),
  logistics_status VARCHAR(25) DEFAULT 'PENDING_PICKUP' CHECK (logistics_status IN ('PENDING_PICKUP', 'IN_TRANSIT', 'DELIVERED')),
  vehicle_number VARCHAR(25) NULL,
  origin_address TEXT,
  destination_address TEXT,
  expected_delivery_at TIMESTAMPTZ,
  pickup_lat DOUBLE PRECISION,
  pickup_lng DOUBLE PRECISION,
  delivery_lat DOUBLE PRECISION,
  delivery_lng DOUBLE PRECISION,
  delivery_otp_hash CHAR(64),
  current_lat DOUBLE PRECISION DEFAULT 26.2183,
  current_lng DOUBLE PRECISION DEFAULT 78.1828,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dispatch_status_history (
  id SERIAL PRIMARY KEY,
  dispatch_id INTEGER NOT NULL REFERENCES escrow_dispatches(id) ON DELETE CASCADE,
  previous_status VARCHAR(25),
  new_status VARCHAR(25) NOT NULL,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  note TEXT,
  changed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  in_app BOOLEAN DEFAULT TRUE,
  sms BOOLEAN DEFAULT FALSE,
  email BOOLEAN DEFAULT FALSE,
  push BOOLEAN DEFAULT FALSE,
  quiet_start TIME,
  quiet_end TIME
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel VARCHAR(20) CHECK (channel IN ('IN_APP','SMS','EMAIL','PUSH')) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  title VARCHAR(160) NOT NULL,
  body TEXT NOT NULL,
  data JSONB DEFAULT '{}'::jsonb,
  status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','READ')),
  attempts INTEGER DEFAULT 0,
  next_attempt_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id SERIAL PRIMARY KEY,
  auction_id INTEGER UNIQUE NOT NULL REFERENCES auctions(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  provider VARCHAR(30) NOT NULL DEFAULT 'MANUAL',
  provider_reference VARCHAR(120) UNIQUE,
  amount_inr NUMERIC(12,2) NOT NULL,
  commission_inr NUMERIC(12,2) DEFAULT 0,
  payable_to_farmer_inr NUMERIC(12,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','AUTHORIZED','CAPTURED','LOCKED','RELEASED','REFUND_PENDING','REFUNDED','FAILED')),
  invoice_no VARCHAR(50) UNIQUE,
  provider_payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_events (
  id SERIAL PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES payment_transactions(id) ON DELETE CASCADE,
  event_id VARCHAR(120) UNIQUE,
  event_type VARCHAR(50) NOT NULL,
  payload JSONB DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lots_status ON crop_lots(status);
CREATE INDEX IF NOT EXISTS idx_lots_district ON crop_lots(district_id);
CREATE INDEX IF NOT EXISTS idx_lots_farmer ON crop_lots(farmer_id);
CREATE INDEX IF NOT EXISTS idx_mandi_lookup ON mandi_prices(district_id, crop_code);
CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status);
CREATE INDEX IF NOT EXISTS idx_bids_auction ON bids(auction_id);

INSERT INTO mandi_prices (district_id, crop_code, modal_price_inr, msp_inr, arrival_quintals) VALUES
  ('GWALIOR','WHEAT',2520,2425,1200),('GWALIOR','PADDY_COMMON',2440,2369,850),
  ('GWALIOR','SOYBEAN',5100,4892,640),('GWALIOR','MUSTARD',6120,5950,420),
  ('GWALIOR','CHICKPEA',5800,5650,310),
  ('INDORE','WHEAT',2580,2425,1500),('INDORE','PADDY_COMMON',2490,2369,720),
  ('INDORE','SOYBEAN',5250,4892,980),('INDORE','MUSTARD',6080,5950,390),
  ('INDORE','CHICKPEA',5900,5650,460),
  ('BHOPAL','WHEAT',2550,2425,1350),('BHOPAL','PADDY_COMMON',2475,2369,790),
  ('BHOPAL','SOYBEAN',5180,4892,870),('BHOPAL','MUSTARD',6150,5950,350),
  ('BHOPAL','CHICKPEA',5850,5650,410),
  ('JABALPUR','WHEAT',2500,2425,1100),('JABALPUR','PADDY_COMMON',2510,2369,930),
  ('JABALPUR','SOYBEAN',5060,4892,560),('JABALPUR','MUSTARD',6000,5950,300),
  ('JABALPUR','CHICKPEA',5780,5650,290)
ON CONFLICT (district_id, crop_code) DO NOTHING;
