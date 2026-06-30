#!/usr/bin/env node
/**
 * quillpdf-mcp — Model Context Protocol server (stdio transport).
 *
 * Exposes the quillpdf operations as MCP tools so any MCP client (Claude Code,
 * Claude Desktop, etc.) can drive local PDF editing. Tools read input paths and
 * write output paths on the SAME machine the server runs on — exactly like the
 * CLI. There is no network path; your files never leave your computer.
 *
 * IMPORTANT: stdout is the MCP transport channel. Never write to stdout here —
 * diagnostics go to stderr only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readPdf, writePdf } from "./io.js";
import * as ops from "./core.js";
import { hexToRgb } from "./core.js";
import { suffixPath } from "./paths.js";
import { VERSION } from "./version.js";

type TextResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(text: string, structured?: Record<string, unknown>): TextResult {
  return structured
    ? { content: [{ type: "text", text }], structuredContent: structured }
    : { content: [{ type: "text", text }] };
}

function fail(err: unknown): TextResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

const server = new McpServer({ name: "quillpdf-mcp", version: VERSION });

const LOCAL = " Runs entirely on this machine — the file is read and written locally and never sent anywhere.";

server.registerTool(
  "pdf_merge",
  {
    title: "Merge PDFs",
    description: "Merge two or more PDF files into one, in the order given." + LOCAL,
    inputSchema: {
      inputs: z.array(z.string()).min(2).describe("Paths to the input PDFs, in merge order (2 or more)"),
      output: z.string().describe("Path to write the merged PDF"),
    },
    annotations: { title: "Merge PDFs", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ inputs, output }) => {
    try {
      const bufs = await Promise.all(inputs.map(readPdf));
      await writePdf(output, await ops.merge(bufs));
      return ok(`Merged ${inputs.length} PDFs → ${output}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "pdf_split",
  {
    title: "Split / extract PDF pages",
    description:
      "Split a PDF by 1-based page ranges (one output file per comma group, e.g. \"1-3,5\"), " +
      "or extract specific pages into a single PDF (e.g. \"1,3,5\"). Provide exactly one of `ranges` or `pages`." +
      LOCAL,
    inputSchema: {
      input: z.string().describe("Path to the input PDF"),
      output: z.string().describe("Output path. In range mode with >1 group, files get -1, -2, … suffixes."),
      ranges: z.string().optional().describe('1-based ranges, one output per comma group, e.g. "1-3,5,7-9"'),
      pages: z.string().optional().describe('1-based pages for a single combined output, e.g. "1,3,5"'),
    },
    annotations: { title: "Split / extract PDF pages", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ input, output, ranges, pages }) => {
    try {
      if (ranges && pages) throw new Error("Provide either `ranges` or `pages`, not both.");
      if (!ranges && !pages) throw new Error("Provide either `ranges` or `pages`.");
      const bytes = await readPdf(input);
      if (pages) {
        await writePdf(output, await ops.extractPages(bytes, pages));
        return ok(`Extracted pages ${pages} → ${output}`, { outputs: [output] });
      }
      const outs = await ops.splitByRanges(bytes, ranges!);
      if (outs.length === 1) {
        await writePdf(output, outs[0]);
        return ok(`Wrote 1 file → ${output}`, { outputs: [output] });
      }
      const written: string[] = [];
      for (let i = 0; i < outs.length; i++) {
        const p = suffixPath(output, i + 1);
        await writePdf(p, outs[i]);
        written.push(p);
      }
      return ok(`Wrote ${written.length} files:\n${written.map((p) => `  ${p}`).join("\n")}`, { outputs: written });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "pdf_rotate",
  {
    title: "Rotate PDF pages",
    description: "Rotate pages by a multiple of 90 degrees. Omit `pages` to rotate every page." + LOCAL,
    inputSchema: {
      input: z.string().describe("Path to the input PDF"),
      output: z.string().describe("Path to write the rotated PDF"),
      angle: z.number().int().describe("Rotation in degrees; must be a multiple of 90 (e.g. 90, 180, -90)"),
      pages: z.array(z.number().int().positive()).optional().describe("1-based pages to rotate (default: all)"),
    },
    annotations: { title: "Rotate PDF pages", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ input, output, angle, pages }) => {
    try {
      const bytes = await readPdf(input);
      await writePdf(output, await ops.rotate(bytes, angle, pages));
      return ok(`Rotated ${pages?.length ? `pages ${pages.join(",")}` : "all pages"} by ${angle}° → ${output}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "pdf_watermark",
  {
    title: "Watermark a PDF",
    description: "Stamp a text watermark on every page." + LOCAL,
    inputSchema: {
      input: z.string().describe("Path to the input PDF"),
      output: z.string().describe("Path to write the watermarked PDF"),
      text: z.string().min(1).describe("Watermark text"),
      fontSize: z.number().positive().optional().describe("Font size in points (default 48)"),
      opacity: z.number().min(0).max(1).optional().describe("Opacity 0-1 (default 0.15)"),
      color: z.string().optional().describe("Color as #RRGGBB (default #808080)"),
      position: z
        .enum(["center", "top-left", "top-right", "bottom-left", "bottom-right"])
        .optional()
        .describe("Placement (default center)"),
    },
    annotations: { title: "Watermark a PDF", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ input, output, text, fontSize, opacity, color, position }) => {
    try {
      const bytes = await readPdf(input);
      const out = await ops.watermark(bytes, text, {
        fontSize,
        opacity,
        color: color ? hexToRgb(color) : undefined,
        position,
      });
      await writePdf(output, out);
      return ok(`Watermarked → ${output}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "pdf_bates",
  {
    title: "Bates-number a PDF",
    description: "Stamp sequential Bates numbers ({prefix}{zero-padded n}) on every page." + LOCAL,
    inputSchema: {
      input: z.string().describe("Path to the input PDF"),
      output: z.string().describe("Path to write the numbered PDF"),
      prefix: z.string().optional().describe("Text before the number (default none)"),
      startNumber: z.number().int().optional().describe("First number (default 1)"),
      padWidth: z.number().int().min(1).optional().describe("Zero-pad width (default 6)"),
      position: z.enum(["bottom-right", "bottom-left", "top-right", "top-left"]).optional().describe("Corner (default bottom-right)"),
      fontSize: z.number().positive().optional().describe("Font size in points (default 10)"),
      color: z.string().optional().describe("Color as #RRGGBB (default #000000)"),
    },
    annotations: { title: "Bates-number a PDF", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ input, output, prefix, startNumber, padWidth, position, fontSize, color }) => {
    try {
      const bytes = await readPdf(input);
      const out = await ops.bates(bytes, { prefix, startNumber, padWidth, position, fontSize, color });
      await writePdf(output, out);
      return ok(`Bates-numbered → ${output}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "pdf_clean_metadata",
  {
    title: "Clean PDF metadata",
    description:
      "Strip document metadata: clears title, author, subject, keywords, creator and the CreationDate/ModDate " +
      "in the info dictionary, AND deletes the document-level XMP metadata stream (the copy Acrobat/Word/InDesign " +
      "write). Note: pdf-lib rewrites /Producer with its own signature on save, so that one field is replaced " +
      "rather than emptied." +
      LOCAL,
    inputSchema: {
      input: z.string().describe("Path to the input PDF"),
      output: z.string().describe("Path to write the cleaned PDF"),
    },
    annotations: { title: "Clean PDF metadata", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ input, output }) => {
    try {
      const bytes = await readPdf(input);
      await writePdf(output, await ops.cleanMetadata(bytes));
      return ok(`Cleaned metadata → ${output}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "pdf_page_count",
  {
    title: "Count PDF pages",
    description: "Return the number of pages in a PDF." + LOCAL,
    inputSchema: {
      input: z.string().describe("Path to the input PDF"),
    },
    outputSchema: { pages: z.number().int() },
    annotations: { title: "Count PDF pages", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async ({ input }) => {
    try {
      const bytes = await readPdf(input);
      const pages = await ops.pageCount(bytes);
      return ok(String(pages), { pages });
    } catch (e) {
      return fail(e);
    }
  },
);

const HELP_TEXT = `quillpdf-mcp v${VERSION} — local-first PDF tools over the Model Context Protocol.

This is an MCP server: it speaks JSON-RPC over stdio and is meant to be launched
by an MCP client (Claude Desktop, Claude Code, …), not run directly in a shell.
Add it to your client config:

  { "mcpServers": { "quillpdf": { "command": "npx", "args": ["-y", "quillpdf-mcp"] } } }

Tools: pdf_merge, pdf_split, pdf_rotate, pdf_watermark, pdf_bates,
       pdf_clean_metadata, pdf_page_count

For the command-line tool instead, run:  quillpdf --help
Docs: https://quillpdf.com
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Connected. Log to stderr only — stdout is the protocol channel.
  process.stderr.write(`quillpdf-mcp v${VERSION} ready (stdio)\n`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`quillpdf-mcp fatal: ${msg}\n`);
  process.exit(1);
});
