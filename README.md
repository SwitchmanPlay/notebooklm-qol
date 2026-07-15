![NotebookLM QoL](assets/hero.png)

# NotebookLM QoL

![Version](https://img.shields.io/badge/version-1.1.0-blue)
![Price](https://img.shields.io/badge/price-100%25_free-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Chrome](https://img.shields.io/badge/Chrome-120%2B-ffc107)
![Manifest](https://img.shields.io/badge/Manifest-V3-4285f4)
![Tracking](https://img.shields.io/badge/tracking-none-success)

A **fully free, open-source** Chrome extension that adds quality-of-life bulk operations to [NotebookLM](https://notebooklm.google.com). It is **not** an importer — it makes managing what's already in your notebooks less painful.

![Promo](assets/promo.png)

## Features (v1.1)

- **⚡ Batch generate** — pick N sources and generate one Studio item (Audio Overview, Video Overview, Quiz, …) **per source**, queued automatically. For types that have format options, NotebookLM's **own** dialog opens on the **first** item — you pick what you want (e.g. Deep Dive vs Brief, Cinematic vs Explainer) and press Generate, and that choice is applied automatically to every remaining job in the batch. For types whose plain create button skips the dialog (Audio Overview, Mind Map), the extension presses NotebookLM's **Customize** button instead so you still get asked. No hidden dialogs, no guessing. Closing the options dialog without generating cancels the batch cleanly, one bad source never stalls it, rate limits pause the queue, and a **Stop** button halts it after the current job. The batch modal remembers your last output type across notebooks.
- **✨ Custom prompt mode (new in v1.1)** — pick your sources in the batch modal, press **Custom prompt mode**, then create the output **once** in NotebookLM's own dialog with *any* type, options and custom text prompt ("what should the hosts focus on", video topic, slide-deck description, …). The extension splits that single request into one generation **per source** at the network level — no clicking, no dialog replay — and auto-renames the results after their source.
- **Rename by template** — batch results are automatically renamed after their source using a template (`{source} — {type}` by default; variables: `{source}` `{type}` `{date}` `{n}`). Renames are stored persistently and applied by a retry loop as soon as each generation finishes — even if you reload or come back to the tab hours later.
- **Rename by source (back in v1.1)** — select **existing** outputs (even ones created long before installing the extension) and rename them after the source(s) they were generated from, in one click. Source information is read passively from NotebookLM's own network responses — no dialogs are opened, nothing is clicked.
- **Multi-select Studio outputs** — always-visible checkboxes, a clickable **Select all outputs** header at the top of the list, plus an always-on bulk bar with a live count and one-click bulk **download** (auto-renamed into a `NotebookLM/` folder in Downloads) and bulk **delete** (single confirmation). The bar stays put and responds on the first click even while NotebookLM is generating.
- **Bulk source management** — check sources (NotebookLM's own select-all works fine), then **Delete checked** in one go from the floating bar, or **Find duplicates** (title-based) and remove them keeping the first of each group.

## Privacy

No analytics, no servers, no accounts. The only host permission is `notebooklm.google.com`. All data stays in your browser.

## Install (developer mode)

1. Download / unzip this folder.
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open NotebookLM — you'll see hover checkboxes in the Studio panel and a *⚡ Batch generate…* button under the create buttons.

## Development

```bash
./build.sh          # bundles src/ -> dist/ with esbuild
npx tsx --test src/lib/*.test.ts   # unit tests (pure logic)
```

Architecture:

- `src/content/selectors.ts` — **every** DOM selector lives here, nothing else touches raw selectors.
- `src/content/adapter.ts` — all NotebookLM actions (list/select/rename/delete/download/generate) via DOM automation.
- `src/content/interceptor.ts` — **v1.1**: MAIN-world script (injected at `document_start` by `inject.ts`) that passively parses NotebookLM's own Studio network responses (artifact ids, titles, status and **source ids**) and, when armed, splits one user-made generation request into one request per source — custom prompts and options included. Communicates with the content script via `CustomEvent`s only; if Google renames the RPC ids it degrades silently and the DOM features keep working.
- `src/content/registry.ts` — content-script side: artifact ↔ sources registry + auto-rename for split-mode batches.
- `src/lib/` — pure, unit-tested logic: rename-template engine, duplicate normalizer, queue state machine.
- `src/content/ui.ts` — injected UI (checkboxes, bulk bars, batch modal, queue panel).
- `src/background.ts` — notifications + download renaming via `downloads.onDeterminingFilename`.

There is no official NotebookLM API; everything works through the DOM. If Google changes the UI, fix `selectors.ts` first. Any selector failure disables its feature gracefully — the native page keeps working untouched.

## Known limitations (v1.1)

- Batch options cover the **Format** tiles you pick in NotebookLM's own dialog; language and length stay on NotebookLM's defaults for now.
- Some output types (e.g. **Mind Maps**) have no Download option in NotebookLM at all — bulk download skips them and says so in a toast.
- **Bulk downloads:** Chrome blocks multiple automatic downloads by default. The first time, click **Allow** on Chrome's "download multiple files" prompt (or allow it under Site settings → Automatic downloads for notebooklm.google.com), otherwise only the first file arrives.
- Renaming old outputs made from **many** sources names them after the first source plus `+N` (e.g. `Ch02.pdf +6 — Quiz`).
- **Rename by source** needs the artifact data captured since the last page load; if you get a "no source data captured yet" toast, reload the page and let the Studio list load first. Mind Maps aren't covered by the network registry yet and fall back to their current title.
- Duplicate detection is title-based (URL-based matching is implemented and tested in `src/lib/dedupe.ts`, but NotebookLM's source list doesn't expose URLs in the DOM).
- Bulk download triggers individual downloads (auto-renamed) rather than a single ZIP.
- ~~Renaming existing outputs is disabled (v1.0).~~ **Fixed in v1.1**: source names now come from NotebookLM's own network responses instead of the unreliable “View prompt & sources” dialog.
- Source-selection persistence and dashboard bulk-delete of notebooks are planned for a future version.
