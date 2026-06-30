#!/usr/bin/env node
/**
 * quillpdf — local-first PDF command-line tool.
 *
 * Every operation reads from disk and writes to disk on THIS machine. No
 * network calls, ever. See core.ts for the engine.
 */
import { Command, InvalidArgumentError } from "commander";
import { readPdf, writePdf } from "./io.js";
import * as ops from "./core.js";
import { hexToRgb } from "./core.js";
import { suffixPath } from "./paths.js";
import { VERSION } from "./version.js";

const WATERMARK_POSITIONS = ["center", "top-left", "top-right", "bottom-left", "bottom-right"] as const;
const BATES_POSITIONS = ["bottom-right", "bottom-left", "top-right", "top-left"] as const;

function parseIntArg(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new InvalidArgumentError("must be an integer.");
  return n;
}

function parseFloatArg(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new InvalidArgumentError("must be a number.");
  return n;
}

/** "1,3,5" → [1,3,5] (1-based, validated as positive integers). */
function parsePageList(value: string): number[] {
  return value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 1) {
        throw new InvalidArgumentError(`invalid page "${p}" — pages are 1-based positive integers.`);
      }
      return n;
    });
}

function enumArg<T extends string>(allowed: readonly T[]) {
  return (value: string): T => {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new InvalidArgumentError(`must be one of: ${allowed.join(", ")}.`);
    }
    return value as T;
  };
}

const program = new Command();
program
  .name("quillpdf")
  .description("Local-first PDF tools — your files never leave your machine.")
  .version(VERSION, "-v, --version");

program
  .command("merge")
  .description("Merge two or more PDFs into one")
  .argument("<files...>", "input PDF files, in order (2 or more)")
  .requiredOption("-o, --output <file>", "output PDF path")
  .action(async (files: string[], opts: { output: string }) => {
    const inputs = await Promise.all(files.map(readPdf));
    await writePdf(opts.output, await ops.merge(inputs));
    console.log(`Merged ${files.length} files → ${opts.output}`);
  });

program
  .command("split")
  .description("Split by page ranges (one file per range) or extract specific pages (one file)")
  .argument("<file>", "input PDF")
  .option("-r, --ranges <spec>", 'comma-separated 1-based ranges, e.g. "1-3,5,7-9" — one output per group')
  .option("-p, --pages <spec>", 'comma-separated 1-based pages, e.g. "1,3,5" — single output with those pages')
  .requiredOption("-o, --output <file>", "output PDF path (range mode appends -1, -2, …)")
  .action(async (file: string, opts: { ranges?: string; pages?: string; output: string }) => {
    if (opts.ranges && opts.pages) throw new Error("Use either --ranges or --pages, not both.");
    if (!opts.ranges && !opts.pages) throw new Error("Provide --ranges or --pages.");
    const bytes = await readPdf(file);
    if (opts.pages) {
      await writePdf(opts.output, await ops.extractPages(bytes, opts.pages));
      console.log(`Extracted pages ${opts.pages} → ${opts.output}`);
      return;
    }
    const outs = await ops.splitByRanges(bytes, opts.ranges!);
    if (outs.length === 1) {
      await writePdf(opts.output, outs[0]);
      console.log(`Wrote 1 file → ${opts.output}`);
      return;
    }
    const paths: string[] = [];
    for (let i = 0; i < outs.length; i++) {
      const p = suffixPath(opts.output, i + 1);
      await writePdf(p, outs[i]);
      paths.push(p);
    }
    console.log(`Wrote ${outs.length} files:\n  ${paths.join("\n  ")}`);
  });

program
  .command("rotate")
  .description("Rotate pages by a multiple of 90 degrees")
  .argument("<file>", "input PDF")
  .requiredOption("-a, --angle <deg>", "rotation in degrees (multiple of 90)", parseIntArg)
  .option("-p, --pages <spec>", '1-based pages to rotate, e.g. "1,3,5" (default: all)', parsePageList)
  .requiredOption("-o, --output <file>", "output PDF path")
  .action(async (file: string, opts: { angle: number; pages?: number[]; output: string }) => {
    const bytes = await readPdf(file);
    await writePdf(opts.output, await ops.rotate(bytes, opts.angle, opts.pages));
    console.log(`Rotated ${opts.pages ? `pages ${opts.pages.join(",")}` : "all pages"} by ${opts.angle}° → ${opts.output}`);
  });

program
  .command("watermark")
  .description("Stamp a text watermark on every page")
  .argument("<file>", "input PDF")
  .requiredOption("-t, --text <text>", "watermark text")
  .requiredOption("-o, --output <file>", "output PDF path")
  .option("--size <pt>", "font size in points", parseFloatArg, 48)
  .option("--opacity <0-1>", "opacity from 0 to 1", parseFloatArg, 0.15)
  .option("--color <hex>", "color as #RRGGBB", "#808080")
  .option("--position <pos>", `one of: ${WATERMARK_POSITIONS.join(", ")}`, enumArg(WATERMARK_POSITIONS), "center")
  .action(
    async (
      file: string,
      opts: { text: string; output: string; size: number; opacity: number; color: string; position: (typeof WATERMARK_POSITIONS)[number] },
    ) => {
      const bytes = await readPdf(file);
      const out = await ops.watermark(bytes, opts.text, {
        fontSize: opts.size,
        opacity: opts.opacity,
        color: hexToRgb(opts.color),
        position: opts.position,
      });
      await writePdf(opts.output, out);
      console.log(`Watermarked → ${opts.output}`);
    },
  );

program
  .command("bates")
  .description("Stamp sequential Bates numbers on every page")
  .argument("<file>", "input PDF")
  .requiredOption("-o, --output <file>", "output PDF path")
  .option("--prefix <str>", "prefix before the number", "")
  .option("--start <n>", "starting number", parseIntArg, 1)
  .option("--pad <n>", "zero-pad width", parseIntArg, 6)
  .option("--position <pos>", `one of: ${BATES_POSITIONS.join(", ")}`, enumArg(BATES_POSITIONS), "bottom-right")
  .option("--size <pt>", "font size in points", parseFloatArg, 10)
  .option("--color <hex>", "color as #RRGGBB", "#000000")
  .action(
    async (
      file: string,
      opts: { output: string; prefix: string; start: number; pad: number; position: (typeof BATES_POSITIONS)[number]; size: number; color: string },
    ) => {
      const bytes = await readPdf(file);
      const out = await ops.bates(bytes, {
        prefix: opts.prefix,
        startNumber: opts.start,
        padWidth: opts.pad,
        position: opts.position,
        fontSize: opts.size,
        color: opts.color,
      });
      await writePdf(opts.output, out);
      console.log(`Bates-numbered → ${opts.output}`);
    },
  );

program
  .command("clean-metadata")
  .description("Strip document metadata (title, author, subject, keywords, creator)")
  .argument("<file>", "input PDF")
  .requiredOption("-o, --output <file>", "output PDF path")
  .action(async (file: string, opts: { output: string }) => {
    const bytes = await readPdf(file);
    await writePdf(opts.output, await ops.cleanMetadata(bytes));
    console.log(`Cleaned metadata → ${opts.output}`);
  });

program
  .command("page-count")
  .description("Print the number of pages")
  .argument("<file>", "input PDF")
  .action(async (file: string) => {
    const bytes = await readPdf(file);
    console.log(String(await ops.pageCount(bytes)));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`quillpdf: ${msg}`);
  process.exit(1);
});
