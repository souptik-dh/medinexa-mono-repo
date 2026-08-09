# MediBook — Clinic / Branch / Doctor / Patient Booking System
## Technical Specification (v2.0 — API-First)

**Status:** Draft for development
**Audience:** Engineering, QA, Product
**Approach:** This spec defines the API contract first. It is the source of truth — clients (patient app, clinic web portal, doctor app) are built against it, not the other way around. Any client screen or flow must be traceable to one or more endpoints below. No endpoint should exist only because a screen needs it without a documented resource/contract reason.

---

## 1. Actors & Auth Scopes

| Actor | `role` claim | Scope |
|---|---|---|
| Patient | `patient` | Own resources only (`patient_id` = token subject) |
| Clinic Owner | `clinic_owner` | Resources under clinics they own |
| Branch Staff | `branch_staff` | Resources under their assigned `branch_id` only |
| Doctor | `doctor` | Own profile + appointments/patients linked to them |
| System Admin | `sys_admin` | Internal only, not exposed to client apps in v1 |

Every endpoint below states its **required role(s)** and **scope rule**. Scope is enforced server-side in the data-access layer (not just checked in the controller) — a query must be structurally incapable of returning another tenant's rows.

---

## 2. API Design Standards

- **Base URL:** `https://api.medibook.app/api/v1`
- **Format:** JSON only. `Content-Type: application/json`, except file upload endpoints which use `multipart/form-data`.
- **Auth:** `Authorization: Bearer <access_token>` (JWT, 15 min TTL) on all non-public endpoints. Refresh via `/auth/refresh` (refresh token, 30 day TTL, rotated on use).
- **Versioning:** URI-versioned (`/v1`). Breaking changes ship as `/v2`; additive changes (new optional fields) do not bump version.
- **Pagination:** cursor-based on all list endpoints — `?limit=20&cursor=<opaque>`. Response includes `next_cursor` (nullable).
- **Idempotency:** all unsafe POSTs that create a billable or state-changing resource (`POST /appointments`, `POST /appointments/:id/payment`) require an `Idempotency-Key` header. Server stores the key for 24h and returns the original response on retry instead of creating a duplicate.
- **Timestamps:** ISO 8601 UTC (`2026-08-09T14:30:00Z`). Dates for scheduling are `YYYY-MM-DD` in the **branch's local timezone**, stored with the branch's `timezone` field so clients render correctly.
- **Errors:** uniform envelope:
```json
{
  "error": {
    "code": "SLOT_ALREADY_BOOKED",
    "message": "This time slot was just taken. Please choose another.",
    "field": null,
    "request_id": "req_8f2a..."
  }
}
```
  - `code` is a stable machine-readable string (UPPER_SNAKE_CASE) clients can branch on; `message` is human-readable and safe to show; never leak stack traces or internal identifiers.
  - Standard HTTP status codes: `400` validation, `401` unauthenticated, `403` unauthorized (wrong role/scope), `404` not found *or* not visible to this scope (never distinguish "doesn't exist" from "not yours" — avoids enumeration), `409` conflict (e.g. slot taken, duplicate invite), `422` semantically invalid, `429` rate limited, `500` server error.
- **Rate limits:** default `100 req/min` per token; auth endpoints `10 req/min` per IP; documented per-endpoint overrides noted where relevant.
- **Field naming:** `snake_case` in JSON.
- **Soft deletes:** clinics/branches/doctors are soft-deleted (`deleted_at` set) to preserve appointment history integrity; hard delete is not exposed via API.

---

## 3. Resource Reference

Each resource section lists: endpoints, auth, request/response shape, and key error codes. Fields marked **(ro)** are read-only/server-set.

### 3.1 Auth

#### `POST /auth/patient/register`
Public. Body: `{ name, email, phone?, password }` → `201` `{ user, access_token, refresh_token }`.
Errors: `409 EMAIL_ALREADY_REGISTERED`.

#### `POST /auth/patient/login`
Public. Body: `{ email, password }` → `200` `{ access_token, refresh_token, user }`.
Errors: `401 INVALID_CREDENTIALS`.

#### `POST /auth/clinic-owner/register` / `POST /auth/clinic-owner/login`
Same shape as patient auth, `role=clinic_owner`.

#### `POST /auth/branch-staff/login`
Body: `{ email }` → sends OTP (email/SMS) as v1 passwordless flow for staff since they're added by an owner, not self-registered. Follow with:
#### `POST /auth/branch-staff/verify-otp`
Body: `{ email, otp }` → `200` `{ access_token, refresh_token, user }`. Errors: `401 INVALID_OTP`, `410 OTP_EXPIRED`.

#### `POST /auth/doctor/accept-invite`
Public (but requires possession of a valid invite). Body: `{ email, invite_code, password }` → `200` `{ access_token, refresh_token, doctor }`.
Errors: `404 INVITE_NOT_FOUND`, `410 INVITE_EXPIRED`, `409 INVITE_ALREADY_ACCEPTED`.
This is the **only** endpoint that transitions a doctor from `pending` to a login-capable account — no clinic-facing endpoint can do this (see §4.4).

#### `POST /auth/doctor/login`
Body: `{ email, password }` → `200` `{ access_token, refresh_token, doctor }`. Errors: `401 INVALID_CREDENTIALS`, `403 INVITE_NOT_ACCEPTED`.

#### `POST /auth/refresh`
Body: `{ refresh_token }` → `200` `{ access_token, refresh_token }`. Errors: `401 REFRESH_TOKEN_INVALID`.

#### `POST /auth/logout`
Auth required. Revokes the current refresh token. → `204`.

---

### 3.2 Clinics

#### `GET /clinics`
Public. Query: `?search=&limit=&cursor=`. → `200` `{ items: Clinic[], next_cursor }`.
`Clinic = { id, name, description, branch_count, created_at }`

#### `POST /clinics`
Auth: `clinic_owner`. Body: `{ name, description? }` → `201 Clinic` (ro: `id, owner_id, created_at`).

#### `GET /clinics/:id`
Public. → `200 Clinic`. `404 CLINIC_NOT_FOUND`.

#### `PATCH /clinics/:id`
Auth: `clinic_owner`, scope: must be `owner_id`. Body: partial `{ name?, description? }` → `200 Clinic`. `403 NOT_CLINIC_OWNER`.

#### `DELETE /clinics/:id`
Auth: `clinic_owner`, scope: owner. Soft-delete. → `204`. `409 CLINIC_HAS_ACTIVE_APPOINTMENTS` if any branch has non-terminal appointments (must resolve/cancel first) — **or** allow with cascade flag `?force=true` that cancels all pending/confirmed appointments and notifies affected patients (product decision, default to blocking).

---

### 3.3 Branches

#### `GET /clinics/:clinicId/branches`
Public. → `200 { items: Branch[] }`.
`Branch = { id, clinic_id, name, address, phone, lat, lng, timezone, photo_url, created_at }`

#### `POST /clinics/:clinicId/branches`
Auth: `clinic_owner`, scope: owns clinic. Body: `{ name, address, phone, lat?, lng?, timezone }` → `201 Branch`.

#### `PATCH /branches/:id`
Auth: `clinic_owner`, scope: owns parent clinic. → `200 Branch`.

#### `DELETE /branches/:id`
Auth: `clinic_owner`. Soft-delete, same active-appointment guard as clinics. → `204`.

#### `POST /branches/:id/photo`
Auth: `clinic_owner`. `multipart/form-data`, field `file` (image, ≤10MB). → `200 { photo_url }`. Errors: `413 FILE_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`.

#### Branch gallery
Multiple images per branch (`branch_gallery_images`, ordered by `position`). Same two-step Cloudinary flow as the branch photo.

- `POST /branches/:id/gallery/signature` — Auth: `clinic_owner`. → Cloudinary grant (`public_id` under `branches/gallery/`).
- `POST /branches/:id/gallery` — Auth: `clinic_owner`. Body: `{ public_id }` → `201 { id, branch_id, image_url, position, created_at }`.
- `GET /branches/:id/gallery` — Public. → `200 { items: GalleryImage[] }`.
- `DELETE /branches/:id/gallery/:imageId` — Auth: `clinic_owner`. → `204`.

`GalleryImage = { id, branch_id, image_url, position, created_at }`

---

### 3.4 Branch Staff

Branch staff hold **fine-grained permissions** on their branch (stored as a JSON array on `branch_staff.permissions_json`), enforced server-side:

`appointments:confirm` · `appointments:payment` · `appointments:complete` · `appointments:cancel` · `staff:manage` · `doctors:manage`

New staff default to the four `appointments:*` permissions. The `clinic_owner` is always allowed; a `branch_staff` calling a gated action without the permission gets `403 PERMISSION_DENIED`.

#### `GET /branches/:id/staff`
Auth: `clinic_owner` (owns branch) or `branch_staff` (self branch only, read-only). → `200 { items: BranchStaff[] }`.
`BranchStaff = { id, branch_id, name, email, added_by, permissions, created_at }`

#### `POST /branches/:id/staff`
Auth: `clinic_owner` **or** `branch_staff` with `staff:manage`. Body: `{ name, email, permissions? }` → `201 BranchStaff`. Triggers `POST /notifications` internal event `staff_invited` (email with login instructions — passwordless OTP, no invite-accept step needed since staff aren't handling licensed clinical work).
Errors: `409 STAFF_ALREADY_EXISTS_FOR_BRANCH`.

#### `GET /branches/:id/staff/:staffId/permissions`
Auth: `clinic_owner` or the staff member themselves. → `200 { staff_id, branch_id, permissions }`.

#### `PATCH /branches/:id/staff/:staffId/permissions`
Auth: `clinic_owner` **or** `branch_staff` with `staff:manage`. Body: `{ permissions: [...] }` (full replace). → `200 { staff_id, branch_id, permissions }`.

#### `DELETE /branches/:id/staff/:staffId`
Auth: `clinic_owner` **or** `branch_staff` with `staff:manage`. → `204`.

---

### 3.5 Doctors & Invites

Doctor records exist in two states: an **invite** (owned by the branch, no login) and an **accepted doctor profile** (owned by the doctor, login-capable). These are modeled as separate resources so permission boundaries are explicit in the URL structure.

#### `POST /branches/:id/doctor-invites`
Auth: `clinic_owner`. Body: `{ name, specialization, email, phone?, fee_amount, currency, certificate?, slot_template: [{ weekday, start_time, end_time, slot_duration_minutes }] }`
→ `201 { id, branch_id, email, status: "pending", expires_at }`.
Side effect: generates single-use `invite_code`, emails it to `email` (code itself is **never** returned in this response body — only sent via the notification channel — to prevent a clinic UI from silently activating a doctor).
Errors: `409 INVITE_ALREADY_PENDING`.

#### `GET /branches/:id/doctor-invites`
Auth: `clinic_owner`. → `200 { items: [{ id, name, email, status, expires_at, created_at }] }` — status one of `pending | accepted | expired | revoked`.

#### `DELETE /doctor-invites/:id`
Auth: `clinic_owner`. Revokes a pending invite. → `204`. `409 INVITE_ALREADY_ACCEPTED` (use doctor-assignment removal instead, see below).

#### `GET /branches/:id/doctors`
Public (only returns **accepted** doctors — pending invites never appear here). → `200 { items: Doctor[] }`.
`Doctor = { id, name, specialization, phone?, certificate_url?, fee_amount, currency, branch_id, next_available_slot }`

#### `PATCH /doctor-assignments/:id`
Auth: `clinic_owner` (branch scope) **or** `doctor` (self, limited fields: `slot_template`, `certificate` only — fee is owner-controlled). Body: partial `{ fee_amount?, slot_template?, certificate? }` → `200 DoctorAssignment`.

#### `DELETE /doctor-assignments/:id`
Auth: `clinic_owner`. Removes doctor from this branch (does not delete the doctor's global account). → `204`. `409 DOCTOR_HAS_ACTIVE_APPOINTMENTS`.

#### `GET /doctors/me` / `PATCH /doctors/me`
Auth: `doctor`. Own profile read/update (`name, phone, bio` — email is immutable post-acceptance).

#### `GET /doctors/:id/availability`
Public. Query: `?date=YYYY-MM-DD`. → `200 { date, slots: [{ time, available: bool }] }`.
Computed as `slot_template` for that weekday minus existing non-cancelled appointments. This is a derived/read endpoint, not a stored resource — always computed live to avoid stale-availability bugs.

---

### 3.6 Appointments

`Appointment = { id, patient_id, clinic_id, branch_id, doctor_id, scheduled_date, scheduled_time, duration_minutes, status, fee_amount, currency, payment_method, created_at, updated_at }`
`status ∈ { pending, confirmed, paid, completed, cancelled, no_show }`

#### `POST /appointments`
Auth: `patient`. Header: `Idempotency-Key` **required**. Body: `{ doctor_id, branch_id, date, time }`.
→ `201 Appointment` (status `pending`).
Errors: `409 SLOT_ALREADY_BOOKED`, `422 OUTSIDE_DOCTOR_AVAILABILITY`, `422 DATE_IN_PAST`.
Server enforces a DB-level unique constraint on `(doctor_id, scheduled_date, scheduled_time)` for non-cancelled rows — this is the authoritative guard against double-booking, not the availability check alone (which is racy under concurrency).
Side effect: creates a `notification` for every `branch_staff` on `branch_id`.

#### `GET /appointments`
Auth: any authenticated role. Scope auto-applied: `patient` → own; `branch_staff` → own branch; `doctor` → own; `clinic_owner` → own clinics. Query: `?status=&date_from=&date_to=&limit=&cursor=`.
→ `200 { items: Appointment[], next_cursor }`.

#### `GET /appointments/:id`
Scope as above. `404` if not visible to caller (see error-code note in §2).

#### `PATCH /appointments/:id/confirm`
Auth: `branch_staff` (own branch) or `clinic_owner`. Requires current status `pending`. → `200 Appointment` (status `confirmed`).
Errors: `409 INVALID_STATUS_TRANSITION`.

#### `PATCH /appointments/:id/payment`
Auth: `branch_staff` or `clinic_owner`. Header: `Idempotency-Key` required. Body: `{ fee_amount, method: "cash"|"upi", reference_no? }`. Requires current status `confirmed`. → `200 Appointment` (status `paid`), creates `Payment` sub-resource.
Errors: `409 INVALID_STATUS_TRANSITION`.

#### `PATCH /appointments/:id/complete`
Auth: `branch_staff` or `clinic_owner` (product decision in v1; doctor-complete is a config flag per clinic, see open question in §7). Requires current status `paid`. → `200 Appointment` (status `completed`).

#### `PATCH /appointments/:id/cancel`
Auth: `patient` (own, if status is `pending`/`confirmed`), `branch_staff`/`clinic_owner` (any non-terminal status). Body: `{ reason? }`. → `200 Appointment` (status `cancelled`).
Errors: `409 CANNOT_CANCEL_PAID_APPOINTMENT` unless caller is staff/owner with override, in which case a refund workflow is out of scope for v1 and must be handled manually.

#### `GET /appointments/:id/status-history`
Scope as `GET /appointments/:id`. → `200 { items: [{ from_status, to_status, changed_by, changed_at, note }] }`. Read-only audit trail, never editable via API.

---

### 3.7 Prescriptions

`Prescription = { id, appointment_id, doctor_id, scan_url?, digitized_text, ocr_confidence?, finalized_at, created_at, updated_at }`

#### `POST /appointments/:id/prescription/scan`
Auth: `doctor` (must be the assigned doctor). `multipart/form-data`, field `file` (image, ≤10MB). → `202 { job_id, status: "processing" }`. Async OCR job.
Errors: `403 NOT_ASSIGNED_DOCTOR`, `409 APPOINTMENT_NOT_YET_PAID` (configurable — default: prescriptions allowed from `paid` onward).

#### `GET /prescription-scan-jobs/:jobId`
Auth: `doctor` (owner of job). → `200 { status: "processing"|"done"|"failed", draft_text?, confidence? }`. Client polls or subscribes via websocket/SSE (v2) for completion. **`draft_text` is never written to the appointment's prescription until the doctor explicitly saves it** — OCR output is always a draft, never auto-published.

#### `PUT /appointments/:id/prescription`
Auth: `doctor` (assigned). Body: `{ text, scan_url? }` → `200 Prescription` (upsert; sets `finalized_at`).
Errors: `403 NOT_ASSIGNED_DOCTOR`.

#### `GET /appointments/:id/prescription`
Auth: `patient` (own), `doctor` (assigned), `branch_staff`/`clinic_owner` (own branch, metadata only — consider redacting full text from non-clinical staff roles per product/privacy review). → `200 Prescription` or `404 PRESCRIPTION_NOT_FOUND`.

#### `GET /appointments/:id/prescription/pdf`
Same auth as above. → `200`, `Content-Type: application/pdf` (rendered server-side from `digitized_text` + clinic/doctor letterhead data).

#### `POST /appointments/:id/prescription/email`
Auth: `doctor` (assigned) or `patient` (own, resend). → `202 { queued: true }`. Fire-and-forget through the notification service; do not block on email provider latency.

---

### 3.8 Medical Documents

`MedicalDocument = { id, patient_id, file_url, file_name, mime_type, size_bytes, uploaded_at }`

#### `POST /patients/me/medical-documents`
Auth: `patient`. `multipart/form-data`, field `file` (image/pdf, ≤20MB). → `201 MedicalDocument`.

#### `GET /patients/me/medical-documents`
Auth: `patient`. → `200 { items: MedicalDocument[] }`.

#### `DELETE /medical-documents/:id`
Auth: `patient` (owner only). → `204`.

#### `GET /patients/:patientId/medical-documents`
Auth: `doctor` **only**, and only if the doctor has at least one non-cancelled appointment (any status/time) with `patientId`. → `200 { items: MedicalDocument[] }`. `403 NO_APPOINTMENT_RELATIONSHIP` otherwise. This relationship check must be a query join, not an application-layer `if`, to prevent regressions from silently widening access.

---

### 3.9 Notifications

`Notification = { id, user_id, branch_id?, type, payload, read_at?, created_at }`
`type ∈ { new_booking, booking_confirmed, payment_received, consultation_completed, prescription_ready, doctor_invited, doctor_invite_accepted, appointment_cancelled }`

#### `GET /notifications`
Auth: any. Scope: own `user_id` (branch staff additionally scoped by `branch_id`). Query: `?unread_only=&limit=&cursor=`. → `200 { items, unread_count, next_cursor }`.

#### `PATCH /notifications/:id/read`
Auth: owner of the notification. → `200 Notification`.

#### `PATCH /notifications/read-all`
Auth: any. Optional body `{ branch_id? }` to scope. → `204`.

Delivery channels (push/email/SMS) are configured per `type` in the notification service and are **not** separately exposed as API resources in v1 — they're a side effect of the triggering write, not a client-callable endpoint.

---

## 4. Cross-Cutting Contracts

### 4.1 Consistent list envelope
Every list endpoint returns:
```json
{ "items": [...], "next_cursor": "opaque-string-or-null" }
```
No exceptions — do not add ad hoc `total_count` fields per-endpoint without adding it everywhere; if total counts are needed, add `total_count?: number` to the shared envelope in a single additive change.

### 4.2 Partial update semantics
`PATCH` bodies are partial — omitted fields are unchanged, `null` explicitly clears a nullable field. `PUT` (used only for prescriptions) is a full upsert.

### 4.3 File upload contract
All upload endpoints (`branch photo`, `certificate`, `prescription scan`, `medical document`) share:
- `multipart/form-data`, single field `file`.
- Response includes the resulting `*_url` as a **signed, time-limited URL** (not a permanent public link) — clients must re-fetch the parent resource for a fresh URL if it's expired, rather than caching the URL long-term.
- `413`/`415` error codes standardized as above.

### 4.4 The doctor-consent invariant (contract-level, not just flow-level)
No endpoint in this API — present or future — may create a `doctors` row with `status=accepted` except `POST /auth/doctor/accept-invite`. This is called out explicitly because it's a security/trust property of the product, not just a UX step: any future endpoint addition must be reviewed against this invariant before merging.

### 4.5 Status transition table (appointments)
Only these transitions are valid; any other `PATCH` attempt returns `409 INVALID_STATUS_TRANSITION`:

| From | To | Endpoint | Allowed roles |
|---|---|---|---|
| — | pending | `POST /appointments` | patient |
| pending | confirmed | `.../confirm` | branch_staff, clinic_owner |
| pending | cancelled | `.../cancel` | patient, branch_staff, clinic_owner |
| confirmed | paid | `.../payment` | branch_staff, clinic_owner |
| confirmed | cancelled | `.../cancel` | patient, branch_staff, clinic_owner |
| paid | completed | `.../complete` | branch_staff, clinic_owner |
| pending/confirmed | no_show | `.../no-show` *(v1.1, not in v1)* | branch_staff |

---

## 5. Flows Expressed as API Call Sequences

### 5.1 Doctor onboarding
```
clinic_owner: POST /branches/:id/doctor-invites
system:        → email to doctor with invite_code
doctor:        POST /auth/doctor/accept-invite {email, invite_code, password}
system:        doctors row created (status=accepted), doctor_branch_assignment created
patient app:   GET /branches/:id/doctors  → doctor now appears
```

### 5.2 Booking → payment → completion
```
patient: GET /clinics → GET /clinics/:id/branches → GET /branches/:id/doctors
patient: GET /doctors/:id/availability?date=...
patient: POST /appointments {doctor_id, branch_id, date, time}  [Idempotency-Key]
system:  notification -> all branch_staff of branch_id
staff:   GET /notifications?unread_only=true
staff:   PATCH /appointments/:id/confirm
staff:   PATCH /appointments/:id/payment {fee_amount, method}   [Idempotency-Key]
doctor:  PUT /appointments/:id/prescription {text}   (optional, any time paid+)
staff:   PATCH /appointments/:id/complete
patient: GET /appointments/:id/prescription/pdf
```

### 5.3 Prescription scan (async)
```
doctor: POST /appointments/:id/prescription/scan  → 202 {job_id}
client: poll GET /prescription-scan-jobs/:jobId until status=done
doctor: reviews draft_text, edits as needed
doctor: PUT /appointments/:id/prescription {text: <edited>, scan_url}
```

---

## 6. Data Model (derived from the API contract)

The tables below exist to satisfy the resource contracts in §3 — if a field isn't exposed or required by an endpoint, it does not belong here without a documented reason (avoid speculative schema).

`users(id, email, phone, password_hash, role, status, created_at, updated_at)`
`clinics(id, name, description, owner_user_id, created_at, updated_at, deleted_at)`
`branches(id, clinic_id, name, address, phone, lat, lng, timezone, photo_url, created_at, updated_at, deleted_at)`
`branch_gallery_images(id, branch_id, public_id, image_url, position, created_at)`
`branch_staff(id, branch_id, user_id, added_by, permissions_json, created_at)`
`doctor_invites(id, branch_id, email, invite_code_hash, status, invited_by, expires_at, created_at)`
`doctors(id, user_id, name, specialization, phone, certificate_url, bio, created_at, deleted_at)`
`doctor_branch_assignments(id, doctor_id, branch_id, fee_amount, currency, is_active)`
`doctor_slot_templates(id, doctor_branch_assignment_id, weekday, start_time, end_time, slot_duration_minutes, effective_from, effective_to)`
`appointments(id, patient_id, clinic_id, branch_id, doctor_id, scheduled_date, scheduled_time, duration_minutes, status, fee_amount, currency, payment_method, created_at, updated_at)`
  — unique constraint: `(doctor_id, scheduled_date, scheduled_time) WHERE status NOT IN ('cancelled')`
`appointment_status_log(id, appointment_id, from_status, to_status, changed_by, changed_at, note)`
`payments(id, appointment_id, amount, currency, method, collected_by, collected_at, reference_no)`
`medical_documents(id, patient_id, file_url, file_name, mime_type, size_bytes, uploaded_at)`
`prescriptions(id, appointment_id UNIQUE, doctor_id, scan_url, digitized_text, ocr_confidence, finalized_at, created_at, updated_at)`
`prescription_scan_jobs(id, appointment_id, doctor_id, status, draft_text, confidence, created_at, completed_at)`
`notifications(id, user_id, branch_id, type, payload_jsonb, read_at, created_at)`

---

## 7. Non-Functional Requirements & Security

Unchanged from prior guidance, restated as API-testable requirements:

- Double-booking prevention is **verified by contract test**: concurrent `POST /appointments` for the same `(doctor_id, date, time)` must result in exactly one `201` and one `409 SLOT_ALREADY_BOOKED`.
- Every scoped `GET`/`PATCH`/`DELETE` must have an automated test asserting `404` (not `200` with someone else's data) when called with a token outside the resource's scope.
- File endpoints must reject unsigned/expired URL reuse in tests.
- p95 latency: read endpoints < 400ms, write endpoints < 800ms, measured at the API gateway.
- All PHI-bearing endpoints (§3.7, §3.8) require TLS 1.2+ and signed URLs with ≤15 min expiry.
- Idempotency-Key enforcement is a contract test, not just a code review note: replaying the same key + body within 24h must return the original resource, not create a duplicate.

---

## 8. Open Questions (carried over, now framed as contract decisions)

1. Should `PATCH /appointments/:id/complete` also be callable by `doctor`? If yes, add role to the transition table in §4.5 and to the endpoint's auth list — this is a one-line contract change, flag before client build starts.
2. Add `POST /appointments/:id/refund` in v1 or defer to v1.1? Currently no refund endpoint exists; `cancel` on a `paid` appointment is blocked by default.
3. Real payment gateway (UPI intent/QR) vs. manual `PATCH .../payment` — if added, it's a new endpoint (`POST /appointments/:id/payment-intent`) rather than a change to the existing manual-entry endpoint, so both can coexist.
4. OCR vendor selection affects `prescription_scan_jobs` field shape (`confidence` format, failure reasons) — pin vendor before finalizing that resource's schema.
5. Multi-branch doctors: contract already supports it (`doctor_branch_assignments` is 1-to-many from doctor), confirm client UX needs a branch switcher on `GET /appointments`.
6. Regulatory jurisdiction determines whether `medical_documents`/`prescriptions` need additional compliance controls (e.g., BAA-eligible storage) beyond §7 — resolve before GA.

---

## 9. Delivery Milestones (API-first order)

1. **M1:** Auth contract (§3.1) fully implemented + tested for all 4 roles, including the doctor-invite/accept split.
2. **M2:** Clinics/Branches/Staff CRUD (§3.2–3.4) with scope enforcement tests.
3. **M3:** Doctor invites + assignments + availability computation (§3.5), contract-tested against the double-booking constraint.
4. **M4:** Appointments full lifecycle (§3.6) incl. status-transition table enforcement and idempotency.
5. **M5:** Prescriptions (§3.7) incl. async OCR job contract, and medical documents (§3.8) with the appointment-relationship access check.
6. **M6:** Notifications (§3.9) wired to all triggering writes; client apps built against the now-stable contract in parallel with M3–M5 using mocked responses.
