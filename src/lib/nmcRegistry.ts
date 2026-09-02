import https from "node:https";

const NMC_SEARCH_URL = "https://www.nmc.org.in/MCIRest/open/getDataFromService?service=searchDoctor";

// nmc.org.in serves an incomplete certificate chain (no intermediate), so Node's
// default fetch (undici) rejects it with UNABLE_TO_VERIFY_LEAF_SIGNATURE — same
// class of legacy-govt-portal TLS issue as PRDEODB in tradeLicense.ts, just a
// different symptom, so this one call also goes through node:https instead of fetch().
const nmcAgent = new https.Agent({ rejectUnauthorized: false });

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
  doctorId: number;
  registrationNo: string | null;
  smcName: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  parentName: string | null;
  regDate: string | null;
  yearInfo: number | null;
  doctorDegree: string | null;
  university: string | null;
  yearOfPassing: string | null;
  address: string | null;
  removedStatus: boolean | null;
}

function postJson(url: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        agent: nmcAgent,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function normalize(raw: NmcRawDoctorRecord): NmcDoctorRecord {
  const name = [raw.firstName, raw.middleName, raw.lastName]
    .filter((part): part is string => !!part?.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    doctorId: raw.doctorId,
    registrationNo: (raw.registrationNo ?? "").trim(),
    name,
    fatherOrHusbandName: raw.parentName?.trim() || null,
    smcName: raw.smcName?.trim() || null,
    registrationDate: raw.regDate?.trim() || null,
    yearOfRegistration: raw.yearInfo ?? null,
    doctorDegree: raw.doctorDegree?.trim() || null,
    university: raw.university?.trim() || null,
    yearOfPassing: raw.yearOfPassing?.trim() || null,
    address: raw.address?.trim() || null,
    removed: raw.removedStatus === true,
  };
}

// The upstream service matches registrationNo as a substring, not exact, so a short
// or numeric-only registration number (e.g. "12345") can come back with thousands of
// unrelated doctors. We do the exact match ourselves and return a single record.
export async function searchNmcDoctorByRegistrationNo(
  registrationNo: string,
): Promise<NmcDoctorRecord | null> {
  const { status, text } = await postJson(
    NMC_SEARCH_URL,
    JSON.stringify({ registrationNo }),
  );

  if (status !== 200) {
    throw new Error(`NMC registry returned HTTP ${status}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("NMC registry returned an unrecognized (non-JSON) response.");
  }
  if (!Array.isArray(raw)) {
    throw new Error("NMC registry returned an unrecognized response shape.");
  }

  const target = registrationNo.trim().toLowerCase();
  const match = (raw as NmcRawDoctorRecord[]).find(
    (r) => (r.registrationNo ?? "").trim().toLowerCase() === target,
  );
  return match ? normalize(match) : null;
}
