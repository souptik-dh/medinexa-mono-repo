import https from "node:https";
import { constants as cryptoConstants } from "node:crypto";

const PRDEODB_URL = "https://prdeodb.wb.gov.in/findAcknowledgement.php";

export interface TradeLicenseCheckResult {
  validated: boolean;
  message: string;
}

// PRDEODB is a legacy government portal — findAcknowledgement.php renders an HTML
// fragment, not JSON, so "parse and normalize into JSON" (per the design doc) means
// sniffing known phrases in that markup rather than JSON.parse. Observed shapes:
//   - found + certificate issued: an "alert-success" block containing
//     "Your certificate has been generated" / a status cell reading "CERTIFICATE ISSUED"
//   - docket not found: an "alert-danger" block containing "Record Not Found"
// Anything else (e.g. "Pending for Gram Panchayat's acknowledgement" — mid-process,
// neither issued nor rejected) is unrecognized and throws, since we can't confidently
// call it VALID or INVALID; the caller maps that to "unable to validate right now".
const NOT_FOUND_RE = /record not found/i;
const ISSUED_RE = /certificate has been generated|certificate issued/i;

// The server's TLS stack only supports legacy renegotiation, which Node's default
// fetch (undici) rejects outright (ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED) —
// so this one call goes through node:https with an Agent that opts back into it,
// rather than the plain fetch() used for every other external call in this codebase.
const legacyTlsAgent = new https.Agent({
  secureOptions: cryptoConstants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
});

function postForm(url: string, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        agent: legacyTlsAgent,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
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

export async function checkTradeLicense(tradeLicenseNumber: string): Promise<TradeLicenseCheckResult> {
  const { status, text: html } = await postForm(
    PRDEODB_URL,
    new URLSearchParams({ deptid: tradeLicenseNumber }).toString(),
  );

  if (NOT_FOUND_RE.test(html)) {
    return {
      validated: false,
      message: "The docket number was not found. Please verify the number and try again.",
    };
  }
  if (ISSUED_RE.test(html)) {
    return { validated: true, message: "Application found" };
  }
  throw new Error(`PRDEODB returned an unrecognized response (status ${status})`);
}
