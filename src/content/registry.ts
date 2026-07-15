/**
 * v1.1: live registry of Studio artifacts, fed by the MAIN-world interceptor
 * (interceptor.ts) via "nblmqol-artifacts" events. For every output NotebookLM
 * reports we know its id, title, type, status and - crucially - the SOURCE IDS
 * it was generated from. Source ids resolve to human names through the Sources
 * panel DOM (the row's more-button id encodes the source uuid).
 *
 * This replaces the removed v0.x "open the View prompt & sources dialog and
 * scrape it" approach, and it also powers auto-renaming for split-mode
 * batches.
 */
import * as adapter from "./adapter.ts"
import * as batchRunner from "./batch.ts"
import { applyTemplate } from "../lib/template.ts"

export type RegistryArtifact = {
  id: string
  title: string
  type: string
  status: string
  sourceIds: string[]
  downloadUrl: string | null
}

// Set to true for a verbose debug build. Filter the console by [nblm-qol].
const DEBUG = false
const dbg = (...args: unknown[]): void => {
  if (DEBUG) console.info("[nblm-qol][registry]", ...args)
}

const artifacts = new Map<string, RegistryArtifact>()

export function get(id: string): RegistryArtifact | null {
  return artifacts.get(id) ?? null
}

export function size(): number {
  return artifacts.size
}

/** Human source names for an artifact, resolved against the Sources panel. */
export function sourceNamesFor(artifactId: string): string[] | null {
  const a = artifacts.get(artifactId)
  if (!a || a.sourceIds.length === 0) return null
  const byId = new Map<string, string>()
  for (const s of adapter.listSources()) if (s.id && s.title) byId.set(s.id, s.title)
  const names = a.sourceIds.map((id) => byId.get(id)).filter((x): x is string => !!x)
  return names.length > 0 ? names : null
}

// ---------------- auto-rename for split-mode batches ----------------

type Expectation = {
  notebookId: string
  template: string
  /**
   * The type label the user picked in the batch modal (e.g. "Quiz").
   * Quiz & flashcards share NotebookLM type code 4, so the network-derived
   * label alone can't always tell them apart - the user's pick wins.
   */
  typeLabel: string | null
  /** Artifacts that existed BEFORE the split - never rename those. */
  priorIds: Set<string>
  /** Set once the interceptor reports which sources were split. */
  expectedSourceIds: Set<string> | null
  renamed: Set<string>
  n: number
  expiresAt: number
}

let expectation: Expectation | null = null

/** Arm auto-renaming for artifacts created by the upcoming split. */
export function armAutoRename(notebookId: string, template: string, typeLabel?: string): void {
  expectation = {
    notebookId,
    template,
    typeLabel: typeLabel ?? null,
    priorIds: new Set<string>([...artifacts.keys(), ...adapter.artifactIds()]),
    expectedSourceIds: null,
    renamed: new Set(),
    n: 0,
    expiresAt: Date.now() + 30 * 60 * 1000,
  }
  dbg(`auto-rename armed (${expectation.priorIds.size} pre-existing artifacts excluded)`)
}

export function disarmAutoRename(): void {
  expectation = null
}

function processExpectation(): void {
  if (!expectation) return
  if (Date.now() > expectation.expiresAt) {
    expectation = null
    return
  }
  for (const a of artifacts.values()) {
    if (expectation.priorIds.has(a.id) || expectation.renamed.has(a.id)) continue
    if (a.sourceIds.length !== 1) continue
    if (expectation.expectedSourceIds && !expectation.expectedSourceIds.has(a.sourceIds[0])) continue
    const names = sourceNamesFor(a.id)
    if (!names) {
      dbg(`auto-rename: artifact ${a.id.slice(0, 8)} source id not resolvable in Sources panel yet - will retry`)
      continue // source row not resolvable (yet) - retry on next event
    }
    expectation.renamed.add(a.id)
    expectation.n++
    const name = applyTemplate(expectation.template, {
      source: names[0],
      type: expectation.typeLabel ?? a.type,
      date: new Date(),
      n: expectation.n,
    })
    dbg(`auto-rename: ${a.id.slice(0, 8)} "${a.title}" -> "${name}"`)
    // queueRename persists + retries until NotebookLM accepts the rename.
    void batchRunner.queueRename(expectation.notebookId, a.id, name)
  }
}

export function init(): void {
  window.addEventListener("nblmqol-artifacts", (e: Event) => {
    const detail = (e as CustomEvent).detail as { artifacts?: RegistryArtifact[] } | undefined
    let added = 0
    for (const a of detail?.artifacts ?? []) {
      if (a && typeof a.id === "string" && a.id) {
        artifacts.set(a.id, a)
        added++
      }
    }
    dbg(`update: ${added} artifact(s) received, total known: ${artifacts.size}`)
    processExpectation()
  })
  window.addEventListener("nblmqol-split-start", (e: Event) => {
    const ids = (((e as CustomEvent).detail?.sourceIds ?? []) as string[]).filter((x) => typeof x === "string")
    if (expectation && ids.length > 0) expectation.expectedSourceIds = new Set(ids)
  })
}
