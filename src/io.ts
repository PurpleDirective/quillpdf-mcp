import { readFile, writeFile } from "node:fs/promises";

/**
 * Read a PDF from disk into a standalone Uint8Array. We copy out of the Buffer
 * Node returns so downstream code never holds a view into a pooled allocation.
 *
 * Rejects non-PDF input up front with the filename in the message — otherwise
 * pdf-lib surfaces a raw parser error ("Failed to parse PDF document … No PDF
 * header found") that doesn't say which file or what's wrong with it.
 */
export async function readPdf(path: string): Promise<Uint8Array> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`file not found: ${path}`);
    }
    throw err;
  }
  // The %PDF- marker must appear near the start (the spec tolerates a little
  // leading junk; 1 KB covers every real-world case).
  if (!buf.subarray(0, 1024).includes("%PDF-")) {
    throw new Error(`"${path}" is not a PDF file (no %PDF header found).`);
  }
  return new Uint8Array(buf);
}

/**
 * Write PDF bytes to disk. Refuses to replace an existing file unless
 * `force` is set — for the legal/discovery audience this tool serves,
 * silently clobbering an exhibit is a real hazard. The "wx" open flag makes
 * the refusal atomic (no check-then-write race).
 */
export async function writePdf(
  path: string,
  bytes: Uint8Array,
  opts?: { force?: boolean },
): Promise<void> {
  try {
    await writeFile(path, bytes, { flag: opts?.force ? "w" : "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `output file already exists: ${path} — use --force (CLI) or force: true (MCP) to replace it.`,
      );
    }
    throw err;
  }
}

/**
 * Read an image (PNG or JPEG) from disk.
 *
 * Separate from readPdf because that one asserts a %PDF header. Format is
 * validated from the magic bytes rather than the extension, so a mislabelled
 * .png that is really a JPEG still works — and a .png that is really a PDF is
 * caught here rather than deep inside pdf-lib.
 */
export async function readImage(path: string): Promise<Uint8Array> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`file not found: ${path}`);
    }
    throw err;
  }
  const isPng =
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!isPng && !isJpg) {
    throw new Error(`"${path}" is not a PNG or JPEG image.`);
  }
  return new Uint8Array(buf);
}

/**
 * Write arbitrary bytes, with the same no-clobber contract as writePdf.
 * Used where the output isn't necessarily a PDF.
 */
export async function writeBinary(
  path: string,
  bytes: Uint8Array,
  opts?: { force?: boolean },
): Promise<void> {
  return writePdf(path, bytes, opts);
}
