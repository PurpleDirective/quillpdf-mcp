# quillpdf-mcp

PDF operations for MCP. An MCP server and CLI for local PDF manipulation:

- Merge, split, organize, delete pages
- Rotate, crop
- Watermark, Bates numbering, page numbers
- Flatten forms, images → PDF
- Metadata cleaning, page count
- AES-256 protect / unlock

Built on [pdf-lib](https://github.com/Hopding/pdf-lib). MIT licensed. stdio transport. No network calls — files never leave your machine.

## Install

```bash
npx -p quillpdf-mcp quillpdf --help   # CLI
npx quillpdf-mcp --help               # MCP server (your MCP client launches it over stdio)
```

Or globally:

```bash
npm install -g quillpdf-mcp
quillpdf --help
```

Requires Node.js 18+.

## Scope

`quillpdf-mcp` implements structural PDF transforms and AES-256 protect/unlock. It does not perform OCR, redaction, or compression — those are available in the browser version ([quillpdf.com](https://quillpdf.com)), where processing also stays client-side. They'll ship here only when they can run fully locally.

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
| `pdf_organize` | Keep pages in the order you list — reorder, delete and duplicate in one step |
| `pdf_delete_pages` | Remove listed pages, keeping the rest in order |
| `pdf_page_numbers` | Stamp readable page numbers (`3`, `3 of 12`, `Page 3 of 12`), optional unnumbered cover |
| `pdf_crop` | Trim page margins by setting the CropBox — **hides, does not remove** (not redaction) |
| `pdf_flatten` | Paint filled form values onto the page so they can't be edited or read back as form data |
| `pdf_from_images` | Build a PDF from PNG/JPEG images, one per page |
| `pdf_protect` | Encrypt with **AES-256** so the document needs a password to open |
| `pdf_unlock` | Remove the password from a document you have the password for |

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

**Existing files are never silently replaced.** If the `-o` path already
exists, the command stops with an error instead of clobbering it — add
`--force` (or `force: true` on the MCP tools) to replace it deliberately.

## Privacy & security notes

- **Local only.** All PDF processing happens in-process via [`pdf-lib`](https://github.com/Hopding/pdf-lib). The server communicates over stdio and never opens a network connection. (The MCP SDK bundles optional HTTP/SSE transports in `node_modules`, but this server only ever uses stdio, so none of that code runs.)
- **Password-protected PDFs are refused, not silently unlocked.** Every operation except `unlock` stops with a clear message rather than stripping the password for you. `unlock` decrypts *only* with a password you supply — it does not recover, guess, or brute-force one.
- **Encryption engine.** `protect` and `unlock` run [QPDF](https://github.com/qpdf/qpdf) (Apache-2.0) compiled to WebAssembly, in-process and offline like everything else. `pdf-lib` cannot encrypt at all, and the community forks that add it are unmaintained — encryption is the one operation where a subtle bug means a document you believe is locked isn't, so this uses the reference implementation instead.
- **AES-256 only.** `protect` emits PDF 2.0 encryption revision 6. The 40-bit and 128-bit modes are deliberately not exposed: QPDF classes both as weak crypto, and shipping a "protected" file that isn't meaningfully protected is worse than shipping nothing.
- **Permission flags are a request, not a guarantee.** `--no-print` / `--no-copy` / `--no-modify` set bits that a well-behaved reader honours; they are not enforced by the encryption. The password is the part that actually protects the file. (Extraction *for accessibility* stays permitted even with `--no-copy`, so screen readers keep working.)
- **Cropping is not redaction.** `crop` sets the CropBox, so trimmed content is hidden but still present in the file and fully recoverable. Do not use it to remove sensitive material.
- **`clean-metadata` scope.** It clears the title, author, subject, keywords, and creator fields plus the CreationDate/ModDate in the document information dictionary, **and** deletes the document-level XMP metadata stream — the copy Acrobat, Word, InDesign, and LibreOffice write, which is often the authoritative one. Note that `pdf-lib` rewrites the `/Producer` field with its own signature on save, so that one field is *replaced* rather than emptied. It does not scrub page-level annotations, embedded file attachments, or the text/image content of pages.

## Not here yet (roadmap)

These need a Node image backend or an OCR engine and are planned for a later release — they are **not** in this package today:

- `compress` (image re-encode) — needs an image codec such as `sharp`
- `pdf-to-image` (render pages to PNG) — needs a rasterizer (`pdfjs-dist` + canvas)
- `redact` (true rasterize-on-redact removal) — needs the same rasterizer
- `ocr` (searchable-text layer) — needs `tesseract.js`

Each would roughly quadruple this package's dependency surface, which is the whole reason
they're held back: the pitch here is a small, local, no-network tool. They'll ship only when
they can run **fully locally** without giving that up.

## Philosophy

Keep the server small, local, and easy to audit. Most "PDF API" tools answer document work with "upload it to us" — for legal discovery, medical records, or financials, the upload is the problem. This runs where you are; the bytes stay on your disk.

## Development

```bash
npm install
npm run build     # tsc → dist/
npm test          # builds, then runs the unit suite (node:test)
```

The engine (`src/core.ts`) is pure: bytes in, bytes out, no I/O. The CLI (`src/cli.ts`) and MCP server (`src/server.ts`) are thin front-ends over it.

## License

MIT © [Purple Directive](https://purpledirective.com). See [LICENSE](LICENSE).

Learn more at [quillpdf.com](https://quillpdf.com).
