import { basename, dirname, extname, join } from "node:path";

/** Insert "-N" before the extension: out.pdf → out-1.pdf (defaults ext to .pdf). */
export function suffixPath(out: string, n: number): string {
  const ext = extname(out) || ".pdf";
  const base = basename(out, extname(out));
  return join(dirname(out), `${base}-${n}${ext}`);
}
