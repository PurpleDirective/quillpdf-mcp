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
