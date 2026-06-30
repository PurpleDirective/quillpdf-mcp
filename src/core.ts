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

import { PDFDocument, rgb, StandardFonts, degrees } from "pdf-lib";

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
 * Strip document metadata (title, author, subject, keywords, creator) and
 * re-serialize.
 *
 * Caveat: pdf-lib unconditionally rewrites the /Producer field with its own
 * signature on save(), so /Producer is replaced (not emptied) regardless of
 * what we set — a known pdf-lib behavior. Every other field listed above is
 * cleared. This does NOT scrub annotations, embedded file attachments, or text
 * content; it targets the document information dictionary.
 */
export async function cleanMetadata(bytes: Uint8Array): Promise<Uint8Array> {
  const src = await loadPdfSafe(bytes);
  src.setTitle("");
  src.setAuthor("");
  src.setSubject("");
  src.setKeywords([]);
  src.setProducer("");
  src.setCreator("");
  return src.save();
}
