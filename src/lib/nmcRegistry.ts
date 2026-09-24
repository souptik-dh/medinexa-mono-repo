const NMC_SEARCH_URL = "https://nmc.org.in/indian-medical-register/search";

export interface NmcDoctorRecord {
  doctorId: number;
  registrationNo: string;
  name: string;
  fatherOrHusbandName: string | null;
  smcName: string | null;
  registrationDate: string | null;
  yearOfRegistration: number | null;
  doctorDegree: string | null;
  university: string | null;
  yearOfPassing: string | null;
  address: string | null;
  removed: boolean;
}

interface NmcRawDoctorRecord {
  id: number;
  name: string | null;
  father_name: string | null;
  registration_no: string | null;
  registration_date: string | null;
  state_medical_council: string | null;
  year_of_info: number | null;
  qualification: string | null;
  university: string | null;
  qualification_year: string | null;
  permanent_address: string | null;
  removed_status: string | boolean | null;
}

interface NmcSearchResponse {
  success: boolean;
  data: NmcRawDoctorRecord[];
}

function normalize(raw: NmcRawDoctorRecord): NmcDoctorRecord {
  return {
    doctorId: raw.id,
    registrationNo: (raw.registration_no ?? "").trim(),
    name: (raw.name ?? "").replace(/\s+/g, " ").trim(),
    fatherOrHusbandName: raw.father_name?.trim() || null,
    smcName: raw.state_medical_council?.trim() || null,
    registrationDate: raw.registration_date?.trim() || null,
    yearOfRegistration: raw.year_of_info ?? null,
    doctorDegree: raw.qualification?.trim() || null,
    university: raw.university?.trim() || null,
    yearOfPassing: raw.qualification_year?.trim() || null,
    address: raw.permanent_address?.trim() || null,
    removed: raw.removed_status === "1" || raw.removed_status === true,
  };
}

// The upstream service matches registrationNo as a substring, not exact, so a short
// or numeric-only registration number (e.g. "12345") can come back with thousands of
// unrelated doctors — the search endpoint caps per_page at 100 and won't honor
// anything higher, so we take the first (and only) page rather than paginate through
// what can be tens of thousands of pages for a generic query. We do the exact match
// ourselves within that page. The same registration number can legitimately belong to
// more than one record in the registry (re-issued numbers, data corrections, etc.), so
// we return every exact match rather than silently picking one — the caller (clinic
// owner sending an invite) picks the right doctor from the list.
export async function searchNmcDoctorsByRegistrationNo(
  registrationNo: string,
): Promise<NmcDoctorRecord[]> {
  const url = new URL(NMC_SEARCH_URL);
  url.searchParams.set("search_type", "reg_no");
  url.searchParams.set("reg_no", registrationNo);
  url.searchParams.set("page", "1");
  url.searchParams.set("per_page", "100");

  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
    },
  });

  if (res.status !== 200) {
    throw new Error(`NMC registry returned HTTP ${res.status}`);
  }

  let parsed: NmcSearchResponse;
  try {
    parsed = await res.json();
  } catch {
    throw new Error("NMC registry returned an unrecognized (non-JSON) response.");
  }
  if (parsed?.success !== true || !Array.isArray(parsed.data)) {
    throw new Error("NMC registry returned an unrecognized response shape.");
  }

  const target = registrationNo.trim().toLowerCase();
  return parsed.data
    .filter((r) => (r.registration_no ?? "").trim().toLowerCase() === target)
    .map(normalize);
}
