Implement a complete **Lab Test Appointment Management System** for both the **Clinic Portal** and the **Patient Mobile App**, including the required backend APIs, database models, validation, notifications, file upload, payment handling, appointment workflow, and branch-level configuration.

The implementation should be production-ready, modular, secure, and scalable.

---

# 1. Core Business Concept

A clinic can have multiple branches.

Each branch can independently configure:

- Available lab/diagnostic tests
- Test price
- Test duration
- Home collection availability
- Clinic visit availability
- Available dates
- Available time slots
- Preparation/precaution instructions
- Whether prescription upload is mandatory

Patients can book tests from a specific branch.

The booking must first go into:

**PENDING**

The clinic must review the patient's uploaded prescription and booking information before approving the appointment.

When approving, the clinic can add or modify **test-specific precautions/instructions**.

After approval, the patient receives the confirmation and precaution information through:

- Mobile app notification
- Email

The patient can pay either:

- **Pay at Clinic**
- **Pay Online**

---

# 2. Clinic Portal

Add a new module in the Clinic Portal:

**Lab Tests & Appointments**

The clinic portal should have the following sections:

1. Lab Test Management
2. Branch Test Configuration
3. Availability Management
4. Lab Test Appointments
5. Appointment Details
6. Prescription Viewer
7. Precaution Management
8. Payment Management
9. Notifications
10. Reports/History

---

# 3. Branch Management

The clinic may have multiple branches.

Every lab test configuration must belong to a specific:

`clinic_id`

and:

`branch_id`

Never make a test automatically available across all branches unless the clinic explicitly enables it.

Example:

Clinic:

**ABC Healthcare**

Branches:

- ABC Healthcare — Downtown
- ABC Healthcare — North Branch
- ABC Healthcare — South Branch

The clinic may configure:

**ECG**

for Downtown but not North Branch.

The API must always verify that the authenticated clinic user has access to the requested `branch_id`.

---

# 4. Lab Test Management

Clinic portal should allow authorized users to create lab tests.

### Test fields

```text
test_id
clinic_id
name
code
description
category
instructions
default_precautions
status
created_at
updated_at
```

Example:

```text
Name: ECG
Code: ECG
Category: Cardiology
Description: Electrocardiogram test
Default precautions: Avoid heavy exercise before the test.
Status: Active
```

Possible categories:

- Blood Test
- Cardiology
- Diabetes
- Urine Test
- Imaging
- General Diagnostics
- Health Check
- Other

Tests should support:

**Active / Inactive**

Inactive tests must not be bookable by patients.

---

# 5. Branch Test Configuration

Create a separate configuration between a test and a branch.

Example database concept:

```text
branch_lab_tests
```

Fields:

```text
id
clinic_id
branch_id
test_id
price
duration_minutes
clinic_available
home_collection_available
prescription_required
status
created_at
updated_at
```

Example:

```text
ECG
Branch: Downtown
Price: ₹800
Duration: 30 minutes
At Clinic: Yes
Home Collection: No
Prescription Required: Yes
```

Another branch may have:

```text
ECG
Branch: North
Price: ₹700
Duration: 20 minutes
At Clinic: Yes
Home Collection: Yes
Prescription Required: No
```

The patient must see the configuration for the selected branch only.

---

# 6. Clinic Portal — Create/Edit Test

Create a form:

### Basic Information

- Test Name
- Test Code
- Category
- Description

### Branch Configuration

- Select Branch
- Price
- Duration
- At Clinic
- Home Collection
- Prescription Required

### Instructions

- Default preparation instructions
- Default precautions

### Status

- Active
- Inactive

Provide:

- Create
- Edit
- Enable/Disable
- Delete where safe
- Duplicate configuration if useful

Do not hard-delete a test configuration if it has historical appointments. Use soft delete/inactive status instead.

---

# 7. Availability Management

Each branch should have its own availability.

Clinic portal should allow staff to configure:

### Weekly schedule

Example:

```text
Monday
09:00 AM - 01:00 PM
02:00 PM - 06:00 PM

Tuesday
09:00 AM - 01:00 PM
02:00 PM - 06:00 PM
```

Also support:

- Holidays
- Closed dates
- Special working dates
- Temporary unavailable periods
- Different schedules for different tests if required

---

# 8. Time Slot Generation

The backend should generate available slots based on:

```text
branch operating hours
test duration
existing appointments
blocked periods
selected service mode
booking rules
```

Example:

Test duration:

```text
30 minutes
```

Available hours:

```text
09:00 - 12:00
```

Generate:

```text
09:00
09:30
10:00
10:30
11:00
11:30
```

Do not return a slot if it has already been booked or temporarily reserved.

The backend must perform the final availability check during booking to prevent double booking.

---

# 9. Home Collection

If:

```text
home_collection_available = true
```

the patient can select:

**Home Collection**

For home collection, capture:

```text
patient_address_id
address
latitude
longitude (if available)
contact_phone
special_delivery/instruction notes
```

The system should verify whether the patient's address is within the branch's supported service area.

If the clinic does not support home collection for that branch/test, the API must reject the request.

---

# 10. Patient App — Test Discovery API

Create APIs so the mobile app can display:

### Branches

```http
GET /api/v1/clinics/{clinicId}/branches
```

### Available tests for a branch

```http
GET /api/v1/branches/{branchId}/lab-tests
```

Support filters:

```text
category
search
service_mode
date
active
```

Example:

```http
GET /api/v1/branches/123/lab-tests?service_mode=HOME
```

Only return active and bookable tests.

---

# 11. Test Details API

```http
GET /api/v1/branches/{branchId}/lab-tests/{branchTestId}
```

Response should include:

```json
{
  "id": 101,
  "test": {
    "name": "ECG",
    "category": "Cardiology",
    "description": "..."
  },
  "branch": {
    "id": 10,
    "name": "Downtown Branch"
  },
  "price": 800,
  "duration_minutes": 30,
  "clinic_available": true,
  "home_collection_available": false,
  "prescription_required": true,
  "default_precautions": [
    "Avoid heavy exercise before the test."
  ]
}
```

---

# 12. Availability API

Create:

```http
GET /api/v1/branches/{branchId}/lab-tests/{branchTestId}/availability
```

Parameters:

```text
date
service_mode
```

Example:

```http
GET /api/v1/branches/10/lab-tests/101/availability?date=2026-08-25&service_mode=CLINIC
```

Return:

```json
{
  "date": "2026-08-25",
  "slots": [
    {
      "start": "09:00",
      "end": "09:30",
      "available": true
    },
    {
      "start": "09:30",
      "end": "10:00",
      "available": false
    }
  ]
}
```

---

# 13. Prescription Upload

If:

```text
prescription_required = true
```

the patient must upload a prescription.

Supported formats:

- JPG
- JPEG
- PNG
- PDF

Add secure file storage.

Do not expose private prescription files through public URLs.

Use:

- authenticated file access
- signed temporary URLs
- access-control validation

Database:

```text
prescriptions
```

Fields:

```text
id
patient_id
appointment_id
file_name
file_url/key
mime_type
file_size
uploaded_at
```

---

# 14. Appointment Database Model

Create:

```text
lab_test_appointments
```

Recommended fields:

```text
id
appointment_number
patient_id
clinic_id
branch_id
branch_lab_test_id
test_id

service_mode
appointment_date
start_time
end_time
duration_minutes

price
payment_method
payment_status

prescription_required
prescription_id

patient_notes
clinic_notes
precautions

status

approved_by
approved_at
rejected_by
rejected_at
rejection_reason

completed_at
cancelled_at

created_at
updated_at
```

---

# 15. Appointment Status

Use a controlled state machine.

Initial status:

```text
PENDING
```

Possible flow:

```text
PENDING
   ↓
APPROVED
   ↓
COMPLETED
```

Alternative:

```text
PENDING → REJECTED
PENDING → CANCELLED
APPROVED → CANCELLED
APPROVED → COMPLETED
```

Do not allow arbitrary status changes.

For example:

- REJECTED cannot become COMPLETED.
- COMPLETED cannot become PENDING.
- Cancelled appointments cannot be approved.

Validate all transitions on the backend.

---

# 16. Create Appointment API

Create:

```http
POST /api/v1/lab-test-appointments
```

Request:

```json
{
  "branch_id": 10,
  "branch_lab_test_id": 101,
  "service_mode": "CLINIC",
  "appointment_date": "2026-08-25",
  "start_time": "10:00",
  "prescription_id": 500,
  "patient_notes": "..."
}
```

Backend must verify:

1. Patient is authenticated.
2. Branch exists.
3. Branch belongs to the selected clinic.
4. Test is active.
5. Test is available at that branch.
6. Selected service mode is supported.
7. Date is valid.
8. Slot is valid.
9. Slot is still available.
10. Prescription is present if required.
11. Patient is allowed to book.
12. Appointment is not duplicated.

Then create:

```text
status = PENDING
```

---

# 17. Double Booking Protection

This is critical.

Do not rely only on the availability API.

When creating an appointment, perform an atomic database-level availability check.

Use appropriate:

- database transaction
- row locking
- unique constraints
- conflict detection

Two patients must never be able to successfully book the same unavailable slot.

---

# 18. Clinic Portal — Appointment List

Create:

```http
GET /api/v1/clinic/lab-test-appointments
```

Support filters:

```text
branch_id
status
date_from
date_to
test_id
service_mode
payment_status
patient_name
appointment_number
```

Tabs:

- Pending
- Approved
- Today
- Upcoming
- Completed
- Rejected
- Cancelled

Show:

```text
Appointment Number
Patient
Test
Branch
Date
Time
Service Mode
Payment Status
Status
```

---

# 19. Clinic Appointment Details

API:

```http
GET /api/v1/clinic/lab-test-appointments/{appointmentId}
```

Display:

### Patient

- Name
- Age
- Gender
- Phone
- Email

### Test

- Test name
- Category
- Duration
- Price

### Appointment

- Branch
- Date
- Time
- Service mode

### Prescription

- View prescription
- Download prescription

### Payment

- Payment method
- Payment status
- Transaction ID if applicable

### Notes

- Patient notes
- Clinic notes
- Precautions

---

# 20. Clinic Approval API

Create:

```http
POST /api/v1/clinic/lab-test-appointments/{appointmentId}/approve
```

Request:

```json
{
  "precautions": [
    "Do not eat for 8 hours before the test.",
    "Drink sufficient water.",
    "Arrive 15 minutes before the appointment."
  ],
  "clinic_notes": "Please bring the original prescription."
}
```

When approving:

1. Verify appointment is `PENDING`.
2. Verify clinic owns the appointment.
3. Verify branch belongs to clinic.
4. Verify prescription if required.
5. Re-check slot availability/business rules.
6. Save precautions.
7. Set status to `APPROVED`.
8. Store approver.
9. Store approval timestamp.
10. Trigger patient notifications.

---

# 21. Reject Appointment API

```http
POST /api/v1/clinic/lab-test-appointments/{appointmentId}/reject
```

Request:

```json
{
  "reason": "The requested time slot is no longer available."
}
```

Set:

```text
status = REJECTED
```

Store:

```text
rejection_reason
rejected_by
rejected_at
```

Notify the patient.

---

# 22. Precautions

There should be two levels:

### Default precautions

Configured by the clinic for the test.

Example:

```text
Blood Test:
- Fast for 8 hours if instructed.
- Drink water.
```

### Appointment-specific precautions

Clinic staff can modify/add precautions during approval.

The final appointment should store a snapshot of the precautions at the time of approval.

This is important because future changes to the test's default precautions should not change historical appointments.

---

# 23. Patient Appointment Details API

```http
GET /api/v1/patient/lab-test-appointments/{appointmentId}
```

Return:

```text
Appointment number
Status
Test
Branch
Clinic
Date
Time
Duration
Service mode
Address
Contact number
Precautions
Payment information
Prescription information
```

---

# 24. Patient Appointment List API

```http
GET /api/v1/patient/lab-test-appointments
```

Filters:

```text
status
upcoming
past
```

Return appointments sorted by nearest upcoming appointment first.

---

# 25. Payment

Support:

```text
PAY_AT_CLINIC
ONLINE
```

Database:

```text
payments
```

Fields:

```text
id
appointment_id
patient_id
amount
currency
payment_method
payment_status
transaction_id
provider
paid_at
refund_status
created_at
updated_at
```

Payment status:

```text
UNPAID
PENDING
PAID
FAILED
REFUNDED
```

---

# 26. Pay at Clinic

If the patient selects:

```text
PAY_AT_CLINIC
```

then:

```text
payment_status = UNPAID
payment_method = PAY_AT_CLINIC
```

Appointment can still be approved by the clinic.

Clinic staff should later be able to mark the payment as collected.

API:

```http
POST /api/v1/clinic/lab-test-appointments/{appointmentId}/payment/collect
```

---

# 27. Online Payment

If:

```text
payment_method = ONLINE
```

create a payment order/session.

Do not mark it as paid based only on the frontend response.

Payment must be confirmed through the payment provider's secure server-side callback/webhook.

Example:

```text
Patient
 ↓
Create appointment/payment
 ↓
Payment Gateway
 ↓
Successful payment
 ↓
Backend webhook
 ↓
Verify transaction
 ↓
payment_status = PAID
```

Use idempotency for payment webhook processing so the same webhook cannot create duplicate payment records.

---

# 28. Notification System

Create notification events:

```text
LAB_TEST_BOOKING_CREATED
LAB_TEST_BOOKING_APPROVED
LAB_TEST_BOOKING_REJECTED
LAB_TEST_PAYMENT_SUCCESS
LAB_TEST_APPOINTMENT_REMINDER
LAB_TEST_APPOINTMENT_CANCELLED
```

When approved, send:

### In-app notification

Example:

```text
Your ECG appointment has been confirmed.

Date: 25 August
Time: 10:00 AM
Branch: Downtown Branch

Precautions:
Please avoid heavy exercise before the test.

Contact: +91 XXXXX XXXXX
```

### Email

Send the same important information by email.

Email should include:

- Clinic name
- Branch
- Test
- Date
- Time
- Service mode
- Address if clinic visit
- Contact number
- Precautions
- Payment status
- Appointment number

---

# 29. Notification Architecture

Do not send emails directly inside the appointment transaction.

Use an asynchronous notification/job system where possible.

Flow:

```text
Appointment Approved
        ↓
Create Notification Event
        ↓
Queue/Job
   ↙          ↘
In-App       Email
```

Store notification delivery status:

```text
PENDING
SENT
FAILED
```

Allow retry for failed email notifications.

---

# 30. Appointment Reminder

Add automated reminders.

Example:

```text
24 hours before appointment
2 hours before appointment
```

Reminder should include:

- Test name
- Date
- Time
- Branch
- Service mode
- Precautions
- Contact number

Do not send reminders for rejected/cancelled appointments.

---

# 31. Clinic Permissions / RBAC

Create permissions such as:

```text
LAB_TEST_VIEW
LAB_TEST_CREATE
LAB_TEST_UPDATE
LAB_TEST_DELETE
LAB_TEST_AVAILABILITY_MANAGE

LAB_APPOINTMENT_VIEW
LAB_APPOINTMENT_APPROVE
LAB_APPOINTMENT_REJECT
LAB_APPOINTMENT_CANCEL
LAB_APPOINTMENT_COMPLETE

LAB_PAYMENT_VIEW
LAB_PAYMENT_COLLECT

LAB_PRESCRIPTION_VIEW
```

Branch staff should only access appointments belonging to their assigned branch unless they have clinic-wide permissions.

---

# 32. API Authentication

All clinic APIs must require authenticated clinic staff/admin access.

Every API must validate:

```text
user_id
clinic_id
branch_id
role
permission
```

Never trust `clinic_id` or `branch_id` supplied by the frontend without authorization checks.

The backend should derive the user's accessible clinic/branch information from authentication and authorization.

---

# 33. API Error Handling

Use consistent responses.

Example:

```json
{
  "success": false,
  "message": "The selected time slot is no longer available.",
  "code": "LAB_SLOT_UNAVAILABLE"
}
```

Recommended error codes:

```text
LAB_TEST_NOT_FOUND
LAB_TEST_INACTIVE
BRANCH_NOT_FOUND
BRANCH_TEST_NOT_AVAILABLE
SERVICE_MODE_NOT_SUPPORTED
SLOT_NOT_AVAILABLE
SLOT_ALREADY_BOOKED
PRESCRIPTION_REQUIRED
PRESCRIPTION_INVALID
APPOINTMENT_NOT_FOUND
INVALID_APPOINTMENT_STATUS
UNAUTHORIZED_BRANCH_ACCESS
PAYMENT_FAILED
PAYMENT_ALREADY_COMPLETED
```

---

# 34. Audit Log

Create audit records for important clinic actions:

```text
appointment_created
appointment_approved
appointment_rejected
precaution_updated
appointment_cancelled
payment_collected
prescription_viewed
```

Store:

```text
user_id
clinic_id
branch_id
appointment_id
action
old_value
new_value
timestamp
ip_address
```

Prescription access should also be auditable because it contains sensitive patient information.

---

# 35. API Endpoint Summary

### Patient APIs

```http
GET    /api/v1/clinics/{clinicId}/branches
GET    /api/v1/branches/{branchId}/lab-tests
GET    /api/v1/branches/{branchId}/lab-tests/{branchTestId}
GET    /api/v1/branches/{branchId}/lab-tests/{branchTestId}/availability

POST   /api/v1/prescriptions
POST   /api/v1/lab-test-appointments

GET    /api/v1/patient/lab-test-appointments
GET    /api/v1/patient/lab-test-appointments/{id}

POST   /api/v1/lab-test-appointments/{id}/cancel

POST   /api/v1/lab-test-appointments/{id}/payment
```

### Clinic APIs

```http
GET    /api/v1/clinic/lab-tests
POST   /api/v1/clinic/lab-tests
PUT    /api/v1/clinic/lab-tests/{id}
PATCH  /api/v1/clinic/lab-tests/{id}/status

GET    /api/v1/clinic/branches/{branchId}/lab-tests
POST   /api/v1/clinic/branches/{branchId}/lab-tests
PUT    /api/v1/clinic/branches/{branchId}/lab-tests/{id}

GET    /api/v1/clinic/branches/{branchId}/lab-test-availability
POST   /api/v1/clinic/branches/{branchId}/lab-test-availability
PUT    /api/v1/clinic/branches/{branchId}/lab-test-availability/{id}

GET    /api/v1/clinic/lab-test-appointments
GET    /api/v1/clinic/lab-test-appointments/{id}

POST   /api/v1/clinic/lab-test-appointments/{id}/approve
POST   /api/v1/clinic/lab-test-appointments/{id}/reject
POST   /api/v1/clinic/lab-test-appointments/{id}/cancel
POST   /api/v1/clinic/lab-test-appointments/{id}/complete

POST   /api/v1/clinic/lab-test-appointments/{id}/payment/collect
```

### Payment APIs

```http
POST   /api/v1/payments/create
POST   /api/v1/payments/webhook
GET    /api/v1/payments/{id}
```

### Notification APIs

```http
GET    /api/v1/notifications
PATCH  /api/v1/notifications/{id}/read
PATCH  /api/v1/notifications/read-all
```

---

# 36. Database Relationships

Implement relationships approximately as:

```text
Clinic
  │
  ├── Branch
  │     │
  │     └── BranchLabTest
  │             │
  │             └── LabTest
  │
  └── ClinicStaff

Patient
  │
  ├── Prescription
  │
  └── LabTestAppointment
              │
              ├── Branch
              ├── LabTest
              ├── BranchLabTest
              ├── Prescription
              ├── Payment
              └── Notifications
```

Use foreign keys and indexes appropriately.

Important indexes:

```text
clinic_id
branch_id
test_id
appointment_date
status
patient_id
payment_status
appointment_number
```

---

# 37. Security Requirements

Implement:

- Authentication
- Role-based authorization
- Branch-level authorization
- Secure prescription access
- Input validation
- File type validation
- File size limits
- Rate limiting for booking/payment APIs
- SQL injection protection
- XSS protection
- CSRF protection where applicable
- Audit logging
- Secure payment webhook verification

Never expose prescription files through publicly accessible permanent URLs.

---

# 38. Mobile App UX Flow

Patient flow should be:

```text
Clinic
 ↓
Select Branch
 ↓
Lab Tests
 ↓
Select Test
 ↓
Test Details
 ↓
Choose
At Clinic / Home Collection
 ↓
Select Date
 ↓
Select Time
 ↓
Upload Prescription
 ↓
Booking Summary
 ↓
Choose Payment
 ↓
Submit Booking
 ↓
Pending
 ↓
Clinic Reviews
 ↓
Approved
 ↓
Patient receives:
App Notification + Email
 ↓
Appointment Details
 ↓
Test Completed
```

---

# 39. Clinic Portal UX Flow

Clinic staff flow:

```text
Clinic Portal
 ↓
Lab Tests
 ↓
Select Branch
 ↓
Configure Tests
 ↓
Set Price
 ↓
Set Duration
 ↓
Enable Clinic/Home Collection
 ↓
Set Availability
 ↓
Patient Books Test
 ↓
Pending Appointments
 ↓
Open Appointment
 ↓
Review Prescription
 ↓
Review Patient Details
 ↓
Add Precautions
 ↓
Approve / Reject
 ↓
Patient Notification + Email
 ↓
Appointment
 ↓
Complete Test
```

---

# 40. Important Business Rules

Implement these rules strictly:

1. A test must belong to a valid clinic.
2. A branch must belong to the clinic.
3. A branch test configuration must belong to that branch.
4. Patients can only book active tests.
5. Patients can only select supported service modes.
6. Patients cannot book unavailable time slots.
7. Prescription upload is mandatory when configured by the clinic.
8. Appointment initially starts as `PENDING`.
9. Only authorized clinic staff can approve/reject appointments.
10. Clinic approval should save the final precautions.
11. Patient must receive approval notification in-app and by email.
12. Payment status must be separate from appointment status.
13. Online payments must be verified server-side.
14. Pay-at-clinic appointments can remain unpaid until the clinic collects payment.
15. Historical appointment data must not change when a clinic later edits a test.
16. Prevent double booking at the database/backend level.
17. Branch staff must not access another branch's appointments.
18. Cancelled/rejected appointments must not be bookable or completed.
19. Prescription files must remain private.
20. Every important clinic action should be auditable.

---

# 41. Deliverables

Implement the feature end-to-end:

### Clinic Portal

- Lab test CRUD
- Branch-specific test configuration
- Pricing
- Duration
- Home/Clinic collection
- Prescription requirement
- Availability management
- Appointment dashboard
- Appointment details
- Prescription viewer
- Approve/reject workflow
- Precaution management
- Payment collection
- Appointment completion
- Filters/search
- Notifications

### Backend

- Database migrations
- Models/entities
- Relationships
- REST APIs
- Authentication/authorization
- Validation
- Appointment state machine
- Slot availability engine
- Double-booking protection
- File upload/storage
- Payment integration
- Payment webhook
- Notification service
- Email service
- Background jobs/reminders
- Audit logs
- Error handling
- API documentation

### Patient App

- Branch test listing
- Test details
- Availability
- Home/clinic selection
- Date/time selection
- Prescription upload
- Booking
- Pending state
- Appointment tracking
- Approval details
- Precautions
- Clinic contact details
- Payment
- Notifications
- Email confirmation

Build the feature so that the **Clinic Portal, Patient App, and backend APIs all use the same source of truth**, with branch-level access control and server-side validation. Do not implement critical business rules only on the frontend.