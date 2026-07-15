/**
 * Content-script entry point. Observes the SPA and idempotently injects UI.
 * Any selector failure disables the related feature quietly - the native page
 * must keep working untouched.
 */
import { loadSettings, onSettingsChanged } from "../lib/settings.ts"
import { debounce } from "./dom.ts"
import { currentNotebookId } from "./adapter.ts"
import * as ui from "./ui.ts"
import * as batch from "./batch.ts"
import * as registry from "./registry.ts"

async function main(): Promise<void> {
  console.info("[nblm-qol] NotebookLM QoL v1.2.0-test active (debug logging ON) \u2014 all extension log lines start with [nblm-qol]")
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
