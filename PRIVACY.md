# Privacy Policy — NotebookLM QoL

**Last updated: July 16, 2026**

NotebookLM QoL ("the extension") is an open-source browser extension that adds quality-of-life features to Google NotebookLM. This policy describes what data the extension handles and where it goes.

## The short version

- The extension collects **no personal data**.
- **Nothing you do is sent to the developer or to any third party.** There are no analytics, no telemetry, no error reporting, no accounts, and no servers operated by this project.
- All communication happens exclusively between your browser and **notebooklm.google.com** (and Google's own file-hosting domains when you download your files) — the same communication that happens when you use NotebookLM normally.

## What the extension stores

The extension stores a small amount of data **locally in your browser** using Chrome's extension storage:

- your settings (e.g. the rename template),
- the state of a running or paused batch queue,
- pending renames waiting for a generation to finish (kept for at most 24 hours).

This data never leaves your device. Uninstalling the extension deletes it.

## How the extension interacts with NotebookLM

- The extension runs **only** on notebooklm.google.com.
- It reads the responses NotebookLM's own web app receives (titles, generation status, download links of **your** outputs) to power renaming, progress display, and direct downloads. This processing happens entirely inside your browser tab.
- When you use batch generation, renaming, or bulk download, the extension sends requests to notebooklm.google.com **on your behalf, using your existing Google session** — the same requests the NotebookLM page itself would send if you clicked manually. Your session credentials are never read out, stored, or transmitted anywhere else.

## Permissions explained

- **storage** — save your settings and queue state locally.
- **downloads** — save your bulk-downloaded files, auto-renamed, into a `NotebookLM/` folder in your Downloads.
- **notifications** — optional desktop notification when a batch finishes.
- **Host access to notebooklm.google.com** — required for every feature; the extension does not run anywhere else.

## What the extension does NOT do

- It does not collect, transmit, or sell any data.
- It does not track your browsing.
- It does not inject ads or modify content on any site other than NotebookLM.
- It does not communicate with any server other than Google's own NotebookLM endpoints.

## Changes

If a future version changes any of the above, this file will be updated in the repository before the version is published.

## Contact

Questions or concerns: open an issue at https://github.com/SwitchmanPlay/notebooklm-qol/issues
