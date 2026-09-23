/**
 * Content-script entry point. Observes the SPA and idempotently injects UI.
 * Any selector failure disables the related feature quietly - the native page
 * must keep working untouched.
 */
import { loadSettings, onSettingsChanged } from "../lib/settings.ts"
import { debounce } from "./dom.ts"
import { currentNotebookId, listArtifacts, listCreateOptions, listSources } from "./adapter.ts"
import * as ui from "./ui.ts"
import * as batch from "./batch.ts"
import * as registry from "./registry.ts"

/**
 * v1.6: answers the popup's health check. NotebookLM moved to
 * notebook.google.com in Sept 2026 and the extension silently stopped
 * injecting - this makes that kind of breakage visible (which part is
 * missing: the content script, the interceptor, or individual selectors).
 */
function healthReport(): Record<string, unknown> {
  const count = (f: () => unknown[]): number => {
    try {
      return f().length
    } catch {
      return -1
    }
  }
  return {
    ok: true,
    version: chrome.runtime.getManifest?.().version ?? "?",
    host: location.host,
    notebook: !!currentNotebookId(),
    interceptor: document.documentElement.dataset.nblmqolNet === "1",
    registry: registry.size(),
    sources: count(listSources),
    artifacts: count(listArtifacts),
    createButtons: count(listCreateOptions),
  }
}

async function main(): Promise<void> {
  try {
    chrome.runtime.onMessage.addListener((msg: any, _sender: any, sendResponse: (r?: any) => void) => {
      if (msg?.type === "health") sendResponse(healthReport())
      return false
    })
  } catch {
    /* context invalidated - nothing to report */
  }
  console.info(`[nblm-qol] NotebookLM QoL v${chrome.runtime.getManifest?.().version ?? "?"} active on ${location.host}`)
  // v1.1: start collecting artifact/source data from the MAIN-world
  // interceptor as early as possible (the interceptor itself is injected at
  // document_start by inject.ts).
  registry.init()
  const settings = await loadSettings()
  await ui.initUi(settings)
  onSettingsChanged((s) => ui.updateSettings(s))

  const scan = debounce(() => {
    try {
      if (currentNotebookId()) {
        ui.ensureStudioUi()
        ui.ensureSourceUi()
      }
    } catch (e) {
      console.warn("[nblm-qol] scan error (feature disabled this tick):", e)
    }
  }, 350)

  const observer = new MutationObserver(scan)
  observer.observe(document.body, { childList: true, subtree: true })
  scan()

  // SPA route changes
  let lastPath = location.pathname
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname
      scan()
      if (currentNotebookId()) ui.offerResumeIfNeeded()
    }
  }, 800)

  if (currentNotebookId()) {
    batch.startRenameLoop()
    await ui.offerResumeIfNeeded()
  } else {
    batch.startRenameLoop()
  }
}

main().catch((e) => console.warn("[nblm-qol] init failed:", e))
