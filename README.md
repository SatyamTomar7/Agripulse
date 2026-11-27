# AgriPulse

AgriPulse is an offline-first agricultural marketplace prototype for farmers, FPOs, buyers, and logistics providers. It supports lot registration and synchronization, manual quality review, FPO pooling, auctions, dispatch tracking, account/KYC administration, and manually maintained mandi prices.

For architecture, workflows, API groups, data model, security notes, and outstanding release blockers, see the [developer system overview](docs/SYSTEM_OVERVIEW.md).

## Local setup

1. Create a PostgreSQL database and apply `backend/src/db/schema.sql`.
2. Copy `backend/.env.example` to `backend/.env`; set `DATABASE_URL` and a strong random `JWT_SECRET`.
3. From `backend`, run `npm install`. Configure `ADMIN_NAME`, `ADMIN_PHONE`, `ADMIN_PASSWORD`, and `ADMIN_DISTRICT_ID` in the process environment, then create the first administrator:

   ```powershell
   npm run admin:create
   ```

   The password must be at least 12 characters with uppercase, lowercase, and a number. The command creates one administrator account and does not reset or overwrite an existing account.
4. Start the API with `npm start` from `backend`.
5. From `frontend`, run `npm install`, configure `VITE_API_URL` if the API is not at `http://localhost:4000`, then run `npm run dev`.

Farmers can register directly. FPO, buyer, and logistics registrations remain pending until an administrator approves them. Admin accounts can only be created through the backend CLI; public registration does not accept the ADMIN role.

## Marketplace limitations

- Mandi values are seeded sample data or manually entered by an administrator. No live AGMARKNET feed is connected; the API labels the data source accordingly.
- Payment authorization, capture, refund, payout, and webhooks are disabled until a real payment gateway integration is implemented and configured. The application does not move funds.
- Notifications are stored in the in-app inbox. SMS, email, and push options are disabled because delivery providers are not configured.
- Dispatch assignment is administrator-only. The delivery OTP is placed in the winning buyer's private in-app notifications and is never returned to the assigning administrator.
- KYC status can be tracked, but identity documents are reviewed outside the application; document upload/storage is not implemented.

## Validation

- Backend: `cd backend; npm test`
- Frontend production build: `cd frontend; npm run build`
- Frontend lint: `cd frontend; npm run lint`
