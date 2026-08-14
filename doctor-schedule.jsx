import { useState, useEffect, useMemo, useCallback } from "react";

const CLINIC_DAYS = [1, 2, 4, 5, 0]; // Mon, Tue, Thu, Fri, Sun (JS getDay: Sun=0..Sat=6)
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOCTORS_LIST_KEY = "doctors:list";

function monthKey(y, m) {
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function makeDoctorId() {
  return `doc_${Math.random().toString(36).slice(2, 10)}`;
}

export default function DoctorSchedule() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0-indexed
  const [doctors, setDoctors] = useState([]); // [{ id, name }]
  const [activeDoctorId, setActiveDoctorId] = useState(null);
  const [newDoctorName, setNewDoctorName] = useState("");
  const [rosterLoaded, setRosterLoaded] = useState(false);

  const [workingDays, setWorkingDays] = useState(new Set(CLINIC_DAYS));
  const [unavailable, setUnavailable] = useState({}); // { "2026-08-17": true }
  const [scheduleLoaded, setScheduleLoaded] = useState(false);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved

  const monthCode = monthKey(year, month);

  // Load doctor roster once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await window.storage.get(DOCTORS_LIST_KEY);
        const parsed = list ? JSON.parse(list.value) : [];
        if (!cancelled) {
          setDoctors(parsed);
          if (parsed.length) setActiveDoctorId(parsed[0].id);
        }
      } catch (e) {
        if (!cancelled) setDoctors([]);
      } finally {
        if (!cancelled) setRosterLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const persistRoster = useCallback(async (list) => {
    await window.storage.set(DOCTORS_LIST_KEY, JSON.stringify(list));
  }, []);

  const addDoctor = () => {
    const name = newDoctorName.trim();
    if (!name) return;
    const doctor = { id: makeDoctorId(), name };
    const next = [...doctors, doctor];
    setDoctors(next);
    setActiveDoctorId(doctor.id);
    setNewDoctorName("");
    persistRoster(next);
  };

  const removeDoctor = (doctorId) => {
    const next = doctors.filter((d) => d.id !== doctorId);
    setDoctors(next);
    persistRoster(next);
    if (activeDoctorId === doctorId) {
      setActiveDoctorId(next.length ? next[0].id : null);
    }
  };

  // Load persisted schedule for the active doctor + month
  useEffect(() => {
    if (!activeDoctorId) {
      setWorkingDays(new Set(CLINIC_DAYS));
      setUnavailable({});
      setScheduleLoaded(true);
      return;
    }
    let cancelled = false;
    setScheduleLoaded(false);
    (async () => {
      try {
        const wd = await window.storage.get(`workingdays:${activeDoctorId}:${monthCode}`);
        const un = await window.storage.get(`unavailable:${activeDoctorId}:${monthCode}`);
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
        if (!cancelled) setScheduleLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [activeDoctorId, monthCode]);

  const persist = useCallback(async (wd, un) => {
    if (!activeDoctorId) return;
    setSaveState("saving");
    try {
      await window.storage.set(`workingdays:${activeDoctorId}:${monthCode}`, JSON.stringify([...wd]));
      await window.storage.set(`unavailable:${activeDoctorId}:${monthCode}`, JSON.stringify(un));
      setSaveState("saved");
    } catch (e) {
      setSaveState("idle");
    }
  }, [activeDoctorId, monthCode]);

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
  const activeDoctor = doctors.find((d) => d.id === activeDoctorId) || null;

  if (!rosterLoaded) {
    return <div style={{ padding: "2rem", fontSize: 14, color: "#5B7A7A" }}>Loading doctors…</div>;
  }

  return (
    <div style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif", background: "#F7FAFA", padding: "1.5rem", borderRadius: 16, color: "#12303A", maxWidth: 760 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 600, color: "#12303A" }}>Doctor schedules</h2>
      <p style={{ margin: "0 0 1rem", fontSize: 13, color: "#5B7A7A" }}>
        Clinic operates Monday, Tuesday, Thursday, Friday and Sunday. Wednesday and Saturday are always closed.
      </p>

      {/* Add doctor */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          value={newDoctorName}
          onChange={(e) => setNewDoctorName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addDoctor(); }}
          placeholder="Doctor name"
          style={{
            flex: 1, padding: "8px 12px", borderRadius: 8,
            border: "1px solid #D6E4E1", fontSize: 13, color: "#12303A",
          }}
        />
        <button onClick={addDoctor} style={navBtn}>+ Add doctor</button>
      </div>

      {/* Doctor tabs */}
      {doctors.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
          {doctors.map((d) => {
            const isActive = d.id === activeDoctorId;
            return (
              <div
                key={d.id}
                onClick={() => setActiveDoctorId(d.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "6px 6px 6px 12px", borderRadius: 999,
                  border: isActive ? "1.5px solid #146C6C" : "1px solid #D6E4E1",
                  background: isActive ? "#DCEEE9" : "#FFFFFF",
                  color: isActive ? "#0F5C5C" : "#5B7A7A",
                  fontSize: 12, fontWeight: 600, cursor: "pointer",
                }}
              >
                {d.name}
                <button
                  onClick={(e) => { e.stopPropagation(); removeDoctor(d.id); }}
                  title="Remove doctor from active list (schedule data is kept)"
                  style={{
                    width: 18, height: 18, borderRadius: "50%", border: "none",
                    background: "transparent", color: "inherit", cursor: "pointer",
                    fontSize: 12, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      {!activeDoctor && (
        <div style={{ padding: "1.5rem", textAlign: "center", color: "#5B7A7A", fontSize: 13, border: "1px dashed #D6E4E1", borderRadius: 12 }}>
          Add a doctor above to set up their schedule.
        </div>
      )}

      {activeDoctor && !scheduleLoaded && (
        <div style={{ padding: "1.5rem", fontSize: 14, color: "#5B7A7A" }}>Loading schedule…</div>
      )}

      {activeDoctor && scheduleLoaded && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#0F5C5C" }}>{activeDoctor.name}</div>
            <span style={{ fontSize: 12, color: "#5B7A7A" }}>{saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}</span>
          </div>

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
                  title={isClinicDay ? "Toggle this doctor's availability on this weekday" : "Clinic closed this day"}
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

          {/* Schedule list */}
          <div style={{ border: "1px solid #E1E8E7", borderRadius: 12, overflow: "hidden" }}>
            {rows.length === 0 && (
              <div style={{ padding: 16, textAlign: "center", color: "#5B7A7A", fontSize: 13 }}>
                No clinic days selected for this month.
              </div>
            )}
            {rows.map((r, i) => (
              <div
                key={r.dateStr}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "10px 12px", fontSize: 13,
                  borderTop: i === 0 ? "none" : "1px solid #EEF2F1",
                }}
              >
                <div>
                  <span style={{ fontWeight: 600 }}>{r.dateStr}</span>
                  <span style={{ color: "#5B7A7A" }}> · {r.label}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{
                    padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600,
                    background: r.off ? "#F7E4E0" : "#DCEEE9",
                    color: r.off ? "#C1503D" : "#0F5C5C",
                  }}>
                    {r.off ? "Not available" : "Scheduled"}
                  </span>
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
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const navBtn = {
  fontSize: 13, padding: "6px 12px", borderRadius: 8,
  border: "1px solid #D6E4E1", background: "#fff", cursor: "pointer", color: "#146C6C",
};
