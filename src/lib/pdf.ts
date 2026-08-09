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
