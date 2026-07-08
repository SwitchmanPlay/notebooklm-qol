/**
 * Background service worker: notifications + download renaming.
 *
 * Download renaming trick: the content script cannot control the filename of
 * NotebookLM's native downloads, but the background can. Right before the
 * content script clicks "Download", it sends { type: "expectDownload", name }.
 * When a download from notebooklm.google.com / googleusercontent.com starts
 * within the next 90s, we suggest the desired filename (keeping the original
 * extension) inside a "NotebookLM/" subfolder of Downloads.
 */

type ExpectedDownload = { name: string; at: number }
const expected: ExpectedDownload[] = []

function sanitize(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim()
    .slice(0, 140) || "NotebookLM file"
}

chrome.runtime.onMessage.addListener((msg: any, _sender: any, sendResponse: (r?: any) => void) => {
  if (msg?.type === "notify") {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: String(msg.title ?? "NotebookLM QoL"),
      message: String(msg.message ?? ""),
    })
    sendResponse?.({ ok: true })
  } else if (msg?.type === "expectDownload") {
    const name = sanitize(String(msg.name ?? ""))
    // Content-script retries can re-announce the same download - don't queue dupes.
    if (expected[expected.length - 1]?.name !== name) {
      expected.push({ name, at: Date.now() })
    } else {
      expected[expected.length - 1].at = Date.now()
    }
    sendResponse?.({ ok: true })
  }
  return false
})

chrome.downloads.onDeterminingFilename?.addListener(
  (item: any, suggest: (s?: { filename: string; conflictAction?: string }) => void) => {
    // prune stale expectations (slide decks can bounce through an export page,
    // so allow a generous window)
    const now = Date.now()
    while (expected.length && now - expected[0].at > 90_000) expected.shift()

    const fromNotebookLM = /notebooklm\.google\.com|googleusercontent\.com|usercontent\.google\.com|docs\.google\.com/.test(
      String(item.url ?? "") + String(item.referrer ?? ""),
    )
    const next = expected.shift()
    if (!next || !fromNotebookLM) {
      suggest()
      return
    }
    const original = String(item.filename ?? "")
    const dot = original.lastIndexOf(".")
    const ext = dot > 0 ? original.slice(dot) : ""
    suggest({ filename: `NotebookLM/${next.name}${ext}`, conflictAction: "uniquify" })
  },
)
