import { useState, useEffect, useMemo, useCallback } from "react";

const CLINIC_DAYS = [1, 2, 4, 5, 0]; // Mon, Tue, Thu, Fri, Sun (JS getDay: Sun=0..Sat=6)
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function monthKey(y, m) {
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

export default function ClinicSchedule() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0-indexed
  const [workingDays, setWorkingDays] = useState(new Set(CLINIC_DAYS));
  const [unavailable, setUnavailable] = useState({}); // { "2026-08-17": true }
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved

  const key = monthKey(year, month);

  // Load persisted data for this month
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    (async () => {
      try {
        const wd = await window.storage.get(`workingdays:${key}`);
        const un = await window.storage.get(`unavailable:${key}`);
        if (!cancelled) {
          setWorkingDays(wd ? new Set(JSON.parse(wd.value)) : new Set(CLINIC_DAYS));
          setUnavailable(un ? JSON.parse(un.value) : {});
        }
      } catch (e) {
        if (!cancelled) {
          setWorkingDays(new Set(CLINIC_DAYS));
          setUnavailable({});
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [key]);

  const persist = useCallback(async (wd, un) => {
    setSaveState("saving");
    try {
      await window.storage.set(`workingdays:${key}`, JSON.stringify([...wd]));
      await window.storage.set(`unavailable:${key}`, JSON.stringify(un));
      setSaveState("saved");
    } catch (e) {
      setSaveState("idle");
    }
  }, [key]);

  const toggleWorkingDay = (dayIdx) => {
    if (!CLINIC_DAYS.includes(dayIdx)) return; // Wed & Sat are never clinic days
    const next = new Set(workingDays);
    if (next.has(dayIdx)) next.delete(dayIdx); else next.add(dayIdx);
    setWorkingDays(next);
    persist(next, unavailable);
  };

  const toggleUnavailable = (dateStr) => {
    const next = { ...unavailable };
    if (next[dateStr]) delete next[dateStr]; else next[dateStr] = true;
    setUnavailable(next);
    persist(workingDays, next);
  };

  // Build schedule rows for the selected month
  const rows = useMemo(() => {
    const out = [];
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const dateObj = new Date(year, month, d);
      const dow = dateObj.getDay();
      if (workingDays.has(dow)) {
        const dateStr = `${year}-${pad(month + 1)}-${pad(d)}`;
        out.push({ dateStr, day: d, dow, label: DAY_NAMES[dow], off: !!unavailable[dateStr] });
      }
    }
    return out;
  }, [year, month, workingDays, unavailable]);

  const scheduledCount = rows.filter((r) => !r.off).length;
  const offCount = rows.filter((r) => r.off).length;

  const changeMonth = (delta) => {
    let m = month + delta, y = year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setMonth(m); setYear(y);
  };

  const monthLabel = new Date(year, month, 1).toLocaleString("en-US", { month: "long", year: "numeric" });

  if (!loaded) {
    return <div style={{ padding: "2rem", fontSize: 14, color: "#5B7A7A" }}>Loading schedule…</div>;
  }

  return (
    <div style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif", background: "#F7FAFA", padding: "1.5rem", borderRadius: 16, color: "#12303A", maxWidth: 720 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: "#12303A" }}>Clinic doctor schedule</h2>
        <span style={{ fontSize: 12, color: "#5B7A7A" }}>{saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}</span>
      </div>
      <p style={{ margin: "0 0 1rem", fontSize: 13, color: "#5B7A7A" }}>
        Clinic operates Monday, Tuesday, Thursday, Friday and Sunday. Wednesday and Saturday are always closed.
      </p>

      {/* Week strip signature element */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {DAY_SHORT.map((name, idx) => {
          const isClinicDay = CLINIC_DAYS.includes(idx);
          const isSelected = workingDays.has(idx);
          return (
            <button
              key={idx}
              onClick={() => toggleWorkingDay(idx)}
              disabled={!isClinicDay}
              style={{
                flex: 1,
                padding: "10px 4px",
                borderRadius: 10,
                border: isSelected ? "1.5px solid #146C6C" : "1px solid #D6E4E1",
                background: !isClinicDay ? "#EDEFEE" : isSelected ? "#DCEEE9" : "#FFFFFF",
                color: !isClinicDay ? "#9AA6A3" : isSelected ? "#0F5C5C" : "#5B7A7A",
                fontSize: 12,
                fontWeight: 600,
                cursor: isClinicDay ? "pointer" : "not-allowed",
                textAlign: "center",
              }}
              title={isClinicDay ? "Toggle doctor availability this weekday" : "Clinic closed this day"}
            >
              {name}
              <div style={{ fontSize: 10, fontWeight: 400, marginTop: 2 }}>
                {!isClinicDay ? "Closed" : isSelected ? "Working" : "Off"}
              </div>
            </button>
          );
        })}
      </div>

      {/* Month navigation */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <button onClick={() => changeMonth(-1)} style={navBtn}>‹ Prev</button>
        <div style={{ fontWeight: 600, fontSize: 15 }}>{monthLabel}</div>
        <button onClick={() => changeMonth(1)} style={navBtn}>Next ›</button>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, fontSize: 12, color: "#5B7A7A" }}>
        <span><strong style={{ color: "#0F5C5C" }}>{scheduledCount}</strong> scheduled days</span>
        <span><strong style={{ color: "#C1503D" }}>{offCount}</strong> marked unavailable</span>
      </div>

      {/* Schedule table */}
      <div style={{ border: "1px solid #E1E8E7", borderRadius: 12, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#EAF3F1", textAlign: "left" }}>
              <th style={th}>Date</th>
              <th style={th}>Day</th>
              <th style={th}>Status</th>
              <th style={{ ...th, textAlign: "right" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 16, textAlign: "center", color: "#5B7A7A" }}>
                No clinic days selected for this month.
              </td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.dateStr} style={{ borderTop: "1px solid #EEF2F1" }}>
                <td style={td}>{r.dateStr}</td>
                <td style={td}>{r.label}</td>
                <td style={td}>
                  <span style={{
                    padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600,
                    background: r.off ? "#F7E4E0" : "#DCEEE9",
                    color: r.off ? "#C1503D" : "#0F5C5C",
                  }}>
                    {r.off ? "Not available" : "Scheduled"}
                  </span>
                </td>
                <td style={{ ...td, textAlign: "right" }}>
                  <button
                    onClick={() => toggleUnavailable(r.dateStr)}
                    style={{
                      fontSize: 11, padding: "4px 10px", borderRadius: 8,
                      border: "1px solid #D6E4E1", background: "#fff", cursor: "pointer",
                      color: r.off ? "#0F5C5C" : "#C1503D",
                    }}
                  >
                    {r.off ? "Mark available" : "Mark unavailable"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const navBtn = {
  fontSize: 13, padding: "6px 12px", borderRadius: 8,
  border: "1px solid #D6E4E1", background: "#fff", cursor: "pointer", color: "#146C6C",
};
const th = { padding: "8px 12px", fontSize: 11, color: "#5B7A7A", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 };
const td = { padding: "8px 12px", color: "#12303A" };
