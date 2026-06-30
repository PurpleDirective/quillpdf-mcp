# quillpdf-mcp

Local-first PDF tools — **merge, split, rotate, watermark, Bates-number, clean metadata, page-count** — exposed as both an **MCP server** (for AI agents) and a **command-line tool**.

> **Your files never leave your machine.** Every operation reads and writes PDFs locally, in your own environment. The server uses only stdio transport and local filesystem I/O — it never opens a network connection or transmits your documents.

Built by [Purple Directive](https://quillpdf.com), the same privacy-first engine behind [QuillPDF](https://quillpdf.com). MIT licensed.

---

## Why

Most "PDF API" tools make you upload your documents to someone else's server. For sensitive files — legal discovery, medical records, financials — that's a non-starter. `quillpdf-mcp` runs the PDF operations *where you are*: as a local CLI, or as a [Model Context Protocol](https://modelcontextprotocol.io) server an AI assistant can call. The bytes stay on your disk.

## Install

Run on demand with `npx` (no install):

```bash
npx -p quillpdf-mcp quillpdf --help   # the CLI
npx quillpdf-mcp --help               # MCP server: prints setup help (your MCP client launches it over stdio)
```

Or install globally for the `quillpdf` and `quillpdf-mcp` commands:

```bash
npm install -g quillpdf-mcp
quillpdf --help
```

Requires Node.js 18 or newer.

---

## Use it from an AI assistant (MCP)

The MCP server speaks stdio and exposes one tool per operation.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "quillpdf": {
      "command": "npx",
      "args": ["-y", "quillpdf-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add quillpdf -- npx -y quillpdf-mcp
```

Then ask your assistant things like *"merge invoice-1.pdf and invoice-2.pdf into combined.pdf"* or *"Bates-number discovery.pdf with prefix ABC starting at 1."* The assistant supplies file paths on your machine; the server reads and writes them locally.

A ready-to-copy config lives in [`examples/mcp-config.json`](examples/mcp-config.json).

### Tools

| Tool | What it does |
|------|--------------|
| `pdf_merge` | Merge 2+ PDFs into one, in order |
| `pdf_split` | Split by page ranges (one file per group) **or** extract specific pages into one file |
| `pdf_rotate` | Rotate pages by a multiple of 90° (all pages or a chosen subset) |
| `pdf_watermark` | Stamp text on every page (size / opacity / color / position) |
| `pdf_bates` | Sequential Bates numbering (prefix, start, zero-pad, corner) |
| `pdf_clean_metadata` | Strip info-dict fields + dates, and delete the XMP metadata stream |
| `pdf_page_count` | Count pages |

---

## Use it from the command line

```bash
# Merge (order is preserved)
quillpdf merge a.pdf b.pdf c.pdf -o combined.pdf

# Split into one file per range group → out-1.pdf (pages 1-3), out-2.pdf (page 5)
quillpdf split in.pdf --ranges "1-3,5" -o out.pdf

# Extract specific pages into a single file (reordering/duplicates allowed)
quillpdf split in.pdf --pages "5,1,1" -o extract.pdf

# Rotate every page 90°, or just some pages
quillpdf rotate in.pdf --angle 90 -o rotated.pdf
quillpdf rotate in.pdf --angle 180 --pages "2,4" -o rotated.pdf

# Watermark
quillpdf watermark in.pdf --text "DRAFT" --opacity 0.15 --position center -o wm.pdf

# Bates numbering → PLT-000001, PLT-000002, …
quillpdf bates in.pdf --prefix "PLT-" --start 1 --pad 6 -o numbered.pdf

# Strip document metadata
quillpdf clean-metadata in.pdf -o clean.pdf

# Page count (prints a number)
quillpdf page-count in.pdf
```

Every command has `--help`.

---

## Privacy & security notes

- **Local only.** All PDF processing happens in-process via [`pdf-lib`](https://github.com/Hopding/pdf-lib). The server communicates over stdio and never opens a network connection. (The MCP SDK bundles optional HTTP/SSE transports in `node_modules`, but this server only ever uses stdio, so none of that code runs.)
- **Password-protected PDFs are refused, not silently unlocked.** If a file is encrypted, the tool stops with a clear message rather than stripping the password for you.
- **`clean-metadata` scope.** It clears the title, author, subject, keywords, and creator fields plus the CreationDate/ModDate in the document information dictionary, **and** deletes the document-level XMP metadata stream — the copy Acrobat, Word, InDesign, and LibreOffice write, which is often the authoritative one. Note that `pdf-lib` rewrites the `/Producer` field with its own signature on save, so that one field is *replaced* rather than emptied. It does not scrub page-level annotations, embedded file attachments, or the text/image content of pages.

## Not here yet (roadmap)

These need a Node image backend or OCR engine and are planned for a later release — they are **not** in this package today:

- `compress` (image re-encode)
- `pdf-to-image` (render pages to PNG)
- `redact` (true rasterize-on-redact removal)
- `ocr` (searchable-text layer)

They'll ship only when they can run **fully locally**, to keep the privacy guarantee intact.

---

## Development

```bash
npm install
npm run build     # tsc → dist/
npm test          # builds, then runs the unit suite (node:test)
```

The engine (`src/core.ts`) is pure: bytes in, bytes out, no I/O. The CLI (`src/cli.ts`) and MCP server (`src/server.ts`) are thin front-ends over it.

## License

MIT © Purple Directive. See [LICENSE](LICENSE).

Learn more at [quillpdf.com](https://quillpdf.com).
