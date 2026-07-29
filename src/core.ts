/**
 * quillpdf-mcp core — pure, local PDF operations.
 *
 * Every function takes PDF bytes in and returns PDF bytes (or a number) out.
 * Nothing here touches the filesystem or the network: the I/O layer (io.ts) and
 * the CLI / MCP front-ends are the only code that reads or writes disk. That
 * keeps the engine trivially unit-testable AND makes the privacy guarantee
 * structural — there is no code path in this module that could send a document
 * anywhere.
 *
 * Ported from the QuillPDF web engine (built on pdf-lib). The browser version
 * took `File` objects and produced object URLs; this version takes and returns
 * `Uint8Array`. The pure-pdf-lib operations port essentially unchanged.
 *
 * Canvas / rasterization operations (compress, pdf-to-image, redact, OCR) are
 * deliberately NOT here — they require a Node image backend and are slated for
 * phase 2. Shipping only fully-local, dependency-light operations keeps the
 * privacy claim honest and the install tiny.
 *
 * Note on file-size limits: the web engine capped inputs (browser memory). This
 * is a local tool operating on the caller's own files, so those artificial caps
 * are intentionally dropped — the user's machine is the real limit.
 */

import { PDFDocument, PDFDict, PDFName, PDFRef, rgb, StandardFonts, degrees } from "pdf-lib";

/**
 * Load a PDF without silently stripping encryption. If the file is password-
 * protected, throw a clear error instead of bypassing the password — matching
 * the web engine's security posture (never quietly unlock a protected doc).
 */
export async function loadPdfSafe(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/encrypt/i.test(msg)) {
      throw new Error(
        "This PDF is password-protected. Remove the password in your PDF reader first — quillpdf will not silently strip passwords from protected documents.",
      );
    }
    throw err;
  }
}

// ── Merge ─────────────────────────────────────────────────────────────────────
/** Merge two or more PDFs into one, preserving order. */
export async function merge(inputs: Uint8Array[]): Promise<Uint8Array> {
  if (inputs.length < 2) throw new Error("Provide at least 2 PDFs to merge.");
  const out = await PDFDocument.create();
  for (const bytes of inputs) {
    const src = await loadPdfSafe(bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return out.save();
}

// ── Split / extract ─────────────────────────────────────────────────────────
/**
 * Parse a 1-based range spec like "1-3,5,7-9" into arrays of 0-based page
 * indices — one inner array per comma-separated group. Throws on out-of-bounds
 * or malformed input.
 */
export function parseRanges(input: string, totalPages: number): number[][] {
  const parts = input.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Empty range spec.");
  return parts.map((part) => {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map((n) => Number(n.trim()));
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b > totalPages || a > b) {
        throw new Error(`Invalid range: "${part}" (document has ${totalPages} page(s)).`);
      }
      return Array.from({ length: b - a + 1 }, (_, i) => a + i - 1);
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > totalPages) {
      throw new Error(`Invalid page: "${part}" (document has ${totalPages} page(s)).`);
    }
    return [n - 1];
  });
}

/**
 * Split a PDF into multiple PDFs — one output per comma-separated range group.
 * e.g. "1-3,5" yields two PDFs: pages 1-3, and page 5.
 */
export async function splitByRanges(bytes: Uint8Array, rangeSpec: string): Promise<Uint8Array[]> {
  const src = await loadPdfSafe(bytes);
  const ranges = parseRanges(rangeSpec, src.getPageCount());
  const results: Uint8Array[] = [];
  for (const indices of ranges) {
    const doc = await PDFDocument.create();
    const pages = await doc.copyPages(src, indices);
    pages.forEach((p) => doc.addPage(p));
    results.push(await doc.save());
  }
  return results;
}

/**
 * Extract a single PDF containing exactly the given 1-based pages, in the order
 * supplied (duplicates and reordering are allowed). e.g. "3,1,1" → a 3-page PDF.
 */
export async function extractPages(bytes: Uint8Array, pageSpec: string): Promise<Uint8Array> {
  const src = await loadPdfSafe(bytes);
  const total = src.getPageCount();
  const indices = pageSpec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 1 || n > total) {
        throw new Error(`Invalid page: "${p}" (document has ${total} page(s)).`);
      }
      return n - 1;
    });
  if (indices.length === 0) throw new Error("No pages specified.");
  const doc = await PDFDocument.create();
  const pages = await doc.copyPages(src, indices);
  pages.forEach((p) => doc.addPage(p));
  return doc.save();
}

// ── Page count ────────────────────────────────────────────────────────────────
export async function pageCount(bytes: Uint8Array): Promise<number> {
  const src = await loadPdfSafe(bytes);
  return src.getPageCount();
}

// ── Rotate ──────────────────────────────────────────────────────────────────
/**
 * Rotate pages by `angle` degrees (must be a multiple of 90 — the PDF /Rotate
 * value is constrained to quarter turns). `pages` is a 1-based page list;
 * omitted or empty = every page. Rotation is additive to any existing rotation
 * and normalized into [0, 360).
 */
export async function rotate(bytes: Uint8Array, angle: number, pages?: number[]): Promise<Uint8Array> {
  if (!Number.isInteger(angle) || angle % 90 !== 0) {
    throw new Error(`Rotation angle must be a multiple of 90 (got ${angle}).`);
  }
  const src = await loadPdfSafe(bytes);
  const all = src.getPages();
  const targets = pages && pages.length > 0 ? pages.map((p) => p - 1) : all.map((_, i) => i);
  for (const i of targets) {
    if (i < 0 || i >= all.length) {
      throw new Error(`Page ${i + 1} out of range (document has ${all.length} page(s)).`);
    }
    const current = all[i].getRotation().angle;
    all[i].setRotation(degrees((((current + angle) % 360) + 360) % 360));
  }
  return src.save();
}

// ── Watermark ─────────────────────────────────────────────────────────────────
export interface WatermarkOptions {
  /** Font size in points. Default 48. */
  fontSize?: number;
  /** 0 (invisible) to 1 (opaque). Default 0.15. */
  opacity?: number;
  /** Normalized RGB, each channel 0-1. Default mid-grey. */
  color?: { r: number; g: number; b: number };
  position?: "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

/** Stamp a text watermark on every page. */
export async function watermark(
  bytes: Uint8Array,
  text: string,
  options: WatermarkOptions = {},
): Promise<Uint8Array> {
  if (!text) throw new Error("Watermark text is required.");
  const {
    fontSize = 48,
    opacity = 0.15,
    color = { r: 0.5, g: 0.5, b: 0.5 },
    position = "center",
  } = options;
  const src = await loadPdfSafe(bytes);
  const font = await src.embedFont(StandardFonts.Helvetica);
  for (const page of src.getPages()) {
    const { width, height } = page.getSize();
    const tw = font.widthOfTextAtSize(text, fontSize);
    let x: number, y: number;
    switch (position) {
      case "top-left": x = 40; y = height - 60; break;
      case "top-right": x = width - tw - 40; y = height - 60; break;
      case "bottom-left": x = 40; y = 40; break;
      case "bottom-right": x = width - tw - 40; y = 40; break;
      default: x = (width - tw) / 2; y = height / 2;
    }
    page.drawText(text, { x, y, size: fontSize, font, color: rgb(color.r, color.g, color.b), opacity });
  }
  return src.save();
}

// ── Bates numbering ───────────────────────────────────────────────────────────
/**
 * Parse a hex color string (#RRGGBB) into normalized rgb components. Returns
 * black on any malformed input — callers must not throw on user color values.
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return { r: 0, g: 0, b: 0 };
  const n = parseInt(clean, 16);
  return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 };
}

export interface BatesOptions {
  prefix?: string;
  startNumber?: number;
  /** Zero-pad width for the numeric portion. Default 6. */
  padWidth?: number;
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  fontSize?: number;
  /** #RRGGBB. Default "#000000". */
  color?: string;
}

/**
 * Stamp sequential Bates numbers on every page: `{prefix}{n padded to padWidth}`,
 * incrementing from startNumber. Stamps sit 40pt from the chosen corner and may
 * overlap existing footers — pick a less-occupied corner if needed.
 */
export async function bates(bytes: Uint8Array, options: BatesOptions = {}): Promise<Uint8Array> {
  const {
    prefix = "",
    startNumber = 1,
    padWidth = 6,
    position = "bottom-right",
    fontSize = 10,
    color = "#000000",
  } = options;
  const { r, g, b } = hexToRgb(color);
  const src = await loadPdfSafe(bytes);
  const font = await src.embedFont(StandardFonts.Helvetica);
  const pages = src.getPages();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const { width, height } = page.getSize();
    const stamp = `${prefix}${String(startNumber + i).padStart(padWidth, "0")}`;
    const tw = font.widthOfTextAtSize(stamp, fontSize);
    let x: number, y: number;
    switch (position) {
      case "top-left": x = 40; y = height - 60; break;
      case "top-right": x = width - tw - 40; y = height - 60; break;
      case "bottom-left": x = 40; y = 40; break;
      case "bottom-right":
      default: x = width - tw - 40; y = 40; break;
    }
    page.drawText(stamp, { x, y, size: fontSize, font, color: rgb(r, g, b) });
  }
  return src.save();
}

// ── Clean metadata ──────────────────────────────────────────────────────────
/**
 * Strip document metadata and re-serialize. This clears, in the document
 * information dictionary: title, author, subject, keywords, creator, and the
 * CreationDate / ModDate. It ALSO deletes the document-level XMP metadata
 * stream (the catalog's /Metadata entry) — modern producers (Acrobat, Word,
 * InDesign, LibreOffice) duplicate the authoritative title/author into XMP, so
 * clearing only the info dictionary would leave that copy behind in plaintext.
 *
 * Caveat: pdf-lib unconditionally rewrites the /Producer field with its own
 * signature on save(), so /Producer is replaced (not emptied) regardless of
 * what we set — a known pdf-lib behavior. This does NOT scrub page-level
 * annotations, embedded file attachments, or the text/image content of pages.
 */
export async function cleanMetadata(bytes: Uint8Array): Promise<Uint8Array> {
  const src = await loadPdfSafe(bytes);

  // 1. Document information dictionary fields.
  src.setTitle("");
  src.setAuthor("");
  src.setSubject("");
  src.setKeywords([]);
  src.setProducer("");
  src.setCreator("");

  // 2. Remove CreationDate / ModDate. pdf-lib has no delete-date API, so reach
  //    into the info dictionary directly.
  const infoDict = src.context.lookupMaybe(src.context.trailerInfo.Info, PDFDict);
  if (infoDict) {
    infoDict.delete(PDFName.of("CreationDate"));
    infoDict.delete(PDFName.of("ModDate"));
  }

  // 3. Delete the catalog-level XMP metadata stream. Drop BOTH the /Metadata
  //    reference and the underlying stream object, so the old XMP bytes do not
  //    survive in the saved file (deleting only the reference would leave the
  //    now-orphaned stream serialized in the output).
  const mdRef = src.catalog.get(PDFName.of("Metadata"));
  src.catalog.delete(PDFName.of("Metadata"));
  if (mdRef instanceof PDFRef) {
    src.context.delete(mdRef);
  }

  return src.save();
}

// ── Organize (reorder / delete pages) ─────────────────────────────────────────

/**
 * Rebuild a PDF with its pages in `order`, a list of 0-based indices.
 *
 * Deletion and reordering are the same operation: a page missing from `order` is
 * deleted, a page in a different position is moved, and a repeated index
 * duplicates that page (useful for a cover sheet repeated per section).
 */
export async function organize(bytes: Uint8Array, order: number[]): Promise<Uint8Array> {
  const src = await loadPdfSafe(bytes);
  const total = src.getPageCount();
  if (order.length === 0) throw new Error("Keep at least one page");
  const bad = order.find((i) => !Number.isInteger(i) || i < 0 || i >= total);
  if (bad !== undefined) throw new Error(`Page ${bad + 1} does not exist in this document`);

  const doc = await PDFDocument.create();
  const pages = await doc.copyPages(src, order);
  pages.forEach((p) => doc.addPage(p));
  return doc.save();
}

/** Delete the given 0-based pages, keeping the rest in their current order. */
export async function deletePages(bytes: Uint8Array, remove: number[]): Promise<Uint8Array> {
  const total = await pageCount(bytes);
  const drop = new Set(remove);
  const keep = Array.from({ length: total }, (_, i) => i).filter((i) => !drop.has(i));
  if (keep.length === 0) throw new Error("That would delete every page — keep at least one");
  return organize(bytes, keep);
}

// ── Page numbers ──────────────────────────────────────────────────────────────

export type PageNumberFormat = "plain" | "of-total" | "page-of-total";

export interface PageNumberOptions {
  format?: PageNumberFormat;
  startNumber?: number;
  /** 0-based pages to leave unstamped. Typically [0] to skip a cover. */
  skipPages?: number[];
  position?: "bottom-center" | "bottom-right" | "bottom-left" | "top-center" | "top-right" | "top-left";
  fontSize?: number;
  color?: string;
  margin?: number;
}

/**
 * Stamp readable page numbers ("3", "3 of 12", "Page 3 of 12").
 *
 * Distinct from {@link bates} despite the overlap: Bates numbers are a legal
 * evidence-control device — fixed-width, prefixed, never skipped, unique across a
 * production set. Page numbers are a reading aid, and readers expect centred
 * placement, "of N" totals, and an unnumbered cover. Merging them would make
 * both worse.
 *
 * Skipped pages still COUNT: skipping the cover of a 12-page document stamps
 * "2 of 12" on the second sheet, matching how a printed document numbers.
 */
export async function pageNumbers(
  bytes: Uint8Array,
  options: PageNumberOptions = {},
): Promise<Uint8Array> {
  const {
    format = "plain",
    startNumber = 1,
    skipPages = [],
    position = "bottom-center",
    fontSize = 10,
    color = "#000000",
    margin = 40,
  } = options;

  const { r, g, b } = hexToRgb(color);
  const src = await loadPdfSafe(bytes);
  const font = await src.embedFont(StandardFonts.Helvetica);
  const pages = src.getPages();
  const skip = new Set(skipPages);
  const total = pages.length + startNumber - 1;

  for (let i = 0; i < pages.length; i++) {
    if (skip.has(i)) continue;
    const page = pages[i];
    const { width, height } = page.getSize();
    const n = startNumber + i;
    const label =
      format === "page-of-total" ? `Page ${n} of ${total}`
      : format === "of-total" ? `${n} of ${total}`
      : `${n}`;
    const tw = font.widthOfTextAtSize(label, fontSize);
    const y = position.startsWith("top") ? height - margin - fontSize : margin;
    const x =
      position.endsWith("left") ? margin
      : position.endsWith("right") ? width - tw - margin
      : (width - tw) / 2;
    page.drawText(label, { x, y, size: fontSize, font, color: rgb(r, g, b) });
  }
  return src.save();
}

// ── Crop ──────────────────────────────────────────────────────────────────────

export interface CropMargins {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/**
 * Trim the visible area of each page by the given margins, in points (72 = 1in).
 *
 * Sets the CropBox — the region a viewer displays — rather than destroying
 * content. Two consequences worth being explicit about, because they point in
 * opposite directions:
 *   - Nothing is lost; a crop is reversible by resetting the box.
 *   - Nothing is REMOVED. Cropping is not redaction. The hidden area is fully
 *     recoverable by anyone. For content that must actually be gone, redaction
 *     is required (not yet available here — see the phase-2 note at the top).
 *
 * Margins apply in unrotated page space, so on a page carrying /Rotate the "top"
 * margin follows the underlying geometry rather than the on-screen top.
 */
export async function crop(
  bytes: Uint8Array,
  margins: CropMargins,
  pages?: number[],
): Promise<Uint8Array> {
  const { top = 0, right = 0, bottom = 0, left = 0 } = margins;
  if ([top, right, bottom, left].some((m) => m < 0)) {
    throw new Error("Crop margins cannot be negative");
  }
  if (top === 0 && right === 0 && bottom === 0 && left === 0) {
    throw new Error("Set at least one margin to crop");
  }

  const src = await loadPdfSafe(bytes);
  const all = src.getPages();
  const targets = pages ?? all.map((_, i) => i);

  for (const i of targets) {
    const page = all[i];
    if (!page) continue;
    // Crop relative to the CURRENT box so repeated crops compose, rather than
    // each one measuring afresh from the media edge.
    const box = page.getCropBox();
    const w = box.width - left - right;
    const h = box.height - top - bottom;
    if (w <= 0 || h <= 0) throw new Error(`Those margins would crop page ${i + 1} to nothing`);
    page.setCropBox(box.x + left, box.y + bottom, w, h);
  }
  return src.save();
}

// ── Flatten ───────────────────────────────────────────────────────────────────

/**
 * Flatten interactive form fields into static page content.
 *
 * Filled values are painted onto the page and can no longer be edited, cleared,
 * or read back as form data — normally what you want before sending a completed
 * form on. Throws when there is no form, so a caller can say "nothing to
 * flatten" rather than hand back a re-saved file that looks processed but isn't.
 */
export async function flatten(bytes: Uint8Array): Promise<Uint8Array> {
  const src = await loadPdfSafe(bytes);
  const form = src.getForm();
  if (form.getFields().length === 0) {
    throw new Error("This PDF has no form fields to flatten");
  }
  form.flatten();
  return src.save();
}

// ── Images → PDF ──────────────────────────────────────────────────────────────

export type ImagePageSize = "a4" | "letter" | "fit";

const PAGE_DIMS: Record<"a4" | "letter", [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

/**
 * Build a PDF from JPEG and/or PNG images, one image per page.
 *
 * Format is detected from the bytes rather than a filename, so this works on a
 * stream and cannot be fooled by a wrong extension. "fit" sizes each page to its
 * image; a4/letter letterboxes the image inside a fixed page, preserving aspect.
 */
export async function imagesToPdf(
  images: Uint8Array[],
  pageSize: ImagePageSize = "a4",
): Promise<Uint8Array> {
  if (images.length === 0) throw new Error("Add at least one image");
  const doc = await PDFDocument.create();

  for (const [i, bytes] of images.entries()) {
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!isPng && !isJpg) {
      throw new Error(`Image ${i + 1} is not a PNG or JPEG (checked the file's own bytes)`);
    }
    const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);

    if (pageSize === "fit") {
      const page = doc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      continue;
    }

    const [pw, ph] = PAGE_DIMS[pageSize];
    const page = doc.addPage([pw, ph]);
    const scale = Math.min(pw / img.width, ph / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return doc.save();
}
