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

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.sync.get("settings")
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
  const raw = await chrome.storage.local.get(key)
  return (raw?.[key] as T) ?? fallback
}

export async function setLocal<T>(key: string, value: T): Promise<void> {
  await chrome.storage.local.set({ [key]: value })
}

export const KEYS = {
  batch: (notebookId: string) => `nblmqol.batch.${notebookId}`,
  renames: "nblmqol.pendingRenames",
  renamePref: "nblmqol.renamePref",
  lastType: "nblmqol.lastType",
  choices: (artifactType: string) => `nblmqol.choices.${artifactType}`,
} as const
