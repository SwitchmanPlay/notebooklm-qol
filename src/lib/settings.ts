/** Settings + persisted state (chrome.storage). */
import { DEFAULT_TEMPLATE } from "./template.ts"

export type Settings = {
  template: string
  features: {
    studioBulk: boolean
    batchGenerate: boolean
    sourceBulk: boolean
  }
}

export const DEFAULT_SETTINGS: Settings = {
  template: DEFAULT_TEMPLATE,
  features: {
    studioBulk: true,
    batchGenerate: true,
    sourceBulk: true,
  },
}

/**
 * v1.2: when the extension is reloaded/updated while a NotebookLM tab is
 * open, the old content script keeps running but every chrome.* call throws
 * "Extension context invalidated". Those errors were spamming the console -
 * all storage helpers now fail soft (defaults / no-op) instead.
 */
function contextAlive(): boolean {
  try {
    return !!chrome.runtime?.id
  } catch {
    return false
  }
}

export async function loadSettings(): Promise<Settings> {
  let raw: { settings?: Partial<Settings> } | undefined
  try {
    if (contextAlive()) raw = await chrome.storage.sync.get("settings")
  } catch {
    /* orphaned content script - use defaults */
  }
  const s = (raw?.settings ?? {}) as Partial<Settings>
  return {
    template: typeof s.template === "string" && s.template.trim() ? s.template : DEFAULT_SETTINGS.template,
    features: { ...DEFAULT_SETTINGS.features, ...(s.features ?? {}) },
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.sync.set({ settings: s })
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes: any, area: string) => {
    if (area === "sync" && changes.settings) loadSettings().then(cb)
  })
}

// ---- local state (per-browser, survives reloads) ----

export type PendingRename = {
  notebookId: string
  artifactId: string
  name: string
  createdAt: number
}

export async function getLocal<T>(key: string, fallback: T): Promise<T> {
  if (!contextAlive()) return fallback
  try {
    const raw = await chrome.storage.local.get(key)
    return (raw?.[key] as T) ?? fallback
  } catch {
    return fallback // orphaned content script (extension reloaded under us)
  }
}

export async function setLocal<T>(key: string, value: T): Promise<void> {
  if (!contextAlive()) return
  try {
    await chrome.storage.local.set({ [key]: value })
  } catch {
    /* orphaned content script - drop the write instead of throwing */
  }
}

export const KEYS = {
  batch: (notebookId: string) => `nblmqol.batch.${notebookId}`,
  renames: "nblmqol.pendingRenames",
  renamePref: "nblmqol.renamePref",
  lastType: "nblmqol.lastType",
  choices: (artifactType: string) => `nblmqol.choices.${artifactType}`,
} as const
