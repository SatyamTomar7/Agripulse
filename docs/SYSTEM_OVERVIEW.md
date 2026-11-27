# AgriPulse - Developer System Overview

## 1. Product and current maturity

AgriPulse is an offline-first agricultural marketplace prototype. Its intended users are farmers, Farmer Producer Organizations (FPOs), buyers, logistics operators, and marketplace administrators. The product flow is designed to take a harvest lot from local capture through quality review, FPO aggregation or an individual auction, dispatch tracking, and eventual payment.

The application currently implements core marketplace workflows and operational screens, but it is **not a production-ready end-to-end marketplace**. Payments do not move funds, mandi pricing is not live, third-party notification delivery is unavailable, and KYC documents are not collected. See [Known gaps and release blockers](#12-known-gaps-and-release-blockers) before planning a demo or deployment.

## 2. Technology and repository map

| Area | Technology | Important files |
|---|---|---|
| Web client | React 18, Vite, Tailwind CSS, Axios | `frontend/src/App.jsx`, `frontend/src/pages/` |
| Offline storage | Dexie / IndexedDB, PWA service worker | `frontend/src/db/offlineDb.js`, `frontend/src/services/syncManager.js` |
| API | Node.js, Express, Socket.IO | `backend/src/app.js`, `backend/src/server.js`, `backend/src/routes/index.js` |
| Database | PostgreSQL, SQL schema and seed rows | `backend/src/db/schema.sql`, `backend/src/config/db.js` |
| Authentication | bcryptjs, JSON Web Tokens, rotating refresh tokens | `backend/src/middleware/auth.js`, routes in `backend/src/routes/index.js` |
| Tests | Jest, Supertest | `backend/tests/coreEngine.test.js` |

`frontend/src/main.jsx` mounts the React app. `App.jsx` restores the user from browser storage, starts the offline sync manager, configures token refresh, and selects a dashboard by role. `backend/src/app.js` configures HTTP middleware and mounts the API router at `/api/v1`; the health endpoint is `/api/health`. `server.js` creates the HTTP and Socket.IO servers and runs the auction expiry worker.

## 3. Roles and responsibilities

| Role | Main capabilities |
|---|---|
| `FARMER` | Register/sync lots, submit quality information, view own lots and prices, start auctions for verified lots, cancel/relist eligible lots, accept a winning bid, view dispatch/payment status. |
| `FPO_ADMIN` | Review lots in the FPO's district, verify/reject submitted quality assessments, preview and create same-crop/same-grade pools, and accept bids on pools created by that FPO. |
| `BUYER` | Browse open auctions, place bids, review anonymized bid history, and view their own payment/dispatch records. |
| `LOGISTICS` | View dispatches assigned to that account and progress them through GPS-tracked pickup/transit/delivery; a buyer-provided OTP is required to mark delivery complete. |
| `ADMIN` | Approve/reject accounts, update KYC status after external review, maintain manual mandi prices, view dispatches, and assign approved logistics operators. Admin accounts are created through a backend CLI, not public registration. |

Farmers are approved at registration but their KYC remains a separate status. FPO, buyer, and logistics registrations are pending until an administrator approves them.

## 4. Core user journeys

### Farmer lot capture and offline sync

1. A farmer enters crop, quantity, moisture, grade, district, and optional quality/photo/location details in `FarmerDashboard.jsx`.
2. The client creates a UUIDv4 `clientEventId` and stores the lot in IndexedDB (`pendingLots`) with a sync status.
3. `syncManager.js` sends pending/retryable lots to `POST /api/v1/lots/sync` when online. The API accepts batches up to 50, validates each record, computes the floor price, writes the lot and status history transactionally, and ignores duplicate event IDs.
4. The client removes successfully synced or duplicate records. Per-lot failures are kept locally and made retryable; failed network batches are marked `ERROR` and retried after a delay or by the user.
5. Attached photos are compressed in the browser; the API accepts a photo data URL up to 280,000 characters. The JSON body limit is 15 MB.

Offline mode covers local lot capture and cached mandi prices, not bidding, quality verification, or dispatch updates. Sync requires an authenticated user and network access.

### Quality, pooling, and auctions

1. A farmer submits quality for their own listed lot. The assessment starts as `SUBMITTED`.
2. An FPO admin in the lot's district verifies or rejects the assessment.
3. A farmer may create an individual auction only after quality is verified. An FPO may pool compatible listed lots in its district when quality is verified and the configured pool size/capacity rules pass.
4. Bids are accepted only from approved buyer accounts. The API serializes bid changes by locking the auction row, enforces minimum increments/reserve, records each bid, and may extend an auction close time if a bid arrives near the deadline.
5. The expiry worker closes expired auctions. If there are no bids, the lot returns to `LISTED`; the farmer can re-open an auction. If there is a winning bid, the lot owner/FPO must accept it after the auction expires.
6. Accepting a bid marks the lot `SOLD`, creates a dispatch row, and creates a `PENDING` payment transaction. The payment transaction is informational only until a real gateway is integrated.

### Dispatch

After bid acceptance, an administrator assigns an approved logistics account from the lot's district and a vehicle number. The API hashes the generated one-time delivery code for validation and sends the plaintext code only to the buyer's private in-app notification. The assignment response does not return the code.

The logistics operator reports GPS coordinates when moving from `PENDING_PICKUP` to `IN_TRANSIT` and from `IN_TRANSIT` to `DELIVERED`. Delivery requires the buyer's six-digit code; on successful delivery the stored OTP hash is cleared.

### Pricing

`fairPriceEngine.js` calculates a recommended floor per quintal:

1. Select the greater of the configured mandi modal and crop MSP.
2. Apply grade multiplier: A = 1.06, B = 1.00, C = 0.92.
3. Apply a 1.5% penalty for each moisture percentage point above 12%.
4. Do not let the result fall below 95% of MSP.

Supported crops/MSP values are WHEAT 2425, PADDY_COMMON 2369, SOYBEAN 4892, MUSTARD 5950, and CHICKPEA 5650 INR. Price data is cached for 15 minutes by district/crop. Seed rows are sample data; administrators can update current values and record a source/history entry.

## 5. Main data model

The schema is in `backend/src/db/schema.sql`. It creates or migrates:

- `users`: identity, role, district, password hash, account/KYC status, and FPO pooling limits.
- `districts`, `crops`: active master data.
- `refresh_tokens`: hashes, expiry, and revocation timestamps for refresh sessions.
- `mandi_prices`, `mandi_price_history`: current sample/manual prices and audit history.
- `crop_lots`, `lot_status_history`: inventory, ownership, quality card, floor price, status, and lifecycle audit.
- `quality_assessments`: farmer-submitted assessment and FPO verification status.
- `auctions`, `bids`: auction configuration, current leader/amount, and bid history.
- `escrow_dispatches`, `dispatch_status_history`: dispatch assignment, GPS/status history, OTP hash, and a placeholder escrow status.
- `notification_preferences`, `notifications`: in-app messages and user channel preferences.
- `payment_transactions`, `payment_events`: payment workflow records intended for a future provider integration.

Most row relationships use numeric IDs and PostgreSQL foreign keys. `crop_lots.client_event_id` and `auctions.lot_id` are unique, making sync retries idempotent and limiting each lot to one reusable auction record.

## 6. API reference by feature

All application routes are under `/api/v1`. Except for the explicitly noted public routes, requests require `Authorization: Bearer <access-token>`.

| Feature | Endpoints |
|---|---|
| Health/master data | `GET /api/health`; `GET /api/v1/master-data` |
| Authentication/profile | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`; `GET /auth/me`; `PATCH /auth/me`; `POST /auth/change-password` |
| Notifications | `GET/PUT /notifications/preferences`; `GET /notifications`; `POST /notifications/:id/read`; `POST /notifications/read-all` |
| Admin | `GET /admin/accounts`; `PATCH /admin/accounts/:id/approval`; `PATCH /admin/accounts/:id/kyc`; `PUT /admin/mandi-prices/:districtId/:cropCode` |
| Price advice | `GET /advisory/fair-price`; `GET /advisory/nearby-prices` |
| Lots and quality | `POST /lots/sync`; `GET /lots`, `/lots/export/csv`, `/lots/:lotId`; `PATCH /lots/:lotId`; `POST /lots/:lotId/cancel`, `/lots/:lotId/relist`, `/lots/:lotId/quality`; `PATCH /lots/:lotId/quality/:status` |
| Auctions and pooling | `POST /lots/:lotId/auction`; `POST /lots/pool/preview`, `/lots/pool`; `GET /auctions`, `/auctions/owned`, `/auctions/:auctionId/bids`; `POST /auctions/:auctionId/bids`, `/auctions/:auctionId/accept` |
| Dispatch | `GET /dispatches`, `/dispatches/:id/history`; `POST /dispatches/:id/assign`; `PATCH /dispatches/:id/status` |
| Payment status | `GET /payments` |

Payment mutation endpoints (`POST /payments/authorize`, `/payments/:transactionId/capture`, `/payments/:transactionId/refund`, `/payments/:transactionId/release`, and `/payments/webhook`) intentionally return `503 PAYMENT_GATEWAY_UNAVAILABLE`. They must not be interpreted as a working payment integration.

Public routes include health, master data, price advice, and open auction listing. Lot listing/detail and other personal/operational records are authenticated and scoped by role.

## 7. Real-time events

The server emits Socket.IO events for clients that are connected:

- `lot:created` after a lot/auction is created or synced.
- `bid:updated` after a bid is committed.
- `auction:closed` after acceptance or expiry.
- `dispatch:updated` after a logistics status update.

These are UI refresh hints, not durable delivery. Persisted state remains in PostgreSQL and clients should reload via the REST API after reconnecting.

## 8. Authentication and security behavior

- Passwords are hashed with bcryptjs (12 rounds); registration enforces uppercase, lowercase, and a digit.
- Access JWTs last 15 minutes. A `JWT_SECRET` of at least 32 bytes is required for token creation/verification.
- Refresh tokens are random, stored only as SHA-256 hashes, rotate on refresh, and expire after seven days.
- Public registration accepts FARMER, FPO_ADMIN, BUYER, and LOGISTICS only. Admin creation is a separate CLI action.
- Role checks use middleware; lot access is scoped to farmer ownership, FPO district, auction visibility, or logistics assignment as appropriate.
- Helmet is enabled and `/api` is rate-limited to 300 requests per minute per client IP.
- The default Express CORS configuration currently reflects request origins with credentials. **Restrict this to known frontend origins before production.**
- `DB_SSL=true` currently sets `rejectUnauthorized: false`. Configure certificate verification before connecting to a production database over TLS.
- Browser tokens are stored in localStorage. Deploy only over HTTPS and evaluate an HttpOnly-cookie design before production.

## 9. Setup and common developer commands

Prerequisites: a supported Node.js runtime and PostgreSQL. Apply the schema before starting the API:

```powershell
psql $env:DATABASE_URL -f backend/src/db/schema.sql
```

1. Copy `backend/.env.example` to `backend/.env`, then set `DATABASE_URL`, `DB_SSL`, and a random `JWT_SECRET` with at least 32 bytes.
2. Install backend dependencies and create the first administrator. Set `ADMIN_NAME`, `ADMIN_PHONE`, `ADMIN_PASSWORD`, and `ADMIN_DISTRICT_ID` in the environment. The password must be at least 12 characters with uppercase, lowercase, and a digit.
3. From `backend`, run `npm install`, `npm run admin:create`, then `npm start` (or `npm run dev` for watch mode).
4. From `frontend`, run `npm install`. Set `VITE_API_URL` if the API is not at `http://localhost:4000`, then run `npm run dev`.

Useful checks:

```powershell
Set-Location backend
npm test

Set-Location ..\frontend
npm run build
npm run lint
```

The current Jest suite focuses on the fair-price engine and selected access-control/payment/OTP/auction behaviors. Most complete user journeys still need PostgreSQL-backed integration and browser-level tests.

## 10. Lifecycle values and interpretation

- Lot status constraint: `DRAFT`, `LISTED`, `POOLED`, `IN_AUCTION`, `SOLD`, `DISPATCHED`, `DELIVERED`, `CANCELED`.
- Quality status is represented in both the quality assessment row (`SUBMITTED`, `VERIFIED`, `REJECTED`) and the lot's JSON quality card (`NOT_SUBMITTED`, then assessment status).
- Auction status: `OPEN`, `CLOSED`, `SETTLED`. `SETTLED` is not currently reached by an integrated payment flow.
- Dispatch status: `PENDING_PICKUP`, `IN_TRANSIT`, `DELIVERED`.
- Payment status values exist in the schema, but provider-backed state transitions are disabled.

**Escrow warning:** `escrow_dispatches.escrow_status` currently defaults to `LOCKED`, even though no funds are actually moved. Treat this as a schema/UI placeholder, not evidence that money is in escrow. It should be corrected alongside the real payment integration before any financial demo.

## 11. Important implementation details

- The schema is designed to be re-applied for additive changes, but is not a versioned migration system. Back up the database and review schema changes before applying them to existing environments.
- The schema seeds districts, crops, and sample/manual mandi prices, but does not create demo users. Re-running it no longer overwrites administrator/account status or resets price rows.
- Auction expiry is polled every 30 seconds in the API process. In a multi-instance deployment, this worker needs a single-runner/locking strategy to avoid duplicate processing.
- Lot statuses `DISPATCHED` and `DELIVERED` exist in the schema, but the current dispatch status handler updates `escrow_dispatches`, not the associated `crop_lots` row.
- `GET /api/health` is a process health response and does not verify PostgreSQL connectivity.
- In-app notifications are persisted. SMS/email/push delivery is disabled; no delivery worker/provider exists.
- Language support is partial; English/Hindi are used in some messages, not across the entire UI.

## 12. Known gaps and release blockers

1. **Payments/escrow:** no payment gateway, verified webhook signature handling, refunds, payouts, or actual escrow operations. Payment mutation routes intentionally fail closed.
2. **Pricing feed:** no AGMARKNET/live source; administrators maintain manual values and seeded values are samples.
3. **Notifications:** no SMS, email, or push provider; only in-app notifications work.
4. **KYC:** no identity document upload, storage, or integrated verification workflow. Admin KYC status should follow an external review process.
5. **Dispatch and settlement:** dispatch tracking works with the demo GPS/status flow, but lot lifecycle status is not advanced to DISPATCHED/DELIVERED, and escrow status must not be trusted as proof of payment.
6. **Production configuration:** tighten CORS, validate database TLS certificates, add deployment secrets management, HTTPS, backups, observability, and a migration/versioning strategy.
7. **Quality/testing:** add database-backed integration tests for registration/approval, sync idempotency, FPO pooling, auction expiry/acceptance, dispatch OTP, and migration from supported prior schemas. Add browser tests for all role dashboards and offline recovery.
8. **Operational scale:** the expiry worker is in each API process; coordinate it before running multiple API instances. Add pagination for account, lot, bid, dispatch, and notification lists as data grows.
9. **UX polish:** lint currently exits successfully but reports React hook/state/purity and unused-variable warnings. Translation coverage is incomplete.

Treat AgriPulse as suitable for a **prototype walkthrough of inventory, quality review, pooling, bidding, and dispatch tracking**, not as a completed commercial marketplace until the blockers above are addressed.
