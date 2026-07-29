/**
 * quillpdf-mcp encryption — Protect and Unlock, backed by QPDF (WebAssembly).
 *
 * Kept out of core.ts on purpose. That module promises "pure pdf-lib, nothing
 * touches the filesystem", and this one resolves a WASM binary from node_modules
 * and runs an Emscripten in-memory filesystem. Same privacy guarantee — no
 * network path exists here either — but a different dependency shape, so it gets
 * its own file rather than quietly weakening core.ts's docstring.
 *
 * Why QPDF rather than pdf-lib: pdf-lib cannot encrypt at all. The community
 * forks that add it are unmaintained (last published 2024-04 and 2023-01), and
 * encryption is the one operation where a subtle bug means a document the user
 * believes is locked isn't. QPDF is the reference implementation, Apache-2.0,
 * and its WASM build produced byte-identical output to native qpdf 12.3.2 in
 * testing.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const IN = "/in.pdf";
const OUT = "/out.pdf";
const EXIT_OK = 0;
const EXIT_WARN = 3;

interface QpdfFS {
  writeFile: (path: string, data: Uint8Array) => void;
  readFile: (path: string) => Uint8Array;
  unlink: (path: string) => void;
}
interface QpdfInstance {
  callMain: (args: string[]) => number;
  FS: QpdfFS;
}
type QpdfFactory = (opts: {
  locateFile: () => string;
  print?: () => void;
  printErr?: () => void;
}) => Promise<QpdfInstance>;

/**
 * Whether the bytes carry PDF encryption, by looking for the /Encrypt entry an
 * encrypted document must reference from its trailer.
 *
 * This is how failures get classified. The WASM glue ships no working printErr
 * hook — qpdf's error text goes straight to the host console and never reaches
 * JS — so every failure looks like an identical exit code 2 from here.
 * Distinguishing "wrong password" from "damaged file" has to come from
 * inspecting the document instead of parsing an error string.
 */
export function looksEncrypted(bytes: Uint8Array): boolean {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return /\/Encrypt[\s/<[]/.test(s);
}

/**
 * Run one qpdf invocation in an isolated module instance.
 *
 * A fresh instance per call, never a cached one: the Emscripten filesystem is
 * module-global, so reuse would leave a previous document's plaintext in memory
 * across operations. Re-instantiating costs milliseconds.
 */
async function runQpdf(bytes: Uint8Array, args: string[]): Promise<Uint8Array | null> {
  const mod = (await import("@neslinesli93/qpdf-wasm")).default as unknown as QpdfFactory;
  const wasm = require.resolve("@neslinesli93/qpdf-wasm/dist/qpdf.wasm");

  // qpdf reports errors via console.error regardless of the printErr option.
  // Expected outcomes here — a wrong password is a normal event the caller turns
  // into a message — must not spray onto a client's stderr.
  //
  // This MUST be installed before the module is instantiated: the Emscripten
  // glue does `console.error.bind(console)` while constructing, so overriding
  // afterwards leaves it holding the original reference and the suppression
  // silently does nothing. Verified 2026-07-29 — the CLI leaked
  // "/in.pdf: invalid password" until the two lines were swapped.
  const realConsoleError = console.error;
  console.error = () => {};

  let qpdf: QpdfInstance;
  try {
    qpdf = await mod({ locateFile: () => wasm, print: () => {}, printErr: () => {} });
  } catch (e) {
    console.error = realConsoleError;
    throw e;
  }

  try {
    qpdf.FS.writeFile(IN, bytes);
    let code: number;
    try {
      code = qpdf.callMain(args);
    } catch {
      return null;
    }
    if (code !== EXIT_OK && code !== EXIT_WARN) return null;
    return new Uint8Array(qpdf.FS.readFile(OUT));
  } finally {
    console.error = realConsoleError;
    for (const p of [IN, OUT]) {
      try {
        qpdf.FS.unlink(p);
      } catch {
        // Absent on a failed run — nothing to clean.
      }
    }
  }
}

/** Cryptographically random owner password, used when the caller supplies none. */
function randomOwnerPassword(): string {
  const bytes = new Uint8Array(24);
  require("node:crypto").webcrypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ProtectOptions {
  /** Password required to open the document. Mandatory. */
  userPassword: string;
  /**
   * Password permitting permission changes. Defaults to a random value.
   *
   * qpdf treats an empty owner password — and one equal to the user password —
   * as insecure, since either lets a reader bypass the permission bits.
   * Defaulting to a random secret means the file is never created in that weaker
   * state. The user password still decrypts, so nothing is lost by the owner
   * password being unknown.
   */
  ownerPassword?: string;
  noPrint?: boolean;
  noCopy?: boolean;
  noModify?: boolean;
}

/**
 * Encrypt a PDF with AES-256 (PDF 2.0 encryption revision 6).
 *
 * 40-bit and 128-bit are deliberately not exposed: qpdf classifies both as weak
 * crypto and requires --allow-weak-crypto to emit them. Producing a "protected"
 * file that isn't meaningfully protected is worse than producing nothing.
 */
export async function protect(bytes: Uint8Array, options: ProtectOptions): Promise<Uint8Array> {
  const { userPassword, ownerPassword, noPrint = false, noCopy = false, noModify = false } = options;
  if (!userPassword) throw new Error("A password is required to protect a PDF");

  // Refuse up front: qpdf cannot re-encrypt a document it can't open, and
  // "already protected" is far more useful than "encryption failed".
  if (looksEncrypted(bytes)) {
    throw new Error(
      "This PDF is already password-protected. Unlock it first, then protect it with a new password.",
    );
  }

  const args = [
    "--encrypt",
    `--user-password=${userPassword}`,
    `--owner-password=${ownerPassword || randomOwnerPassword()}`,
    "--bits=256",
  ];
  if (noPrint) args.push("--print=none");
  if (noCopy) args.push("--extract=n");
  if (noModify) args.push("--modify=none");
  args.push("--", IN, OUT);

  const out = await runQpdf(bytes, args);
  if (!out) {
    throw new Error(
      "Could not protect this PDF. The file may be damaged or use a PDF feature quillpdf can't rewrite.",
    );
  }
  return out;
}

/**
 * Remove encryption from a PDF the caller has the password for.
 *
 * Only ever decrypts with a supplied password — it does not recover, guess, or
 * brute-force one. A tool that stripped protection without the password would be
 * a liability rather than a feature.
 */
export async function unlock(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  if (!looksEncrypted(bytes)) {
    throw new Error("This PDF isn't password-protected — there's nothing to unlock.");
  }

  const out = await runQpdf(bytes, [`--password=${password}`, "--decrypt", IN, OUT]);
  if (!out) {
    // Encryption was confirmed above, so a failure here is overwhelmingly a
    // password problem rather than a malformed file.
    throw new Error(
      password
        ? "That password didn't work. quillpdf cannot recover a lost PDF password."
        : "This PDF needs a password. Supply it with --password.",
    );
  }
  return out;
}
