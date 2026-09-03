import { api } from "@/lib/http";
import { pool } from "@/lib/db";
import { requireRoles } from "@/lib/auth";
import { getAppointmentInScope } from "@/lib/appointments";
import { getReceiptForPdf } from "@/lib/receipts";
import { buildReceiptPdf } from "@/lib/pdf";

const EVENT_TITLES: Record<string, string> = {
  booking_confirmed: "Booking Confirmation Receipt",
  payment_received: "Payment Receipt",
  completed: "Consultation Completion Receipt",
};

export const GET = api({ rateLimit: 200 }, async (ctx) => {
  const auth = requireRoles(ctx.auth, ["patient", "branch_staff", "doctor", "clinic_owner"]);
  await getAppointmentInScope(pool, ctx.params.id, auth);
  const receipt = await getReceiptForPdf(pool, "appointment", ctx.params.id, ctx.params.receiptId);

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
      ...(d.doctor_name ? [{ label: "Doctor", value: `Dr. ${d.doctor_name}` }] : []),
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
