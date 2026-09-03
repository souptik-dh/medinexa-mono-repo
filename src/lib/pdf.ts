export function buildTextPdf(opts: {
  title: string;
  meta: string[];
  body: string;
}): Buffer {
  const esc = (s: string): string =>
    s
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/[^\x20-\x7e]/g, "?");

  const streamLines: string[] = [];
  streamLines.push(`BT /F1 16 Tf 50 800 Td (${esc(opts.title)}) Tj ET`);
  let y = 772;
  for (const m of opts.meta) {
    streamLines.push(`BT /F1 10 Tf 50 ${y} Td (${esc(m)}) Tj ET`);
    y -= 16;
  }
  y -= 8;
  for (const line of opts.body.split(/\r?\n/)) {
    if (y < 50) {
      y = 780;
      streamLines.push(`BT /F1 10 Tf 50 ${y} Td (continued) Tj ET`);
      y -= 16;
    }
    streamLines.push(`BT /F1 11 Tf 50 ${y} Td (${esc(line)}) Tj ET`);
    y -= 16;
  }

  const stream = streamLines.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  const header = "%PDF-1.4\n";
  const lines: string[] = [];
  let offset = header.length;
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(offset);
    const obj = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    lines.push(obj);
    offset += Buffer.byteLength(obj, "latin1");
  }
  const xrefStart = offset;
  const xref = `${xrefStart.toString()}\nxref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((o) => String(o).padStart(10, "0") + " 00000 n \n")
    .join("")}`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(header + lines.join("") + xref + trailer, "latin1");
}

// A hand-picked, rough Helvetica average-advance-width ratio per point size
// (this generator has no font metrics table), used only to approximately
// center/right-align short header lines — not exact, good enough for a receipt.
function approxTextWidth(s: string, size: number, bold = false): number {
  return s.length * size * (bold ? 0.56 : 0.5);
}

/**
 * Renders a letterhead-style money-receipt PDF. With `copy: "both"` (the
 * default) it prints twice on one A4 page (top half "PATIENT COPY", bottom
 * half "CLINIC COPY") — mirroring a typical clinic/diagnostic-centre paper
 * receipt meant to be cut in half. With `copy: "patient"` or `"clinic"` it
 * prints only that copy, full-page — used when a specific role fetches the
 * PDF and should only see their own copy.
 */
export function buildReceiptPdf(opts: {
  title: string;
  receiptNumber: string;
  issuedAt: string;
  clinicName: string;
  branchName: string;
  branchAddress?: string | null;
  branchPhone?: string | null;
  patientName: string;
  rows: { label: string; value: string }[];
  amount?: { label: string; value: string; due?: boolean } | null;
  copy?: "patient" | "clinic" | "both";
}): Buffer {
  const esc = (s: string): string =>
    s
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/[^\x20-\x7e]/g, "?");

  const pageWidth = 595;
  const pageHeight = 842;
  const marginX = 40;
  const labelX = marginX + 4;
  const valueX = marginX + 120;
  const stream: string[] = [];

  const text = (s: string, x: number, y: number, size: number, bold = false) => {
    stream.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${esc(s)}) Tj ET`);
  };
  const centered = (s: string, y: number, size: number, bold = false) => {
    const w = approxTextWidth(s, size, bold);
    text(s, Math.max(marginX, (pageWidth - w) / 2), y, size, bold);
  };
  const rightAligned = (s: string, xRight: number, y: number, size: number, bold = false) => {
    text(s, xRight - approxTextWidth(s, size, bold), y, size, bold);
  };
  const hLine = (y: number, x1 = marginX, x2 = pageWidth - marginX) => {
    stream.push(`${x1} ${y} m ${x2} ${y} l S`);
  };

  const drawCopy = (top: number, copyLabel: string) => {
    let y = top - 32;
    centered(opts.clinicName, y, 16, true);
    y -= 15;
    if (opts.branchAddress) {
      centered(opts.branchAddress, y, 9);
      y -= 12;
    }
    if (opts.branchPhone) {
      centered(`Phone: ${opts.branchPhone}`, y, 9);
      y -= 12;
    }
    y -= 6;
    hLine(y);
    y -= 17;

    text(opts.title, marginX, y, 12, true);
    const badgeLabel = copyLabel;
    const badgeW = approxTextWidth(badgeLabel, 8, true) + 14;
    const badgeX = pageWidth - marginX - badgeW;
    stream.push("0.3 G 0.8 w");
    stream.push(`${badgeX} ${y - 4} ${badgeW} 14 re S`);
    stream.push("0 G");
    text(badgeLabel, badgeX + 7, y, 8, true);
    y -= 16;
    text(`Receipt No: ${opts.receiptNumber}   |   Issued: ${opts.issuedAt}`, marginX, y, 8.5);
    y -= 13;
    hLine(y);
    y -= 18;

    const infoRows = [
      { label: "Clinic", value: opts.clinicName },
      { label: "Branch", value: opts.branchName },
      { label: "Patient", value: opts.patientName },
      ...opts.rows,
    ];
    for (const row of infoRows) {
      text(row.label, labelX, y, 10);
      text(row.value, valueX, y, 10, true);
      y -= 15;
    }

    y -= 5;
    hLine(y);
    y -= 20;

    if (opts.amount) {
      text(opts.amount.label.toUpperCase(), marginX, y, 11, true);
      if (opts.amount.due) {
        const dueLabel = "DUE";
        const dueW = approxTextWidth(dueLabel, 8, true) + 12;
        const valueW = approxTextWidth(opts.amount.value, 13, true);
        const dueX = pageWidth - marginX - valueW - dueW - 10;
        stream.push("0.75 0.1 0.1 RG 0.8 w");
        stream.push(`${dueX} ${y - 3} ${dueW} 13 re S`);
        stream.push("0.75 0.1 0.1 rg");
        text(dueLabel, dueX + 6, y, 8, true);
        stream.push("0 G 0 g");
      }
      rightAligned(opts.amount.value, pageWidth - marginX, y, 13, true);
      y -= 20;
    }

    centered("This is a system-generated receipt.", y - 10, 7.5);
  };

  const copy = opts.copy ?? "both";

  if (copy === "both") {
    drawCopy(pageHeight, "PATIENT COPY");

    // Perforation between the two copies.
    const midY = pageHeight / 2;
    centered("- - - - - - - - - -  CUT HERE  - - - - - - - - - -", midY + 8, 8);
    stream.push("[3 3] 0 d 0.6 w");
    hLine(midY);
    stream.push("[] 0 d 1 w");

    drawCopy(midY, "CLINIC COPY");
  } else {
    drawCopy(pageHeight, copy === "patient" ? "PATIENT COPY" : "CLINIC COPY");
  }

  const content = stream.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];

  const header = "%PDF-1.4\n";
  const lines: string[] = [];
  let offset = header.length;
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(offset);
    const obj = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    lines.push(obj);
    offset += Buffer.byteLength(obj, "latin1");
  }
  const xrefStart = offset;
  const xref = `${xrefStart.toString()}\nxref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((o) => String(o).padStart(10, "0") + " 00000 n \n")
    .join("")}`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(header + lines.join("") + xref + trailer, "latin1");
}
