# MediBook — REST API Reference

Live implementation reference for the MediBook API. Every endpoint below documents the **actual request/response payloads** produced by the code in `src/app/api/v1`, with JSON examples.

- **Base URL:** `http://localhost:3000/api/v1` (dev) or `https://api.medibook.app/api/v1` (prod)
- **Format:** JSON only (`Content-Type: application/json`), except legacy upload endpoints (certificates, prescription scans, medical documents) and clinic/branch license uploads which use `multipart/form-data`, and photo uploads which use a two-step Cloudinary flow (see [File uploads](#file-uploads)).
- **Auth:** `Authorization: Bearer <access_token>` (JWT, 15 min TTL). Refresh via `POST /auth/refresh`.
- **IDs:** all resource IDs are UUIDs (v4), generated server-side.

---

## Table of contents

1. [Conventions](#conventions)
2. [Roles & scope](#roles--scope)
3. [Authentication](#authentication)
4. [Clinics](#clinics)
5. [Branches](#branches)
6. [Clinic & branch licenses](#clinic--branch-licenses)
7. [Branch staff](#branch-staff)
8. [Doctors, invites & assignments](#doctors-invites--assignments)
9. [Patients](#patients)
10. [Appointments](#appointments)
11. [Payment ledger](#payment-ledger)
12. [Prescriptions](#prescriptions)
13. [Medical documents](#medical-documents)
14. [Notifications](#notifications)
15. [Files (signed URLs)](#files-signed-urls)
16. [Error codes](#error-codes)
17. [Status transition table](#status-transition-table)

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

**Photos (doctor, branch, branch gallery)** — uploaded directly to Cloudinary from the client, in two steps:

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
  "password": "password123"
}
```

| Field | Type | Notes |
|---|---|---|
| `name` | string | required, 1–255 chars |
| `email` | string | required, lowercase, must be valid |
| `phone` | string? | optional, max 32 |
| `password` | string | required, 8–128 chars |

**Response `201`**

```json
{
  "user": {
    "id": "3f9d6b5e-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
    "name": "Aisha Verma",
    "email": "aisha@example.com",
    "phone": "+919876543210",
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

Public. Rate limited 10/min per IP. Activates a `clinic_owner` account (`status: 'pending'` → `'active'`) using the token from the welcome email sent by `POST /auth/clinic-owner/register`. The token is single-use and expires after 24 hours.

The verification link is emailed as `{VERIFY_EMAIL_URL}/verify_email?token={VERIFICATION_TOKEN}` — `VERIFY_EMAIL_URL` defaults to `https://medinexa-clinic.onrender.com`.

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

**Errors:** `400 VALIDATION_ERROR`, `400 VERIFICATION_TOKEN_INVALID`, `410 VERIFICATION_TOKEN_EXPIRED`.

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
    "specialization": "Cardiologist",
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
  "reg_no": "MC-123456"
}
```

| Field | Type | Notes |
|---|---|---|
| `email` | string | required, must match a pending invite |
| `invite_code` | string | required, 1–32 chars |
| `password` | string | required, 8–128 chars |
| `reg_no` | string? | optional registration number, max 64, unique |

**Response `200`**

```json
{
  "access_token": "<jwt>",
  "refresh_token": "<opaque>",
  "doctor": {
    "id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
    "name": "Dr. Smith",
    "specialization": "Cardiologist",
    "phone": "+919900000001",
    "certificate_url": null,
    "bio": null
  }
}
```

**Errors:** `404 INVITE_NOT_FOUND`, `410 INVITE_EXPIRED`, `409 INVITE_ALREADY_ACCEPTED`, `409 EMAIL_ALREADY_REGISTERED`, `409 REG_NO_ALREADY_REGISTERED`.

### POST /auth/branch-staff/login

Requests a passwordless OTP for an existing staff account. Rate limited 10/min per IP.
Always returns the same message (does not reveal whether the email exists).

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
  "drug_license_number": "DL-MH-2026-1187",
  "clinical_establishment_reg_number": "CER-MH-2026-0932"
}
```

| Field | Type | Notes |
|---|---|---|
| `trade_license_number` | string | **required**, issued by the local municipality, 1–100 |
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
  "drug_license_number": "DL-MH-2026-1187",
  "drug_license_url": null,
  "clinical_establishment_reg_number": "CER-MH-2026-0932",
  "clinical_establishment_reg_url": null,
  "created_at": "2026-08-09T10:00:00.000Z"
}
```

License document URLs are `null` until uploaded via `POST /clinics/:clinicId/licenses/:type` (see [Clinic & branch licenses](#clinic--branch-licenses)).

**Errors:** `400 VALIDATION_ERROR` (missing `trade_license_number`).

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

**Request body** (partial) — any subset of `name, description, nearby_location, city, district, pin_code, state, post_office, trade_license_number, drug_license_number, clinical_establishment_reg_number`. `trade_license_number` cannot be cleared to `null`; `drug_license_number` and `clinical_establishment_reg_number` can.

```json
{ "name": "Sunrise Heart & Care", "description": null, "nearby_location": "Opposite City Mall", "city": "Mumbai", "district": "Mumbai Suburban", "pin_code": "400058", "state": "Maharashtra", "post_office": "Andheri West GPO", "drug_license_number": null }
```

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
  "drug_license_number": null,
  "drug_license_url": null,
  "clinical_establishment_reg_number": "CER-MH-2026-0932",
  "clinical_establishment_reg_url": null,
  "created_at": "2026-08-01T09:30:00Z"
}
```

**Errors:** `404 CLINIC_NOT_FOUND`, `403 NOT_CLINIC_OWNER`.

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
      "created_at": "2026-08-02T11:00:00Z"
    }
  ]
}
```

**Errors:** `404 CLINIC_NOT_FOUND`.

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
  "specialization": "Cardiologist",
  "email": "dr.smith@example.com",
  "phone": "+919900000001",
  "fee_amount": 500,
  "currency": "INR",
  "certificate": "https://example.com/cert.pdf",
  "slot_template": [
    {
      "weekday": 1,
      "start_time": "09:00",
      "end_time": "13:00",
      "slot_duration_minutes": 20
    },
    {
      "weekday": 3,
      "start_time": "16:00",
      "end_time": "20:00",
      "slot_duration_minutes": 20
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `name` | string | required |
| `specialization` | string? | max 255 |
| `email` | string | required |
| `phone` | string? | max 32 |
| `fee_amount` | number | required, > 0, ≤ 1,000,000 |
| `currency` | string | required, 3-letter code |
| `certificate` | string? | max 500 |
| `slot_template` | array | required, ≥ 1 entry |
| `slot_template[].weekday` | number | 0 (Sun) – 6 (Sat) |
| `slot_template[].start_time` | string | `HH:MM` |
| `slot_template[].end_time` | string | `HH:MM`, must be after start |
| `slot_template[].slot_duration_minutes` | number | 5–240 |

**Response `201`**

```json
{
  "id": "7c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "email": "dr.smith@example.com",
  "status": "pending",
  "expires_at": "2026-08-16T10:00:00Z"
}
```

**Errors:** `409 INVITE_ALREADY_PENDING`, `409 DOCTOR_ALREADY_ASSIGNED`.

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
      "status": "pending",
      "expires_at": "2026-08-16T10:00:00Z",
      "created_at": "2026-08-09T10:00:00Z"
    }
  ]
}
```

`status` ∈ `pending | accepted | expired | revoked`.

### DELETE /doctor-invites/:id

Auth: `clinic_owner` **or** `branch_staff` with `doctors:manage`. Revokes a pending invite.

**Response `204 No Content`**

**Errors:** `404 INVITE_NOT_FOUND`, `409 INVITE_ALREADY_ACCEPTED`.

### GET /branches/:id/doctors

Public. Returns only **accepted** doctors assigned to the branch.

**Response `200`**

```json
{
  "items": [
    {
      "id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
      "assignment_id": "e4f5a6b7-8c9d-0e1f-2a3b-4c5d6e7f8a9b",
      "name": "Dr. Smith",
      "specialization": "Cardiologist",
      "phone": "+919900000001",
      "certificate_url": null,
      "fee_amount": 500,
      "currency": "INR",
      "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
      "next_available_slot": "2026-08-10T09:20:00"
    }
  ]
}
```

`id` is the doctor's own id. `assignment_id` is the id of this doctor's assignment to the branch — use it for `PATCH /doctor-assignments/:id` and `DELETE /doctor-assignments/:id`, not `id`. `next_available_slot` is a localized `YYYY-MM-DDTHH:MM:00` string or `null`.

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

Auth: `clinic_owner` (branch scope) **or** `doctor` (self) **or** `branch_staff` with `doctors:manage`. Doctors may only update `slot_template`/`certificate`; attempting to set `fee_amount` as a doctor returns `403 FEE_OWNER_CONTROLLED`.

**Request body** (partial)

```json
{
  "fee_amount": 600,
  "slot_template": [{ "weekday": 2, "start_time": "10:00", "end_time": "14:00", "slot_duration_minutes": 30 }],
  "certificate": "https://example.com/new-cert.pdf"
}
```

**Response `200`**

```json
{
  "id": "e4f5a6b7-8c9d-0e1f-2a3b-4c5d6e7f8a9b",
  "doctor_id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "fee_amount": 600,
  "currency": "INR",
  "certificate_url": "https://example.com/new-cert.pdf"
}
```

**Errors:** `404 ASSIGNMENT_NOT_FOUND`, `403 FEE_OWNER_CONTROLLED`.

### DELETE /doctor-assignments/:id

Auth: `clinic_owner` **or** `branch_staff` with `doctors:manage`. Deactivates the assignment (soft-removes the doctor from the branch; does not delete the doctor's account).

**Response `204 No Content`**

**Errors:** `409 DOCTOR_HAS_ACTIVE_APPOINTMENTS`.

### GET /doctors/me

Auth: `doctor`.

**Response `200`**

```json
{
  "id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "name": "Dr. Smith",
  "specialization": "Cardiologist",
  "reg_no": "MC-123456",
  "phone": "+919900000001",
  "certificate_url": null,
  "bio": null
}
```

### PATCH /doctors/me

Auth: `doctor`.

**Request body** (partial)

```json
{ "name": "Dr. John Smith", "reg_no": "MC-654321", "phone": "+919900000002", "bio": "MBBS, MD (Cardiology)" }
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

Searches `reg_no` (prefix), `name` (contains), and `specialization` (contains). Results ordered by exact `reg_no` match first.

**Response `200`**

```json
{
  "items": [
    {
      "id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
      "name": "Dr. Smith",
      "specialization": "Cardiologist",
      "reg_no": "MC-123456",
      "phone": "+919900000001",
      "clinic_count": 1
    }
  ]
}
```

**Errors:** `400 VALIDATION_ERROR` (missing `q`), `401 UNAUTHORIZED`.

### GET /doctors/:id/availability

Public.

**Query:** `?date=2026-08-10` (required, `YYYY-MM-DD`)

**Response `200`**

```json
{
  "date": "2026-08-10",
  "slots": [
    { "time": "09:00", "available": true },
    { "time": "09:20", "available": true },
    { "time": "09:40", "available": false }
  ]
}
```

**Errors:** `422 VALIDATION_ERROR` (bad date), `404 DOCTOR_NOT_FOUND`.

---

## Patients

Patients are `users` rows with `role = 'patient'` — there is no separate `patients` table. This section lists patients who have booked at least one (non-cancelled) appointment at a given branch.

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
  "updated_at": "2026-08-09T10:05:00Z"
}
```

`status` ∈ `pending | confirmed | paid | completed | cancelled | no_show`

List and detail responses enrich this base object:

- `GET /appointments` items additionally include `doctor_name` and `branch_name`.
- `GET /appointments/:id` additionally includes `doctor_name`, `branch_name`, and a nested `patient` object: `{ id, name, email, phone, address, photo_url }`.

### POST /appointments

Auth: `patient`. Header `Idempotency-Key` **required**.

On success, an in-app notification (`new_booking`) is created for every branch staff member **and** the clinic owner, and each of them is emailed the patient's name/email/phone and the doctor's name.

**Request body**

```json
{
  "doctor_id": "c6b9d2e1-8f6b-4e3a-9c1d-2b7a5e4f8c1d",
  "branch_id": "5e8f6c7a-9d2f-4c8a-1b3e-4a5d8f6c7a8b",
  "date": "2026-08-10",
  "time": "09:20"
}
```

| Field | Type | Notes |
|---|---|---|
| `doctor_id` | string (UUID) | required |
| `branch_id` | string (UUID) | required |
| `date` | string | required, `YYYY-MM-DD`, not in the past |
| `time` | string | required, `HH:MM`, must be an aligned slot |

**Response `201`** — Appointment object (`status: "pending"`).

**Errors:** `400 IDEMPOTENCY_KEY_REQUIRED`, `409 SLOT_ALREADY_BOOKED`, `422 OUTSIDE_DOCTOR_AVAILABILITY`, `422 DATE_IN_PAST`, `404 BRANCH_NOT_FOUND`, `404 DOCTOR_NOT_FOUND`.

### GET /appointments

Auth: any authenticated role. Scope auto-applied: `patient` → own; `branch_staff` → own branch; `doctor` → own; `clinic_owner` → own clinics. Paginated.

**Query:** `?status=&date_from=&date_to=&limit=&cursor=` (`status` must be one of the enum values).

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
  "file_url": "https://api.medibook.app/api/v1/files/medical-doc-8f7e...pdf?expires=...&sig=...",
  "file_name": "blood-report.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 245760,
  "uploaded_at": "2026-08-09T11:00:00Z"
}
```

### POST /patients/me/medical-documents

Auth: `patient`. `multipart/form-data`, field `file`.
Allowed: `image/jpeg`, `image/png`, `image/webp`, `application/pdf`, ≤ 20MB.

**Response `201`** — MedicalDocument object.

**Errors:** `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`.

### GET /patients/me/medical-documents

Auth: `patient`.

**Response `200`**

```json
{ "items": [ /* MedicalDocument objects, newest first */ ] }
```

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

`type` ∈ `new_booking | booking_confirmed | payment_received | consultation_completed | prescription_ready | doctor_invited | doctor_invite_accepted | appointment_cancelled`

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
| `CLINIC_NOT_FOUND` / `BRANCH_NOT_FOUND` / `DOCTOR_NOT_FOUND` / `ASSIGNMENT_NOT_FOUND` / `INVITE_NOT_FOUND` / `APPOINTMENT_NOT_FOUND` / `PRESCRIPTION_NOT_FOUND` / `DOCUMENT_NOT_FOUND` / `NOTIFICATION_NOT_FOUND` / `JOB_NOT_FOUND` / `IMAGE_NOT_FOUND` | 404 | Resource missing (or not visible to the caller) |
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
| `SLOT_ALREADY_BOOKED` | 409 | Slot taken (DB-level unique guard) |
| `INVALID_STATUS_TRANSITION` | 409 | Appointment status change not allowed |
| `CANNOT_CANCEL_PAID_APPOINTMENT` | 409 | Patient cannot cancel a paid appointment |
| `DOCTOR_HAS_ACTIVE_APPOINTMENTS` | 409 | Cannot remove doctor with live appointments |
| `CLINIC_HAS_ACTIVE_APPOINTMENTS` | 409 | Clinic/branch has non-terminal appointments |
| `APPOINTMENT_NOT_YET_PAID` | 409 | Prescription scan before payment |
| `OUTSIDE_DOCTOR_AVAILABILITY` / `DATE_IN_PAST` | 422 | Booking rules violated |
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

---

## End-to-end examples

### Doctor onboarding

```
POST /auth/clinic-owner/register
POST /clinics                       {name, trade_license_number}
POST /clinics/:clinicId/branches    {name, address, phone, timezone, trade_license_number}
POST /branches/:id/doctor-invites   {name, specialization, email, fee_amount, currency, slot_template}
  → invite code emailed to the doctor
POST /auth/doctor/accept-invite     {email, invite_code, password, reg_no}
GET  /branches/:id/doctors          → doctor now listed
```

### Booking → payment → completion

```
GET  /clinics?search=Sunrise
GET  /clinics/:clinicId/branches
GET  /branches/:id/doctors
GET  /doctors/:doctorId/availability?date=2026-08-10
POST /appointments   {doctor_id, branch_id, date, time}   [Idempotency-Key]
PATCH /appointments/:id/confirm
PATCH /appointments/:id/payment     {fee_amount, method}   [Idempotency-Key]
PUT   /appointments/:id/prescription {text}
PATCH /appointments/:id/complete
GET   /appointments/:id/prescription/pdf
```
