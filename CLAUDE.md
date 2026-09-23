# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome extension (Chrome 120+) that adds batch generate / bulk rename / bulk download / bulk delete to NotebookLM. Since Sept 2026 NotebookLM is branded **Gemini Notebook** and lives at `notebook.google.com` (the old `notebooklm.google.com` redirects there). Both hosts must stay in every host list: `manifest.json` (`host_permissions`, both `content_scripts`, `web_accessible_resources`), the download-origin regex in `background.ts`, and `HOST_RE` in `popup.ts`. A missing host means the extension silently does nothing. There is no official NotebookLM API: everything works through DOM automation plus passive parsing of NotebookLM's own network traffic. TypeScript, no framework, no runtime dependencies.

## Commands

```bash
bash build.sh          # esbuild-bundles src/ -> dist/ (5 IIFE bundles + copies content.css)
npm test               # node:test via tsx, runs the three src/lib/*.test.ts files
npx tsx --test src/lib/queue.test.ts   # single test file
npm run typecheck      # tsc --noEmit
```

- `build.sh` uses `esbuild` from PATH, or `$ESBUILD` if set. On Windows run it through Git Bash.
- `npm test` lists test files explicitly in `package.json`, so a new test file must be added there.
- Tests only cover pure logic in `src/lib/`. Everything under `src/content/` can only be checked by loading the unpacked extension in `chrome://extensions` and reloading the NotebookLM tab. The old content script is invalidated on extension reload.
- The popup shows a health check for the active tab: content script reachable, interceptor loaded (`data-nblmqol-net` on `<html>`), and selector hit counts. Check it first when something "does nothing".
- **`dist/` is committed** and `manifest.json` loads straight from it. Rebuild and commit `dist/` together with any `src/` change.

## Architecture

Three execution contexts that talk through narrow channels:

1. **MAIN-world interceptor** (`src/content/interceptor.ts` → `dist/interceptor.js`). `inject.ts` runs at `document_start` in the isolated world and only injects this script via `<script src>`, which is why it's listed in `web_accessible_resources`. It patches the page's network layer to:
   - passively parse the `batchexecute` RPC `gArtLc` responses (artifact id, title, type, status, **source ids**, direct download URLs);
   - in one-shot "split mode", rewrite the `R7cb6c` creation request to the first source only and replay it per remaining source. This is how batch generate keeps every option and custom prompt;
   - send renames through NotebookLM's own rename RPC, reusing the auth/URL params it captured from the page's requests.
   It has **no `chrome.*` access** and communicates with the content script only through `window` `CustomEvent`s named `nblmqol-*`. The event contract is documented in the file header. If Google renames the RPC ids, it must degrade silently.
   Gotcha: quizzes, flashcards and mind maps share type code 4. The subtype is `a[9][1][0]`: 1 = flashcards, 2 = quiz, 4 = mind map.

2. **Isolated-world content script** (`src/content/index.ts` → `dist/content.js`). It uses a debounced MutationObserver plus an SPA path poll to inject UI idempotently.
   - `selectors.ts`: **every** DOM selector lives here and nowhere else. When Google changes the UI, fix this file first.
   - `adapter.ts`: all NotebookLM actions (list/select/rename/delete/download/generate). Network paths (rename RPC, direct download URLs) are tried first, with DOM click automation as the fallback.
   - `registry.ts`: artifact ↔ source-ids registry fed by interceptor events, plus persistent pending auto-renames for split-mode batches.
   - `batch.ts`: batch orchestration and the background rename loop. `ui.ts`: all injected UI (checkboxes, bulk bars, batch modal, queue/progress/cancel panels). `dom.ts`: helpers.
   - Every feature must fail closed: a selector miss disables that feature for that tick, and the native page keeps working.

3. **Service worker** (`src/background.ts`): notifications, download naming via `downloads.onDeterminingFilename` (the content script sends `expectDownload` first), and verified direct downloads. It checks that the response isn't an HTML error page and reports back so the content script can fall back to the click path.

`src/lib/` holds pure, DOM-free logic (rename template engine with `{source}` `{type}` `{date}` `{n}`, duplicate normalizer, queue state machine) and `settings.ts` (chrome.storage wrapper). `src/popup.ts` + `popup.html` form the settings popup.

Conventions: `chrome` is declared as `any` in `src/chrome.d.ts` (no `@types/chrome`). Imports use explicit `.ts` extensions. Console logs are prefixed with `[nblm-qol]`.

## Releasing

A version bump touches `manifest.json` `version` (the console banner and popup read it at runtime), the README version badge, and the README changelog/"Known limitations (vX)" heading. `package.json`'s version is not kept in sync. Adding a host permission makes Chrome disable the Web Store build on update until the user re-approves it.
