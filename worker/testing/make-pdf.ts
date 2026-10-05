/**
 * Test-only: a tiny PDF writer, so extraction tests need no binary fixtures.
 * Each page is either lines of Helvetica text or a grey image with no text
 * layer (what a scanner produces). Output is a valid PDF 1.4 with an xref.
 */
export type FakePage = { lines: string[] } | { image: true };

export function makePdf(pages: FakePage[], opts: { title?: string } = {}): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // object number
  };

  const catalog = add(""); // filled in below
  const pagesObj = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const info = opts.title ? add(`<< /Title (${escapePdf(opts.title)}) >>`) : null;

  const kids: number[] = [];
  for (const page of pages) {
    let resources: string;
    let content: string;
    if ("image" in page) {
      const w = 64;
      const h = 64;
      const pixels = "\x80".repeat(w * h);
      const img = add(
        `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`,
      );
      resources = `<< /XObject << /Im0 ${img} 0 R >> >>`;
      content = "q 500 0 0 700 50 50 cm /Im0 Do Q";
    } else {
      resources = `<< /Font << /F1 ${font} 0 R >> >>`;
      const body = page.lines.map((l, i) => `${i === 0 ? "" : "0 -14 Td "}(${escapePdf(l)}) Tj`).join("\n");
      content = `BT /F1 11 Tf 50 780 Td\n${body}\nET`;
    }
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 842] /Resources ${resources} /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  // Latin-1 throughout, so string length = byte length for the xref offsets.
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);
}

function escapePdf(s: string): string {
  return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

/** A page of plausible prose, numbered so pages differ. */
export function proseLines(page: number): string[] {
  return [
    `Chapter ${page}: Consistency models`,
    "A distributed system replicates data so that it survives the failure of",
    "a single machine. Replication raises the question of what a reader sees",
    "while a write is still propagating, which is what a consistency model",
    `answers. Section ${page} compares linearizability with eventual consistency.`,
  ];
}
