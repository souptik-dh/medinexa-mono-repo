import { api } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getLabTestAppointmentInScope } from "@/lib/lab-tests";
import { getReceiptForPdf } from "@/lib/receipts";
import { buildReceiptPdf } from "@/lib/pdf";

const EVENT_TITLES: Record<string, string> = {
  booking_confirmed: "Booking Confirmation Receipt",
  payment_received: "Payment Receipt",
  completed: "Test Completion Receipt",
};

export const GET = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "clinic_owner"]);
  await getLabTestAppointmentInScope(pool, ctx.params.id, auth);
  const receipt = await getReceiptForPdf(pool, "lab_test_appointment", ctx.params.id, ctx.params.receiptId);

  const d: Record<string, unknown> =
    typeof receipt.details_json === "string" ? JSON.parse(receipt.details_json) : receipt.details_json;

  const paid = typeof d.paid === "boolean" ? d.paid : receipt.event_type !== "booking_confirmed";

  const pdf = buildReceiptPdf({
    title: EVENT_TITLES[receipt.event_type] ?? "Receipt",
    receiptNumber: receipt.receipt_number,
    issuedAt: String(receipt.created_at),
    clinicName: String(d.clinic_name ?? "Clinic"),
    branchName: String(d.branch_name ?? "Branch"),
    branchAddress: d.branch_address ? String(d.branch_address) : null,
    branchPhone: d.branch_phone ? String(d.branch_phone) : null,
    patientName: String(d.patient_name ?? "Patient"),
    rows: [
      ...(d.test_name ? [{ label: "Test", value: String(d.test_name) }] : []),
      ...(d.appointment_number ? [{ label: "Appointment No.", value: String(d.appointment_number) }] : []),
      ...(d.service_mode
        ? [{ label: "Service Mode", value: d.service_mode === "HOME" ? "Home Collection" : "Clinic Visit" }]
        : []),
      { label: "Date & Time", value: `${d.scheduled_date ?? ""} ${d.scheduled_time ?? ""}`.trim() },
      ...(receipt.payment_method ? [{ label: "Payment Method", value: String(receipt.payment_method) }] : []),
      ...(receipt.reference_no ? [{ label: "Reference No.", value: String(receipt.reference_no) }] : []),
    ],
    amount:
      receipt.amount !== null && receipt.amount !== undefined
        ? {
            label: paid ? "Amount" : "Amount Due",
            value: `${Number(receipt.amount)} ${receipt.currency}`,
            due: !paid,
          }
        : null,
    copy: auth.role === "patient" ? "patient" : "clinic",
  });

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="receipt-${receipt.receipt_number}.pdf"`,
    },
  });
});
