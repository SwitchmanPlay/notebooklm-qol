import { loadSettings, saveSettings, Settings } from "./lib/settings.ts"
import { templatePreview } from "./lib/template.ts"

const $ = (id: string) => document.getElementById(id) as HTMLInputElement

async function main(): Promise<void> {
  const settings = await loadSettings()
  $("template").value = settings.template
  $("f-studioBulk").checked = settings.features.studioBulk
  $("f-batchGenerate").checked = settings.features.batchGenerate
  $("f-sourceBulk").checked = settings.features.sourceBulk
  renderPreview()

  let t: number | undefined
  const save = () => {
    clearTimeout(t)
    t = setTimeout(async () => {
      const s: Settings = {
        template: $("template").value.trim() || settings.template,
        features: {
          studioBulk: $("f-studioBulk").checked,
          batchGenerate: $("f-batchGenerate").checked,
          sourceBulk: $("f-sourceBulk").checked,
        },
      }
      await saveSettings(s)
      const saved = document.getElementById("saved")!
      saved.textContent = "Saved \u2713"
      setTimeout(() => (saved.textContent = ""), 1500)
    }, 350) as unknown as number
  }

  $("template").addEventListener("input", () => {
    renderPreview()
    save()
  })
  for (const id of ["f-studioBulk", "f-batchGenerate", "f-sourceBulk"]) {
    $(id).addEventListener("change", save)
  }
}

// v1.6: health check of the active tab (see healthReport in content/index.ts).
const HOST_RE = /^https:\/\/notebook(lm)?\.google\.com\//

type Health = {
  version: string
  notebook: boolean
  interceptor: boolean
  registry: number
  sources: number
  artifacts: number
  createButtons: number
}

function setStatus(kind: "ok" | "warn" | "bad" | "", title: string, detail = "", items: Array<[string, boolean]> = []): void {
  const box = document.getElementById("status")!
  box.className = `status ${kind}`.trim()
  box.textContent = ""
  const t = document.createElement("strong")
  t.textContent = title
  box.appendChild(t)
  if (detail) box.appendChild(document.createTextNode(detail))
  if (items.length) {
    const ul = document.createElement("ul")
    for (const [label, good] of items) {
      const li = document.createElement("li")
      li.textContent = `${good ? "✓" : "✗"} ${label}`
      if (!good) li.className = "miss"
      ul.appendChild(li)
    }
    box.appendChild(ul)
  }
}

async function checkHealth(): Promise<void> {
  let tab: any
  try {
    ;[tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  } catch {
    /* no tab access */
  }
  if (!tab?.id || !HOST_RE.test(String(tab.url ?? ""))) {
    setStatus("", "Not on NotebookLM", "Open a notebook on notebook.google.com to use the tools.")
    return
  }
  const health = await new Promise<Health | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 1500)
    try {
      chrome.tabs.sendMessage(tab.id, { type: "health" }, (r: Health | undefined) => {
        clearTimeout(timer)
        void chrome.runtime.lastError
        resolve(r ?? null)
      })
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })
  if (!health) {
    setStatus("bad", "Not running on this tab", "Reload the NotebookLM tab (needed after installing or updating the extension).")
    return
  }
  if (!health.notebook) {
    setStatus("ok", "Active", "Open a notebook to see the Studio and source tools.")
    return
  }
  const items: Array<[string, boolean]> = [
    [`Sources panel (${health.sources})`, health.sources > 0],
    [`Studio create buttons (${health.createButtons})`, health.createButtons > 0],
    [`Studio outputs (${health.artifacts})`, true],
    [`Network data (${health.registry} outputs seen)`, health.interceptor],
  ]
  const broken = items.filter(([, good]) => !good).length
  if (broken === 0) setStatus("ok", "All systems go", "", items)
  else
    setStatus(
      "warn",
      "Partly working",
      " NotebookLM may have changed its page. Reload the tab; if it persists, please open an issue on GitHub.",
      items,
    )
}

function renderPreview(): void {
  const el = document.getElementById("preview")!
  try {
    el.textContent = `Preview: ${templatePreview($("template").value || "")}`
  } catch {
    el.textContent = ""
  }
}

main()
document.getElementById("version")!.textContent = `v${chrome.runtime.getManifest().version}`
void checkHealth()
