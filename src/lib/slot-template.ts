import { z } from "zod";

export const SLOT_LABELS = ["morning", "afternoon", "evening", "custom"] as const;
export type SlotLabel = (typeof SLOT_LABELS)[number];

const toMinutes = (t: string): number => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

// Shared by PATCH /doctor-assignments/:id and POST /branches/:id/doctor-invites — both
// write doctor_slot_templates rows and must accept/validate the exact same shape.
export const slotTemplateSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    label: z.enum(SLOT_LABELS).nullable().optional(),
    start_time: z.string().regex(/^\d{2}:\d{2}$/),
    end_time: z.string().regex(/^\d{2}:\d{2}$/),
    slot_duration_minutes: z.number().int().min(5).max(240),
    max_patients: z.number().int().min(1).max(100).default(1),
    is_active: z.boolean().default(true),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .array()
  .min(1)
  .refine(
    (arr) => arr.every((s) => s.start_time < s.end_time),
    "start_time must be earlier than end_time.",
  )
  .refine(
    (arr) => arr.every((s) => !s.end_date || s.start_date <= s.end_date),
    "start_date must not be after end_date.",
  )
  .refine(
    (arr) => {
      // Overlap is checked per weekday regardless of is_active, so re-activating a
      // range later can never silently produce two conflicting active ranges.
      const byWeekday = new Map<number, typeof arr>();
      for (const s of arr) {
        const list = byWeekday.get(s.weekday) ?? [];
        list.push(s);
        byWeekday.set(s.weekday, list);
      }
      for (const list of byWeekday.values()) {
        const sorted = [...list].sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time));
        for (let i = 0; i < sorted.length - 1; i++) {
          if (toMinutes(sorted[i].end_time) > toMinutes(sorted[i + 1].start_time)) return false;
        }
      }
      return true;
    },
    "Time ranges for the same weekday must not overlap.",
  );

export type SlotTemplateInput = z.infer<typeof slotTemplateSchema>[number];
