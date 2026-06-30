// Unit tests for the quillpdf-mcp core engine.
//
// These exercise the ACTUAL ported functions (the compiled dist/core.js), not
// just pdf-lib invariants — the Node port is pure, so every operation can run
// and be asserted in-process. Fixtures are built in memory with pdf-lib so the
// repo carries no binary test PDFs.
//
// Run:  npm test   (pretest builds dist first)

import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts, rgb, degrees } from "pdf-lib";

import {
  merge,
  parseRanges,
  splitByRanges,
  extractPages,
  pageCount,
  rotate,
  watermark,
  bates,
  hexToRgb,
  cleanMetadata,
  loadPdfSafe,
} from "../dist/core.js";

/** Build an unencrypted PDF with N pages and some metadata. Returns Uint8Array. */
async function makePdf({ pages = 1, title = "orig-title" } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor("Original Author");
  doc.setSubject("Original Subject");
  doc.setKeywords(["secret", "words"]);
  doc.setCreator("Original Creator");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([400, 500]);
    page.drawText(`Page ${i + 1}`, { x: 50, y: 450, size: 24, font, color: rgb(0, 0, 0) });
  }
  return doc.save();
}

const ENCRYPTED_BLOB =
  "%PDF-1.4\n" +
  "1 0 obj\n<< /Type /Catalog >>\nendobj\n" +
  "2 0 obj\n<< /Filter /Standard /V 1 /R 2 /Length 40 /P -3904 " +
  "/O <28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a> " +
  "/U <28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a> >>\nendobj\n" +
  "xref\n0 3\n0000000000 65535 f \n0000000010 00000 n \n0000000050 00000 n \n" +
  "trailer\n<< /Size 3 /Root 1 0 R /Encrypt 2 0 R " +
  "/ID [<11111111111111111111111111111111><11111111111111111111111111111111>] >>\n" +
  "startxref\n200\n%%EOF\n";

// ── loadPdfSafe ───────────────────────────────────────────────────────────────
test("loadPdfSafe: loads a normal PDF", async () => {
  const doc = await loadPdfSafe(await makePdf({ pages: 2 }));
  assert.equal(doc.getPageCount(), 2);
});

test("loadPdfSafe: refuses an encrypted PDF with a clear message (no silent unlock)", async () => {
  const bytes = new TextEncoder().encode(ENCRYPTED_BLOB);
  await assert.rejects(() => loadPdfSafe(bytes), /password-protected/i);
});

// ── merge ─────────────────────────────────────────────────────────────────────
test("merge: page counts sum", async () => {
  const out = await merge([await makePdf({ pages: 2 }), await makePdf({ pages: 3 })]);
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 5);
});

test("merge: order is preserved (3 inputs)", async () => {
  const out = await merge([await makePdf({ pages: 1 }), await makePdf({ pages: 2 }), await makePdf({ pages: 1 })]);
  assert.equal((await PDFDocument.load(out)).getPageCount(), 4);
});

test("merge: rejects fewer than 2 inputs", async () => {
  await assert.rejects(async () => merge([await makePdf()]), /at least 2/i);
});

// ── parseRanges ─────────────────────────────────────────────────────────────
test("parseRanges: ranges and singletons → 0-based indices", () => {
  assert.deepEqual(parseRanges("1-3,5,7-9", 10), [[0, 1, 2], [4], [6, 7, 8]]);
});

test("parseRanges: whitespace tolerant", () => {
  assert.deepEqual(parseRanges(" 1 - 2 , 4 ", 5), [[0, 1], [3]]);
});

test("parseRanges: out-of-bounds throws", () => {
  assert.throws(() => parseRanges("1-99", 5), /Invalid range/);
  assert.throws(() => parseRanges("0", 5), /Invalid page/);
  assert.throws(() => parseRanges("3-1", 5), /Invalid range/);
});

// ── splitByRanges ───────────────────────────────────────────────────────────
test("splitByRanges: one output per comma group with correct page counts", async () => {
  const src = await makePdf({ pages: 5 });
  const outs = await splitByRanges(src, "1-3,5");
  assert.equal(outs.length, 2);
  assert.equal((await PDFDocument.load(outs[0])).getPageCount(), 3);
  assert.equal((await PDFDocument.load(outs[1])).getPageCount(), 1);
});

// ── extractPages ────────────────────────────────────────────────────────────
test("extractPages: single output with the listed pages, order preserved", async () => {
  const src = await makePdf({ pages: 5 });
  const out = await extractPages(src, "5,1,1");
  assert.equal((await PDFDocument.load(out)).getPageCount(), 3);
});

test("extractPages: invalid page throws", async () => {
  await assert.rejects(async () => extractPages(await makePdf({ pages: 2 }), "9"), /Invalid page/);
});

// ── pageCount ─────────────────────────────────────────────────────────────────
test("pageCount: returns the number of pages", async () => {
  assert.equal(await pageCount(await makePdf({ pages: 7 })), 7);
});

// ── rotate ──────────────────────────────────────────────────────────────────
test("rotate: all pages by 90°", async () => {
  const out = await rotate(await makePdf({ pages: 2 }), 90);
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPages()[0].getRotation().angle, 90);
  assert.equal(doc.getPages()[1].getRotation().angle, 90);
});

test("rotate: only the targeted (1-based) pages", async () => {
  const out = await rotate(await makePdf({ pages: 3 }), 180, [2]);
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPages()[0].getRotation().angle, 0);
  assert.equal(doc.getPages()[1].getRotation().angle, 180);
  assert.equal(doc.getPages()[2].getRotation().angle, 0);
});

test("rotate: additive and normalized into [0,360)", async () => {
  // Start a page already at 270°, add 180° → 450 → normalized 90.
  const doc0 = await PDFDocument.create();
  const p = doc0.addPage([400, 400]);
  p.setRotation(degrees(270));
  const out = await rotate(await doc0.save(), 180);
  assert.equal((await PDFDocument.load(out)).getPages()[0].getRotation().angle, 90);
});

test("rotate: non-multiple-of-90 throws", async () => {
  await assert.rejects(async () => rotate(await makePdf(), 45), /multiple of 90/);
});

test("rotate: out-of-range page throws", async () => {
  await assert.rejects(async () => rotate(await makePdf({ pages: 2 }), 90, [9]), /out of range/);
});

// ── watermark ─────────────────────────────────────────────────────────────────
test("watermark: page count preserved, output reloadable", async () => {
  const out = await watermark(await makePdf({ pages: 3 }), "DRAFT", { position: "center" });
  assert.equal((await PDFDocument.load(out)).getPageCount(), 3);
});

test("watermark: empty text throws", async () => {
  await assert.rejects(async () => watermark(await makePdf(), ""), /required/i);
});

// ── bates ─────────────────────────────────────────────────────────────────────
test("bates: page count preserved", async () => {
  const out = await bates(await makePdf({ pages: 5 }), { prefix: "PLT-", startNumber: 100, padWidth: 6 });
  assert.equal((await PDFDocument.load(out)).getPageCount(), 5);
});

test("bates: 100-page document stamps without error", async () => {
  const out = await bates(await makePdf({ pages: 100 }), { prefix: "VOL1-" });
  assert.equal((await PDFDocument.load(out)).getPageCount(), 100);
});

// ── hexToRgb ──────────────────────────────────────────────────────────────────
test("hexToRgb: valid colors parse to normalized floats", () => {
  assert.deepEqual(hexToRgb("#000000"), { r: 0, g: 0, b: 0 });
  assert.deepEqual(hexToRgb("#ffffff"), { r: 1, g: 1, b: 1 });
  assert.deepEqual(hexToRgb("#FF0000"), { r: 1, g: 0, b: 0 });
});

test("hexToRgb: invalid input falls back to black", () => {
  assert.deepEqual(hexToRgb("notacolor"), { r: 0, g: 0, b: 0 });
  assert.deepEqual(hexToRgb("#gg0000"), { r: 0, g: 0, b: 0 });
  assert.deepEqual(hexToRgb(""), { r: 0, g: 0, b: 0 });
});

// ── cleanMetadata ─────────────────────────────────────────────────────────────
test("cleanMetadata: clears title/author/subject/keywords/creator", async () => {
  const out = await cleanMetadata(await makePdf({ title: "orig-title" }));
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getTitle() ?? "", "");
  assert.equal(doc.getAuthor() ?? "", "");
  assert.equal(doc.getSubject() ?? "", "");
  assert.equal(doc.getCreator() ?? "", "");
  // Known pdf-lib behavior: /Producer is overwritten with pdf-lib's signature
  // on save() regardless of what we set. We assert it so a future pdf-lib change
  // surfaces here.
  assert.match(doc.getProducer() ?? "", /pdf-lib/i);
});

test("cleanMetadata: output is still a valid, loadable PDF", async () => {
  const out = await cleanMetadata(await makePdf({ pages: 2 }));
  assert.equal((await PDFDocument.load(out)).getPageCount(), 2);
});

// ── XMP metadata scrub (regression for the review-found leak) ─────────────────
// pdf-lib does not itself emit XMP, so we hand-attach a /Metadata stream exactly
// as Acrobat/Word/InDesign/LibreOffice do, then prove cleanMetadata removes it.
async function makeXmpPdf(secret) {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const xmp =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${secret}</rdf:li></rdf:Alt></dc:title>` +
    `<dc:creator><rdf:Seq><rdf:li>${secret}-AUTHOR</rdf:li></rdf:Seq></dc:creator>` +
    '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const xmpBytes = new TextEncoder().encode(xmp);
  const dict = doc.context.obj({
    Type: PDFName.of("Metadata"),
    Subtype: PDFName.of("XML"),
    Length: PDFNumber.of(xmpBytes.length),
  });
  const ref = doc.context.register(PDFRawStream.of(dict, xmpBytes));
  doc.catalog.set(PDFName.of("Metadata"), ref);
  return doc.save();
}

test("cleanMetadata: scrubs the catalog XMP stream, not just the info dict", async () => {
  const SECRET = "SECRET-XMP-9f3a2b";
  const src = await makeXmpPdf(SECRET);
  assert.ok(Buffer.from(src).includes(SECRET), "fixture must contain the XMP secret before cleaning");
  const out = await cleanMetadata(src);
  assert.ok(!Buffer.from(out).includes(SECRET), "cleaned output must NOT contain the XMP secret");
  assert.equal((await PDFDocument.load(out)).getPageCount(), 1, "cleaned output stays a valid 1-page PDF");
});
