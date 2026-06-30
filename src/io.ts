import { readFile, writeFile } from "node:fs/promises";

/**
 * Read a PDF from disk into a standalone Uint8Array. We copy out of the Buffer
 * Node returns so downstream code never holds a view into a pooled allocation.
 */
export async function readPdf(path: string): Promise<Uint8Array> {
  const buf = await readFile(path);
  return new Uint8Array(buf);
}

/** Write PDF bytes to disk. */
export async function writePdf(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes);
}
