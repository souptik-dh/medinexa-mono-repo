# Jido Healthcare — REST API Reference

Live implementation reference for the MediBook API. Every endpoint below documents the **actual request/response payloads** produced by the code in `src/app/api/v1`, with JSON examples.

- **Base URL:** `http://localhost:3000/api/v1` (dev) or `https://api.medibook.app/api/v1` (prod)
- **Format:** JSON only (`Content-Type: application/json`), except legacy upload endpoints (certificates, prescription scans, medical documents) and clinic/branch license uploads which use `multipart/form-data`, and photo uploads which use a two-step Cloudinary flow (see [File uploads](#file-uploads)).
- **Auth:** `Authorization: Bearer <access_token>` (JWT, 15 min TTL). Refresh via `POST /auth/refresh`.
- **IDs:** all resource IDs are UUIDs (v4), generated server-side.

---

## Table of contents

1. [Conventions](#conventions)
2. [Health](#health)
3. [Roles & scope](#roles--scope)
4. [Authentication](#authentication)
5. [Clinics](#clinics)
6. [Branches](#branches)
7. [Clinic & branch licenses](#clinic--branch-licenses)
8. [Branch staff](#branch-staff)
9. [Doctors, invites & assignments](#doctors-invites--assignments)
10. [Reviews & ratings](#reviews--ratings)
11. [Patients](#patients)
12. [Appointments](#appointments)
13. [Lab tests](#lab-tests)
14. [Payment ledger](#payment-ledger)
15. [Prescriptions](#prescriptions)
16. [Medical documents](#medical-documents)
17. [Notifications](#notifications)
18. [Files (signed URLs)](#files-signed-urls)
19. [Error codes](#error-codes)
20. [Status transition table](#status-transition-table)
21. [Lab test status transitions](#lab-test-status-transitions)

---

## Conventions

### Error envelope

Every non-2xx response uses the same envelope:

```json
{
  "error": {
    "code": "SLOT_ALREADY_BOOKED",
    "message": "This time slot was just taken. Please choose another.",
    "field": null,
    "request_id": "req_8f2a1c33"
  }
}
```

`code` is stable `UPPER_SNAKE_CASE`; `field` is present for validation errors; `request_id` is a short traceable ID.

### Pagination

Cursor-based. `?limit=<1..100>&cursor=<opaque>`. Paginated list responses include a `next_cursor` field (`null` when there are no more pages). Cursor is opaque — treat it as an opaque string.

List endpoints that **are** paginated: `GET /clinics`, `GET /appointments`, `GET /notifications`.
List endpoints that are **not** paginated (return `{ items }` only): branches, staff, doctor-invites, branch doctors, doctor search, medical documents, status history, payment ledger.
`GET /branches/:id/patients` uses a separate `limit`/`offset` + `has_more` scheme instead of the cursor above — see [Patients](#patients).

### Idempotency

`Idempotency-Key` header is **required** for:

- `POST /appointments`
- `PATCH /appointments/:id/payment`

Replaying the same key within 24h returns the stored original response instead of creating a duplicate.

### Timestamps

ISO 8601 UTC — e.g. `2026-08-09T14:30:00Z`. Scheduling `date` is `YYYY-MM-DD`, `time` is `HH:MM` (24h), interpreted in the **branch's timezone**.

### Rate limits

Default `100 req/min` per token. Auth endpoints `10 req/min` per IP. Overrides:

| Endpoint | Limit |
|---|---|
| `POST /auth/*` (all) | 10/min per IP |
| `PATCH /appointments/:id/payment` | 20/min |
| `GET /doctors/search` | 60/min |

### File uploads

Two upload models are used:

**Photos (patient, doctor, branch, branch gallery)** — uploaded directly to Cloudinary from the client, in two steps:

1. `POST <resource>/photo/signature` (auth required) returns a short-lived signed upload grant. The client **must** upload to the exact `public_id` it was issued.
2. The client uploads the file directly to the returned `upload_url` (Cloudinary), sending `file` + `public_id` + `timestamp` + `api_key` + `cloud_name` + `allowed_formats` + `signature` as `multipart/form-data`.
3. `POST <resource>/photo` (auth required) persists the result — body `{ "public_id": "<issued id>" }`. The API validates the id and stores a Cloudinary delivery URL.

Allowed formats: `jpg`, `png`, `webp`, `gif`. Size limits are enforced by the Cloudinary account settings.

**Clinic/branch license documents** — `multipart/form-data`, single field named `file`, sent straight to the endpoint (no signature step). The server itself performs a signed upload to Cloudinary (`resource_type=auto`, so PDFs and images both work) and returns a **permanent** `secure_url`, which is stored directly on the clinic/branch's `*_url` column. Allowed: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`, up to 10MB.

**Legacy server-stored uploads (certificates, prescription scans, medical documents)** — `multipart/form-data`, single field named `file`. The API returns a **signed, time-limited URL** (15 min expiry) — never a permanent public link.

Common upload errors: `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `400 FILE_REQUIRED`, `400 FILE_EMPTY`. Photo persist endpoints return `400 INVALID_PUBLIC_ID` when the `public_id` was not issued by a signature endpoint.

### Partial updates

`PATCH` bodies are partial — omitted fields are unchanged, `null` explicitly clears a nullable field.

---

## Health

### GET /health

Auth: none. Unauthenticated liveness/readiness check — pings the database and reports its status. Rate-limited at 60 requests/min per IP.

**Response `200`**

```json
{ "status": "ok", "db": "up" }
```

**Response `503`** (database unreachable)

```json
{ "status": "error", "db": "down" }
```

---

## Roles & scope

| Role | Scope |
|---|---|
| `patient` | Own resources only |
| `clinic_owner` | Resources under clinics/branches they own |
| `branch_staff` | Resources under their assigned branch only |
| `doctor` | Own profile + appointments/patients linked to them |
| `sys_admin` | Bypasses role checks (internal) |

---

## Authentication

### POST /auth/patient/register

Public. Rate limited 10/min per IP.

**Request body**

```json
{
  "name": "Aisha Verma",
  "email": "aisha@example.com",
  "phone": "+919876543210",
  "address": "123 Link Road, Andheri West",
  "nearby_location": "Near Andheri Station",
  "city": "Mumbai",
  "district": "Mumbai Suburban",
  "pin_code": "400058",
  "state": "Maharashtra",
  "post_office": "Andheri West HO",
  "password": "password123"
}
```

| Field | Type | Notes |
|---|---|---|
| `name` | string | required, 1–255 chars |
| `email` | string | required, lowercase, must be valid |
| `phone` | string? | optional, max 32 |
| `address` | string | required, 1–500 chars |
| `nearby_location` | string? | optional, max 500 |
| `city` | string? | optional, max 255 |
| `district` | string? | optional, max 255 |
| `pin_code` | string? | optional, max 20 |
| `state` | string? | optional, max 255 |
| `post_office` | string? | optional, max 255 |
| `password` | string | required, 8–128 chars |

**Response `201`**

```json
{
  "user": {
    "id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
    "name": "Aisha Verma",
    "email": "aisha@example.com",
    "phone": "+919876543210",
    "address": "123 Link Road, Andheri West",
    "nearby_location": "Near Andheri Station",
    "city": "Mumbai",
    "district": "Mumbai Suburban",
    "pin_code": "400058",
    "state": "Maharashtra",
    "post_office": "Andheri West HO",
    "role": "patient"
  },
  "access_token": "<jwt>",
  "refresh_token": "<opaque>"
}
```

**Errors:** `409 EMAIL_ALREADY_REGISTERED`, `400 VALIDATION_ERROR`.

### POST /auth/clinic-owner/register

Public. Rate limited 10/min per IP. In addition to creating the `clinic_owner` user, it auto-creates an initial clinic (named after the owner) in the same transaction.

The account is created with `status = 'pending'`. No usable `access_token`/`refresh_token` is issued — a welcome email with a verification link is sent instead, and the account cannot log in until the link is followed (see [`POST /auth/verify-email`](#post-authverify-email)).

**Request body**

```json
{ "name": "Suresh Nair", "email": "owner@example.com", "phone": "+919876543211", "password": "password123" }
```

**Response `201`**

```json
{
  "user": {
    "id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
    "name": "Suresh Nair",
    "email": "owner@example.com",
    "phone": "+919876543211",
    "role": "clinic_owner"
  },
  "access_token": null,
  "refresh_token": null,
  "clinic": {
    "id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
    "name": "Suresh Nair",
    "description": null,
    "owner_id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
    "created_at": "2026-08-09T12:00:00.000Z"
  },
  "message": "Registration successful. Check your email to verify your account before logging in."
}
```

**Errors:** `409 EMAIL_ALREADY_REGISTERED`, `400 VALIDATION_ERROR`.

### POST /auth/patient/login

Public. Rate limited 10/min per IP.

**Request body**

```json
{ "email": "aisha@example.com", "password": "password123" }
```

**Response `200`** — same shape as register (without a status change):

```json
{
  "access_token": "<jwt>",
  "refresh_token": "<opaque>",
  "user": {
    "id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
    "name": "Aisha Verma",
    "email": "aisha@example.com",
    "phone": "+919876543210",
    "role": "patient"
  }
}
```

**Errors:** `401 INVALID_CREDENTIALS`, `403 INVITE_NOT_ACCEPTED` (pending account), `401 ACCOUNT_DISABLED`.

### POST /auth/clinic-owner/login

Same shape as patient login; requires `role = clinic_owner`.

**Errors:** `401 INVALID_CREDENTIALS`, `403 EMAIL_NOT_VERIFIED` (registered but the verification link hasn't been followed yet), `401 ACCOUNT_DISABLED`.

### POST /auth/verify-email

Public. Rate limited 10/min per IP. Single-use, 24h-expiry token; shared by two flows:

1. **Signup verification** — activates a `clinic_owner` account (`status: 'pending'` → `'active'`) using the token from the welcome email sent by `POST /auth/clinic-owner/register`.
2. **Email change** — confirms a pending email change requested via `POST /patients/me/change-email`; on success, updates `users.email` to the new address instead of touching `status`.

The verification link is emailed as `{VERIFY_EMAIL_URL}/verify_email?token={VERIFICATION_TOKEN}` — `VERIFY_EMAIL_URL` defaults to `https://healthcare.jido.co.in`.

**Request body**

```json
{ "token": "<verification_token>" }
```

**Response `200`**

```json
{
  "message": "Your email has been verified. You can now log in."
}
```

For the email-change flow, `message` is `"Your email address has been updated."` instead.

**Errors:** `400 VALIDATION_ERROR`, `400 VERIFICATION_TOKEN_INVALID`, `409 EMAIL_ALREADY_REGISTERED` (new email was claimed by someone else in the meantime), `410 VERIFICATION_TOKEN_EXPIRED`.

### POST /auth/doctor/login

**Request body**

```json
{ "email": "dr.smith@example.com", "password": "password123" }
```

**Response `200`** — returns a `doctor` object instead of `user`:

```json
{
  "access_token": "<jwt>",
  "refresh_token": "<opaque>",
  "doctor": {
    "id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
    "name": "Dr. Smith",
    "specializations": [{ "id": "a1b2c3d4-...", "name": "Cardiology" }],
    "phone": "+919900000001",
    "certificate_url": null,
    "bio": null
  }
}
```

**Errors:** `401 INVALID_CREDENTIALS`, `403 INVITE_NOT_ACCEPTED`, `401 ACCOUNT_DISABLED`.

### POST /auth/doctor/accept-invite

Public, but requires possession of a valid invite code. Rate limited 10/min per IP.
This is the **only** endpoint that activates a doctor account.

On success, an in-app `doctor_invite_accepted` notification is created for whoever sent the invite **and** for the clinic owner (deduped if they're the same person), and the clinic owner is emailed that the doctor has joined.

**Request body**

```json
{
  "email": "dr.smith@example.com",
  "invite_code": "K7QX2Z9P",
  "password": "password123",
  "reg_no": "MC-123456",
  "smc_name": "Medical Council of India",
  "doctor_degree": "MBBS, MD"
}
```

| Field | Type | Notes |
|---|---|---|
| `email` | string | required, must match a pending invite |
| `invite_code` | string | required, 1–32 chars |
| `password` | string | required, 8–128 chars |
| `reg_no` | string? | optional registration number, max 64, unique — ignored if the invite already has one set (from invite creation) |
| `smc_name` | string? | max 255 — ignored if the invite already has one set |
| `doctor_degree` | string? | max 100 — ignored if the invite already has one set |

**Response `200`**

```json
{
  "access_token": "<jwt>",
  "refresh_token": "<opaque>",
  "doctor": {
    "id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
    "name": "Dr. Smith",
    "specializations": [{ "id": "a1b2c3d4-...", "name": "Cardiology" }],
    "reg_no": "MC-123456",
    "smc_name": "Medical Council of India",
    "doctor_degree": "MBBS, MD",
    "phone": "+919900000001",
    "certificate_url": null,
    "bio": null
  }
}
```

**Errors:** `404 INVITE_NOT_FOUND`, `410 INVITE_EXPIRED`, `409 INVITE_ALREADY_ACCEPTED`, `409 EMAIL_ALREADY_REGISTERED`, `409 REG_NO_ALREADY_REGISTERED`.

### POST /auth/branch-staff/login

Requests a passwordless OTP for an existing staff account. Rate limited 10/min per IP.
Rejects any email that is not an active `branch_staff` account with `403 NOT_BRANCH_STAFF` — this reveals whether an email is registered as branch staff (a deliberate trade-off; the OTP-sent response itself does not reveal anything further).

**Request body**

```json
{ "email": "staff@clinic.com" }
```

**Response `200`**

```json
{
  "message": "If an account exists for this email, an OTP has been sent."
}
```

**Errors:** `403 NOT_BRANCH_STAFF` — "Access Denied: This email address is not registered as Branch Staff."

### POST /auth/branch-staff/verify-otp

Verifies the OTP and issues tokens. Rate limited 10/min per IP. Max 5 attempts per OTP.

**Request body**

```json
{ "email": "staff@clinic.com", "otp": "482913" }
```

**Response `200`**

```json
{
  "access_token": "<jwt>",
  "refresh_token": "<opaque>",
  "user": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "name": "Rohit Sharma",
    "email": "staff@clinic.com",
    "role": "branch_staff",
    "branch_id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f"
  }
}
```

**Errors:** `401 INVALID_OTP`, `401 OTP_MAX_ATTEMPTS`, `410 OTP_EXPIRED`, `403 ACCOUNT_DISABLED`.

### POST /auth/forgot-password

Public. Rate limited 10/min per IP. Requests a password reset link for the given email. Always returns the same message (does not reveal whether the email exists). A reset token is only issued when the email belongs to an **active** account with a password (`patient`, `clinic_owner`, or `doctor`); passwordless `branch_staff` accounts are skipped.

The reset link is emailed as `{RESET_PASSWORD_URL}/new_password?token={RESET_TOKEN}` — `RESET_PASSWORD_URL` defaults to `https://medinexa-clinic.onrender.com`. Tokens are single-use and expire after 1 hour.

**Request body**

```json
{ "email": "aisha@example.com" }
```

**Response `200`**

```json
{
  "message": "If an account exists for this email, a password reset link has been sent."
}
```

**Errors:** `400 VALIDATION_ERROR`.

### POST /auth/reset-password

Public. Rate limited 10/min per IP. Sets a new password using a valid, unexpired reset token. The token is invalidated (single-use) once the password is successfully updated.

**Request body**

```json
{ "token": "<reset_token>", "new_password": "newpassword123", "confirm_password": "newpassword123" }
```

| Field | Type | Notes |
|---|---|---|
| `token` | string | required, the token from the reset email link |
| `new_password` | string | required, 8–128 chars |
| `confirm_password` | string | required, must match `new_password` |

**Response `200`**

```json
{
  "message": "Your password has been updated. You can now log in with your new password."
}
```

**Errors:** `400 VALIDATION_ERROR` (including password mismatch), `400 RESET_TOKEN_INVALID`, `410 RESET_TOKEN_EXPIRED`.

### POST /auth/refresh

Rotates the refresh token (both old and new are returned; the old is revoked).

**Request body**

```json
{ "refresh_token": "<opaque>" }
```

**Response `200`**

```json
{
  "access_token": "<new-jwt>",
  "refresh_token": "<new-opaque>"
}
```

**Errors:** `401 REFRESH_TOKEN_INVALID`.

### POST /auth/logout

Auth required. Revokes the given refresh token.

**Request body**

```json
{ "refresh_token": "<opaque>" }
```

**Response `204 No Content`**

---

## Clinics

### GET /clinics

Public. Paginated. If the request is authenticated as a `clinic_owner`, results are silently scoped to clinics owned by that caller (isolation, not an opt-in filter — a clinic owner can never see another owner's clinics through this endpoint). Unauthenticated callers and any other role see the full public directory.

**Query:** `?search=&limit=&cursor=`

**Response `200`**

```json
{
  "items": [
    {
      "id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
      "name": "Sunrise Multispeciality",
      "description": "General & cardiac care",
      "branch_count": 2,
      "created_at": "2026-08-01T09:30:00Z"
    }
  ],
  "next_cursor": null
}
```

### GET /clinics/nearby

Auth: `patient`. Paginated. Matches clinics against the caller's own saved `city`/`district`/`pin_code`/`state`/`post_office` (set at [`POST /auth/patient/register`](#post-authpatientregister) or via profile update) — a clinic is returned if **any** one of those fields matches (OR, not AND). Fields the patient hasn't set are skipped.

**Query:** `?limit=&cursor=`

**Response `200`**

```json
{
  "items": [
    {
      "id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
      "name": "Sunrise Multispeciality",
      "description": "General & cardiac care",
      "nearby_location": null,
      "city": "Mumbai",
      "district": "Mumbai Suburban",
      "pin_code": "400058",
      "state": "Maharashtra",
      "post_office": null,
      "branch_count": 2,
      "created_at": "2026-08-01T09:30:00Z"
    }
  ],
  "next_cursor": null
}
```

**Errors:** `400 ADDRESS_NOT_SET` if the caller has none of `city`/`district`/`pin_code`/`state`/`post_office` set on their profile.

### GET /clinics/mine

Auth: `clinic_owner`. Returns every clinic owned by the caller, each with its full details and nested `branches` (also with full details). Not paginated — a clinic owner is expected to have few clinics.

**Response `200`**

```json
{
  "items": [
    {
      "id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
      "name": "Sunrise Multispeciality",
      "description": "General & cardiac care",
      "nearby_location": null,
      "city": null,
      "district": null,
      "pin_code": null,
      "state": null,
      "post_office": null,
      "owner_id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
      "trade_license_number": "TL-2026-004521",
      "trade_license_url": null,
      "trade_license_validated": true,
      "trade_license_validation_status": "VALID",
      "trade_license_validated_at": "2026-08-01T09:31:00.000Z",
      "drug_license_number": "DL-MH-2026-1187",
      "drug_license_url": null,
      "clinical_establishment_reg_number": "CER-MH-2026-0932",
      "clinical_establishment_reg_url": null,
      "created_at": "2026-08-01T09:30:00Z",
      "updated_at": "2026-08-01T09:30:00Z",
      "branches": [
        {
          "id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
          "clinic_id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
          "name": "Sunrise — Andheri",
          "address": "12, SV Road, Andheri West, Mumbai 400058",
          "nearby_location": null,
          "city": "Mumbai",
          "district": "Mumbai Suburban",
          "pin_code": "400058",
          "state": "Maharashtra",
          "post_office": null,
          "phone": "+912240010010",
          "lat": 19.1195670,
          "lng": 72.8470000,
          "timezone": "Asia/Kolkata",
          "photo_url": null,
          "trade_license_number": "TL-2026-009812",
          "trade_license_url": null,
          "drug_license_number": null,
          "drug_license_url": null,
          "clinical_establishment_reg_number": null,
          "clinical_establishment_reg_url": null,
          "created_at": "2026-08-02T11:00:00Z"
        }
      ]
    }
  ]
}
```

**Errors:** `401 UNAUTHORIZED`, `403 INSUFFICIENT_ROLE` (role other than `clinic_owner`).

### POST /clinics

Auth: `clinic_owner`.

**Request body**

```json
{
  "name": "Sunrise Multispeciality",
  "description": "General & cardiac care",
  "nearby_location": "Near SV Road Bridge",
  "city": "Mumbai",
  "district": "Mumbai Suburban",
  "pin_code": "400058",
  "state": "Maharashtra",
  "post_office": "Andheri West GPO",
  "trade_license_number": "TL-2026-004521",
  "trade_license_validation_status": "VALID",
  "drug_license_number": "DL-MH-2026-1187",
  "clinical_establishment_reg_number": "CER-MH-2026-0932"
}
```

| Field | Type | Notes |
|---|---|---|
| `trade_license_number` | string | **required**, issued by the local municipality, 1–100 |
| `trade_license_validation_status` | string | **required, must be `"VALID"`** — the `status` a prior `POST /clinics/validate-trade-license` call returned for this exact number. A clinic cannot be created at all until that number has been validated; `PENDING`/`INVALID`/omitted all fail the same way. See [Trade license validation](#trade-license-validation). |
| `drug_license_number` | string? | optional — only if selling/stocking medicines, max 100 |
| `clinical_establishment_reg_number` | string? | optional — Clinical Establishment Registration, max 100 |

**Response `201`**

```json
{
  "id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
  "name": "Sunrise Multispeciality",
  "description": "General & cardiac care",
  "nearby_location": null,
  "city": null,
  "district": null,
  "pin_code": null,
  "state": null,
  "post_office": null,
  "owner_id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "trade_license_number": "TL-2026-004521",
  "trade_license_url": null,
  "trade_license_validated": true,
  "trade_license_validation_status": "VALID",
  "trade_license_validated_at": "2026-08-09T10:00:00.000Z",
  "drug_license_number": "DL-MH-2026-1187",
  "drug_license_url": null,
  "clinical_establishment_reg_number": "CER-MH-2026-0932",
  "clinical_establishment_reg_url": null,
  "created_at": "2026-08-09T10:00:00.000Z"
}
```

License document URLs are `null` until uploaded via `POST /clinics/:clinicId/licenses/:type` (see [Clinic & branch licenses](#clinic--branch-licenses)).

**Errors:** `400 VALIDATION_ERROR` (missing `trade_license_number`), `422 TRADE_LICENSE_NOT_VALIDATED` (`trade_license_validation_status` isn't `"VALID"`).

### GET /clinics/:clinicId

Public. If the request is authenticated as a `clinic_owner` who does not own this clinic, responds `404 CLINIC_NOT_FOUND` instead of the clinic's data — this prevents a clinic owner from viewing another owner's clinic by guessing/changing the ID. Unauthenticated callers and any other role see it normally.

**Response `200`**

```json
{
  "id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
  "name": "Sunrise Multispeciality",
  "description": "General & cardiac care",
  "nearby_location": null,
  "city": null,
  "district": null,
  "pin_code": null,
  "state": null,
  "post_office": null,
  "owner_id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "trade_license_number": "TL-2026-004521",
  "trade_license_url": "https://res.cloudinary.com/p274ocjz/image/upload/v1754700900/clinics/licenses/3f9d6b5e-....pdf",
  "trade_license_validated": true,
  "trade_license_validation_status": "VALID",
  "trade_license_validated_at": "2026-08-01T09:31:00.000Z",
  "drug_license_number": "DL-MH-2026-1187",
  "drug_license_url": null,
  "clinical_establishment_reg_number": "CER-MH-2026-0932",
  "clinical_establishment_reg_url": null,
  "branch_count": 2,
  "created_at": "2026-08-01T09:30:00Z",
  "updated_at": "2026-08-01T09:30:00Z"
}
```

**Errors:** `404 CLINIC_NOT_FOUND`.

### PATCH /clinics/:clinicId

Auth: `clinic_owner`, must own the clinic.

**Request body** (partial) — any subset of `name, description, nearby_location, city, district, pin_code, state, post_office, trade_license_number, trade_license_validation_status, drug_license_number, clinical_establishment_reg_number`. `trade_license_number` cannot be cleared to `null`; `drug_license_number` and `clinical_establishment_reg_number` can.

```json
{ "name": "Sunrise Heart & Care", "description": null, "nearby_location": "Opposite City Mall", "city": "Mumbai", "district": "Mumbai Suburban", "pin_code": "400058", "state": "Maharashtra", "post_office": "Andheri West GPO", "drug_license_number": null }
```

`trade_license_validation_status` follows the same "only right after validating this exact number" rule as `POST /clinics` — see [Trade license validation](#trade-license-validation). If `trade_license_number` is being changed to a new value and this request does **not** also include `trade_license_validation_status`, the server resets `trade_license_validated`/`trade_license_validation_status`/`trade_license_validated_at` to `false`/`PENDING`/`null` regardless of their previous value — a number change always invalidates a prior validation unless the client re-validated the new number in the same request.

**Response `200`**

```json
{
  "id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
  "name": "Sunrise Heart & Care",
  "description": null,
  "nearby_location": "Opposite City Mall",
  "city": "Mumbai",
  "district": "Mumbai Suburban",
  "pin_code": "400058",
  "state": "Maharashtra",
  "post_office": "Andheri West GPO",
  "owner_id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "trade_license_number": "TL-2026-004521",
  "trade_license_url": "https://res.cloudinary.com/p274ocjz/image/upload/v1754700900/clinics/licenses/3f9d6b5e-....pdf",
  "trade_license_validated": true,
  "trade_license_validation_status": "VALID",
  "trade_license_validated_at": "2026-08-01T09:31:00.000Z",
  "drug_license_number": null,
  "drug_license_url": null,
  "clinical_establishment_reg_number": "CER-MH-2026-0932",
  "clinical_establishment_reg_url": null,
  "created_at": "2026-08-01T09:30:00Z"
}
```

**Errors:** `404 CLINIC_NOT_FOUND`, `403 NOT_CLINIC_OWNER`.

### Trade license validation

A clinic's `trade_license_number` is checked against the West Bengal PRDEODB acknowledgement service via `POST /clinics/validate-trade-license`, called from both the create-clinic and edit-clinic forms. That endpoint is a stateless proxy — it never touches a clinic row — so the client is responsible for persisting the outcome by passing `trade_license_validation_status` back in the following `POST /clinics` (create) or `PATCH /clinics/:clinicId` (edit) call. Entering a number is never itself validation: **`POST /clinics` hard-requires `trade_license_validation_status: "VALID"` and rejects the request with `422 TRADE_LICENSE_NOT_VALIDATED` otherwise** — a clinic simply cannot exist without a validated trade license. `PATCH /clinics/:clinicId` is less strict (existing clinics can still be edited while `PENDING`/`INVALID`), but changing an already-validated number resets it to `PENDING` server-side, see below.

### POST /clinics/validate-trade-license

Auth: `clinic_owner` or `sys_admin`. Rate limited 10/min. Proxies a lookup against the West Bengal PRDEODB acknowledgement service server-side, so the browser never talks to (or holds a session/cookie for) that third-party site directly. Stateless — doesn't touch any clinic row, since it's also used from the create-clinic form before a clinic exists yet; the caller persists the result by echoing `status` back in the next `POST /clinics` or `PATCH /clinics/:clinicId` call (see the note on those endpoints above).

**Body:** `{ "trade_license_number": "SSNOCJRKJ30370340N" }`

**Response `200`** (always `200` — a rejected/not-found license and a network failure both come back as a normal response, not an HTTP error, so the client doesn't need special-case error handling for the "expected to sometimes fail" cases)

Validated:
```json
{
  "success": true,
  "validated": true,
  "status": "VALID",
  "trade_license_number": "SSNOCJRKJ30370340N",
  "message": "Trade License Number validated successfully."
}
```

Rejected by PRDEODB:
```json
{
  "success": true,
  "validated": false,
  "status": "INVALID",
  "trade_license_number": "SSNOCJRKJ30370340N",
  "message": "Trade License Number could not be validated."
}
```

PRDEODB unreachable or returned something unparseable:
```json
{
  "success": false,
  "validated": false,
  "status": "PENDING",
  "message": "Unable to validate Trade License Number at this time. Please try again."
}
```

**Errors:** `400 VALIDATION_ERROR` (missing `trade_license_number`), `401 UNAUTHORIZED`, `403 INSUFFICIENT_ROLE`, `429 RATE_LIMITED`.

### DELETE /clinics/:clinicId

Auth: `clinic_owner`, must own the clinic. Soft-delete.

**Query:** `?force=true` — cancels all active (`pending`/`confirmed`/`paid`) appointments before deleting.

**Response `204 No Content`**

**Errors:** `409 CLINIC_HAS_ACTIVE_APPOINTMENTS` (when active appointments exist and `force` is not true).

---

## Branches

### GET /clinics/:clinicId/branches

Public. Same clinic-owner isolation as `GET /clinics/:clinicId`: a `clinic_owner` who does not own the parent clinic gets `404 CLINIC_NOT_FOUND`, not the branch list.

**Response `200`**

```json
{
  "items": [
    {
      "id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
      "clinic_id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
      "name": "Sunrise — Andheri",
      "address": "12, SV Road, Andheri West, Mumbai 400058",
      "nearby_location": null,
      "city": "Mumbai",
      "district": "Mumbai Suburban",
      "pin_code": "400058",
      "state": "Maharashtra",
      "post_office": null,
      "phone": "+912240010010",
      "lat": 19.1195670,
      "lng": 72.8470000,
      "timezone": "Asia/Kolkata",
      "photo_url": null,
      "trade_license_number": "TL-2026-009812",
      "trade_license_url": null,
      "drug_license_number": null,
      "drug_license_url": null,
      "clinical_establishment_reg_number": null,
      "clinical_establishment_reg_url": null,
      "created_at": "2026-08-02T11:00:00Z",
      "rating": { "average": 4.5, "count": 12 }
    }
  ]
}
```

`rating` aggregates every review (see [Reviews & ratings](#reviews--ratings)) whose `branch_id` points at this branch — `average` is rounded to one decimal and `null` with `count: 0` when the branch has no reviews yet.

**Errors:** `404 CLINIC_NOT_FOUND`.

### GET /branches/nearby

Auth: `patient`. Paginated. Same OR-match as [`GET /clinics/nearby`](#get-clinicsnearby), but against branches across all clinics — matches if any one of the caller's saved `city`/`district`/`pin_code`/`state`/`post_office` equals the branch's corresponding field.

**Query:** `?limit=&cursor=`

**Response `200`**

```json
{
  "items": [
    {
      "id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
      "clinic_id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
      "name": "Sunrise — Andheri",
      "address": "12, SV Road, Andheri West, Mumbai 400058",
      "nearby_location": null,
      "city": "Mumbai",
      "district": "Mumbai Suburban",
      "pin_code": "400058",
      "state": "Maharashtra",
      "post_office": null,
      "phone": "+912240010010",
      "lat": 19.1195670,
      "lng": 72.8470000,
      "timezone": "Asia/Kolkata",
      "photo_url": null,
      "trade_license_number": "TL-2026-009812",
      "trade_license_url": null,
      "drug_license_number": null,
      "drug_license_url": null,
      "clinical_establishment_reg_number": null,
      "clinical_establishment_reg_url": null,
      "created_at": "2026-08-02T11:00:00Z"
    }
  ],
  "next_cursor": null
}
```

**Errors:** `400 ADDRESS_NOT_SET` if the caller has none of `city`/`district`/`pin_code`/`state`/`post_office` set on their profile.

### POST /clinics/:clinicId/branches

Auth: `clinic_owner`, must own the clinic.

**Request body**

```json
{
  "name": "Sunrise — Andheri",
  "address": "12, SV Road, Andheri West, Mumbai 400058",
  "nearby_location": "Near SV Road Bridge",
  "city": "Mumbai",
  "district": "Mumbai Suburban",
  "pin_code": "400058",
  "state": "Maharashtra",
  "phone": "+912240010010",
  "lat": 19.119567,
  "lng": 72.847,
  "timezone": "Asia/Kolkata",
  "trade_license_number": "TL-2026-009812",
  "drug_license_number": null,
  "clinical_establishment_reg_number": null
}
```

| Field | Type | Notes |
|---|---|---|
| `name` | string | required, 1–255 |
| `address` | string | required, 1–500 |
| `nearby_location` | string? | optional, helpful landmark or nearby place, max 500 |
| `city` | string? | optional, max 255 |
| `district` | string? | optional, max 255 |
| `pin_code` | string? | optional, postal code, max 20 |
| `state` | string? | optional, max 255 |
| `post_office` | string? | optional, post office name, max 255 |
| `phone` | string | required, 1–32 |
| `lat` | number? | -90…90 |
| `lng` | number? | -180…180 |
| `timezone` | string | required, valid IANA timezone |
| `trade_license_number` | string | **required**, issued by the local municipality, 1–100 |
| `drug_license_number` | string? | optional — only if selling/stocking medicines, max 100 |
| `clinical_establishment_reg_number` | string? | optional — Clinical Establishment Registration, max 100 |

**Response `201`** — full Branch object (same shape as the list item above), with license URLs `null` until uploaded via `POST /branches/:id/licenses/:type` (see [Clinic & branch licenses](#clinic--branch-licenses)).

**Errors:** `404 CLINIC_NOT_FOUND`, `403 NOT_CLINIC_OWNER`, `400 VALIDATION_ERROR` (invalid timezone or missing `trade_license_number`).

### PATCH /branches/:id

Auth: `clinic_owner`, must own the parent clinic.

**Request body** (partial) — any subset of `name, address, nearby_location, city, district, pin_code, state, phone, lat, lng, timezone, trade_license_number, drug_license_number, clinical_establishment_reg_number`. `trade_license_number` cannot be cleared to `null`; `drug_license_number` and `clinical_establishment_reg_number` can.

```json
{ "phone": "+912240010011" }
```

**Response `200`** — full Branch object.

**Errors:** `404 BRANCH_NOT_FOUND`, `403 NOT_CLINIC_OWNER`.

### DELETE /branches/:id

Auth: `clinic_owner`. Soft-delete. `?force=true` cancels active appointments first.

**Response `204 No Content`**

**Errors:** `409 CLINIC_HAS_ACTIVE_APPOINTMENTS`.

### POST /branches/:id/photo/signature

Auth: `clinic_owner`, must own the branch. Returns a Cloudinary upload grant for the branch photo.

**Response `200`**

```json
{
  "upload_url": "https://api.cloudinary.com/v1_1/p274ocjz/image/upload",
  "cloud_name": "p274ocjz",
  "api_key": "181659462436854",
  "timestamp": 1754700000,
  "public_id": "branches/3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "allowed_formats": ["jpg", "png", "webp", "gif"],
  "signature": "9d3c1f0a..."
}
```

The `public_id` is server-generated and bound to the signature. Upload the file directly to `upload_url` as `multipart/form-data` with fields `file`, `public_id`, `timestamp`, `api_key`, `cloud_name`, `allowed_formats`, `signature`, then call `POST /branches/:id/photo` to persist.

**Errors:** `404 BRANCH_NOT_FOUND`, `403 NOT_CLINIC_OWNER`.

### POST /branches/:id/photo

Auth: `clinic_owner`, must own the branch. Persists the branch photo after a direct Cloudinary upload.

**Request body**

```json
{ "public_id": "branches/3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d" }
```

| Field | Type | Notes |
|---|---|---|
| `public_id` | string | required, must be one issued by `POST /branches/:id/photo/signature` |

**Response `200`**

```json
{
  "photo_url": "https://res.cloudinary.com/p274ocjz/image/upload/branches/3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d"
}
```

**Errors:** `404 BRANCH_NOT_FOUND`, `403 NOT_CLINIC_OWNER`, `400 INVALID_PUBLIC_ID`, `400 VALIDATION_ERROR`.

### POST /branches/:id/gallery/signature

Auth: `clinic_owner`, must own the branch. Returns a Cloudinary upload grant for a **gallery** image. Same two-step flow as the branch photo; the `public_id` is under the `branches/gallery/` folder.

**Response `200`** — same shape as `POST /branches/:id/photo/signature`, with `public_id: "branches/gallery/<uuid>"`.

**Errors:** `404 BRANCH_NOT_FOUND`, `403 NOT_CLINIC_OWNER`.

### POST /branches/:id/gallery

Auth: `clinic_owner`, must own the branch. Persists one gallery image after a direct Cloudinary upload. Repeat per image to build the gallery.

**Request body**

```json
{ "public_id": "branches/gallery/3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d" }
```

**Response `201`**

```json
{
  "id": "7c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "image_url": "https://res.cloudinary.com/p274ocjz/image/upload/branches/gallery/3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "position": 0,
  "created_at": "2026-08-09T12:00:00.000Z"
}
```

Images are ordered by `position` (assigned sequentially on upload).

**Errors:** `404 BRANCH_NOT_FOUND`, `403 NOT_CLINIC_OWNER`, `400 INVALID_PUBLIC_ID`, `400 VALIDATION_ERROR`.

### GET /branches/:id/gallery

Public.

**Response `200`**

```json
{
  "items": [
    {
      "id": "7c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
      "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
      "image_url": "https://res.cloudinary.com/p274ocjz/image/upload/branches/gallery/3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
      "position": 0,
      "created_at": "2026-08-09T12:00:00Z"
    }
  ]
}
```

**Errors:** `404 BRANCH_NOT_FOUND`.

### DELETE /branches/:id/gallery/:imageId

Auth: `clinic_owner`, must own the branch. Removes an image from the gallery.

**Response `204 No Content`**

**Errors:** `404 BRANCH_NOT_FOUND`, `403 NOT_CLINIC_OWNER`, `404 IMAGE_NOT_FOUND`.

---

## Branch schedule

A **branch-level operating calendar** sits above every doctor's own scheduling (`doctor_slot_templates` + leaves) in the availability rule: a doctor can never be bookable on a weekday the branch itself is marked closed, or a date covered by an active branch-wide closure — regardless of what the doctor's own template/leaves say. This is computed live by every availability endpoint and by `POST /appointments`, never cached or stored per-doctor.

`operating_days` covers all 7 weekdays (0=Sun..6=Sat) — a weekday with no explicit override defaults to **open**, so an existing branch with zero rows in `branch_operating_days` behaves exactly as before this feature shipped, until a clinic owner customizes it.

### GET /branches/:id/schedule

Auth: `clinic_owner` (owns branch) **or** `branch_staff` (assigned to branch, any permission) **or** `doctor` (assigned to branch). Returns the full 7-day week regardless of how many days have been customized.

**Response `200`**

```json
{
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "operating_days": [
    { "weekday": 0, "is_open": true },
    { "weekday": 1, "is_open": true },
    { "weekday": 2, "is_open": true },
    { "weekday": 3, "is_open": false },
    { "weekday": 4, "is_open": true },
    { "weekday": 5, "is_open": true },
    { "weekday": 6, "is_open": false }
  ]
}
```

**Errors:** `404 BRANCH_NOT_FOUND`, `403 PERMISSION_DENIED` (doctor not assigned to this branch).

### PATCH /branches/:id/schedule

Auth: `clinic_owner` **or** `branch_staff` with `branch:settings`. Upserts the given weekdays only — any weekday not included keeps its current value (or the open default). Not a full-replace like `slot_template`.

**Request body**

```json
{ "operating_days": [{ "weekday": 3, "is_open": false }, { "weekday": 6, "is_open": false }] }
```

**Response `200`** — full 7-day week, same shape as `GET`.

**Errors:** `404 BRANCH_NOT_FOUND`, `403 PERMISSION_DENIED`, `400 VALIDATION_ERROR`.

### GET /branches/:id/schedule/closures

Auth: same read access as `GET /branches/:id/schedule`. Lists branch-wide closures (holidays, maintenance, etc). Both active and cancelled closures are returned, kept as an audit record.

**Response `200`**

```json
{
  "items": [
    {
      "id": "c3d4e5f6-...",
      "start_date": "2026-10-02",
      "end_date": "2026-10-02",
      "reason": "Public holiday",
      "status": "active",
      "created_at": "2026-08-13T10:00:00.000Z"
    }
  ]
}
```

### POST /branches/:id/schedule/closures

Auth: `clinic_owner` **or** `branch_staff` with `branch:settings`. Marks a date range unavailable for **every** doctor at this branch in one call.

Any pre-existing non-terminal appointment that falls inside the new closure's date range is cancelled as a side effect: doctor appointments in `pending`/`confirmed` (a `paid` appointment is left untouched — cancelling it has refund implications out of scope here, so staff must handle those manually) and lab test appointments in `PENDING`/`APPROVED`. Each affected patient gets an in-app `appointment_cancelled`/`lab_test_cancelled` notification **and** an email — a booking they made suddenly becoming invalid is a surprise, not a routine cancel, so it's always emailed regardless of the notification-type table in [Notifications](#notifications).

**Request body**

```json
{ "start_date": "2026-10-02", "end_date": "2026-10-02", "reason": "Public holiday" }
```

| Field | Type | Notes |
|---|---|---|
| `start_date` | string | required, `YYYY-MM-DD` (inclusive) |
| `end_date` | string? | `YYYY-MM-DD`, nullable — defaults to `start_date` for a single day |
| `reason` | string? | max 255 |

**Response `201`**

```json
{ "id": "c3d4e5f6-...", "branch_id": "5e8f6c7a-...", "start_date": "2026-10-02", "end_date": "2026-10-02", "reason": "Public holiday", "status": "active" }
```

**Errors:** `404 BRANCH_NOT_FOUND`, `403 PERMISSION_DENIED`, `400 VALIDATION_ERROR` (`end_date` before `start_date`).

### DELETE /branches/:id/schedule/closures/:closureId

Auth: same as `POST`. **Cancels** the closure (`status` → `cancelled`) rather than deleting it, restoring availability across its date range immediately — same soft-cancel pattern as doctor leaves.

**Response `204 No Content`**

**Errors:** `404 BRANCH_NOT_FOUND`, `403 PERMISSION_DENIED`, `404 CLOSURE_NOT_FOUND`.

---

## Clinic & branch licenses

Both clinics and branches carry three license fields — a **Trade License** from the local municipality (required), a **Drug License** (optional, only needed if the clinic/branch sells or stocks medicines), and a **Clinical Establishment Registration** (optional, for healthcare operations). The `*_number` fields are set via `POST /clinics`, `POST /clinics/:clinicId/branches`, `PATCH /clinics/:clinicId`, or `PATCH /branches/:id`. The corresponding document is uploaded separately with the endpoints below, which persist a `*_url` field on the clinic/branch.

| `:type` value | Sets | Required |
|---|---|---|
| `trade-license` | `trade_license_number` / `trade_license_url` | Yes |
| `drug-license` | `drug_license_number` / `drug_license_url` | No |
| `clinical-establishment-registration` | `clinical_establishment_reg_number` / `clinical_establishment_reg_url` | No |

### POST /clinics/:clinicId/licenses/:type

Auth: `clinic_owner`, must own the clinic. `multipart/form-data`, single field named `file`. The server uploads the file to Cloudinary (`resource_type=auto`) and stores the resulting permanent `secure_url` — see [File uploads](#file-uploads). Allowed types: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`, up to 10MB.

**Response `200`**

```json
{
  "type": "trade-license",
  "url": "https://res.cloudinary.com/p274ocjz/image/upload/v1754700900/clinics/licenses/3f9d6b5e-....pdf"
}
```

**Errors:** `404 CLINIC_NOT_FOUND`, `403 NOT_CLINIC_OWNER`, `400 INVALID_LICENSE_TYPE`, `400 FILE_REQUIRED` / `FILE_EMPTY`, `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`.

### POST /branches/:id/licenses/:type

Auth: `clinic_owner`, must own the parent clinic. Same request/response shape, `:type` values, and Cloudinary storage as the clinic endpoint above, but persists onto the branch.

**Response `200`**

```json
{
  "type": "drug-license",
  "url": "https://res.cloudinary.com/p274ocjz/image/upload/v1754700900/branches/licenses/3f9d6b5e-....pdf"
}
```

**Errors:** `404 BRANCH_NOT_FOUND`, `403 NOT_CLINIC_OWNER`, `400 INVALID_LICENSE_TYPE`, `400 FILE_REQUIRED` / `FILE_EMPTY`, `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`.

---

## Branch staff

Branch staff have **fine-grained permissions** scoped to their branch. Permissions are stored per staff membership (a JSON array on the `branch_staff` row) and enforced server-side on the actions they gate.

Permission keys:

| Key | Gates |
|---|---|
| `appointments:confirm` | `PATCH /appointments/:id/confirm` |
| `appointments:payment` | `PATCH /appointments/:id/payment` |
| `appointments:complete` | `PATCH /appointments/:id/complete` |
| `appointments:cancel` | `PATCH /appointments/:id/cancel` |
| `staff:manage` | Add/remove staff + read/update permissions |
| `doctors:manage` | Invite/revoke doctors, update/remove assignments, doctor photos |
| `patients:view` | `GET /branches/:id/patients` |
| `reviews:view` | `GET /branches/:id/reviews` |
| `branch:settings` | `PATCH /branches/:id/schedule`, `POST`/`DELETE` on `/branches/:id/schedule/closures` |

New staff default to `["appointments:confirm", "appointments:payment", "appointments:complete", "appointments:cancel"]`. The `clinic_owner` is always allowed and is unaffected. A `branch_staff` calling a gated action without the required permission gets `403 PERMISSION_DENIED`.

### GET /branch-staff/me

Auth: `branch_staff`. Returns the clinic and branch the logged-in staff member is assigned to, plus their own permissions. Use this to drive the "my branch" view instead of trusting any client-supplied `clinic_id`/`branch_id`.

**Response `200`**

```json
{
  "clinic": {
    "id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
    "name": "Sunrise Health Clinic"
  },
  "branch": {
    "id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
    "name": "Sunrise Health Clinic - Andheri",
    "address": "123 Link Road, Andheri West",
    "phone": "+919812345678",
    "timezone": "Asia/Kolkata"
  },
  "permissions": ["appointments:confirm", "appointments:payment", "appointments:complete", "appointments:cancel"]
}
```

**Errors:** `404 BRANCH_NOT_FOUND` if the account has no active branch assignment.

### GET /branches/:id/staff

Auth: `clinic_owner` (owns branch) or `branch_staff` (own branch only).

**Response `200`**

```json
{
  "items": [
    {
      "id": "1a2b3c4d-5e6f-7890-abcd-ef1234567890",
      "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
      "name": "Rohit Sharma",
      "email": "staff@clinic.com",
      "added_by": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
      "permissions": ["appointments:confirm", "appointments:payment", "appointments:complete", "appointments:cancel"],
      "created_at": "2026-08-03T10:00:00Z"
    }
  ]
}
```

**Errors:** `404 BRANCH_NOT_FOUND`.

### POST /branches/:id/staff

Auth: `clinic_owner` **or** `branch_staff` with `staff:manage`. Creates the staff user and sends a login instruction email.

**Request body**

```json
{ "name": "Rohit Sharma", "email": "staff@clinic.com" }
```

| Field | Type | Notes |
|---|---|---|
| `name` | string | required |
| `email` | string | required |
| `permissions` | string[]? | optional, any subset of the keys above; defaults to the four appointment permissions |

**Response `201`**

```json
{
  "id": "1a2b3c4d-5e6f-7890-abcd-ef1234567890",
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "name": "Rohit Sharma",
  "email": "staff@clinic.com",
  "added_by": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "permissions": ["appointments:confirm", "appointments:payment", "appointments:complete", "appointments:cancel"],
  "created_at": "2026-08-09T10:00:00.000Z"
}
```

**Errors:** `409 STAFF_ALREADY_EXISTS_FOR_BRANCH`.

### GET /branches/:id/staff/:staffId/permissions

Auth: `clinic_owner` (owns branch) or the `branch_staff` viewing their own row.

**Response `200`**

```json
{
  "staff_id": "1a2b3c4d-5e6f-7890-abcd-ef1234567890",
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "permissions": ["appointments:confirm", "appointments:payment", "appointments:complete", "appointments:cancel"]
}
```

**Errors:** `404 STAFF_NOT_FOUND`, `403 PERMISSION_DENIED`.

### PATCH /branches/:id/staff/:staffId/permissions

Auth: `clinic_owner` **or** `branch_staff` with `staff:manage`. Full replace — send the complete desired set.

**Request body**

```json
{ "permissions": ["appointments:confirm", "staff:manage", "doctors:manage"] }
```

**Response `200`** — same shape as GET, with the updated `permissions`.

**Errors:** `404 STAFF_NOT_FOUND`, `400 VALIDATION_ERROR` (unknown key).

### DELETE /branches/:id/staff/:staffId

Auth: `clinic_owner` **or** `branch_staff` with `staff:manage`. Hard-deletes the staff membership row.

**Response `204 No Content`**

---

## Doctors, invites & assignments

### POST /branches/:id/doctor-invites

Auth: `clinic_owner` (must own the branch) **or** `branch_staff` with `doctors:manage`. Emails a single-use invite code (the code is **never** returned in the response).

**Request body**

```json
{
  "name": "Dr. Smith",
  "specialization_ids": ["a1b2c3d4-..."],
  "email": "dr.smith@example.com",
  "phone": "+919900000001",
  "reg_no": "MC-123456",
  "smc_name": "Medical Council of India",
  "doctor_degree": "MBBS, MD",
  "fee_amount": 500,
  "currency": "INR",
  "certificate": "https://example.com/cert.pdf",
  "slot_type": "fixed",
  "slot_template": [
    {
      "weekday": 1,
      "start_time": "09:00",
      "end_time": "13:00",
      "slot_duration_minutes": 20,
      "start_date": "2026-08-17",
      "end_date": "2026-12-31"
    },
    {
      "weekday": 3,
      "start_time": "16:00",
      "end_time": "20:00",
      "slot_duration_minutes": 20,
      "start_date": "2026-08-17",
      "end_date": null
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `name` | string | required |
| `specialization_ids` | string[] | required, 1–10 `doctor_specializations.id` values (see `GET /doctors/specializations`; use `POST /doctors/specializations` first if the one you need doesn't exist yet) |
| `email` | string | required |
| `phone` | string? | max 32 |
| `reg_no` | string? | max 64, optional — pre-fill the doctor's registration number; if omitted, the doctor supplies it on accept |
| `smc_name` | string? | max 255, optional — State Medical Council name |
| `doctor_degree` | string? | max 100, optional — e.g. `MBBS, MD` |
| `fee_amount` | number | required, > 0, ≤ 1,000,000 |
| `currency` | string | required, 3-letter code |
| `certificate` | string? | max 500 |
| `slot_type` | string? | `fixed` \| `sequential`, defaults to `fixed` — see [Slot types](#slot-types) |
| `slot_template` | array | required, ≥ 1 entry |
| `slot_template[].weekday` | number | 0 (Sun) – 6 (Sat); the pattern repeats every week within the date range below |
| `slot_template[].start_time` | string | `HH:MM` |
| `slot_template[].end_time` | string | `HH:MM`, must be after start |
| `slot_template[].slot_duration_minutes` | number | 5–240 |
| `slot_template[].start_date` | string | `YYYY-MM-DD`, required — first date the weekly pattern applies |
| `slot_template[].end_date` | string? | `YYYY-MM-DD`, nullable — last date the pattern applies; `null`/omitted means it repeats indefinitely |

#### Slot types

A doctor's booking behavior for a branch is controlled by `slot_type` on the assignment (`doctor_branch_assignments.slot_type`), set at invite time and editable via `PATCH /doctor-assignments/:id`:

- **`fixed`** (default) — the patient picks one specific `HH:MM` slot from `GET /doctors/:id/availability`, and `POST /appointments` requires a `time` that aligns to the doctor's slot template.
- **`sequential`** ("as per bookings") — the doctor only defines a time range and slot duration (e.g. 7 PM–9 PM, 15 min slots); patients do **not** choose a time. `POST /appointments` omits `time`, and the server assigns the next free slot in order: 1st booking gets 7:00–7:15, 2nd gets 7:15–7:30, 3rd gets 7:30–7:45, and so on. If the range is full for that date, `POST /appointments` returns `409 DOCTOR_FULLY_BOOKED`.

**Response `201`**

```json
{
  "id": "7c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "email": "dr.smith@example.com",
  "reg_no": "MC-123456",
  "smc_name": "Medical Council of India",
  "doctor_degree": "MBBS, MD",
  "specializations": [{ "id": "a1b2c3d4-...", "name": "Cardiology" }],
  "status": "pending",
  "expires_at": "2026-08-16T10:00:00Z"
}
```

**Errors:** `409 INVITE_ALREADY_PENDING`, `409 DOCTOR_ALREADY_ASSIGNED`, `422 SPECIALIZATION_NOT_FOUND`.

### GET /branches/:id/doctor-invites

Auth: `clinic_owner` **or** `branch_staff` with `doctors:manage`.

**Response `200`**

```json
{
  "items": [
    {
      "id": "7c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
      "name": "Dr. Smith",
      "email": "dr.smith@example.com",
      "reg_no": "MC-123456",
      "specializations": [{ "id": "a1b2c3d4-...", "name": "Cardiology" }],
      "smc_name": "Medical Council of India",
      "doctor_degree": "MBBS, MD",
      "status": "pending",
      "expires_at": "2026-08-16T10:00:00Z",
      "created_at": "2026-08-09T10:00:00Z"
    }
  ]
}
```

`status` ∈ `pending | accepted | expired | revoked`. `reg_no` is `null` until the doctor accepts the invite.

### DELETE /doctor-invites/:id

Auth: `clinic_owner` **or** `branch_staff` with `doctors:manage`. Revokes a pending invite.

**Response `204 No Content`**

**Errors:** `404 INVITE_NOT_FOUND`, `409 INVITE_ALREADY_ACCEPTED`.

### GET /branches/:id/doctors

Public. Returns only **accepted** doctors assigned to the branch.

**Response `200`**

```json
{
  "total": 1,
  "items": [
    {
      "id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
      "assignment_id": "e4f5a6b7-8c9d-0e1f-2a3b-4c5d6e7f8a9b",
      "name": "Dr. Smith",
      "specialization": "Cardiology",
      "specializations": [{ "id": "a1b2c3d4-...", "name": "Cardiology" }],
      "smc_name": "Medical Council of India",
      "doctor_degree": "MBBS, MD",
      "phone": "+919900000001",
      "certificate_url": null,
      "photo_url": null,
      "fee_amount": 500,
      "currency": "INR",
      "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
      "slot_type": "fixed",
      "start_date": "2026-01-15",
      "end_date": null,
      "next_available_slot": "2026-08-10T09:20:00",
      "unavailable_dates": [
        { "start_date": "2026-08-20", "end_date": "2026-08-20", "reason": "Holiday" },
        { "start_date": "2026-09-01", "end_date": "2026-09-07", "reason": "Annual leave" }
      ],
      "rating": { "average": 4.5, "count": 12 }
    }
  ]
}
```

`total` is the count of doctors in `items` (this endpoint is not paginated). `id` is the doctor's own id. `assignment_id` is the id of this doctor's assignment to the branch — use it for `PATCH /doctor-assignments/:id` and `DELETE /doctor-assignments/:id`, not `id`. `start_date`/`end_date` are derived from the assignment's `slot_template` rows (`doctor_slot_templates`, set via `POST /branches/:id/doctor-invites` or `PATCH /doctor-assignments/:id`): `start_date` is the earliest `slot_template[].start_date` across all of the assignment's weekly entries, and `end_date` is the latest `slot_template[].end_date` — but `null` if **any** entry has no `end_date` (i.e. repeats indefinitely), since that makes the assignment's overall end open-ended. Both are `null` if the assignment has no slot template rows. `unavailable_dates` lists the assignment's upcoming active leaves (`doctor_slot_exceptions`, see `GET /doctor-assignments/:id/exceptions`) as `{ start_date, end_date, reason }` — a leave is a genuine inclusive date range now (`start_date` and `end_date` can differ), not always a single day. `next_available_slot` is a localized `YYYY-MM-DDTHH:MM:00` string or `null`. `slot_type` ∈ `fixed | sequential` — see [Slot types](#slot-types); when `sequential`, the client should offer a "book next available" action instead of a time picker. `specialization` is a comma-joined display string derived from `specializations` (kept for backward compatibility); `specializations` is the doctor's full, possibly-multiple set of master-list specializations (see `GET /doctors/specializations`). `rating` is this doctor's aggregate across **all** their reviews platform-wide (not scoped to this branch — see [Reviews & ratings](#reviews--ratings)); `average` is rounded to one decimal and `null` with `count: 0` when the doctor has no reviews yet.

### GET /doctors

Public. Cursor-paginated. Browses doctors across all clinics/branches with no
prerequisite search term or known branch — unlike `GET /doctors/search` (auth-required,
`q` required) or `GET /branches/:id/doctors` (requires a branch id). Drives a
patient-facing "browse all doctors" view (e.g. a home screen's "Top doctors" section).

**Query:** `?specialization_id=&city=&q=&limit=&cursor=` — `specialization_id` (a
`doctor_specializations.id`, see `GET /doctors/specializations` for the canonical list)
and `city` are exact matches (`city` typically comes from the patient's own saved
profile); `q` is an optional `name` substring match. All filters are optional and
combine with AND.

**Response `200`**

```json
{
  "items": [
    {
      "id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
      "assignment_id": "e4f5a6b7-8c9d-0e1f-2a3b-4c5d6e7f8a9b",
      "name": "Dr. Smith",
      "specialization": "Cardiology",
      "specializations": [{ "id": "a1b2c3d4-...", "name": "Cardiology" }],
      "smc_name": "Medical Council of India",
      "doctor_degree": "MBBS, MD",
      "phone": "+919900000001",
      "photo_url": null,
      "fee_amount": 500,
      "currency": "INR",
      "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
      "branch_name": "Sunrise — Andheri",
      "clinic_id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
      "clinic_name": "Sunrise Multispeciality",
      "city": "Mumbai",
      "slot_type": "fixed",
      "start_date": "2026-01-15",
      "end_date": null,
      "next_available_slot": "2026-08-10T09:20:00",
      "rating": { "average": 4.5, "count": 12 }
    }
  ],
  "next_cursor": null
}
```

One item per active doctor↔branch assignment (a doctor at two branches appears twice,
each with its own `assignment_id`/fee/availability) — same field semantics as
`GET /branches/:id/doctors`'s items. `limit` is capped at 50 regardless of the
`?limit=` value, since `next_available_slot` costs one extra query per row.
`specialization` is a comma-joined display string derived from `specializations`
(kept for backward compatibility); `specializations` is the doctor's full,
possibly-multiple set of master-list specializations. `rating` is the same
platform-wide aggregate described under `GET /branches/:id/doctors`.

### GET /doctors/specializations

Public. Not paginated. The platform-level master list of doctor specializations
(`doctor_specializations` table), most-assigned first — drives category/filter chips
on a browse screen and the searchable specialization picker on a clinic's doctor-invite
form. Only `status = 'active'` specializations are returned. Optional `?q=` does a
substring match on `name`, for the invite form's search-as-you-type box.

**Response `200`**

```json
{
  "items": [
    { "id": "a1b2c3d4-...", "name": "Cardiology", "slug": "cardiology", "description": null, "doctor_count": 12 },
    { "id": "b2c3d4e5-...", "name": "General Physician", "slug": "general-physician", "description": null, "doctor_count": 8 }
  ]
}
```

### POST /doctors/specializations

Auth: `clinic_owner`, `branch_staff`, or `sys_admin`. Lets a clinic add a specialization
directly from the doctor-invite form when the one they need isn't in the master list
yet. Dedup is case-insensitive via a slug derived from `name` (lowercased, non-alphanumerics
collapsed to `-`): if a specialization with the same slug already exists — created by this
clinic or any other — that existing row is returned (`200`) instead of creating a
duplicate; otherwise a new row is created (`201`).

**Body:** `{ "name": "Interventional Cardiology", "description": "optional, max 500 chars" }`

**Response `200`/`201`**

```json
{
  "id": "c3d4e5f6-...",
  "name": "Interventional Cardiology",
  "slug": "interventional-cardiology",
  "description": null,
  "status": "active",
  "created_at": "2026-08-15T10:00:00.000Z",
  "updated_at": "2026-08-15T10:00:00.000Z"
}
```

### POST /branches/:id/doctors/:doctorId/photo/signature

Auth: `clinic_owner`, must own the branch **or** `branch_staff` with `doctors:manage`. Returns a Cloudinary upload grant for a doctor assigned to the branch.

**Response `200`** — same shape as `POST /doctors/me/photo/signature`, with a `public_id` under the `doctors/` folder.

**Errors:** `404 BRANCH_NOT_FOUND`, `403 NOT_CLINIC_OWNER`, `404 DOCTOR_NOT_FOUND` (doctor not assigned to the branch).

### POST /branches/:id/doctors/:doctorId/photo

Auth: `clinic_owner`, must own the branch **or** `branch_staff` with `doctors:manage`. Persists the doctor's profile photo (visible on all branches) after a direct Cloudinary upload.

**Request body**

```json
{ "public_id": "doctors/3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d" }
```

**Response `200`**

```json
{
  "photo_url": "https://res.cloudinary.com/p274ocjz/image/upload/doctors/3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d"
}
```

**Errors:** `404 BRANCH_NOT_FOUND`, `403 NOT_CLINIC_OWNER`, `404 DOCTOR_NOT_FOUND`, `400 INVALID_PUBLIC_ID`, `400 VALIDATION_ERROR`.

### PATCH /doctor-assignments/:id

Auth: `clinic_owner` (branch scope) **or** `doctor` (self) **or** `branch_staff` with `doctors:manage`. Doctors may only update `slot_type`/`slot_template`/`certificate`; attempting to set `fee_amount` as a doctor returns `403 FEE_OWNER_CONTROLLED`.

**Request body** (partial)

```json
{
  "fee_amount": 600,
  "slot_type": "sequential",
  "slot_template": [{
    "weekday": 2,
    "start_time": "10:00",
    "end_time": "14:00",
    "slot_duration_minutes": 30,
    "start_date": "2026-08-17",
    "end_date": "2026-12-31"
  }],
  "certificate": "https://example.com/new-cert.pdf"
}
```

`slot_type` ∈ `fixed | sequential` — see [Slot types](#slot-types). Switching an assignment to `sequential` does not require changing `slot_template`; the same weekday/time-range/duration rows are reused, just booked in order instead of by patient-picked time.

Sending `slot_template` fully replaces the assignment's existing rows — it is not a diff/patch of individual entries. Each entry's `weekday` pattern repeats every week between `start_date` and `end_date` (or indefinitely if `end_date` is `null`). To keep a doctor's weekly schedule but pull them off a single date within that range (holiday, leave, etc.), use the exceptions endpoints below instead of shrinking the date range. These per-entry dates are also what `GET /branches/:id/doctors` aggregates into its top-level `start_date`/`end_date` per doctor — see that endpoint's docs.

**Response `200`**

```json
{
  "id": "e4f5a6b7-8c9d-0e1f-2a3b-4c5d6e7f8a9b",
  "doctor_id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "fee_amount": 600,
  "currency": "INR",
  "slot_type": "sequential",
  "certificate_url": "https://example.com/new-cert.pdf"
}
```

**Errors:** `404 ASSIGNMENT_NOT_FOUND`, `403 FEE_OWNER_CONTROLLED`.

### DELETE /doctor-assignments/:id

Auth: `clinic_owner` **or** `branch_staff` with `doctors:manage`. Deactivates the assignment (soft-removes the doctor from the branch; does not delete the doctor's account).

**Response `204 No Content`**

**Errors:** `409 DOCTOR_HAS_ACTIVE_APPOINTMENTS`.

### GET /doctor-assignments/:id/exceptions

Auth: `clinic_owner` (branch scope) **or** `doctor` (self) **or** `branch_staff` with `doctors:manage`. Lists the doctor's **leaves** for this assignment — inclusive date ranges within the assignment's slot-template range where the doctor is unavailable, overriding the otherwise-recurring weekly pattern. Both active and cancelled leaves are returned (cancelled ones are kept as an audit record); filter on `status` client-side if only active leaves are needed.

**Response `200`**

```json
{
  "items": [
    {
      "id": "b1c2d3e4-...",
      "excluded_date": "2026-09-01",
      "end_date": "2026-09-07",
      "reason": "Annual leave",
      "status": "active",
      "created_at": "2026-08-13T10:00:00.000Z"
    }
  ]
}
```

`excluded_date` is the leave's (inclusive) start date; `end_date` is the (inclusive) end date — equal to `excluded_date` for a single-day leave. `status` ∈ `active | cancelled`; only `active` leaves block availability/booking (see [§8 Backend availability calculation](#doctors-invites--assignments)).

### POST /doctor-assignments/:id/exceptions

Auth: same as above. Marks a date range unavailable ("doctor leave"), even if it falls inside an active `slot_template` weekday/date-range. The leave does not need to fall entirely inside the assignment's slot-template range — the effective unavailable window is the **intersection** of the leave and the doctor's availability period, computed live by every availability/booking endpoint rather than stored.

Same cascade as branch closures (see [POST /branches/:id/schedule/closures](#post-branchesidscheduleclosures)): any of this doctor's `pending`/`confirmed` appointments at this branch that fall inside the leave's date range are cancelled, with an in-app notification and email to each affected patient. `paid` appointments are left untouched.

**Request body**

```json
{ "excluded_date": "2026-09-01", "end_date": "2026-09-07", "reason": "Annual leave" }
```

| Field | Type | Notes |
|---|---|---|
| `excluded_date` | string | required, `YYYY-MM-DD` — leave start date (inclusive) |
| `end_date` | string? | `YYYY-MM-DD`, nullable — leave end date (inclusive); omit for a single-day leave (defaults to `excluded_date`) |
| `reason` | string? | max 255 |

**Response `201`**

```json
{
  "id": "b1c2d3e4-...",
  "doctor_branch_assignment_id": "e4f5a6b7-...",
  "excluded_date": "2026-09-01",
  "end_date": "2026-09-07",
  "reason": "Annual leave",
  "status": "active"
}
```

**Errors:** `404 ASSIGNMENT_NOT_FOUND`, `400 VALIDATION_ERROR` (`end_date` before `excluded_date`). Overlapping leaves for the same assignment are allowed (the union of active ranges is what matters for availability), so there is no `409 EXCEPTION_ALREADY_EXISTS` in this version of the contract.

### DELETE /doctor-assignments/:id/exceptions/:exceptionId

Auth: same as above. **Cancels** the leave (`status` → `cancelled`) rather than deleting the row, so it's kept as an audit record — this immediately restores the doctor's normal recurring availability across the leave's date range, without touching `slot_template`.

**Response `204 No Content`**

**Errors:** `404 EXCEPTION_NOT_FOUND`.

### GET /doctors/me

Auth: `doctor`.

**Response `200`**

```json
{
  "id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "name": "Dr. Smith",
  "specializations": [{ "id": "a1b2c3d4-...", "name": "Cardiology" }],
  "reg_no": "MC-123456",
  "smc_name": "Medical Council of India",
  "doctor_degree": "MBBS, MD",
  "phone": "+919900000001",
  "certificate_url": null,
  "photo_url": null,
  "bio": null
}
```

### PATCH /doctors/me

Auth: `doctor`.

**Request body** (partial)

```json
{ "name": "Dr. John Smith", "reg_no": "MC-654321", "smc_name": "Medical Council of India", "doctor_degree": "MBBS, MD", "phone": "+919900000002", "bio": "MBBS, MD (Cardiology)" }
```

**Response `200`** — updated doctor object (same shape as GET).

**Errors:** `409` on duplicate `reg_no`, `404 DOCTOR_NOT_FOUND`.

### POST /doctors/me/photo/signature

Auth: `doctor`. Returns a Cloudinary upload grant for the doctor's profile photo.

**Response `200`**

```json
{
  "upload_url": "https://api.cloudinary.com/v1_1/p274ocjz/image/upload",
  "cloud_name": "p274ocjz",
  "api_key": "181659462436854",
  "timestamp": 1754700000,
  "public_id": "doctors/3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "allowed_formats": ["jpg", "png", "webp", "gif"],
  "signature": "9d3c1f0a..."
}
```

**Errors:** `404 DOCTOR_NOT_FOUND`.

### POST /doctors/me/photo

Auth: `doctor`. Persists the doctor's profile photo after a direct Cloudinary upload.

**Request body**

```json
{ "public_id": "doctors/3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d" }
```

| Field | Type | Notes |
|---|---|---|
| `public_id` | string | required, must be one issued by `POST /doctors/me/photo/signature` |

**Response `200`**

```json
{
  "photo_url": "https://res.cloudinary.com/p274ocjz/image/upload/doctors/3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d"
}
```

**Errors:** `404 DOCTOR_NOT_FOUND`, `400 INVALID_PUBLIC_ID`, `400 VALIDATION_ERROR`.

### GET /doctors/search

Auth: any authenticated user (`patient`, `clinic_owner`, `branch_staff`, `doctor`). Rate limited 60/min.

**Query:** `?q=<query>&limit=<1..50>` — `q` is required.

Searches `reg_no` (prefix), `name` (contains), and each doctor's master-list specialization names (contains). Results ordered by exact `reg_no` match first.

**Response `200`**

```json
{
  "items": [
    {
      "id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
      "name": "Dr. Smith",
      "specialization": "Cardiology",
      "specializations": [{ "id": "a1b2c3d4-...", "name": "Cardiology" }],
      "reg_no": "MC-123456",
      "smc_name": "Medical Council of India",
      "doctor_degree": "MBBS, MD",
      "phone": "+919900000001",
      "clinic_count": 1,
      "rating": { "average": 4.5, "count": 12 }
    }
  ]
}
```

`rating` is the same platform-wide aggregate described under `GET /branches/:id/doctors`.

**Errors:** `400 VALIDATION_ERROR` (missing `q`), `401 UNAUTHORIZED`.

### GET /doctors/:id/availability

Public. The authoritative availability rule (applied identically here, in `/availability/week`, `/availability/calendar`, and `POST /appointments`) is:

```text
AVAILABLE =
    the branch is open on that weekday                       (branch_operating_days)
    AND NOT EXISTS an ACTIVE branch closure covering date     (branch_closures)
    AND date >= assignment's derived availability start date  (inclusive)
    AND date <= assignment's derived availability end date    (inclusive, if set)
    AND date >= today
    AND NOT EXISTS an ACTIVE leave covering date               (doctor_slot_exceptions)
    AND at least one bookable slot exists for that date
```

The branch-level check is the outermost gate — see [Branch schedule](#branch-schedule) — and is checked before the doctor's own schedule, so it gets its own `clinic_closed` status distinct from `outside_schedule`/`leave`.

The availability start/end dates are never stored directly — they're derived as the union of the assignment's `doctor_slot_templates` date ranges (same aggregation as `GET /branches/:id/doctors`'s `start_date`/`end_date`). All date comparisons are on `YYYY-MM-DD` strings, never JS `Date` timestamps, so there's no timezone drift between "today" and stored dates.

Two modes, selected by which query params are present:

**Single-date mode** — `?date=2026-08-10` (`YYYY-MM-DD`, required for this mode), `?branch_id=` optional (defaults to the doctor's first active assignment if omitted, for backward compatibility).

**Response `200`**

```json
{
  "date": "2026-08-10",
  "status": "available",
  "is_bookable": true,
  "leave": null,
  "closure": null,
  "slots": [
    { "time": "09:00", "available": true, "slot_type": "fixed" },
    { "time": "09:20", "available": true, "slot_type": "fixed" },
    { "time": "09:40", "available": false, "slot_type": "fixed" }
  ]
}
```

`status` ∈ `available | leave | clinic_closed | unavailable | fully_booked | outside_schedule | past`. `leave` is `{ start_date, end_date, reason }` when `status = "leave"`, else `null`. `closure` is `{ start_date, end_date, reason }` when `status = "clinic_closed"` **and** it was a specific branch closure (not just a recurring closed weekday), else `null` — see [Branch schedule](#branch-schedule). `slots`/`status`/`is_bookable`/`leave`/`closure` were added additively — `date`+`slots` is unchanged from the prior contract, so existing clients keep working untouched. Each slot carries the `slot_type` of the template it came from (see [Slot types](#slot-types)); for a `sequential` assignment the client should not let the patient pick a slot directly — `POST /appointments` auto-assigns the next open one.

**Range mode** — `?from=2026-08-16&to=2026-08-31&branch_id=<id>` (all three required; range capped at 62 days). Returns calendar availability, leave info, and slots for every date in one response instead of one call per day.

**Response `200`**

```json
{
  "doctor_id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "availability_period": { "start_date": "2026-08-16", "end_date": "2026-08-23" },
  "leaves": [
    { "start_date": "2026-08-20", "end_date": "2026-08-22", "reason": "Doctor unavailable" }
  ],
  "closures": [
    { "start_date": "2026-08-27", "end_date": "2026-08-27", "reason": "Public holiday" }
  ],
  "dates": [
    {
      "date": "2026-08-16",
      "day": "Sunday",
      "status": "available",
      "is_bookable": true,
      "leave": null,
      "closure": null,
      "slots": [{ "time": "09:00", "available": true, "slot_type": "fixed" }]
    },
    {
      "date": "2026-08-20",
      "day": "Thursday",
      "status": "leave",
      "is_bookable": false,
      "leave": { "start_date": "2026-08-20", "end_date": "2026-08-22", "reason": "Doctor unavailable" },
      "closure": null,
      "slots": []
    },
    {
      "date": "2026-08-27",
      "day": "Thursday",
      "status": "clinic_closed",
      "is_bookable": false,
      "leave": null,
      "closure": { "start_date": "2026-08-27", "end_date": "2026-08-27", "reason": "Public holiday" },
      "slots": []
    }
  ]
}
```

`closures` (top-level) lists the branch's active closures overlapping `[from, to]`, mirroring `leaves` — see [Branch schedule](#branch-schedule).

**Errors:** `422 VALIDATION_ERROR` (bad `date`, single-date mode) / `400 VALIDATION_ERROR` (missing/invalid `branch_id`, `from`, `to`, or range too large), `404 DOCTOR_NOT_FOUND`.

### GET /doctors/:id/availability/week

Public. Drives a doctor profile's "Availability this week" cards without the client generating dates or hardcoding a weekly pattern itself.

**Query:** `?branch_id=<id>` (required), `?date=2026-08-16` (optional anchor date, `YYYY-MM-DD`, defaults to today) — the response covers exactly the 7 calendar days starting at `date`.

**Response `200`**

```json
{
  "week_start": "2026-08-16",
  "week_end": "2026-08-22",
  "dates": [
    { "date": "2026-08-16", "day": "Sun", "status": "available", "is_bookable": true, "display_time": "9:00 AM" },
    { "date": "2026-08-17", "day": "Mon", "status": "unavailable", "is_bookable": false, "display_time": "No slots" },
    { "date": "2026-08-20", "day": "Thu", "status": "leave", "is_bookable": false, "display_time": "Doctor on leave" },
    { "date": "2026-08-21", "day": "Fri", "status": "clinic_closed", "is_bookable": false, "display_time": "Clinic closed" }
  ]
}
```

`display_time` is a UI-ready label: the first open slot formatted 12-hour (`"9:00 AM"`) when bookable, `"Doctor on leave"` for `leave`, `"Clinic closed"` for `clinic_closed`, `"Fully booked"` for `fully_booked`, else `"No slots"`. Tapping a date should follow up with `GET /doctors/:id/availability?from=<date>&to=<date>&branch_id=<id>` for the actual slot list.

**Errors:** `400 VALIDATION_ERROR` (missing `branch_id`, bad `date`), `404 DOCTOR_NOT_FOUND`.

### GET /doctors/:id/availability/calendar

Public. Drives a full-month calendar picker (e.g. the booking flow's date step) in one call.

**Query:** `?branch_id=<id>&year=2026&month=8` (all required; `month` is 1–12).

**Response `200`**

```json
{
  "year": 2026,
  "month": 8,
  "availability_period": { "start_date": "2026-08-16", "end_date": "2026-08-23" },
  "dates": [
    { "date": "2026-08-16", "status": "available", "is_bookable": true },
    { "date": "2026-08-20", "status": "leave", "is_bookable": false },
    { "date": "2026-08-21", "status": "clinic_closed", "is_bookable": false },
    { "date": "2026-08-24", "status": "outside_schedule", "is_bookable": false }
  ]
}
```

Every day of the month is included (not just the availability period) so the client can render the full grid and grey out non-bookable days without extra logic — dates with open slots should be visually highlighted; all others (outside the doctor's schedule, the clinic closed, fully booked, on leave, or in the past) rendered disabled.

**Errors:** `400 VALIDATION_ERROR` (missing/invalid `branch_id`, `year`, or `month`), `404 DOCTOR_NOT_FOUND`.

---

## Reviews & ratings

A patient may rate a doctor 1–5 stars (plus an optional comment) once they've had a **completed** appointment with them. The `reviews` table has one row per `(patient_id, doctor_id)` — not per appointment — so rating the same doctor again after a later visit updates the existing review in place (rating, comment, and which `branch_id`/`appointment_id` it's attached to) rather than creating a second row. This is also why a doctor's rating (`GET /doctors`, `GET /branches/:id/doctors`, `GET /doctors/search`) is always platform-wide, never scoped to one branch — a patient only ever contributes one rating per doctor, however many branches they've seen them at.

A branch's aggregate rating (`GET /clinics/:clinicId/branches`, `GET /branches/:id/reviews`) is the average across every review whose `branch_id` currently points at that branch — i.e. wherever each patient's *most recent* review of a doctor happened to take place, not a durable per-branch history for doctors who move between branches.

### POST /appointments/:id/review

Auth: `patient`, must own the appointment. Requires the appointment's `status` to be `completed`.

**Body:** `{ "rating": 5, "comment": "Very thorough, explained everything clearly." }`

| Field | Type | Notes |
|---|---|---|
| `rating` | number | required, integer 1–5 |
| `comment` | string? | optional, max 1000 |

**Response `201`** (first review of this doctor) or **`200`** (updated an existing one)

```json
{
  "id": "d4e5f6a7-8b9c-0d1e-2f3a-4b5c6d7e8f9a",
  "patient_id": "b7c8d9e0-1f2a-3b4c-5d6e-7f8a9b0c1d2e",
  "doctor_id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "appointment_id": "7c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
  "rating": 5,
  "comment": "Very thorough, explained everything clearly.",
  "created_at": "2026-08-15T10:00:00.000Z",
  "updated_at": "2026-08-15T10:00:00.000Z"
}
```

**Errors:** `404 APPOINTMENT_NOT_FOUND`, `409 APPOINTMENT_NOT_COMPLETED`, `400 VALIDATION_ERROR`.

### GET /doctors/:id/reviews

Public. Not cursor-paginated — uses `limit`/`offset` like `GET /branches/:id/patients`. Drives a doctor profile's rating summary and patient feedback list.

**Query:** `?limit=&offset=`

**Response `200`**

```json
{
  "rating": { "average": 4.5, "count": 12 },
  "items": [
    {
      "id": "d4e5f6a7-8b9c-0d1e-2f3a-4b5c6d7e8f9a",
      "patient_name": "Priya S.",
      "rating": 5,
      "comment": "Very thorough, explained everything clearly.",
      "created_at": "2026-08-15T10:00:00.000Z"
    }
  ],
  "has_more": false
}
```

`rating.average` is rounded to one decimal and `null` with `count: 0` when the doctor has no reviews yet. `patient_name` is masked to first name + last-initial (e.g. `"Priya Sharma"` → `"Priya S."`) since this endpoint is public — see `GET /branches/:id/reviews` for the clinic-side view with full names.

### GET /branches/:id/reviews

Auth: `clinic_owner` (owns branch) **or** `branch_staff` with `reviews:view`. Not cursor-paginated — uses `limit`/`offset`. Lets clinic staff see the patient feedback behind their branch's rating, across every doctor there (or one doctor with `?doctor_id=`).

**Query:** `?doctor_id=&limit=&offset=`

**Response `200`**

```json
{
  "rating": { "average": 4.5, "count": 12 },
  "items": [
    {
      "id": "d4e5f6a7-8b9c-0d1e-2f3a-4b5c6d7e8f9a",
      "doctor_id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
      "doctor_name": "Dr. Smith",
      "patient_name": "Priya Sharma",
      "rating": 5,
      "comment": "Very thorough, explained everything clearly.",
      "created_at": "2026-08-15T10:00:00.000Z"
    }
  ],
  "has_more": false
}
```

Unlike the public `GET /doctors/:id/reviews`, `patient_name` here is the patient's full name — matching `GET /branches/:id/patients`, already visible to clinic staff for accountability.

**Errors:** `404 BRANCH_NOT_FOUND`, `403 PERMISSION_DENIED`.

---

## Patients

Patients are `users` rows with `role = 'patient'` — there is no separate `patients` table. This section lists patients who have booked at least one (non-cancelled) appointment at a given branch.

### GET /patients/me

Auth: `patient`. Returns the caller's own profile, including their preferred clinic/branch.

**Response `200`**

```json
{
  "id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "name": "Aisha Verma",
  "first_name": "Aisha",
  "last_name": "Verma",
  "email": "aisha@example.com",
  "phone": "+919876543210",
  "date_of_birth": "1994-03-12",
  "gender": "female",
  "address": "123 Link Road, Andheri West",
  "nearby_location": "Near Andheri Station",
  "city": "Mumbai",
  "district": "Mumbai Suburban",
  "pin_code": "400058",
  "state": "Maharashtra",
  "post_office": "Andheri West HO",
  "photo_url": null,
  "preferred_clinic_id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
  "preferred_clinic_name": "Sunrise Clinic",
  "preferred_branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "preferred_branch_name": "Andheri West Branch",
  "created_at": "2026-08-01T09:30:00Z",
  "updated_at": "2026-08-01T09:30:00Z"
}
```

`first_name`/`last_name` are optional and independent of `name` — `name` remains the canonical display name (required, shown across appointments/notifications/emails). `preferred_clinic_id`/`preferred_clinic_name`/`preferred_branch_id`/`preferred_branch_name` are `null` until the patient sets a preferred branch via `PATCH /patients/me`.

### PATCH /patients/me

Auth: `patient`. Partial update of the caller's own profile — see [Partial updates](#partial-updates). `name` and `address` cannot be cleared to empty/`null` (both are required at registration); the remaining fields accept `null` to clear them.

**Request body** (any subset)

```json
{ "phone": "+919876543211", "city": "Pune", "pin_code": "411001" }
```

| Field | Type | Notes |
|---|---|---|
| `name` | string? | 1–255 chars |
| `first_name` | string? | 1–150 chars. If `name` is omitted, `name` is recomputed as `"{first_name} {last_name}"` |
| `last_name` | string? | 1–150 chars. See above |
| `phone` | string?\|null | max 32 |
| `date_of_birth` | string?\|null | `YYYY-MM-DD`, cannot be in the future |
| `gender` | string?\|null | one of `male`, `female`, `other`, `prefer_not_to_say` |
| `address` | string? | 1–500 chars |
| `nearby_location` | string?\|null | max 500 |
| `city` | string?\|null | max 255 |
| `district` | string?\|null | max 255 |
| `pin_code` | string?\|null | max 20 |
| `state` | string?\|null | max 255 |
| `post_office` | string?\|null | max 255 |
| `preferred_clinic_id` | string (UUID)?\|null | must be an existing, non-deleted clinic. Setting to `null` also clears `preferred_branch_id` |
| `preferred_branch_id` | string (UUID)?\|null | must be an existing, non-deleted branch. Also sets `preferred_clinic_id` to that branch's clinic (overriding any `preferred_clinic_id` in the same request). Setting to `null` clears only the branch |

**Response `200`**: same shape as `GET /patients/me`.

**Errors:** `400 VALIDATION_ERROR`, `404 CLINIC_NOT_FOUND`, `404 BRANCH_NOT_FOUND`.

### GET /patients/me/medical-info

Auth: `patient`. Returns the caller's medical profile and emergency contact — kept in a separate table from the general profile above. Fields default to `null` if the patient hasn't filled them in yet (never 404s).

**Response `200`**

```json
{
  "patient_id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "blood_group": "O+",
  "allergies": "Penicillin, peanuts",
  "medical_conditions": "Type 2 diabetes",
  "current_medications": "Metformin 500mg twice daily",
  "previous_surgeries": "Appendectomy (2018)",
  "medical_notes": "Prefers morning appointments due to medication schedule.",
  "emergency_contact": {
    "name": "Rohan Verma",
    "relationship": "Spouse",
    "phone": "+919876500000"
  },
  "updated_at": "2026-08-01T09:30:00Z"
}
```

### PATCH /patients/me/medical-info

Auth: `patient`. Partial update — see [Partial updates](#partial-updates). Creates the record on first write.

**Request body** (any subset)

```json
{ "blood_group": "O+", "allergies": "Penicillin, peanuts" }
```

| Field | Type | Notes |
|---|---|---|
| `blood_group` | string?\|null | one of `A+`, `A-`, `B+`, `B-`, `AB+`, `AB-`, `O+`, `O-`, `unknown` |
| `allergies` | string?\|null | max 2000 |
| `medical_conditions` | string?\|null | max 2000 |
| `current_medications` | string?\|null | max 2000 |
| `previous_surgeries` | string?\|null | max 2000 |
| `medical_notes` | string?\|null | max 2000 |
| `emergency_contact_name` | string?\|null | max 255 |
| `emergency_contact_relationship` | string?\|null | max 100 |
| `emergency_contact_phone` | string?\|null | max 32 |

**Response `200`**: same shape as `GET /patients/me/medical-info`.

**Errors:** `400 VALIDATION_ERROR`.

### GET /patients/me/appointment-summary

Auth: `patient`. Compact counts plus the soonest upcoming appointment, for the profile page's appointment summary card.

**Response `200`**

```json
{
  "upcoming_count": 2,
  "completed_count": 5,
  "cancelled_count": 1,
  "no_show_count": 0,
  "total_count": 8,
  "next_appointment": {
    "id": "f1e2d3c4-b5a6-7980-9a8b-7c6d5e4f3a2b",
    "scheduled_date": "2026-08-15",
    "scheduled_time": "09:20",
    "status": "confirmed",
    "doctor_id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
    "doctor_name": "Dr. Kavita Rao",
    "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
    "branch_name": "Andheri West Branch"
  },
  "previous_appointment": {
    "id": "a9b8c7d6-e5f4-3210-9a8b-7c6d5e4f3a2b",
    "scheduled_date": "2026-07-20",
    "scheduled_time": "11:00",
    "status": "completed",
    "doctor_id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
    "doctor_name": "Dr. Kavita Rao",
    "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
    "branch_name": "Andheri West Branch"
  }
}
```

`upcoming_count` counts non-terminal appointments (`pending`/`confirmed`/`paid`) scheduled today or later. `next_appointment` is the soonest such appointment, or `null` if there is none. `previous_appointment` is the most recent `completed` appointment (the patient's last visit), or `null` if there is none.

### POST /patients/me/change-password

Auth: `patient`. Rate limited 10/min. Changes the caller's password and revokes all of their active sessions (they must log in again everywhere).

**Request body**

```json
{ "current_password": "OldPass123", "new_password": "NewPass456", "confirm_password": "NewPass456" }
```

**Response `200`**

```json
{ "message": "Password changed. Please log in again on your other devices." }
```

**Errors:** `400 VALIDATION_ERROR`, `401 INVALID_CREDENTIALS`.

### POST /patients/me/change-email

Auth: `patient`. Rate limited 10/min. Starts an email change: verifies the current password, then emails a confirmation link to the **new** address (reusing the `POST /auth/verify-email` flow — the token carries the pending new email). The old address is notified of the request. The email only changes once the new address is confirmed.

**Request body**

```json
{ "new_email": "aisha.new@example.com", "current_password": "OldPass123" }
```

**Response `200`**

```json
{ "message": "Check your new email address for a confirmation link to complete the change." }
```

**Errors:** `400 VALIDATION_ERROR`, `401 INVALID_CREDENTIALS`, `409 EMAIL_ALREADY_REGISTERED`.

### GET /patients/me/sessions

Auth: `patient`. Lists the caller's active (non-revoked, non-expired) login sessions, i.e. refresh tokens.

**Response `200`**

```json
{
  "items": [
    { "id": "a1b2c3d4-...", "created_at": "2026-08-01T09:30:00Z", "expires_at": "2026-08-31T09:30:00Z" }
  ]
}
```

### DELETE /patients/me/sessions/:id

Auth: `patient`. Revokes one of the caller's sessions by id (e.g. "log out this device").

**Response `204 No Content`**

**Errors:** `404 SESSION_NOT_FOUND`.

### POST /patients/me/logout-all

Auth: `patient`. Revokes **all** of the caller's active sessions ("log out everywhere").

**Response `204 No Content`**

### POST /patients/me/photo/signature

Auth: `patient`. Issues a signed Cloudinary upload grant for the caller's own profile photo — same two-step flow as [File uploads](#file-uploads) (folder `patients`).

**Response `200`**

```json
{
  "upload_url": "https://api.cloudinary.com/v1_1/<cloud_name>/image/upload",
  "cloud_name": "<cloud_name>",
  "api_key": "<api_key>",
  "timestamp": 1770000000,
  "public_id": "patients/3c2f6a1b-9e8d-4c7a-b5f0-1a2b3c4d5e6f",
  "allowed_formats": ["jpg", "png", "webp", "gif"],
  "signature": "<sha1>"
}
```

### POST /patients/me/photo

Auth: `patient`. Persists the photo uploaded to the `public_id` issued above.

**Request body**

```json
{ "public_id": "patients/3c2f6a1b-9e8d-4c7a-b5f0-1a2b3c4d5e6f" }
```

**Response `200`**

```json
{ "photo_url": "https://res.cloudinary.com/<cloud_name>/image/upload/patients/3c2f6a1b-9e8d-4c7a-b5f0-1a2b3c4d5e6f" }
```

**Errors:** `400 INVALID_PUBLIC_ID`.

### GET /branches/:id/patients

Auth: `clinic_owner` (owns branch) **or** `branch_staff` with `patients:view`. **Not** cursor-paginated — uses `limit`/`offset`.

**Query:** `?search=&type=new|old&limit=<1..100>&offset=`

- `search` matches patient name, email, or phone (contains).
- `type=new` returns patients with exactly one non-cancelled appointment at this branch; `type=old` returns patients with more than one (returning patients). Omit for both.

**Response `200`**

```json
{
  "items": [
    {
      "id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
      "name": "Aisha Verma",
      "email": "aisha@example.com",
      "phone": "+919876543210",
      "address": "12, SV Road, Andheri West, Mumbai 400058",
      "photo_url": null,
      "visit_count": 3,
      "is_new_patient": false,
      "first_visit_date": "2026-05-01",
      "last_visit_date": "2026-08-09"
    }
  ],
  "has_more": false
}
```

**Errors:** `404 BRANCH_NOT_FOUND`, `403 PERMISSION_DENIED`.

---

## Appointments

`Appointment` object:

```json
{
  "id": "f1e2d3c4-b5a6-7980-9a8b-7c6d5e4f3a2b",
  "patient_id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "clinic_id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "doctor_id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "scheduled_date": "2026-08-10",
  "scheduled_time": "09:20",
  "duration_minutes": 20,
  "status": "pending",
  "fee_amount": 500,
  "currency": "INR",
  "payment_method": null,
  "created_at": "2026-08-09T10:05:00Z",
  "updated_at": "2026-08-09T10:05:00Z",
  "patient_details": {
    "relationship": "self",
    "name": "Aisha Verma",
    "phone": "+919876543210",
    "age": null,
    "gender": null
  }
}
```

`status` ∈ `pending | confirmed | paid | completed | cancelled | no_show`

`patient_details` identifies who the visit is actually **for** — a patient account can book on
behalf of a family member or friend, so this can differ from the booking account
(`patient_id`, the logged-in user who made the booking). It's always present on every
appointment (list and detail alike): `relationship` ∈ `self | spouse | child | parent | sibling | friend | other`,
defaulting to `self` with the account holder's own `name`/`phone` when `patient_details` is
omitted from `POST /appointments`. `age` and `gender` are optional free-form details the
booking patient can supply for the visitor and are `null` unless given.

List and detail responses enrich this base object:

- `GET /appointments` items additionally include `doctor_name`, `doctor_photo_url`, and `branch_name`.
- `GET /appointments/:id` additionally includes `doctor_name`, `doctor_photo_url`, `branch_name`, and a nested `patient` object: `{ id, name, email, phone, address, photo_url }` — this is always the **booking account holder**, not necessarily the visiting patient in `patient_details`.

### POST /appointments

Auth: `patient`. Header `Idempotency-Key` **required**.

On success, an in-app notification (`new_booking`) is created for every branch staff member **and** the clinic owner, and each of them is emailed the account holder's name/email/phone, the visiting patient's name/relationship (from `patient_details`) if booked for someone else, and the doctor's name.

Behavior depends on the doctor's assignment `slot_type` for `branch_id` (see [Slot types](#slot-types)):

- **`fixed`** — `time` is required and must be one of the doctor's aligned slots for that date (from `GET /doctors/:id/availability`).
- **`sequential`** — `time` is ignored/omitted; the server books the next free slot in the doctor's range for that date, in booking order (1st patient gets the range's first slot, 2nd patient gets the next, etc.).

**Request body**

```json
{
  "doctor_id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "date": "2026-08-10",
  "time": "09:20",
  "patient_details": {
    "relationship": "child",
    "name": "Rohan Verma",
    "phone": "+919876500000",
    "age": 8,
    "gender": "male"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `doctor_id` | string (UUID) | required |
| `branch_id` | string (UUID) | required |
| `date` | string | required, `YYYY-MM-DD`, not in the past |
| `time` | string? | required and must be an aligned slot when the doctor's `slot_type` is `fixed`; omit for `sequential` doctors |
| `patient_details` | object? | optional — omit to book for yourself (defaults to `relationship: "self"` using your own account name/phone) |
| `patient_details.relationship` | string? | `self` \| `spouse` \| `child` \| `parent` \| `sibling` \| `friend` \| `other`, defaults to `self` |
| `patient_details.name` | string | required if `patient_details` is present, 1–255 chars |
| `patient_details.phone` | string? | max 32 |
| `patient_details.age` | number? | 0–150 |
| `patient_details.gender` | string? | one of `male`, `female`, `other`, `prefer_not_to_say` |

**Response `201`** — Appointment object (`status: "pending"`, `scheduled_time` is the server-assigned time for `sequential` bookings).

The server never trusts the client's disabled-calendar rendering — every check below re-runs against `branch_operating_days`/`branch_closures`/`doctor_slot_templates`/`doctor_slot_exceptions` regardless of what the calendar/availability endpoints previously returned, so a direct API call can't book a leave day, a branch-closed day, or a day outside the doctor's schedule. The branch-level gate is checked first (it's the outermost constraint) and produces `409 CLINIC_CLOSED`; a doctor leave produces `409 DOCTOR_ON_LEAVE`. Neither is folded into the generic `422 OUTSIDE_DOCTOR_AVAILABILITY`, so the client can show the specific reason instead of a generic unavailable message.

**Errors:** `400 IDEMPOTENCY_KEY_REQUIRED`, `400 VALIDATION_ERROR` (`time` missing for a `fixed` doctor), `409 SLOT_ALREADY_BOOKED` (`fixed` only), `409 DOCTOR_FULLY_BOOKED` (`sequential` only — no slots left that date), `409 CLINIC_CLOSED` (branch not open, or an active branch closure, on the selected date), `409 DOCTOR_ON_LEAVE` (date falls within an active leave), `422 OUTSIDE_DOCTOR_AVAILABILITY`, `422 DATE_IN_PAST`, `404 BRANCH_NOT_FOUND`, `404 DOCTOR_NOT_FOUND`.

### GET /appointments

Auth: any authenticated role. Scope auto-applied: `patient` → own; `branch_staff` → own branch; `doctor` → own; `clinic_owner` → own clinics. Paginated.

**Query:** `?clinic_id=&status=&date_from=&date_to=&limit=&cursor=` (`status` must be one of the enum values). `clinic_id` narrows to one clinic, on top of whatever scope already applies.

**Response `200`**

```json
{
  "items": [ /* Appointment objects */ ],
  "next_cursor": null
}
```

### GET /appointments/:id

Auth: any authenticated role, scope as above.

**Response `200`** — Appointment object.

**Errors:** `404 APPOINTMENT_NOT_FOUND` (also returned when not visible to the caller).

### PATCH /appointments/:id/confirm

Auth: `branch_staff` (own branch, requires `appointments:confirm`) or `clinic_owner`. Requires current status `pending`. No body.

On success, the patient receives an in-app `booking_confirmed` notification and a confirmation email (doctor, branch, date, time).

**Response `200`** — Appointment object (`status: "confirmed"`).

**Errors:** `409 INVALID_STATUS_TRANSITION`.

### PATCH /appointments/:id/payment

Auth: `branch_staff` (own branch, requires `appointments:payment`) or `clinic_owner`. Header `Idempotency-Key` **required**. Requires current status `confirmed`. Records a `Payment` and marks the appointment `paid`.

On success: the patient gets an in-app `payment_received` notification; the clinic owner gets an in-app `payment_received` notification **and** an email naming the patient and the payment method (`cash`/`upi`); and the payment amount is added to that clinic/branch's monthly total in `clinic_payment_ledger` — see [Payment ledger](#payment-ledger).

**Request body**

```json
{
  "fee_amount": 500,
  "method": "upi",
  "reference_no": "UPI-REF-88421"
}
```

| Field | Type | Notes |
|---|---|---|
| `fee_amount` | number | required, > 0, ≤ 1,000,000 |
| `method` | string | required, `cash` or `upi` |
| `reference_no` | string? | max 255 |

**Response `200`** — Appointment object (`status: "paid"`, `payment_method` set).

**Errors:** `400 IDEMPOTENCY_KEY_REQUIRED`, `409 INVALID_STATUS_TRANSITION`.

### PATCH /appointments/:id/complete

Auth: `branch_staff` (own branch, requires `appointments:complete`) or `clinic_owner`. Requires current status `paid`. No body.

**Response `200`** — Appointment object (`status: "completed"`).

**Errors:** `409 INVALID_STATUS_TRANSITION`.

### PATCH /appointments/:id/cancel

Auth: `patient` (own, from `pending`/`confirmed`) or `branch_staff` (own branch, requires `appointments:cancel`) or `clinic_owner` (from `pending`/`confirmed`/`paid`).

**Request body**

```json
{ "reason": "Patient requested cancellation" }
```

**Response `200`** — Appointment object (`status: "cancelled"`).

**Errors:** `409 CANNOT_CANCEL_PAID_APPOINTMENT` (patient cancelling a paid appointment), `409 INVALID_STATUS_TRANSITION`.

### GET /appointments/:id/status-history

Auth: any authenticated role, scope as `GET /appointments/:id`.

**Response `200`**

```json
{
  "items": [
    {
      "from_status": null,
      "to_status": "pending",
      "changed_by": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
      "changed_at": "2026-08-09T10:05:00Z",
      "note": null
    },
    {
      "from_status": "pending",
      "to_status": "confirmed",
      "changed_by": "1a2b3c4d-5e6f-7890-abcd-ef1234567890",
      "changed_at": "2026-08-09T10:10:00Z",
      "note": null
    }
  ]
}
```

---

## Lab tests

Clinics define **lab tests** (e.g. ECG, blood panel) at the clinic level, then configure price/availability per branch via **branch lab tests**. Patients browse a branch's tests, check time-slot availability, and book **lab test appointments**. Appointments follow a separate state machine from doctor appointments.

### Lab test categories

`category` is clinic-defined free text (string, 1–100 chars) — not a fixed enum. `GET /clinic/lab-tests/categories` returns the distinct categories a clinic has already used, for suggesting/autocompleting values on create; typing a new one is valid and simply introduces that category going forward.

### Lab test appointment statuses

`status` ∈ `PENDING | APPROVED | REJECTED | CANCELLED | COMPLETED`

### Payment statuses

`payment_status` ∈ `UNPAID | PENDING | PAID | FAILED | REFUNDED`

### Service modes

`service_mode` ∈ `CLINIC | HOME` — `HOME` triggers home collection and requires address fields on the appointment.

### Serialized objects

#### LabTest

```json
{
  "id": "a1b2c3d4-...",
  "clinic_id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
  "name": "ECG",
  "code": "ECG",
  "description": "Electrocardiogram test",
  "category": "cardiology",
  "instructions": "Avoid heavy exercise 1 hour before",
  "default_precautions": ["Remove metallic jewelry"],
  "status": "active",
  "created_at": "2026-08-01T09:30:00Z",
  "updated_at": "2026-08-01T09:30:00Z"
}
```

#### BranchLabTest

```json
{
  "id": "b2c3d4e5-...",
  "clinic_id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "test_id": "a1b2c3d4-...",
  "test_name": "ECG",
  "test_code": "ECG",
  "test_category": "cardiology",
  "test_description": "Electrocardiogram test",
  "price": 800,
  "currency": "INR",
  "duration_minutes": 30,
  "clinic_available": true,
  "home_collection_available": false,
  "prescription_required": false,
  "status": "active",
  "created_at": "2026-08-02T11:00:00Z",
  "updated_at": "2026-08-02T11:00:00Z"
}
```

#### LabTestAppointment

```json
{
  "id": "c3d4e5f6-...",
  "appointment_number": "LAB20260818ABC123",
  "patient_id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "clinic_id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "branch_lab_test_id": "b2c3d4e5-...",
  "test_id": "a1b2c3d4-...",
  "service_mode": "CLINIC",
  "appointment_date": "2026-08-25",
  "start_time": "09:00",
  "end_time": "09:30",
  "duration_minutes": 30,
  "price": 800,
  "currency": "INR",
  "payment_method": "PAY_AT_CLINIC",
  "payment_status": "UNPAID",
  "prescription_required": false,
  "prescription_id": null,
  "patient_notes": "Fasting since last night",
  "clinic_notes": null,
  "precautions": ["Remove metallic jewelry"],
  "status": "PENDING",
  "approved_by": null,
  "approved_at": null,
  "rejected_by": null,
  "rejected_at": null,
  "rejection_reason": null,
  "completed_at": null,
  "cancelled_at": null,
  "created_at": "2026-08-18T10:00:00Z",
  "updated_at": "2026-08-18T10:00:00Z"
}
```

When `service_mode` is `HOME`, the response additionally includes `home_address`, `home_lat`, `home_lng`, `home_contact_phone`, and `home_notes`. When joined data is present (list/detail endpoints), the response may include nested `test`, `branch`, `patient`, and `clinic` objects. Clinic detail responses additionally include `prescriptions[]` and `payments[]` arrays.

### Patient-facing: browse tests & availability

#### GET /branches/:id/lab-tests

Auth: any authenticated user. Lists active lab tests configured for the branch. Rate limited 60/min.

**Query:** `?category=&search=&service_mode=` — `category` filters by test category; `search` matches test name/code; `service_mode` filters by `CLINIC` or `HOME` availability. All optional.

**Response `200`**

```json
{
  "items": [
    {
      "id": "b2c3d4e5-...",
      "clinic_id": "9d2f4c8a-...",
      "branch_id": "5e8f6c7a-...",
      "test_id": "a1b2c3d4-...",
      "test_name": "ECG",
      "test_code": "ECG",
      "test_category": "cardiology",
      "test_description": "Electrocardiogram test",
      "price": 800,
      "currency": "INR",
      "duration_minutes": 30,
      "clinic_available": true,
      "home_collection_available": false,
      "prescription_required": false,
      "status": "active",
      "created_at": "2026-08-02T11:00:00Z",
      "updated_at": "2026-08-02T11:00:00Z"
    }
  ]
}
```

**Errors:** `404 BRANCH_NOT_FOUND`.

#### GET /branches/:id/lab-tests/:branchTestId

Auth: any authenticated user. Returns a single branch lab test. Rate limited 60/min.

**Response `200`** — BranchLabTest object.

**Errors:** `404 BRANCH_NOT_FOUND`, `404 TEST_NOT_FOUND`.

#### GET /branches/:id/lab-tests/:branchTestId/availability

Auth: any authenticated user. Returns available time slots for a given date. Rate limited 60/min.

**Query:** `?date=2026-08-25` (required, `YYYY-MM-DD`, not in the past).

**Response `200`**

```json
{
  "date": "2026-08-25",
  "slots": [
    { "start": "09:00", "end": "09:30", "available": true },
    { "start": "09:30", "end": "10:00", "available": false },
    { "start": "10:00", "end": "10:30", "available": true }
  ]
}
```

Slots are generated from `lab_test_schedules` for the branch, filtered against branch closures and existing non-cancelled appointments. Each slot's `duration_minutes` comes from the branch lab test config.

**Errors:** `404 BRANCH_NOT_FOUND`, `404 TEST_NOT_FOUND`, `400 VALIDATION_ERROR` (missing/invalid `date`), `422 DATE_IN_PAST`.

### Patient-facing: book, view, cancel & pay

#### POST /lab-test-appointments

Auth: `patient`. Rate limited 10/min. Header `Idempotency-Key` **required**. Creates a new lab test appointment. Double-booking is prevented at the database level via a unique constraint on `(branch_id, branch_lab_test_id, appointment_date, slot_key)` excluding cancelled slots.

On success, an in-app `lab_test_booked` notification is created for every branch staff member and the clinic owner.

**Request body**

```json
{
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "branch_lab_test_id": "b2c3d4e5-...",
  "service_mode": "CLINIC",
  "appointment_date": "2026-08-25",
  "start_time": "09:00",
  "prescription_id": null,
  "patient_notes": "Fasting since last night",
  "payment_method": "PAY_AT_CLINIC"
}
```

| Field | Type | Notes |
|---|---|---|
| `branch_id` | string (UUID) | required |
| `branch_lab_test_id` | string (UUID) | required |
| `service_mode` | string | `CLINIC` or `HOME`, defaults to `CLINIC` |
| `appointment_date` | string | required, `YYYY-MM-DD`, not in the past |
| `start_time` | string | required, `HH:MM`, must be an available slot |
| `prescription_id` | string (UUID)? | required when `prescription_required` is `true` on the branch lab test |
| `patient_notes` | string? | max 1000 |
| `payment_method` | string | `PAY_AT_CLINIC` or `ONLINE`, defaults to `PAY_AT_CLINIC` |
| `home_address` | string? | required when `service_mode` is `HOME` |
| `home_lat` | number? | -90…90 |
| `home_lng` | number? | -180…180 |
| `home_contact_phone` | string? | max 32 |
| `home_notes` | string? | max 500 |

**Response `201`** — LabTestAppointment object (`status: "PENDING"`). A `lab_test_payment` record is also created with the appointment's price.

**Errors:** `400 IDEMPOTENCY_KEY_REQUIRED`, `400 VALIDATION_ERROR`, `404 BRANCH_NOT_FOUND`, `404 TEST_NOT_FOUND`, `409 SLOT_ALREADY_BOOKED`, `422 DATE_IN_PAST`, `422 OUTSIDE_SCHEDULE`, `422 PRESCRIPTION_REQUIRED`.

#### GET /patient/lab-test-appointments

Auth: `patient`. Cursor-paginated. Lists the caller's own lab test appointments.

**Query:** `?status=&upcoming=true&past=true&limit=&cursor=` — `status` filters by appointment status; `upcoming=true` returns future appointments only; `past=true` returns past appointments only. All optional.

**Response `200`**

```json
{
  "items": [ /* LabTestAppointment objects */ ],
  "next_cursor": null
}
```

#### GET /patient/lab-test-appointments/:id

Auth: `patient` (own) or any clinic staff/owner. Returns a single lab test appointment.

**Response `200`** — LabTestAppointment object with nested `test`, `branch`, `patient`, `clinic` objects when applicable.

**Errors:** `404 APPOINTMENT_NOT_FOUND`.

#### POST /lab-test-appointments/:id/cancel

Auth: `patient` (own) or `clinic_owner`/`branch_staff` (with `lab_appointments:cancel`). Rate limited 10/min. Patients can only cancel their own appointments. Transitions the appointment to `CANCELLED` via the state machine and sets `cancelled_at`.

On success, an in-app `lab_test_cancelled` notification is sent to the relevant parties.

**Request body**

```json
{ "reason": "Patient requested cancellation" }
```

**Response `200`** — LabTestAppointment object (`status: "CANCELLED"`).

**Errors:** `404 APPOINTMENT_NOT_FOUND`, `409 INVALID_STATUS_TRANSITION`.

#### POST /lab-test-appointments/:id/payment

Auth: `patient` (own). Rate limited 10/min. Initiates payment for a lab test appointment. Validates the appointment is in `PENDING` or `APPROVED` status.

**Request body**

```json
{
  "payment_method": "PAY_AT_CLINIC"
}
```

| Field | Type | Notes |
|---|---|---|
| `payment_method` | string | required, `PAY_AT_CLINIC` or `ONLINE` |

**Response `200`**

```json
{
  "id": "d4e5f6a7-...",
  "appointment_id": "c3d4e5f6-...",
  "amount": 800,
  "currency": "INR",
  "payment_method": "PAY_AT_CLINIC",
  "payment_status": "PENDING",
  "created_at": "2026-08-18T10:00:00Z"
}
```

**Errors:** `404 APPOINTMENT_NOT_FOUND`, `409 INVALID_STATUS_TRANSITION`.

### Clinic management: lab test CRUD

#### GET /clinic/lab-tests

Auth: `clinic_owner` (own clinics) or `branch_staff` (own clinic, read-only) or `sys_admin`. Cursor-paginated. Lists lab tests — for `clinic_owner` and `branch_staff`, scoped to their own clinic(s) unless narrowed further by `clinic_id`.

**Query:** `?clinic_id=&status=&category=&search=&limit=&cursor=` — all optional. `clinic_id` narrows to one clinic (useful when an owner has more than one); omitting it returns tests across every clinic the caller can see.

**Response `200`**

```json
{
  "items": [ /* LabTest objects */ ],
  "next_cursor": null
}
```

#### POST /clinic/lab-tests

Auth: `clinic_owner` or `sys_admin`. Rate limited 10/min. Creates a new lab test for the clinic.

`name` and `code` are both optional — omit them to quick-create from just a `category` (e.g. from a category-only combobox UI): `name` defaults to the category text, and `code` is auto-derived from it (slugified, deduped against the clinic's existing codes; there's no DB-level uniqueness constraint on `code`).

**Request body**

```json
{
  "clinic_id": "9d2f4c8a-1b3e-4a5d-8f6c-7a8b9c0d1e2f",
  "name": "ECG",
  "code": "ECG",
  "description": "Electrocardiogram test",
  "category": "cardiology",
  "instructions": "Avoid heavy exercise 1 hour before",
  "default_precautions": ["Remove metallic jewelry"]
}
```

| Field | Type | Notes |
|---|---|---|
| `clinic_id` | string (UUID) | required |
| `name` | string? | 1–255; defaults to `category` when omitted |
| `code` | string? | 1–50; auto-derived from `category` when omitted |
| `description` | string? | max 2000 |
| `category` | string | required, 1–100, free text — see [categories](#lab-test-categories) |
| `instructions` | string? | max 2000 |
| `default_precautions` | string[]? | array of strings, max 50 items, each max 255 chars |

**Response `201`** — LabTest object.

**Errors:** `400 VALIDATION_ERROR`.

#### GET /clinic/lab-tests/categories

Auth: `clinic_owner`, `branch_staff` (read-only), or `sys_admin`. Rate limited 60/min. Distinct `category` values already used across the caller's lab tests, for suggesting/autocompleting on create — not an exhaustive or fixed list.

**Query:** `?clinic_id=` — optional, narrows to one clinic.

**Response `200`**

```json
{ "items": ["cardiology", "ECG", "Diabetes Panel"] }
```

#### PUT /clinic/lab-tests/:id

Auth: `clinic_owner` or `sys_admin`. Rate limited 10/min. Updates a lab test. Full replace on optional fields.

**Request body** (any subset of the create body fields, excluding `clinic_id`)

```json
{ "name": "12-Lead ECG", "description": "Standard 12-lead electrocardiogram" }
```

**Response `200`** — LabTest object.

**Errors:** `404 TEST_NOT_FOUND`, `400 VALIDATION_ERROR`.

#### PATCH /clinic/lab-tests/:id/status

Auth: `clinic_owner` or `sys_admin`. Rate limited 10/min. Toggles a lab test between active and inactive. Inactive tests are hidden from patients and cannot be booked.

**Request body**

```json
{ "status": "inactive" }
```

| Field | Type | Notes |
|---|---|---|
| `status` | string | required, `active` or `inactive` |

**Response `200`** — LabTest object.

**Errors:** `404 TEST_NOT_FOUND`, `400 VALIDATION_ERROR`.

### Clinic management: branch test configuration

#### GET /clinic/branches/:branchId/lab-tests

Auth: `clinic_owner` (owns branch) or `branch_staff` (own branch, requires `lab_tests:manage`) or `sys_admin`. Lists branch lab test configurations.

**Query:** `?status=` (optional).

**Response `200`**

```json
{
  "items": [ /* BranchLabTest objects */ ]
}
```

**Errors:** `404 BRANCH_NOT_FOUND`.

#### POST /clinic/branches/:branchId/lab-tests

Auth: `clinic_owner` or `sys_admin`. Rate limited 10/min. Configures an existing lab test for a specific branch with pricing and availability settings.

**Request body**

```json
{
  "test_id": "a1b2c3d4-...",
  "price": 800,
  "currency": "INR",
  "duration_minutes": 30,
  "clinic_available": true,
  "home_collection_available": false,
  "prescription_required": false
}
```

| Field | Type | Notes |
|---|---|---|
| `test_id` | string (UUID) | required, must be a lab test belonging to the branch's clinic |
| `price` | number | required, > 0, ≤ 1,000,000 |
| `currency` | string | required, 3-letter code |
| `duration_minutes` | number | 5–240, defaults to 30 |
| `clinic_available` | boolean | defaults to `true` |
| `home_collection_available` | boolean | defaults to `false` |
| `prescription_required` | boolean | defaults to `false` |

**Response `201`** — BranchLabTest object.

**Errors:** `404 BRANCH_NOT_FOUND`, `404 TEST_NOT_FOUND`, `400 VALIDATION_ERROR`, `409 TEST_ALREADY_CONFIGURED_FOR_BRANCH`.

#### PUT /clinic/branches/:branchId/lab-tests/:id

Auth: `clinic_owner` or `sys_admin`. Rate limited 10/min. Updates a branch lab test configuration.

**Request body** (partial — any subset of the create body fields, excluding `test_id`)

```json
{ "price": 900, "home_collection_available": true }
```

**Response `200`** — BranchLabTest object.

**Errors:** `404 BRANCH_NOT_FOUND`, `404 TEST_NOT_FOUND`, `400 VALIDATION_ERROR`.

### Clinic management: lab test schedules

#### GET /clinic/branches/:branchId/lab-test-schedules

Auth: `clinic_owner` (owns branch) or `branch_staff` (own branch) or `sys_admin`. Lists the branch's weekly lab test schedules. Not paginated.

**Response `200`**

```json
{
  "items": [
    {
      "id": "e5f6a7b8-...",
      "branch_id": "5e8f6c7a-...",
      "weekday": 1,
      "start_time": "09:00",
      "end_time": "17:00",
      "is_active": true,
      "created_at": "2026-08-02T11:00:00Z",
      "updated_at": "2026-08-02T11:00:00Z"
    }
  ]
}
```

**Errors:** `404 BRANCH_NOT_FOUND`.

#### POST /clinic/branches/:branchId/lab-test-schedules

Auth: `clinic_owner` or `sys_admin`. Rate limited 10/min. Creates a weekly schedule entry for the branch. Multiple entries per weekday are allowed (e.g. morning + evening slots).

**Request body**

```json
{
  "weekday": 1,
  "start_time": "09:00",
  "end_time": "17:00",
  "is_active": true
}
```

| Field | Type | Notes |
|---|---|---|
| `weekday` | number | required, 0 (Sun) – 6 (Sat) |
| `start_time` | string | required, `HH:MM` (24h) |
| `end_time` | string | required, `HH:MM`, must be after `start_time` |
| `is_active` | boolean | defaults to `true` |

**Response `201`** — schedule entry object.

**Errors:** `404 BRANCH_NOT_FOUND`, `400 VALIDATION_ERROR` (`end_time` not after `start_time`).

#### PUT /clinic/branches/:branchId/lab-test-schedules/:id

Auth: `clinic_owner` or `sys_admin`. Rate limited 10/min. Updates a schedule entry.

**Request body** (partial — any subset of `weekday`, `start_time`, `end_time`, `is_active`)

```json
{ "end_time": "18:00" }
```

**Response `200`** — schedule entry object.

**Errors:** `404 BRANCH_NOT_FOUND`, `404 SCHEDULE_NOT_FOUND`, `400 VALIDATION_ERROR`.

#### DELETE /clinic/branches/:branchId/lab-test-schedules/:id

Auth: `clinic_owner` or `sys_admin`. Rate limited 10/min. Removes a schedule entry.

**Response `204`** — no body.

**Errors:** `404 BRANCH_NOT_FOUND`, `404 SCHEDULE_NOT_FOUND`.

### Clinic management: appointment management

#### GET /clinic/lab-test-appointments

Auth: `clinic_owner` (own clinics) or `branch_staff` (own branch, with `lab_appointments:view`) or `sys_admin`. Cursor-paginated. Lists all lab test appointments for the clinic.

**Query:** `?branch_id=&status=&test_id=&service_mode=&payment_status=&patient_name=&appointment_number=&date_from=&date_to=&limit=&cursor=` — all optional.

Sorted by status priority (`PENDING` first, then `APPROVED`, then others) then by `appointment_date`/`start_time` descending.

**Response `200`**

```json
{
  "items": [ /* LabTestAppointment objects with nested test, branch, patient */ ],
  "next_cursor": null
}
```

**Errors:** `403 PERMISSION_DENIED` (branch_staff without `lab_appointments:view`).

#### GET /clinic/lab-test-appointments/:id

Auth: `clinic_owner` (own clinics) or `branch_staff` (own branch, with `lab_appointments:view`) or `sys_admin`. Returns a single appointment with full detail including nested `prescriptions[]` and `payments[]` arrays.

**Response `200`** — LabTestAppointment object with `prescriptions` and `payments`.

**Errors:** `404 APPOINTMENT_NOT_FOUND`.

#### POST /clinic/lab-test-appointments/:id/approve

Auth: `clinic_owner` or `branch_staff` with `lab_appointments:approve` or `sys_admin`. Rate limited 10/min. Approves a `PENDING` appointment. Merges the branch test's `default_precautions` with any custom `precautions` passed in the request body.

On success, an in-app `lab_test_approved` notification is sent to the patient and an email is sent with the appointment details.

**Request body**

```json
{
  "precautions": ["Fasting required for 8 hours"],
  "clinic_notes": "Patient has a pacemaker — use limb leads only"
}
```

| Field | Type | Notes |
|---|---|---|
| `precautions` | string[]? | optional, merged with the test's `default_precautions` |
| `clinic_notes` | string? | max 2000 |

**Response `200`** — LabTestAppointment object (`status: "APPROVED"`, `precautions` and `clinic_notes` set).

**Errors:** `404 APPOINTMENT_NOT_FOUND`, `409 INVALID_STATUS_TRANSITION`.

#### POST /clinic/lab-test-appointments/:id/reject

Auth: `clinic_owner` or `branch_staff` with `lab_appointments:reject` or `sys_admin`. Rate limited 10/min. Rejects a `PENDING` appointment. A reason is required.

On success, an in-app `lab_test_rejected` notification is sent to the patient and an email is sent with the rejection reason.

**Request body**

```json
{ "reason": "Required specialist not available on this date" }
```

| Field | Type | Notes |
|---|---|---|
| `reason` | string | required, max 500 |

**Response `200`** — LabTestAppointment object (`status: "REJECTED"`, `rejection_reason` set).

**Errors:** `404 APPOINTMENT_NOT_FOUND`, `409 INVALID_STATUS_TRANSITION`.

#### POST /clinic/lab-test-appointments/:id/complete

Auth: `clinic_owner` or `branch_staff` with `lab_appointments:complete` or `sys_admin`. Rate limited 10/min. Marks an `APPROVED` appointment as completed. Sets `completed_at`.

On success, an in-app `lab_test_completed` notification is sent to the patient and an email is sent confirming the test is done.

**Response `200`** — LabTestAppointment object (`status: "COMPLETED"`).

**Errors:** `404 APPOINTMENT_NOT_FOUND`, `409 INVALID_STATUS_TRANSITION`.

#### POST /clinic/lab-test-appointments/:id/payment/collect

Auth: `clinic_owner` or `branch_staff` with `lab_payments:collect` or `sys_admin`. Rate limited 10/min. Collects a pay-at-clinic payment. Only valid for appointments with `payment_method = "PAY_AT_CLINIC"`.

**Request body**

```json
{ "reference_no": "CASH-00123" }
```

| Field | Type | Notes |
|---|---|---|
| `reference_no` | string? | max 255 |

**Response `200`**

```json
{
  "id": "d4e5f6a7-...",
  "appointment_id": "c3d4e5f6-...",
  "amount": 800,
  "currency": "INR",
  "payment_method": "PAY_AT_CLINIC",
  "payment_status": "PAID",
  "collected_by": "1a2b3c4d-...",
  "collected_at": "2026-08-25T09:30:00Z",
  "reference_no": "CASH-00123",
  "paid_at": "2026-08-25T09:30:00Z"
}
```

**Errors:** `404 APPOINTMENT_NOT_FOUND`, `409 INVALID_STATUS_TRANSITION`, `409 PAYMENT_ALREADY_COLLECTED`.

---

## Payment ledger

Every successful `PATCH /appointments/:id/payment` accumulates into a per-clinic, per-branch, per-month running total (`clinic_payment_ledger`), keyed on `(clinic_id, branch_id, period_month, currency)`.

### GET /clinics/:clinicId/ledger

Auth: `clinic_owner`, must own the clinic. **Not** paginated.

**Query:** `?month=YYYY-MM` (optional — omit for all months, newest first)

**Response `200`**

```json
{
  "items": [
    {
      "id": "9c1d2b7a-5e4f-8c1d-3f9d-6b5e8f6b4e3a",
      "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
      "branch_name": "Sunrise — Andheri",
      "period_month": "2026-08",
      "currency": "INR",
      "total_amount": 12500,
      "payment_count": 25,
      "updated_at": "2026-08-09T12:30:00.000Z"
    }
  ]
}
```

**Errors:** `404 CLINIC_NOT_FOUND`, `403 NOT_CLINIC_OWNER`, `400 VALIDATION_ERROR` (bad `month`).

---

## Prescriptions

`Prescription` object:

```json
{
  "id": "a0b1c2d3-e4f5-6789-0abc-def123456789",
  "appointment_id": "f1e2d3c4-b5a6-7980-9a8b-7c6d5e4f3a2b",
  "doctor_id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "scan_url": null,
  "digitized_text": "Tab. Aspirin 75mg OD x 30 days",
  "ocr_confidence": null,
  "finalized_at": "2026-08-09T12:30:00Z",
  "created_at": "2026-08-09T12:30:00Z",
  "updated_at": "2026-08-09T12:30:00Z"
}
```

For `branch_staff`/`clinic_owner` callers, `digitized_text` is redacted to `null`.

### POST /appointments/:id/prescription/scan

Auth: `doctor` (assigned to the appointment). Requires appointment status `paid` or `completed`.
`multipart/form-data`, field `file`. Allowed: `image/jpeg`, `image/png`, `image/webp`, ≤ 10MB. Starts an async OCR job.

**Response `202`**

```json
{
  "job_id": "1f2e3d4c-5b6a-7980-9a8b-7c6d5e4f3a2b",
  "status": "processing"
}
```

**Errors:** `403 NOT_ASSIGNED_DOCTOR`, `409 APPOINTMENT_NOT_YET_PAID`, `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`.

### GET /prescription-scan-jobs/:jobId

Auth: `doctor` (owner of the job). Poll until `status` is `done`.

**Response `200`**

```json
{
  "status": "done",
  "draft_text": "[OCR DRAFT] Digitized prescription for appointment f1e2...\nGenerated 2026-08-09T12:35:00.000Z — review and edit before publishing to the patient.",
  "confidence": 94.2
}
```

**Errors:** `404 JOB_NOT_FOUND`.

### PUT /appointments/:id/prescription

Auth: `doctor` (assigned). Upserts the prescription and sets `finalized_at`.

**Request body**

```json
{
  "text": "Tab. Aspirin 75mg OD x 30 days\nTab. Atorvastatin 10mg HS x 30 days",
  "scan_url": "https://api.medibook.app/api/v1/files/prescription-scan-1f2e...jpg?expires=...&sig=..."
}
```

| Field | Type | Notes |
|---|---|---|
| `text` | string | required, 1–50,000 chars |
| `scan_url` | string? | max 500 |

**Response `200`** — Prescription object.

**Errors:** `403 NOT_ASSIGNED_DOCTOR`.

### GET /appointments/:id/prescription

Auth: `patient` (own), `doctor` (assigned), `branch_staff`/`clinic_owner` (own branch; text redacted).

**Response `200`** — Prescription object.

**Errors:** `404 PRESCRIPTION_NOT_FOUND`.

### GET /appointments/:id/prescription/pdf

Auth: same as GET prescription.

**Response `200`** — `application/pdf`, inline attachment `prescription-<id>.pdf`.

**Errors:** `404 PRESCRIPTION_NOT_FOUND`.

### POST /appointments/:id/prescription/email

Auth: `doctor` (assigned) or `patient` (own). Sends the prescription email (fire-and-forget).

**Response `202`**

```json
{ "queued": true }
```

---

## Medical documents

`MedicalDocument` object:

```json
{
  "id": "8f7e6d5c-4b3a-2908-1f0e-9d8c7b6a5f4e",
  "patient_id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "category": "lab_report",
  "file_url": "https://api.medibook.app/api/v1/files/medical-doc-8f7e...pdf?expires=...&sig=...",
  "file_name": "blood-report.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 245760,
  "uploaded_at": "2026-08-09T11:00:00Z"
}
```

`category` ∈ `prescription | lab_report | doctor_note | other` (defaults to `other`). Note that finalized in-app prescriptions live under [Prescriptions](#prescriptions) (`GET /appointments/:id/prescription`) — this `category` is for patient-uploaded scans/photos of prescriptions, not the digitized record.

### POST /patients/me/medical-documents

Auth: `patient`. `multipart/form-data`, fields `file` (required) and `category` (optional, defaults to `other`).
Allowed: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`, ≤ 20MB.

**Response `201`** — MedicalDocument object.

**Errors:** `400 VALIDATION_ERROR` (bad `category`), `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`.

### GET /patients/me/medical-documents

Auth: `patient`.

**Query:** `?category=` (optional — one of `prescription`, `lab_report`, `doctor_note`, `other`)

**Response `200`**

```json
{ "items": [ /* MedicalDocument objects, newest first */ ] }
```

**Errors:** `400 VALIDATION_ERROR` (bad `category`).

### DELETE /medical-documents/:id

Auth: `patient` (owner only).

**Response `204 No Content`**

**Errors:** `404 DOCUMENT_NOT_FOUND`.

### GET /patients/:patientId/medical-documents

Auth: `doctor` **only**, and only with a non-cancelled appointment relationship to the patient.

**Response `200`**

```json
{ "items": [ /* MedicalDocument objects */ ] }
```

**Errors:** `403 NO_APPOINTMENT_RELATIONSHIP`.

---

## Notifications

`Notification` object:

```json
{
  "id": "2e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "user_id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "branch_id": null,
  "type": "booking_confirmed",
  "payload": { "appointment_id": "f1e2d3c4-...", "date": "2026-08-10", "time": "09:20" },
  "read_at": null,
  "created_at": "2026-08-09T10:10:00Z"
}
```

`type` ∈ `new_booking | booking_confirmed | payment_received | consultation_completed | prescription_ready | doctor_invited | doctor_invite_accepted | appointment_cancelled | lab_test_booked | lab_test_approved | lab_test_rejected | lab_test_cancelled | lab_test_completed`

**Delivery:** notifications are stored in-app and polled via the endpoints below. Patient-facing events (`booking_confirmed`, `payment_received`, `consultation_completed`, `prescription_ready`, and patient-cancelled/`appointment_cancelled` by staff) additionally fan out a **push** notification via Firebase Cloud Messaging to every device the patient is registered on (see [Device tokens](#device-tokens) below). Push failures never fail the triggering request.

### Device tokens

The mobile app registers one FCM token per device install so a patient signed in on multiple phones/tablets gets pushes on all of them.

#### POST /notifications/device-tokens

Auth: any authenticated role.

**Request body**

```json
{ "token": "f7c3b9...(FCM registration token)", "platform": "android" }
```

`platform` ∈ `android | ios`. If the token is already registered to a different user (e.g. a shared device that logged into a new account), it's reassigned to the caller.

**Response `201`** — `{ "registered": true }`

#### DELETE /notifications/device-tokens?token=...

Auth: owner of the token. Called on logout/uninstall. Idempotent — succeeds even if the token was never registered or already removed.

**Response `204 No Content`**

### GET /notifications

Auth: any authenticated role. Scoped to the caller (branch staff also see their branch's notifications). Paginated.

**Query:** `?unread_only=true&limit=&cursor=`

**Response `200`**

```json
{
  "items": [ /* Notification objects */ ],
  "unread_count": 3,
  "next_cursor": null
}
```

### PATCH /notifications/:id/read

Auth: owner of the notification.

**Response `200`** — Notification object with `read_at` set.

**Errors:** `404 NOTIFICATION_NOT_FOUND`.

### PATCH /notifications/read-all

Auth: any authenticated role.

**Request body** (optional)

```json
{ "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b" }
```

**Response `204 No Content`**

---

## Files (signed URLs)

### GET /files/:key

Public, but requires a valid signature. `key` is the encoded file name; query params `expires` (unix seconds) and `sig` (HMAC-SHA256 hex) are produced by the upload endpoints.

**Response `200`** — file bytes. `Content-Type` set from the extension, `Cache-Control: private, no-store`.

**Errors:** `403 INVALID_SIGNED_URL` (missing/invalid/expired signature or file not found).

---

## Error codes

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400/422 | Schema/field validation failure (`field` is set) |
| `INVALID_JSON` | 400 | Body is not a valid JSON object |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Missing `Idempotency-Key` header |
| `FILE_REQUIRED` / `FILE_EMPTY` | 400 | Missing or empty upload field |
| `INVALID_PUBLIC_ID` | 400 | Photo `public_id` was not issued by a signature endpoint |
| `INVALID_LICENSE_TYPE` | 400 | License upload `:type` is not one of `trade-license`, `drug-license`, `clinical-establishment-registration` |
| `UNAUTHORIZED` | 401 | No/invalid token |
| `INVALID_CREDENTIALS` | 401 | Wrong email/password |
| `ACCOUNT_DISABLED` | 401/403 | Account not `active` |
| `INVALID_OTP` / `OTP_MAX_ATTEMPTS` | 401 | OTP failure |
| `RESET_TOKEN_INVALID` | 400 | Reset token missing, already used, or unknown |
| `REFRESH_TOKEN_INVALID` | 401 | Refresh token invalid/expired/revoked |
| `INSUFFICIENT_ROLE` | 403 | Authenticated but wrong role |
| `PERMISSION_DENIED` | 403 | `branch_staff` lacks the required branch permission for the action |
| `NOT_CLINIC_OWNER` | 403 | Not the owner of the clinic/branch |
| `NOT_ASSIGNED_DOCTOR` | 403 | Doctor is not assigned to this appointment |
| `NO_APPOINTMENT_RELATIONSHIP` | 403 | No appointment link with the patient |
| `FEE_OWNER_CONTROLLED` | 403 | Doctor tried to change the fee |
| `INVALID_SIGNED_URL` | 403 | Bad/expired file URL signature |
| `CLINIC_NOT_FOUND` / `BRANCH_NOT_FOUND` / `DOCTOR_NOT_FOUND` / `ASSIGNMENT_NOT_FOUND` / `INVITE_NOT_FOUND` / `APPOINTMENT_NOT_FOUND` / `PRESCRIPTION_NOT_FOUND` / `DOCUMENT_NOT_FOUND` / `NOTIFICATION_NOT_FOUND` / `JOB_NOT_FOUND` / `IMAGE_NOT_FOUND` / `SESSION_NOT_FOUND` / `EXCEPTION_NOT_FOUND` / `CLOSURE_NOT_FOUND` / `TEST_NOT_FOUND` / `SCHEDULE_NOT_FOUND` | 404 | Resource missing (or not visible to the caller) |
| `INVITE_EXPIRED` / `OTP_EXPIRED` / `RESET_TOKEN_EXPIRED` | 410 | Expired one-time code |
| `FILE_TOO_LARGE` | 413 | Upload exceeds size limit |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Upload has a disallowed MIME type |
| `RATE_LIMITED` | 429 | Too many requests |
| `EMAIL_ALREADY_REGISTERED` | 409 | Email already in use |
| `REG_NO_ALREADY_REGISTERED` | 409 | Doctor registration number already in use |
| `INVITE_ALREADY_PENDING` | 409 | Duplicate pending invite |
| `INVITE_ALREADY_ACCEPTED` | 409 | Invite already accepted |
| `DOCTOR_ALREADY_ASSIGNED` | 409 | Doctor already at this branch |
| `STAFF_ALREADY_EXISTS_FOR_BRANCH` | 409 | Staff email already registered to the branch |
| `SLOT_ALREADY_BOOKED` | 409 | Slot taken (DB-level unique guard, `fixed` doctors) |
| `DOCTOR_FULLY_BOOKED` | 409 | No slots left that date (`sequential` doctors) |
| `DOCTOR_ON_LEAVE` | 409 | Booking date falls within an active doctor leave |
| `CLINIC_CLOSED` | 409 | Branch not open (or under an active closure) on the selected date |
| `INVALID_STATUS_TRANSITION` | 409 | Appointment status change not allowed |
| `CANNOT_CANCEL_PAID_APPOINTMENT` | 409 | Patient cannot cancel a paid appointment |
| `DOCTOR_HAS_ACTIVE_APPOINTMENTS` | 409 | Cannot remove doctor with live appointments |
| `CLINIC_HAS_ACTIVE_APPOINTMENTS` | 409 | Clinic/branch has non-terminal appointments |
| `APPOINTMENT_NOT_YET_PAID` | 409 | Prescription scan before payment |
| `APPOINTMENT_NOT_COMPLETED` | 409 | Tried to rate a doctor before the appointment was completed |
| `TEST_CODE_ALREADY_EXISTS` | 409 | Lab test code already exists for this clinic |
| `TEST_ALREADY_CONFIGURED_FOR_BRANCH` | 409 | Lab test is already configured for this branch |
| `PAYMENT_ALREADY_COLLECTED` | 409 | Lab test payment was already collected |
| `OUTSIDE_DOCTOR_AVAILABILITY` / `DATE_IN_PAST` / `OUTSIDE_SCHEDULE` | 422 | Booking rules violated |
| `TRADE_LICENSE_NOT_VALIDATED` | 422 | `POST /clinics` without a `trade_license_validation_status: "VALID"` from a prior validate call |
| `PRESCRIPTION_REQUIRED` | 422 | Lab test requires a prescription but none was provided |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

## Status transition table

| From | To | Endpoint | Allowed roles |
|---|---|---|---|
| — | `pending` | `POST /appointments` | patient |
| `pending` | `confirmed` | `PATCH /appointments/:id/confirm` | branch_staff, clinic_owner |
| `pending` | `cancelled` | `PATCH /appointments/:id/cancel` | patient, branch_staff, clinic_owner |
| `confirmed` | `paid` | `PATCH /appointments/:id/payment` | branch_staff, clinic_owner |
| `confirmed` | `cancelled` | `PATCH /appointments/:id/cancel` | patient, branch_staff, clinic_owner |
| `paid` | `completed` | `PATCH /appointments/:id/complete` | branch_staff, clinic_owner |
| `paid` | `cancelled` | `PATCH /appointments/:id/cancel` | branch_staff, clinic_owner |

Any other transition returns `409 INVALID_STATUS_TRANSITION`.

### Lab test status transitions

| From | To | Endpoint | Allowed roles |
|---|---|---|---|
| — | `PENDING` | `POST /lab-test-appointments` | patient |
| `PENDING` | `APPROVED` | `POST /clinic/lab-test-appointments/:id/approve` | clinic_owner, branch_staff |
| `PENDING` | `REJECTED` | `POST /clinic/lab-test-appointments/:id/reject` | clinic_owner, branch_staff |
| `PENDING` | `CANCELLED` | `POST /lab-test-appointments/:id/cancel` | patient, clinic_owner, branch_staff |
| `APPROVED` | `COMPLETED` | `POST /clinic/lab-test-appointments/:id/complete` | clinic_owner, branch_staff |
| `APPROVED` | `CANCELLED` | `POST /lab-test-appointments/:id/cancel` | patient, clinic_owner, branch_staff |

Any other transition returns `409 INVALID_STATUS_TRANSITION`.

---

## End-to-end examples

### Doctor onboarding

```
POST /auth/clinic-owner/register
POST /clinics                       {name, trade_license_number}
POST /clinics/:clinicId/branches    {name, address, phone, timezone, trade_license_number}
POST /branches/:id/doctor-invites   {name, specialization_ids, email, fee_amount, currency, slot_type, slot_template}
  → invite code emailed to the doctor
POST /auth/doctor/accept-invite     {email, invite_code, password, reg_no}
GET  /branches/:id/doctors          → doctor now listed
```

### Booking → payment → completion

```
GET  /clinics?search=Sunrise
GET  /clinics/:clinicId/branches
GET  /branches/:id/doctors
GET  /doctors/:doctorId/availability/calendar?branch_id=...&year=2026&month=8
GET  /doctors/:doctorId/availability?date=2026-08-10&branch_id=...
POST /appointments   {doctor_id, branch_id, date, time?}   [Idempotency-Key]   (time omitted for "sequential" doctors)
PATCH /appointments/:id/confirm
PATCH /appointments/:id/payment     {fee_amount, method}   [Idempotency-Key]
PUT   /appointments/:id/prescription {text}
PATCH /appointments/:id/complete
GET   /appointments/:id/prescription/pdf
```

### Lab test booking → approval → completion

```
POST /auth/patient/login                     {email, password}
GET  /branches/:branchId/lab-tests           ?category=blood_test
GET  /branches/:branchId/lab-tests/:testId   (detail + price, duration)
GET  /branches/:branchId/lab-tests/:testId/availability?date=2026-08-25
POST /lab-test-appointments                  {branch_id, branch_lab_test_id, appointment_date, start_time, payment_method}   [Idempotency-Key]
POST /lab-test-appointments/:id/payment      {payment_method}
GET  /patient/lab-test-appointments          ?status=PENDING
POST /clinic/lab-test-appointments/:id/approve   {precautions: ["Fasting required"]}
POST /clinic/lab-test-appointments/:id/payment/collect   {reference_no: "CASH-001"}
POST /clinic/lab-test-appointments/:id/complete
GET  /patient/lab-test-appointments/:id      (final status: COMPLETED)
```
