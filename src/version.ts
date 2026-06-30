import { readFileSync } from "node:fs";

/**
 * Package version, read from package.json at runtime. From the compiled
 * `dist/version.js`, `../package.json` resolves to the package root — which is
 * always present in the published tarball.
 */
export const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
