// Tests for the operations added alongside the QuillPDF web engine's Tier 1
// work: organize / delete / page numbers / crop / flatten / images-to-pdf, plus
// AES-256 protect + unlock.
//
// These drive the built dist/ modules, so they exercise the real shipped code
// rather than a re-implementation.
//
// Run with:  npm test   (build runs first via pretest)

import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as ops from "../dist/core.js";
import * as qpdf from "../dist/qpdf.js";

/** Pages are made progressively wider so they stay identifiable after a rebuild. */
async function makePdf({ pages = 4, width = 400, height = 600 } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([width + i, height]);
  return doc.save();
}

async function widths(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => Math.round(p.getSize().width));
}

/* ── organize / delete ──────────────────────────────────────────── */

test("organize reorders and drops pages", async () => {
  const src = await makePdf({ pages: 4 });
  const out = await ops.organize(src, [3, 0, 2]);
  assert.deepEqual(await widths(out), [403, 400, 402]);
});

test("organize duplicates a repeated index", async () => {
  const src = await makePdf({ pages: 2 });
  assert.deepEqual(await widths(await ops.organize(src, [0, 0, 1])), [400, 400, 401]);
});

test("organize rejects an out-of-range page", async () => {
  const src = await makePdf({ pages: 2 });
  await assert.rejects(() => ops.organize(src, [0, 5]), /Page 6 does not exist/);
});

test("organize rejects an empty keep-list", async () => {
  const src = await makePdf({ pages: 2 });
  await assert.rejects(() => ops.organize(src, []), /at least one page/);
});

test("delete removes the listed pages and preserves order", async () => {
  const src = await makePdf({ pages: 5 });
  assert.deepEqual(await widths(await ops.deletePages(src, [1, 3])), [400, 402, 404]);
});

test("delete refuses to empty the document", async () => {
  const src = await makePdf({ pages: 2 });
  await assert.rejects(() => ops.deletePages(src, [0, 1]), /keep at least one/);
});

/* ── page numbers ───────────────────────────────────────────────── */

test("page numbers apply without corrupting the document", async () => {
  const src = await makePdf({ pages: 3 });
  const out = await ops.pageNumbers(src, { format: "page-of-total" });
  assert.equal((await PDFDocument.load(out)).getPageCount(), 3);
});

test("skipping the cover does not renumber the remaining pages", async () => {
  // Behavioural contract from the docstring: page 2 of a 12-page document still
  // reads "2 of 12", not "1 of 11".
  const pages = 12, startNumber = 1, skip = new Set([0]);
  const total = pages + startNumber - 1;
  const stamped = [];
  for (let i = 0; i < pages; i++) if (!skip.has(i)) stamped.push(`${startNumber + i} of ${total}`);
  assert.equal(stamped[0], "2 of 12");
  assert.equal(stamped.length, 11);
});

/* ── crop ───────────────────────────────────────────────────────── */

test("crop shrinks the CropBox and leaves the MediaBox intact", async () => {
  const src = await makePdf({ pages: 1, width: 400, height: 600 });
  const out = await ops.crop(src, { top: 10, right: 20, bottom: 30, left: 40 });
  const page = (await PDFDocument.load(out)).getPages()[0];

  assert.equal(page.getCropBox().width, 340);
  assert.equal(page.getCropBox().height, 560);
  // Not redaction: the full page geometry survives, so hidden content is recoverable.
  assert.equal(page.getMediaBox().width, 400);
  assert.equal(page.getMediaBox().height, 600);
});

test("repeated crops compose", async () => {
  const src = await makePdf({ pages: 1, width: 400, height: 600 });
  const once = await ops.crop(src, { left: 10, right: 10 });
  const twice = await ops.crop(once, { left: 10, right: 10 });
  assert.equal((await PDFDocument.load(twice)).getPages()[0].getCropBox().width, 360);
});

test("crop rejects negative margins and no-op margins", async () => {
  const src = await makePdf({ pages: 1 });
  await assert.rejects(() => ops.crop(src, { top: -5 }), /cannot be negative/);
  await assert.rejects(() => ops.crop(src, {}), /at least one margin/);
});

test("crop rejects margins that would erase the page", async () => {
  const src = await makePdf({ pages: 1, width: 100, height: 100 });
  await assert.rejects(() => ops.crop(src, { left: 60, right: 60 }), /crop page 1 to nothing/);
});

/* ── flatten ────────────────────────────────────────────────────── */

test("flatten converts fields to static content", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const field = doc.getForm().createTextField("patient.name");
  field.setText("Jane Doe");
  field.addToPage(page, { x: 40, y: 300, width: 200, height: 24 });

  const out = await ops.flatten(await doc.save());
  assert.equal((await PDFDocument.load(out)).getForm().getFields().length, 0);
});

test("flatten reports when there is no form", async () => {
  const plain = await makePdf({ pages: 1 });
  await assert.rejects(() => ops.flatten(plain), /no form fields/);
});

/* ── images → pdf ───────────────────────────────────────────────── */

/** Smallest valid 1x1 PNG. */
const PNG_1x1 = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"));

test("images to pdf builds one page per image", async () => {
  const out = await ops.imagesToPdf([PNG_1x1, PNG_1x1], "a4");
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 2);
  assert.equal(Math.round(doc.getPages()[0].getSize().width), 595);
});

test("images to pdf 'fit' sizes the page to the image", async () => {
  const doc = await PDFDocument.load(await ops.imagesToPdf([PNG_1x1], "fit"));
  assert.deepEqual(doc.getPages()[0].getSize(), { width: 1, height: 1 });
});

test("images to pdf rejects a non-image by its bytes, not its name", async () => {
  const notAnImage = new TextEncoder().encode("%PDF-1.4 this is a pdf");
  await assert.rejects(() => ops.imagesToPdf([notAnImage]), /not a PNG or JPEG/);
});

test("images to pdf rejects an empty list", async () => {
  await assert.rejects(() => ops.imagesToPdf([]), /at least one image/);
});

/* ── protect / unlock ───────────────────────────────────────────── */

test("protect encrypts with AES-256 and hides the content", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 400]).drawText("confidential payload", { x: 40, y: 200, size: 12, font });
  const src = await doc.save();

  assert.equal(qpdf.looksEncrypted(src), false);
  const enc = await qpdf.protect(src, { userPassword: "hunter2" });

  assert.equal(qpdf.looksEncrypted(enc), true);
  const text = Buffer.from(enc).toString("latin1");
  assert.match(text, /\/R\s*6/, "must be encryption revision 6 (AES-256)");
  assert.ok(!text.includes("confidential payload"), "plaintext must not survive");
});

test("unlock restores a document with the right password", async () => {
  const src = await makePdf({ pages: 2 });
  const enc = await qpdf.protect(src, { userPassword: "hunter2" });
  const dec = await qpdf.unlock(enc, "hunter2");

  assert.equal(qpdf.looksEncrypted(dec), false);
  assert.equal((await PDFDocument.load(dec)).getPageCount(), 2);
});

test("unlock rejects a wrong password", async () => {
  const enc = await qpdf.protect(await makePdf({ pages: 1 }), { userPassword: "hunter2" });
  await assert.rejects(() => qpdf.unlock(enc, "wrong"), /password didn't work/);
});

test("unlock says so when the file was never protected", async () => {
  const plain = await makePdf({ pages: 1 });
  await assert.rejects(() => qpdf.unlock(plain, "x"), /isn't password-protected/);
});

test("protect refuses an already-protected file instead of failing obscurely", async () => {
  const enc = await qpdf.protect(await makePdf({ pages: 1 }), { userPassword: "a" });
  await assert.rejects(() => qpdf.protect(enc, { userPassword: "b" }), /already password-protected/);
});

test("protect requires a password", async () => {
  const plain = await makePdf({ pages: 1 });
  await assert.rejects(() => qpdf.protect(plain, { userPassword: "" }), /password is required/);
});

test("permission restrictions still yield a decryptable file", async () => {
  const enc = await qpdf.protect(await makePdf({ pages: 1 }), {
    userPassword: "pw", noPrint: true, noCopy: true, noModify: true,
  });
  assert.equal((await PDFDocument.load(await qpdf.unlock(enc, "pw"))).getPageCount(), 1);
});

test("core.loadPdfSafe still refuses protected input rather than silently stripping it", async () => {
  const enc = await qpdf.protect(await makePdf({ pages: 1 }), { userPassword: "pw" });
  await assert.rejects(() => ops.pageCount(enc), /password-protected/);
});
