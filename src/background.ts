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

// v1.3.1: direct (network URL) downloads started by us, keyed by downloadId.
// We only report ok to the content script once the response headers prove a
// real file is coming - a stale/protected URL yields an HTML error page
// ("File wasn't available on site"), in which case the content script falls
// back to the click path.
type DirectPending = { name: string; respond: (r?: any) => void; timer: ReturnType<typeof setTimeout> }
const directPending = new Map<number, DirectPending>()

function settleDirect(downloadId: number, result: { ok: boolean; error?: string }): void {
  const p = directPending.get(downloadId)
  if (!p) return
  directPending.delete(downloadId)
  clearTimeout(p.timer)
  try {
    p.respond(result)
  } catch {
    /* the message channel may already be closed */
  }
}

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
  } else if (msg?.type === "directDownload") {
    // v1.3: network-based bulk download - the content script found a direct
    // file URL inside NotebookLM's own poll responses; chrome.downloads
    // fetches it instantly (no menu clicks needed on the page).
    // v1.3.1: verified. We answer only after the response headers arrive:
    // ok:true for a real file (renamed into NotebookLM/), ok:false when the
    // server sent an HTML page or errored - the caller then uses the click path.
    const name = sanitize(String(msg.name ?? ""))
    try {
      chrome.downloads.download({ url: String(msg.url ?? "") }, (downloadId?: number) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          sendResponse?.({ ok: false, error: chrome.runtime.lastError?.message ?? "download failed" })
          return
        }
        const timer = setTimeout(() => {
          // No headers within 25s: assume a slow but live download - don't
          // let the caller start a duplicate via the click path.
          settleDirect(downloadId, { ok: true })
        }, 25_000)
        directPending.set(downloadId, { name, respond: sendResponse as (r?: any) => void, timer })
      })
      return true // keep the message channel open for the async response
    } catch (e) {
      sendResponse?.({ ok: false, error: (e as Error).message })
    }
  }
  return false
})

// v1.3.1: a direct download that dies before/without headers (network error,
// interrupted) must also report failure so the click-path fallback kicks in.
chrome.downloads.onChanged?.addListener((delta: any) => {
  if (delta?.error?.current && directPending.has(delta.id)) {
    settleDirect(delta.id, { ok: false, error: String(delta.error.current) })
  }
})

chrome.downloads.onDeterminingFilename?.addListener(
  (item: any, suggest: (s?: { filename: string; conflictAction?: string }) => void) => {
    // v1.3.1: downloads we started ourselves (directDownload) are matched by
    // id, never via the expected[] queue - no races with page downloads.
    const p = directPending.get(item.id)
    if (p) {
      const original = String(item.filename ?? "")
      const mime = String(item.mime ?? "")
      const isHtml = mime === "text/html" || /\.html?$/i.test(original)
      if (isHtml) {
        // Stale or protected URL: the server sent an error page instead of
        // the file. Cancel & erase the junk download and let the content
        // script fall back to clicking NotebookLM's own Download menu.
        suggest()
        settleDirect(item.id, { ok: false, error: "URL served an HTML page instead of the file" })
        try {
          chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }))
        } catch {
          /* best effort */
        }
        return
      }
      const dot = original.lastIndexOf(".")
      const ext = dot > 0 ? original.slice(dot) : ""
      suggest({ filename: `NotebookLM/${p.name}${ext}`, conflictAction: "uniquify" })
      settleDirect(item.id, { ok: true })
      return
    }

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
