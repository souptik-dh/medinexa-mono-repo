import { writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "postman");
const OUT_FILE = path.join(OUT_DIR, "MediBook-API.postman_collection.json");

const BASE_URL = "http://localhost:3000/api/v1";

const SET_TOKENS = [
  "const j = pm.response.json();",
  'pm.collectionVariables.set("access_token", j.access_token);',
  'pm.collectionVariables.set("refresh_token", j.refresh_token);',
];

function buildUrl(url, query) {
  if (url.startsWith("{{")) {
    return { raw: url, host: [url], path: [] };
  }
  const [pathPart, queryString] = url.split("?");
  const path = pathPart
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map((seg) => seg.replace(/^:([A-Za-z0-9_]+)$/, "{{$1}}"));
  const raw = `{{baseUrl}}/${path.join("/")}`;
  const q =
    query ??
    (queryString
      ? queryString.split("&").map((kv) => {
          const [k, v] = kv.split("=");
          return { key: decodeURIComponent(k), value: decodeURIComponent(v ?? "") };
        })
      : undefined);
  return {
    raw,
    host: ["{{baseUrl}}"],
    path,
    ...(q?.length ? { query: q } : {}),
  };
}

function bearerAuth() {
  return {
    type: "bearer",
    bearer: [{ key: "token", value: "{{access_token}}", type: "string" }],
  };
}

function rawJson(obj) {
  return {
    mode: "raw",
    raw: JSON.stringify(obj, null, 2),
    options: { raw: { language: "json" } },
  };
}

function formData(extra = []) {
  return {
    mode: "formdata",
    formdata: [
      { key: "file", type: "file", src: [] },
      ...extra,
    ],
  };
}

function req({ folder, name, method, url, auth = true, body, query, header = [], test }) {
  return { folder, name, method, url, auth, body, query, header, test };
}

const requests = [
  // ── Auth ────────────────────────────────────────────────────────────────
  req({
    folder: "Auth",
    name: "Patient Register",
    method: "POST",
    url: "/auth/patient/register",
    auth: false,
    body: rawJson({ name: "Aisha Verma", email: "aisha@example.com", phone: "+919876543210", password: "password123" }),
    test: [...SET_TOKENS, 'pm.collectionVariables.set("userId", j.user.id);'],
  }),
  req({
    folder: "Auth",
    name: "Clinic Owner Register",
    method: "POST",
    url: "/auth/clinic-owner/register",
    auth: false,
    body: rawJson({ name: "Suresh Nair", email: "owner@example.com", phone: "+919876543211", password: "password123" }),
    test: [...SET_TOKENS, 'pm.collectionVariables.set("userId", j.user.id);', 'pm.collectionVariables.set("clinicId", j.clinic.id);'],
  }),
  req({
    folder: "Auth",
    name: "Patient Login",
    method: "POST",
    url: "/auth/patient/login",
    auth: false,
    body: rawJson({ email: "aisha@example.com", password: "password123" }),
    test: [...SET_TOKENS, 'pm.collectionVariables.set("userId", j.user.id);'],
  }),
  req({
    folder: "Auth",
    name: "Clinic Owner Login",
    method: "POST",
    url: "/auth/clinic-owner/login",
    auth: false,
    body: rawJson({ email: "owner@example.com", password: "password123" }),
    test: [...SET_TOKENS, 'pm.collectionVariables.set("userId", j.user.id);'],
  }),
  req({
    folder: "Auth",
    name: "Doctor Login",
    method: "POST",
    url: "/auth/doctor/login",
    auth: false,
    body: rawJson({ email: "dr.smith@example.com", password: "password123" }),
    test: [...SET_TOKENS, 'if (j.doctor) pm.collectionVariables.set("doctorId", j.doctor.id);'],
  }),
  req({
    folder: "Auth",
    name: "Doctor Accept Invite",
    method: "POST",
    url: "/auth/doctor/accept-invite",
    auth: false,
    body: rawJson({ email: "dr.smith@example.com", invite_code: "K7QX2Z9P", password: "password123", reg_no: "MC-123456" }),
    test: [...SET_TOKENS, 'if (j.doctor) pm.collectionVariables.set("doctorId", j.doctor.id);'],
  }),
  req({
    folder: "Auth",
    name: "Branch Staff Login (request OTP)",
    method: "POST",
    url: "/auth/branch-staff/login",
    auth: false,
    body: rawJson({ email: "staff@clinic.com" }),
  }),
  req({
    folder: "Auth",
    name: "Branch Staff Verify OTP",
    method: "POST",
    url: "/auth/branch-staff/verify-otp",
    auth: false,
    body: rawJson({ email: "staff@clinic.com", otp: "482913" }),
    test: [...SET_TOKENS, 'if (j.user) { pm.collectionVariables.set("userId", j.user.id); if (j.user.branch_id) pm.collectionVariables.set("branchId", j.user.branch_id); }'],
  }),
  req({
    folder: "Auth",
    name: "Refresh Tokens",
    method: "POST",
    url: "/auth/refresh",
    auth: false,
    body: rawJson({ refresh_token: "{{refresh_token}}" }),
    test: SET_TOKENS,
  }),
  req({
    folder: "Auth",
    name: "Logout",
    method: "POST",
    url: "/auth/logout",
    body: rawJson({ refresh_token: "{{refresh_token}}" }),
  }),

  // ── Clinics ─────────────────────────────────────────────────────────────
  req({
    folder: "Clinics",
    name: "List Clinics",
    method: "GET",
    url: "/clinics",
    auth: false,
    query: [{ key: "search", value: "", description: "Name filter" }, { key: "limit", value: "20" }, { key: "cursor", value: "" }],
  }),
  req({
    folder: "Clinics",
    name: "Create Clinic",
    method: "POST",
    url: "/clinics",
    body: rawJson({ name: "Sunrise Multispeciality", description: "General & cardiac care" }),
    test: ['const j = pm.response.json();', 'if (j.id) pm.collectionVariables.set("clinicId", j.id);'],
  }),
  req({
    folder: "Clinics",
    name: "Get Clinic",
    method: "GET",
    url: "/clinics/:clinicId",
    auth: false,
  }),
  req({
    folder: "Clinics",
    name: "Update Clinic",
    method: "PATCH",
    url: "/clinics/:clinicId",
    body: rawJson({ name: "Sunrise Heart & Care" }),
  }),
  req({
    folder: "Clinics",
    name: "Delete Clinic",
    method: "DELETE",
    url: "/clinics/:clinicId?force=true",
  }),

  // ── Branches ────────────────────────────────────────────────────────────
  req({
    folder: "Branches",
    name: "List Branches",
    method: "GET",
    url: "/clinics/:clinicId/branches",
    auth: false,
  }),
  req({
    folder: "Branches",
    name: "Create Branch",
    method: "POST",
    url: "/clinics/:clinicId/branches",
    body: rawJson({
      name: "Sunrise — Andheri",
      address: "12, SV Road, Andheri West, Mumbai 400058",
      phone: "+912240010010",
      lat: 19.119567,
      lng: 72.847,
      timezone: "Asia/Kolkata",
    }),
    test: ['const j = pm.response.json();', 'if (j.id) pm.collectionVariables.set("branchId", j.id);'],
  }),
  req({
    folder: "Branches",
    name: "Update Branch",
    method: "PATCH",
    url: "/branches/:branchId",
    body: rawJson({ phone: "+912240010011" }),
  }),
  req({
    folder: "Branches",
    name: "Delete Branch",
    method: "DELETE",
    url: "/branches/:branchId?force=true",
  }),
  req({
    folder: "Branches",
    name: "Branch Photo Signature",
    method: "POST",
    url: "/branches/:branchId/photo/signature",
    test: ['const j = pm.response.json();', 'if (j.public_id) pm.collectionVariables.set("publicId", j.public_id);'],
  }),
  req({
    folder: "Branches",
    name: "Set Branch Photo",
    method: "POST",
    url: "/branches/:branchId/photo",
    body: rawJson({ public_id: "{{publicId}}" }),
    test: ['const j = pm.response.json();', 'if (j.photo_url) pm.collectionVariables.set("fileUrl", j.photo_url);'],
  }),
  req({
    folder: "Branches",
    name: "Branch Gallery Signature",
    method: "POST",
    url: "/branches/:branchId/gallery/signature",
    test: ['const j = pm.response.json();', 'if (j.public_id) pm.collectionVariables.set("publicId", j.public_id);'],
  }),
  req({
    folder: "Branches",
    name: "Add Gallery Image",
    method: "POST",
    url: "/branches/:branchId/gallery",
    body: rawJson({ public_id: "{{publicId}}" }),
    test: ['const j = pm.response.json();', 'if (j.id) pm.collectionVariables.set("galleryImageId", j.id);'],
  }),
  req({
    folder: "Branches",
    name: "List Gallery Images",
    method: "GET",
    url: "/branches/:branchId/gallery",
    auth: false,
  }),
  req({
    folder: "Branches",
    name: "Remove Gallery Image",
    method: "DELETE",
    url: "/branches/:branchId/gallery/:galleryImageId",
  }),

  // ── Branch Staff ────────────────────────────────────────────────────────
  req({
    folder: "Branch Staff",
    name: "List Staff",
    method: "GET",
    url: "/branches/:branchId/staff",
  }),
  req({
    folder: "Branch Staff",
    name: "Add Staff",
    method: "POST",
    url: "/branches/:branchId/staff",
    body: rawJson({ name: "Rohit Sharma", email: "staff@clinic.com" }),
    test: ['const j = pm.response.json();', 'if (j.id) pm.collectionVariables.set("staffId", j.id);'],
  }),
  req({
    folder: "Branch Staff",
    name: "Remove Staff",
    method: "DELETE",
    url: "/branches/:branchId/staff/:staffId",
  }),
  req({
    folder: "Branch Staff",
    name: "Get Staff Permissions",
    method: "GET",
    url: "/branches/:branchId/staff/:staffId/permissions",
  }),
  req({
    folder: "Branch Staff",
    name: "Update Staff Permissions",
    method: "PATCH",
    url: "/branches/:branchId/staff/:staffId/permissions",
    body: rawJson({
      permissions: ["appointments:confirm", "appointments:payment", "appointments:complete", "appointments:cancel"],
    }),
  }),

  // ── Doctors, Invites & Assignments ──────────────────────────────────────
  req({
    folder: "Doctors, Invites & Assignments",
    name: "Create Doctor Invite",
    method: "POST",
    url: "/branches/:branchId/doctor-invites",
    body: rawJson({
      name: "Dr. Smith",
      specialization: "Cardiologist",
      email: "dr.smith@example.com",
      phone: "+919900000001",
      fee_amount: 500,
      currency: "INR",
      certificate: "https://example.com/cert.pdf",
      slot_template: [
        { weekday: 1, start_time: "09:00", end_time: "13:00", slot_duration_minutes: 20 },
        { weekday: 3, start_time: "16:00", end_time: "20:00", slot_duration_minutes: 20 },
      ],
    }),
    test: ['const j = pm.response.json();', 'if (j.id) pm.collectionVariables.set("inviteId", j.id);'],
  }),
  req({
    folder: "Doctors, Invites & Assignments",
    name: "List Doctor Invites",
    method: "GET",
    url: "/branches/:branchId/doctor-invites",
  }),
  req({
    folder: "Doctors, Invites & Assignments",
    name: "Revoke Doctor Invite",
    method: "DELETE",
    url: "/doctor-invites/:inviteId",
  }),
  req({
    folder: "Doctors, Invites & Assignments",
    name: "List Branch Doctors",
    method: "GET",
    url: "/branches/:branchId/doctors",
    auth: false,
  }),
  req({
    folder: "Doctors, Invites & Assignments",
    name: "Update Doctor Assignment",
    method: "PATCH",
    url: "/doctor-assignments/:assignmentId",
    body: rawJson({
      fee_amount: 600,
      slot_template: [{ weekday: 2, start_time: "10:00", end_time: "14:00", slot_duration_minutes: 30 }],
    }),
  }),
  req({
    folder: "Doctors, Invites & Assignments",
    name: "Remove Doctor Assignment",
    method: "DELETE",
    url: "/doctor-assignments/:assignmentId",
  }),
  req({
    folder: "Doctors, Invites & Assignments",
    name: "Get My Doctor Profile",
    method: "GET",
    url: "/doctors/me",
  }),
  req({
    folder: "Doctors, Invites & Assignments",
    name: "Update My Doctor Profile",
    method: "PATCH",
    url: "/doctors/me",
    body: rawJson({ name: "Dr. John Smith", reg_no: "MC-654321", phone: "+919900000002", bio: "MBBS, MD (Cardiology)" }),
  }),
  req({
    folder: "Doctors, Invites & Assignments",
    name: "My Doctor Photo Signature",
    method: "POST",
    url: "/doctors/me/photo/signature",
    test: ['const j = pm.response.json();', 'if (j.public_id) pm.collectionVariables.set("publicId", j.public_id);'],
  }),
  req({
    folder: "Doctors, Invites & Assignments",
    name: "Set My Doctor Photo",
    method: "POST",
    url: "/doctors/me/photo",
    body: rawJson({ public_id: "{{publicId}}" }),
    test: ['const j = pm.response.json();', 'if (j.photo_url) pm.collectionVariables.set("fileUrl", j.photo_url);'],
  }),
  req({
    folder: "Doctors, Invites & Assignments",
    name: "Branch Doctor Photo Signature",
    method: "POST",
    url: "/branches/:branchId/doctors/:doctorId/photo/signature",
    test: ['const j = pm.response.json();', 'if (j.public_id) pm.collectionVariables.set("publicId", j.public_id);'],
  }),
  req({
    folder: "Doctors, Invites & Assignments",
    name: "Set Branch Doctor Photo",
    method: "POST",
    url: "/branches/:branchId/doctors/:doctorId/photo",
    body: rawJson({ public_id: "{{publicId}}" }),
    test: ['const j = pm.response.json();', 'if (j.photo_url) pm.collectionVariables.set("fileUrl", j.photo_url);'],
  }),
  req({
    folder: "Doctors, Invites & Assignments",
    name: "Search Doctors",
    method: "GET",
    url: "/doctors/search",
    query: [{ key: "q", value: "Smith", description: "reg_no, name, or specialization" }, { key: "limit", value: "20" }],
    test: ['const j = pm.response.json();', 'if (j.items && j.items[0]) { pm.collectionVariables.set("doctorId", j.items[0].id); }'],
  }),
  req({
    folder: "Doctors, Invites & Assignments",
    name: "Doctor Availability",
    method: "GET",
    url: "/doctors/:doctorId/availability",
    auth: false,
    query: [{ key: "date", value: "2026-08-10", description: "YYYY-MM-DD" }],
  }),

  // ── Appointments ────────────────────────────────────────────────────────
  req({
    folder: "Appointments",
    name: "Create Appointment",
    method: "POST",
    url: "/appointments",
    header: [{ key: "Idempotency-Key", value: "{{$guid}}", description: "Required" }],
    body: rawJson({
      doctor_id: "{{doctorId}}",
      branch_id: "{{branchId}}",
      date: "2026-08-10",
      time: "09:20",
    }),
    test: [
      "const j = pm.response.json();",
      'if (j.id) pm.collectionVariables.set("appointmentId", j.id);',
      'if (j.patient_id) pm.collectionVariables.set("patientId", j.patient_id);',
    ],
  }),
  req({
    folder: "Appointments",
    name: "List Appointments",
    method: "GET",
    url: "/appointments",
    query: [{ key: "status", value: "", description: "pending|confirmed|paid|completed|cancelled|no_show" }, { key: "date_from", value: "" }, { key: "date_to", value: "" }, { key: "limit", value: "20" }, { key: "cursor", value: "" }],
  }),
  req({
    folder: "Appointments",
    name: "Get Appointment",
    method: "GET",
    url: "/appointments/:appointmentId",
  }),
  req({
    folder: "Appointments",
    name: "Confirm Appointment",
    method: "PATCH",
    url: "/appointments/:appointmentId/confirm",
  }),
  req({
    folder: "Appointments",
    name: "Record Payment",
    method: "PATCH",
    url: "/appointments/:appointmentId/payment",
    header: [{ key: "Idempotency-Key", value: "{{$guid}}", description: "Required" }],
    body: rawJson({ fee_amount: 500, method: "upi", reference_no: "UPI-REF-88421" }),
  }),
  req({
    folder: "Appointments",
    name: "Complete Appointment",
    method: "PATCH",
    url: "/appointments/:appointmentId/complete",
  }),
  req({
    folder: "Appointments",
    name: "Cancel Appointment",
    method: "PATCH",
    url: "/appointments/:appointmentId/cancel",
    body: rawJson({ reason: "Patient requested cancellation" }),
  }),
  req({
    folder: "Appointments",
    name: "Appointment Status History",
    method: "GET",
    url: "/appointments/:appointmentId/status-history",
  }),

  // ── Prescriptions ───────────────────────────────────────────────────────
  req({
    folder: "Prescriptions",
    name: "Scan Prescription",
    method: "POST",
    url: "/appointments/:appointmentId/prescription/scan",
    body: formData(),
    test: ['const j = pm.response.json();', 'if (j.job_id) pm.collectionVariables.set("jobId", j.job_id);'],
  }),
  req({
    folder: "Prescriptions",
    name: "Get OCR Job",
    method: "GET",
    url: "/prescription-scan-jobs/:jobId",
  }),
  req({
    folder: "Prescriptions",
    name: "Upsert Prescription",
    method: "PUT",
    url: "/appointments/:appointmentId/prescription",
    body: rawJson({ text: "Tab. Aspirin 75mg OD x 30 days\nTab. Atorvastatin 10mg HS x 30 days", scan_url: "{{fileUrl}}" }),
  }),
  req({
    folder: "Prescriptions",
    name: "Get Prescription",
    method: "GET",
    url: "/appointments/:appointmentId/prescription",
  }),
  req({
    folder: "Prescriptions",
    name: "Get Prescription PDF",
    method: "GET",
    url: "/appointments/:appointmentId/prescription/pdf",
  }),
  req({
    folder: "Prescriptions",
    name: "Email Prescription",
    method: "POST",
    url: "/appointments/:appointmentId/prescription/email",
  }),

  // ── Medical Documents ───────────────────────────────────────────────────
  req({
    folder: "Medical Documents",
    name: "Upload Medical Document",
    method: "POST",
    url: "/patients/me/medical-documents",
    body: formData(),
    test: ['const j = pm.response.json();', 'if (j.id) pm.collectionVariables.set("medicalDocumentId", j.id);', 'if (j.file_url) pm.collectionVariables.set("fileUrl", j.file_url);'],
  }),
  req({
    folder: "Medical Documents",
    name: "List My Medical Documents",
    method: "GET",
    url: "/patients/me/medical-documents",
  }),
  req({
    folder: "Medical Documents",
    name: "Delete Medical Document",
    method: "DELETE",
    url: "/medical-documents/:medicalDocumentId",
  }),
  req({
    folder: "Medical Documents",
    name: "Patient Medical Documents (doctor)",
    method: "GET",
    url: "/patients/:patientId/medical-documents",
  }),

  // ── Notifications ───────────────────────────────────────────────────────
  req({
    folder: "Notifications",
    name: "List Notifications",
    method: "GET",
    url: "/notifications",
    query: [{ key: "unread_only", value: "true" }, { key: "limit", value: "20" }, { key: "cursor", value: "" }],
    test: ['const j = pm.response.json();', 'if (j.items && j.items[0]) { pm.collectionVariables.set("notificationId", j.items[0].id); }'],
  }),
  req({
    folder: "Notifications",
    name: "Mark Notification Read",
    method: "PATCH",
    url: "/notifications/:notificationId/read",
  }),
  req({
    folder: "Notifications",
    name: "Mark All Read",
    method: "PATCH",
    url: "/notifications/read-all",
    body: rawJson({ branch_id: "{{branchId}}" }),
  }),

  // ── Files ───────────────────────────────────────────────────────────────
  req({
    folder: "Files",
    name: "Get Signed File",
    method: "GET",
    url: "{{fileUrl}}",
    auth: false,
    header: [],
  }),
];

// ── Build collection ──────────────────────────────────────────────────────
const variables = [
  { key: "baseUrl", value: BASE_URL },
  { key: "access_token", value: "" },
  { key: "refresh_token", value: "" },
  { key: "userId", value: "" },
  { key: "clinicId", value: "" },
  { key: "branchId", value: "" },
  { key: "doctorId", value: "" },
  { key: "assignmentId", value: "" },
  { key: "inviteId", value: "" },
  { key: "staffId", value: "" },
  { key: "patientId", value: "" },
  { key: "appointmentId", value: "" },
  { key: "jobId", value: "" },
  { key: "medicalDocumentId", value: "" },
  { key: "notificationId", value: "" },
  { key: "publicId", value: "" },
  { key: "fileUrl", value: "" },
  { key: "galleryImageId", value: "" },
].map((v) => ({ ...v, type: "string" }));

const folders = [...new Set(requests.map((r) => r.folder))];

const item = folders.map((folder) => ({
  name: folder,
  item: requests
    .filter((r) => r.folder === folder)
    .map((r) => {
      const request = {
        method: r.method,
        header: [
          { key: "Accept", value: "application/json", type: "text" },
          ...(r.header ?? []),
        ],
        url: buildUrl(r.url, r.query),
      };
      if (r.auth !== false) request.auth = bearerAuth();
      if (r.body) request.body = r.body;
      const out = { name: r.name, request, response: [] };
      if (r.test) {
        out.event = [
          { listen: "test", script: { type: "text/javascript", exec: r.test } },
        ];
      }
      return out;
    }),
}));

const collection = {
  info: {
    _postman_id: randomUUID(),
    name: "MediBook API",
    description:
      "Generated from API.md. Base URL is configurable via the `baseUrl` collection variable.\n\nLogin/register requests auto-save `access_token`, `refresh_token`, and resource IDs (`clinicId`, `branchId`, `doctorId`, `appointmentId`, ...) into collection variables, which the downstream requests reference via `{{...}}` placeholders. Run the auth requests first, then the resource requests in order.",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: variables,
  item,
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_FILE, JSON.stringify(collection, null, 2));
console.log(`Postman collection written to ${OUT_FILE}`);
console.log(`Requests: ${requests.length}, Folders: ${folders.length}`);
