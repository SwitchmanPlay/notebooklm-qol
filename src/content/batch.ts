/**
 * Batch-generate runner: drives the pure queue state machine via the adapter.
 * Also owns the pending-rename retry loop (renames apply as soon as NotebookLM
 * allows renaming, i.e. once generation has finished). Pending renames are
 * stored in chrome.storage.local, so they survive reloads and even closing the
 * tab - when you come back hours later, the loop picks them up again.
 */
import {
  BatchState,
  createBatch,
  nextPending,
  startJob,
  completeJob,
  failJob,
  pauseForRateLimit,
  resume,
  summary,
} from "../lib/queue.ts"
import { applyTemplate } from "../lib/template.ts"
import { KEYS, PendingRename, getLocal, setLocal, loadSettings } from "../lib/settings.ts"
import * as adapter from "./adapter.ts"
import { sleep } from "./dom.ts"

export type BatchEvents = {
  onUpdate: (batch: BatchState) => void
  /** Human-facing notices, e.g. "pick options in NotebookLM's dialog". */
  onNotice?: (msg: string) => void
}

/** BatchState plus the options we need to resume it faithfully after a reload. */
export type SavedBatch = BatchState & {
  renameToSource?: boolean
  choices?: Record<string, string>
}

let running = false
let cancelRequested = false

export function isRunning(): boolean {
  return running
}

/** Ask the runner to stop after the job that is currently generating. */
export function requestCancel(): void {
  cancelRequested = true
}

export async function loadSavedBatch(notebookId: string): Promise<SavedBatch | null> {
  return getLocal<SavedBatch | null>(KEYS.batch(notebookId), null)
}

export async function clearBatch(notebookId: string): Promise<void> {
  await setLocal(KEYS.batch(notebookId), null)
}

export async function startNewBatch(args: {
  notebookId: string
  artifactType: string
  sources: Array<{ id: string; title: string }>
  renameToSource: boolean
  choices?: Record<string, string>
  events: BatchEvents
}): Promise<void> {
  const batch = createBatch({
    batchId: `batch-${Date.now()}`,
    notebookId: args.notebookId,
    artifactType: args.artifactType,
    sources: args.sources,
  })
  await runBatch(batch, args.renameToSource, args.choices, args.events)
}

export async function resumeBatch(saved: SavedBatch, events: BatchEvents): Promise<void> {
  await runBatch(resume(saved), saved.renameToSource ?? true, saved.choices, events)
}

async function runBatch(
  batch: BatchState,
  renameToSource: boolean,
  choices: Record<string, string> | undefined,
  events: BatchEvents,
): Promise<void> {
  if (running)
    throw new Error("A batch is already running \u2014 press \u201cStop after current job\u201d in the queue panel (bottom right) or wait for it to finish.")
  running = true
  cancelRequested = false
  const settings = await loadSettings()
  // `choices` stays undefined until the user confirms NotebookLM's options
  // dialog on the FIRST job; it is then recorded, reused for every remaining
  // job, and persisted so a resume after reload keeps the same options.
  const persist = (b: BatchState) =>
    setLocal<SavedBatch>(KEYS.batch(b.notebookId), { ...b, renameToSource, choices })
  try {
    batch = { ...batch, status: "running" }
    await persist(batch)
    events.onUpdate(batch)

    let index = 0
    for (;;) {
      if (cancelRequested) {
        batch = { ...batch, status: "idle" }
        await persist(batch)
        events.onUpdate(batch)
        notify("Batch stopped", "Remaining jobs were not started. You can resume from the queue panel.")
        return
      }
      const job = nextPending(batch)
      if (!job) break
      index++
      batch = startJob(batch, job.id)
      await persist(batch)
      events.onUpdate(batch)

      try {
        // Let any late artifact from the previous job finish appearing, so it
        // can never be attributed to this job (this crossed renames in v0.1).
        await adapter.waitForStableArtifacts()
        await adapter.applySourceSelection(new Set([job.sourceId, job.sourceTitle]))
        const res = await adapter.generateArtifactInteractive(job.artifactType, choices ?? null, () =>
          events.onNotice?.(
            "NotebookLM is asking for options \u2014 pick them and press Generate. They'll be reused for the rest of this batch.",
          ),
        )
        if (res.recordedChoices) choices = res.recordedChoices
        const artifactId = res.id
        batch = completeJob(batch, job.id, artifactId)
        if (renameToSource) {
          const name = applyTemplate(settings.template, {
            source: job.sourceTitle,
            type: job.artifactType,
            date: new Date(),
            n: index,
          })
          await addPendingRename({
            notebookId: batch.notebookId,
            artifactId,
            name,
            createdAt: Date.now(),
          })
          // Try immediately too - some artifact types allow instant rename.
          tryApplyRenames()
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/BATCH_CANCELLED/.test(msg)) {
          // The user closed the options dialog without generating - treat it
          // as "cancel the whole batch", not as a failed job.
          batch = { ...failJob(batch, job.id, "cancelled \u2014 options dialog closed without generating"), status: "idle" }
          await persist(batch)
          events.onUpdate(batch)
          events.onNotice?.("Batch cancelled \u2014 the options dialog was closed without generating. No further jobs were started.")
          return
        }
        if (/NotebookLM says:/.test(msg)) {
          batch = pauseForRateLimit(batch, job.id)
          await persist(batch)
          events.onUpdate(batch)
          notify("Batch paused", msg)
          return
        }
        batch = failJob(batch, job.id, msg)
        console.warn(`[nblm-qol] job failed (${job.sourceTitle}):`, msg)
      }
      await persist(batch)
      events.onUpdate(batch)
      await sleep(1500) // be gentle between jobs
    }

    await persist(batch)
    events.onUpdate(batch)
    const s = summary(batch)
    notify(
      "Batch generation started",
      `${s.done}/${s.total} generations kicked off${s.failed ? `, ${s.failed} failed` : ""}. Renaming happens automatically as they finish.`,
    )
  } finally {
    running = false
    cancelRequested = false
  }
}

function notify(title: string, message: string): void {
  try {
    chrome.runtime.sendMessage({ type: "notify", title, message })
  } catch {
    /* extension context may be gone during navigation */
  }
}

// ---------------- pending renames ----------------

async function addPendingRename(r: PendingRename): Promise<void> {
  const all = await getLocal<PendingRename[]>(KEYS.renames, [])
  all.push(r)
  await setLocal(KEYS.renames, all)
}

/** Queue a rename to be applied as soon as NotebookLM allows it (survives reloads). */
export async function queueRename(notebookId: string, artifactId: string, name: string): Promise<void> {
  await addPendingRename({ notebookId, artifactId, name, createdAt: Date.now() })
  tryApplyRenames()
}

/** v0.6: drop every queued rename for this notebook (undo an accidental bulk rename). */
export async function clearPendingRenames(notebookId: string): Promise<number> {
  const all = await getLocal<PendingRename[]>(KEYS.renames, [])
  const keep = all.filter((r) => r.notebookId !== notebookId)
  await setLocal(KEYS.renames, keep)
  return all.length - keep.length
}

let renameTimer: number | undefined
let applyingRenames = false

export function startRenameLoop(): void {
  if (renameTimer != null) return
  renameTimer = setInterval(tryApplyRenames, 25_000) as unknown as number
  tryApplyRenames()
}

export async function tryApplyRenames(): Promise<void> {
  if (applyingRenames || running) return
  applyingRenames = true
  try {
    const notebookId = adapter.currentNotebookId()
    if (!notebookId) return
    const all = await getLocal<PendingRename[]>(KEYS.renames, [])
    const dayAgo = Date.now() - 24 * 3600 * 1000
    const keep: PendingRename[] = []
    let changed = false
    for (const r of all) {
      if (r.createdAt < dayAgo) {
        changed = true
        continue // expired
      }
      if (r.notebookId !== notebookId) {
        keep.push(r)
        continue
      }
      const artifact = adapter.findArtifact(r.artifactId)
      if (!artifact) {
        keep.push(r) // not rendered (yet) - retry later
        continue
      }
      if (artifact.title === r.name) {
        changed = true
        continue // already done
      }
      // v0.8: don't even attempt while still generating - it can never stick
      // and only spams "rename didn't stick" warnings. Retry on a later tick.
      if (/^generating\b/i.test(artifact.title)) {
        keep.push(r)
        continue
      }
      try {
        await adapter.renameArtifact(r.artifactId, r.name)
        changed = true
        await sleep(400)
      } catch {
        keep.push(r) // still generating / didn't stick - retry on next tick
      }
    }
    if (changed || keep.length !== all.length) await setLocal(KEYS.renames, keep)
  } finally {
    applyingRenames = false
  }
}

export async function pendingRenameCount(notebookId: string): Promise<number> {
  const all = await getLocal<PendingRename[]>(KEYS.renames, [])
  return all.filter((r) => r.notebookId === notebookId).length
}
