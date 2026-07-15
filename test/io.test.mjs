// io.ts guards: the overwrite refusal (silent-clobber hazard for the
// legal/discovery audience) and the friendly non-PDF / missing-file errors.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPdf, writePdf } from "../dist/io.js";
import { PDFDocument } from "pdf-lib";

async function makePdfBytes() {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return doc.save();
}

test("writePdf refuses to replace an existing file by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quillpdf-io-"));
  const out = join(dir, "precious.pdf");
  await writeFile(out, "irreplaceable exhibit");
  const bytes = await makePdfBytes();

  await assert.rejects(
    () => writePdf(out, bytes),
    /output file already exists: .*precious\.pdf.*--force/,
    "must refuse with an actionable message"
  );
  assert.equal(
    await readFile(out, "utf8"),
    "irreplaceable exhibit",
    "the existing file must be untouched after the refusal"
  );
  await rm(dir, { recursive: true });
});

test("writePdf replaces an existing file when force is set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quillpdf-io-"));
  const out = join(dir, "out.pdf");
  await writeFile(out, "old");
  const bytes = await makePdfBytes();

  await writePdf(out, bytes, { force: true });
  const written = await readFile(out);
  assert.ok(written.length > 100 && written.subarray(0, 5).toString() === "%PDF-", "new PDF bytes written");
  await rm(dir, { recursive: true });
});

test("writePdf writes normally when the file doesn't exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quillpdf-io-"));
  const out = join(dir, "fresh.pdf");
  await writePdf(out, await makePdfBytes());
  assert.ok((await readFile(out)).length > 0);
  await rm(dir, { recursive: true });
});

test("readPdf rejects a non-PDF file with the filename in the message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quillpdf-io-"));
  const txt = join(dir, "notes.txt");
  await writeFile(txt, "just some text, definitely not a pdf");
  await assert.rejects(() => readPdf(txt), /"?.*notes\.txt"? is not a PDF file/);
  await rm(dir, { recursive: true });
});

test("readPdf reports a missing file plainly", async () => {
  await assert.rejects(() => readPdf("/nonexistent/nowhere.pdf"), /file not found: \/nonexistent\/nowhere\.pdf/);
});

test("readPdf accepts a real PDF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quillpdf-io-"));
  const p = join(dir, "real.pdf");
  await writeFile(p, await makePdfBytes());
  const bytes = await readPdf(p);
  assert.ok(bytes.length > 100);
  await rm(dir, { recursive: true });
});
