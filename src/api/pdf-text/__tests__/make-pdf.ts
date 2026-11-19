/**
 * Small, valid PDFs for tests: one page per string (lines split on "\n"),
 * Helvetica, ASCII text. pdf.js leaves out text past the page's edges, so a
 * long page needs short lines and a small `fontSize`. `encrypted` adds a
 * standard security handler whose user password is not empty, so a reader
 * must ask for it.
 */
export function makePdf(pages: string[], options: { encrypted?: boolean; fontSize?: number } = {}): Uint8Array {
  const size = options.fontSize ?? 12;
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalog = add("");
  const pageTree = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const text of pages) {
    const lines = text.split("\n").map((line) => `(${line.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj T*`).join(" ");
    const stream = `BT /F1 ${size} Tf ${size * 1.2} TL 36 ${780 - size} Td ${lines} ET`;
    const contents = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contents} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`;
  objects[pageTree - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const hex32 = (seed: string) => Buffer.from(seed.repeat(32).slice(0, 32)).toString("hex");
  const encrypt = options.encrypted ? add(`<< /Filter /Standard /V 1 /R 2 /O <${hex32("o")}> /U <${hex32("u")}> /P -4 >>`) : 0;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${encrypt ? ` /Encrypt ${encrypt} 0 R /ID [<${"ab".repeat(16)}> <${"ab".repeat(16)}>]` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}
