/**
 * Injected UI: Studio artifact checkboxes + select-all header + bulk bar,
 * Batch-generate modal (with per-type format options), queue panel, and
 * source-panel bulk actions. All elements carry the `nblmqol-` prefix and are
 * idempotently (re)injected by the observer in index.ts.
 */
import * as adapter from "./adapter.ts"
import { $, $$, sleep } from "./dom.ts"
import { SEL } from "./selectors.ts"
import { applyTemplate } from "../lib/template.ts"
import { findDuplicateGroups } from "../lib/dedupe.ts"
import { BatchState, summary } from "../lib/queue.ts"
import { KEYS, Settings, getLocal, setLocal } from "../lib/settings.ts"
import * as batchRunner from "./batch.ts"

let settings: Settings

export async function initUi(s: Settings): Promise<void> {
  settings = s
}

export function updateSettings(s: Settings): void {
  settings = s
}

// ================= Studio: artifact checkboxes + bulk bar =================

const selectedArtifacts = new Set<string>()
// artifact id -> first time it went missing from the DOM (see prune logic below)
const missingSince = new Map<string, number>()

export function ensureStudioUi(): void {
  if (!settings?.features.studioBulk) return
  const items = adapter.listArtifacts()
  if (items.length === 0) return

  for (const a of items) {
    if (!a.id || a.el.querySelector(".nblmqol-check")) continue
    const box = document.createElement("input")
    box.type = "checkbox"
    box.className = "nblmqol-check"
    box.title = "Select for bulk actions (NotebookLM QoL)"
    box.checked = selectedArtifacts.has(a.id)
    const id = a.id
    box.addEventListener("click", (e) => e.stopPropagation())
    box.addEventListener("change", () => {
      if (box.checked) selectedArtifacts.add(id)
      else selectedArtifacts.delete(id)
      a.el.classList.toggle("nblmqol-selected", box.checked)
      updateBulkBar()
    })
    a.el.classList.add("nblmqol-host")
    // v0.7: big invisible hit zone - anywhere left of the title toggles the
    // checkbox instead of opening the artifact.
    const zone = document.createElement("label")
    zone.className = "nblmqol-checkzone"
    zone.addEventListener("click", (e) => e.stopPropagation())
    zone.appendChild(box)
    a.el.appendChild(zone)
  }
  // Prune selections of artifacts that are really gone - but only after a
  // grace period: Angular briefly renders a PARTIAL list while generating,
  // and pruning against it randomly dropped selections in v0.4.
  const ids = adapter.artifactIds()
  const now = Date.now()
  for (const id of [...selectedArtifacts]) {
    if (ids.has(id)) {
      missingSince.delete(id)
      continue
    }
    const since = missingSince.get(id) ?? now
    missingSince.set(id, since)
    if (now - since > 10_000) {
      selectedArtifacts.delete(id)
      missingSince.delete(id)
    }
  }
  ensureBulkBar()
  ensureStudioHeader()
  ensureBatchButton()
}

/**
 * Persistent Studio bulk bar. It lives in document.body (never inside Angular's
 * DOM, which re-renders constantly while generating) and its nodes are built
 * exactly ONCE, then only updated in place. Rebuilding UI on observer ticks was
 * why buttons and "Select all outputs" appeared dead mid-generation - the node
 * you pressed got replaced between mousedown and mouseup.
 */
function ensureBulkBar(): void {
  const total = adapter.listArtifacts().filter((a) => a.id).length
  let bar = $("#nblmqol-bulkbar")
  if (total === 0) {
    bar?.remove()
    return
  }
  if (!bar) {
    bar = document.createElement("div")
    bar.id = "nblmqol-bulkbar"
    // v0.6: no "Select all" down here - the header at the top of the list owns it.
    const count = el("span", "nblmqol-count", "")
    const actions = el("span", "nblmqol-bulkactions", "")
    actions.append(
      btn("Download", () => bulkDownload()),
      // v1.0: bulk "Rename by template" for EXISTING outputs is disabled - the
      // "View prompt & sources" dialog proved too unreliable to read. Flip
      // ENABLE_BULK_RENAME to true to work on it again (see README).
      ...(ENABLE_BULK_RENAME ? [btn("Rename by template", () => bulkRename(), "nblmqol-teal")] : []),
      btn("Delete", () => bulkDelete(), "nblmqol-danger"),
      btn("\u2715", () => clearSelection(), "nblmqol-ghost"),
    )
    bar.append(count, actions)
    document.body.appendChild(bar)
  }
  updateBulkBar()
}

/** Update the bulk bar AND the top header in place - never replaces nodes. */
function updateBulkBar(): void {
  // Count from the selection set itself - the DOM list can be PARTIAL for a
  // moment while NotebookLM re-renders (this made "3 selected" show as 1).
  const sel = selectedArtifacts.size
  const total = Math.max(adapter.artifactIds().size, sel)
  const setBox = (box: HTMLInputElement | null) => {
    if (!box) return
    box.checked = total > 0 && sel === total
    box.indeterminate = sel > 0 && sel < total
  }
  const bar = $("#nblmqol-bulkbar")
  if (bar) {
    const count = bar.querySelector<HTMLElement>(".nblmqol-count")
    if (count) count.textContent = sel > 0 ? `${sel}/${total} selected` : `${total} outputs`
    bar.classList.toggle("nblmqol-empty", sel === 0)
  }
  const head = document.getElementById("nblmqol-studiohead")
  if (head) {
    setBox(head.querySelector<HTMLInputElement>("#nblmqol-selectall-top"))
    const count = head.querySelector<HTMLElement>(".nblmqol-count")
    if (count) count.textContent = sel > 0 ? `${sel}/${total} selected` : ""
    refreshPendingBadge()
  }
}

/** Check/uncheck every output at once (used by both the header and the bar). */
function setAllOutputs(on: boolean): void {
  for (const a of adapter.listArtifacts()) {
    if (!a.id) continue
    if (on) selectedArtifacts.add(a.id)
    else selectedArtifacts.delete(a.id)
    a.el.classList.toggle("nblmqol-selected", on)
    const rb = a.el.querySelector<HTMLInputElement>(".nblmqol-check")
    if (rb) rb.checked = on
  }
  updateBulkBar()
}

/** v0.6: badge for the persistent rename queue + a way to cancel it (it
 * otherwise keeps applying renames even after a page reload). */
let lastPendingCheck = 0
function refreshPendingBadge(): void {
  const now = Date.now()
  if (now - lastPendingCheck < 5000) return
  lastPendingCheck = now
  const notebookId = adapter.currentNotebookId()
  const b = document.getElementById("nblmqol-pendbtn")
  if (!notebookId || !b) return
  void batchRunner.pendingRenameCount(notebookId).then((n) => {
    b.style.display = n > 0 ? "" : "none"
    b.textContent = `\u2715 ${n} queued rename(s)`
    b.title = "Cancel all queued renames for this notebook"
  })
}

async function cancelQueuedRenames(): Promise<void> {
  const notebookId = adapter.currentNotebookId()
  if (!notebookId) return
  const n = await batchRunner.clearPendingRenames(notebookId)
  toast(`Cancelled ${n} queued rename(s)`)
  lastPendingCheck = 0
  refreshPendingBadge()
}

/**
 * v0.5: "Select all outputs" pinned at the TOP of the Studio list (the
 * floating bar alone wasn't intuitive). Built once; re-inserted only when
 * Angular re-renders the list container; updated in place by updateBulkBar.
 */
function ensureStudioHeader(): void {
  const firstItem = $(SEL.artifactItem)
  const listParent = firstItem?.parentElement
  let head = document.getElementById("nblmqol-studiohead")
  if (!listParent) {
    head?.remove()
    return
  }
  if (!head) {
    head = el("div", "", "")
    head.id = "nblmqol-studiohead"
    const lab = el("label", "", "")
    const box = document.createElement("input")
    box.type = "checkbox"
    box.id = "nblmqol-selectall-top"
    lab.append(box, el("span", "", "Select all outputs"))
    const pend = btn("", () => void cancelQueuedRenames(), "nblmqol-ghost nblmqol-mini")
    pend.id = "nblmqol-pendbtn"
    pend.style.display = "none"
    head.append(lab, el("span", "nblmqol-count", ""), pend)
    // v0.6: clicking the TEXT toggles too, not just the 16px checkbox. We
    // compute the target state ourselves and preventDefault so the native
    // label toggle and Angular's handlers can't fight us.
    lab.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      const total = adapter.artifactIds().size
      const on = total === 0 ? true : selectedArtifacts.size < total
      setTimeout(() => setAllOutputs(on), 0)
    })
  }
  if (!head.isConnected || head.parentElement !== listParent) listParent.insertBefore(head, listParent.firstChild)
}

function clearSelection(): void {
  selectedArtifacts.clear()
  for (const a of adapter.listArtifacts()) {
    a.el.classList.remove("nblmqol-selected")
    const box = a.el.querySelector<HTMLInputElement>(".nblmqol-check")
    if (box) box.checked = false
  }
  updateBulkBar()
}

async function bulkDownload(): Promise<void> {
  const ids = [...selectedArtifacts]
  let ok = 0
  let skipped = 0
  let failed = 0
  let i = 0
  toast(
    `Starting ${ids.length} download(s)\u2026 keep this tab open. If Chrome asks to allow multiple downloads, choose Allow!`,
  )
  for (const id of ids) {
    i++
    const a = adapter.findArtifact(id)
    if (!a) {
      failed++
      toast("A selected output is not in the list right now (still generating?) - skipped")
      continue
    }
    let done = false
    for (let attempt = 1; attempt <= 2 && !done; attempt++) {
      try {
        chrome.runtime.sendMessage({ type: "expectDownload", name: a.title })
        await adapter.downloadArtifact(id)
        ok++
        done = true
      } catch (e) {
        await adapter.closeMenus()
        const m = (e as Error).message
        if (/No Download option/i.test(m)) {
          // e.g. mind maps - NotebookLM simply has no download for them
          skipped++
          done = true
          toast(`\u201c${a.title}\u201d (${a.type}) has no download option in NotebookLM \u2014 skipped`)
        } else if (attempt === 2) {
          failed++
          toast(`Download failed for \u201c${a.title}\u201d: ${m}`)
        } else await sleep(1500)
      }
    }
    // Slide decks & reports can bounce through an export page - give each
    // download plenty of room before the next menu dance.
    if (i < ids.length) await sleep(6000)
  }
  const bits = [`Triggered ${ok}/${ids.length} download(s)`]
  if (skipped) bits.push(`${skipped} skipped (no download option)`)
  if (failed) bits.push(`${failed} failed`)
  toast(bits.join(", "))
}

// v1.0: feature flag, intentionally OFF. Renaming EXISTING outputs relied on
// reading the "View prompt & sources" dialog, which proved too unreliable in
// real notebooks. Batch generation still auto-renames NEW outputs, which works.
// Kept (not deleted) so a future fix only needs to flip this flag.
const ENABLE_BULK_RENAME = false

async function bulkRename(): Promise<void> {
  const all = adapter.listArtifacts().filter((a) => a.id && selectedArtifacts.has(a.id))
  // Still-generating outputs have no menu and no sources yet - skip them
  // up front instead of timing out on each one (reselect them once done).
  const items = all.filter((a) => !/^generating\b/i.test(a.title))
  const skippedGen = all.length - items.length
  if (items.length === 0) {
    toast("All selected outputs are still generating \u2014 try again when they finish.")
    return
  }
  // Guard against accidental "rename all 37 outputs" clicks.
  if (
    items.length > 3 &&
    !window.confirm(
      `Rename ${items.length} outputs using the template \u201c${settings.template}\u201d?\n\nThis reads each output's sources first (a few seconds per item). Queued renames keep applying even after a reload \u2014 you can cancel them from the header above the outputs list.`,
    )
  )
    return
  const notebookId = adapter.currentNotebookId()
  // v0.7: keep NotebookLM's dialogs invisible for the whole run and make sure
  // nothing is left open from before - a stuck dialog broke every rename.
  adapter.setOverlaysHidden(true)
  await adapter.forceCloseDialogs()
  let n = 0
  let ok = 0
  let queued = 0
  let fromTitle = 0
  for (const a of items) {
    n++
    toast(`Renaming ${n}/${items.length}: reading sources of \u201c${a.title}\u201d\u2026`)
    // Resolve the real source name(s) via "View prompt and sources" - this is
    // what makes renaming OLD outputs (created before the extension) work.
    let sourceName = a.title
    const srcs = await adapter.getArtifactSources(a.id!)
    if (srcs && srcs.length > 0) sourceName = srcs.length === 1 ? srcs[0] : `${srcs[0]} +${srcs.length - 1}`
    else fromTitle++ // be honest in the summary instead of silently using the title
    const name = applyTemplate(settings.template, { source: sourceName, type: a.type, date: new Date(), n })
    try {
      await adapter.renameArtifact(a.id!, name)
      ok++
      await sleep(400)
    } catch {
      // Still generating or the rename didn't stick - queue it; the background
      // loop retries every ~25s and survives page reloads.
      if (notebookId) {
        await batchRunner.queueRename(notebookId, a.id!, name)
        queued++
      }
    }
  }
  await adapter.forceCloseDialogs()
  adapter.setOverlaysHidden(false)
  const bits = [`Renamed ${ok}/${items.length}`]
  if (queued > 0) bits.push(`${queued} queued (applies automatically when ready)`)
  if (fromTitle > 0) bits.push(`${fromTitle} used the current title (sources unreadable)`)
  if (skippedGen > 0) bits.push(`${skippedGen} still generating \u2014 skipped`)
  toast(bits.join(", "))
  clearSelection()
}

async function bulkDelete(): Promise<void> {
  const items = adapter.listArtifacts().filter((a) => a.id && selectedArtifacts.has(a.id))
  const names = items.map((a) => `\u2022 ${a.title}`).join("\n")
  if (!window.confirm(`Delete ${items.length} Studio item(s)?\n\n${names}`)) return
  let ok = 0
  for (const a of items) {
    try {
      await adapter.deleteArtifact(a.id!)
      ok++
      await sleep(500)
    } catch (e) {
      toast(`Delete failed for \u201c${a.title}\u201d: ${(e as Error).message}`)
    }
  }
  toast(`Deleted ${ok}/${items.length}`)
  clearSelection()
}

// ================= Batch generate =================

function ensureBatchButton(): void {
  if (!settings?.features.batchGenerate) return
  const hosts = $$(SEL.createButtonHost)
  if (hosts.length === 0 || $("#nblmqol-batchbtn")) return
  const grid = hosts[0].parentElement
  if (!grid) return
  const b = document.createElement("button")
  b.id = "nblmqol-batchbtn"
  b.type = "button"
  b.textContent = "\u26a1 Batch generate\u2026"
  b.title = "Generate one Studio item per source (NotebookLM QoL)"
  b.addEventListener("click", () => {
    openBatchModal().catch((e) => toast((e as Error).message))
  })
  grid.after(b)
}

async function openBatchModal(): Promise<void> {
  $("#nblmqol-modal")?.remove()
  const sources = adapter.listSources().filter((s) => s.title)
  const types = adapter.listCreateOptions()
  if (sources.length === 0) {
    toast("No sources found in this notebook.")
    return
  }

  const overlay = el("div", "", "")
  overlay.id = "nblmqol-modal"
  const card = el("div", "nblmqol-card", "")
  overlay.appendChild(card)
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove()
  })

  card.appendChild(el("h3", "", "Batch generate \u2014 one per source"))

  // type picker
  const typeRow = el("div", "nblmqol-row", "")
  typeRow.appendChild(el("label", "", "Type"))
  const select = document.createElement("select")
  for (const t of types) {
    const o = document.createElement("option")
    o.value = t.label
    o.textContent = t.label
    select.appendChild(o)
  }
  // v0.6: remember the last chosen type - across notebooks.
  const lastType = await getLocal<string>(KEYS.lastType, "")
  if (lastType && types.some((t) => t.label === lastType)) select.value = lastType
  typeRow.appendChild(select)
  card.appendChild(typeRow)

  // Format options are chosen ONCE, in NotebookLM's own dialog, when the
  // first job starts - then applied automatically to every remaining job.
  card.appendChild(
    el(
      "p",
      "nblmqol-hint",
      "If this type has options (e.g. Deep Dive/Brief, Explainer/Short), NotebookLM's own dialog will open for the FIRST item \u2014 pick what you want and press Generate. Your picks are applied to the rest of the batch automatically.",
    ),
  )

  // source list - mirror the sources currently checked in the Sources panel
  const nativeChecked = sources.filter((s) => s.checked)
  const mirror = nativeChecked.length > 0 && nativeChecked.length < sources.length
  const listWrap = el("div", "nblmqol-sourcelist", "")
  const allRow = el("label", "nblmqol-source nblmqol-selectall", "")
  const allBox = document.createElement("input")
  allBox.type = "checkbox"
  allBox.checked = !mirror
  allRow.append(allBox, el("span", "", "Select all"))
  listWrap.appendChild(allRow)
  const rowBoxes: Array<{ box: HTMLInputElement; source: (typeof sources)[number] }> = []
  for (const s of sources) {
    const row = el("label", "nblmqol-source", "")
    const box = document.createElement("input")
    box.type = "checkbox"
    box.checked = mirror ? s.checked : true
    row.append(box, el("span", "", s.title))
    listWrap.appendChild(row)
    rowBoxes.push({ box, source: s })
  }
  const syncAllBox = () => {
    allBox.checked = rowBoxes.every((r) => r.box.checked)
  }
  allBox.addEventListener("change", () => rowBoxes.forEach((r) => (r.box.checked = allBox.checked)))
  rowBoxes.forEach((r) => r.box.addEventListener("change", syncAllBox))
  card.appendChild(listWrap)
  if (mirror) card.appendChild(el("p", "nblmqol-hint", "Pre-selected to match the sources checked in the Sources panel."))

  // rename toggle (remembers your last choice)
  const renamePref = await getLocal<boolean>(KEYS.renamePref, true)
  const renameRow = el("label", "nblmqol-row nblmqol-toggle", "")
  const renameBox = document.createElement("input")
  renameBox.type = "checkbox"
  renameBox.checked = renamePref
  renameRow.append(renameBox, el("span", "", `Rename results using template (\u201c${settings.template}\u201d)`))
  card.appendChild(renameRow)

  card.appendChild(
    el(
      "p",
      "nblmqol-hint",
      "Jobs start one at a time; generation continues in NotebookLM's own queue. Keep this tab open while jobs are being started. You can stop a running batch from the queue panel.",
    ),
  )

  const actions = el("div", "nblmqol-actions", "")
  actions.append(
    btn("Cancel", () => overlay.remove(), "nblmqol-ghost"),
    btn("Start batch", async () => {
      const chosen = rowBoxes.filter((r) => r.box.checked).map((r) => ({
        id: r.source.id ?? r.source.title,
        title: r.source.title,
      }))
      if (chosen.length === 0) {
        toast("Pick at least one source.")
        return
      }
      const notebookId = adapter.currentNotebookId()
      if (!notebookId) {
        toast("Could not detect notebook id from URL.")
        return
      }
      await setLocal(KEYS.renamePref, renameBox.checked)
      await setLocal(KEYS.lastType, select.value)
      overlay.remove()
      try {
        await batchRunner.startNewBatch({
          notebookId,
          artifactType: select.value,
          sources: chosen,
          renameToSource: renameBox.checked,
          events: { onUpdate: renderQueuePanel, onNotice: toast },
        })
      } catch (e) {
        toast((e as Error).message)
      }
    }),
  )
  card.appendChild(actions)
  document.body.appendChild(overlay)
}

// ================= Queue panel =================

export function renderQueuePanel(batch: BatchState): void {
  let panel = $("#nblmqol-queue")
  const s = summary(batch)
  const finished = batch.status === "finished"
  const stopped = batch.status === "idle"
  if (!panel) {
    panel = document.createElement("div")
    panel.id = "nblmqol-queue"
    document.body.appendChild(panel)
  }
  panel.innerHTML = ""
  const head = el("div", "nblmqol-queue-head", "")
  const title = finished
    ? "Batch done"
    : stopped
      ? "Batch stopped"
      : batch.status === "paused_rate_limit"
        ? "Batch paused (rate limit)"
        : "Batch running\u2026"
  head.append(
    el("strong", "", title),
    el("span", "nblmqol-count", `${s.done}/${s.total} started${s.failed ? `, ${s.failed} failed` : ""}`),
  )
  const closeB = btn("\u2715", async () => {
    panel!.remove()
    if (finished || stopped) await batchRunner.clearBatch(batch.notebookId)
  }, "nblmqol-ghost")
  head.appendChild(closeB)
  panel.appendChild(head)

  const list = el("div", "nblmqol-queue-list", "")
  for (const j of batch.jobs) {
    const row = el("div", `nblmqol-job nblmqol-${j.state}`, "")
    const icon = j.state === "done" ? "\u2713" : j.state === "failed" ? "\u2717" : j.state === "generating" ? "\u25cf" : "\u25cb"
    row.append(el("span", "nblmqol-job-icon", icon), el("span", "nblmqol-job-title", j.sourceTitle))
    if (j.error && j.state === "failed") row.title = j.error
    list.appendChild(row)
  }
  panel.appendChild(list)

  if (batch.status === "running" && batchRunner.isRunning()) {
    panel.appendChild(
      btn("Stop after current job", () => {
        batchRunner.requestCancel()
        toast("Stopping after the current job\u2026")
      }, "nblmqol-danger"),
    )
  }

  if (batch.status === "paused_rate_limit" || (stopped && s.pending > 0)) {
    panel.appendChild(
      btn("Resume", async () => {
        try {
          const saved = (await batchRunner.loadSavedBatch(batch.notebookId)) ?? batch
          await batchRunner.resumeBatch(saved, { onUpdate: renderQueuePanel, onNotice: toast })
        } catch (e) {
          toast((e as Error).message)
        }
      }),
    )
  }
}

/** Offer to resume an interrupted batch after a reload. */
export async function offerResumeIfNeeded(): Promise<void> {
  const notebookId = adapter.currentNotebookId()
  if (!notebookId) return
  const saved = await batchRunner.loadSavedBatch(notebookId)
  if (!saved) return
  const s = summary(saved)
  if (saved.status === "finished" || s.pending + s.generating === 0) return
  renderQueuePanel({ ...saved, status: "idle" })
}

// ================= Source panel bulk bar =================

export function ensureSourceUi(): void {
  if (!settings?.features.sourceBulk) return
  const sources = adapter.listSources()
  const checkedCount = sources.filter((s) => s.checked).length
  let bar = $("#nblmqol-srcbar")
  const show = sources.length > 0 && checkedCount > 0
  if (!show) {
    if (bar && !bar.dataset.dupes) bar.remove()
    return
  }
  // Same anti-click-eating rule as the bulk bar: never rebuild unchanged UI.
  const sig = `${checkedCount}/${sources.length}`
  if (bar && bar.dataset.sig === sig) return
  if (!bar) {
    bar = document.createElement("div")
    bar.id = "nblmqol-srcbar"
    document.body.appendChild(bar)
  }
  bar.dataset.sig = sig
  delete bar.dataset.dupes
  bar.innerHTML = ""
  bar.append(
    el("span", "nblmqol-count", `${checkedCount} source(s) checked`),
    btn("Delete checked", () => bulkDeleteSources(), "nblmqol-danger"),
    btn("Find duplicates", () => showDuplicates(), "nblmqol-ghost"),
  )
}

// v0.6: the v0.5 header above the Sources list was removed again - NotebookLM
// already has its own "Select all sources" checkbox, and the floating bar
// already offers Delete checked / Find duplicates. One menu is enough.

async function bulkDeleteSources(): Promise<void> {
  const chosen = adapter.listSources().filter((s) => s.checked)
  const names = chosen.map((s) => `\u2022 ${s.title}`).join("\n")
  if (!window.confirm(`Remove ${chosen.length} source(s) from this notebook?\n\n${names}`)) return
  let ok = 0
  for (const s of chosen) {
    try {
      await adapter.deleteSource(s.id ?? s.title)
      ok++
      await sleep(600)
    } catch (e) {
      toast(`Failed on \u201c${s.title}\u201d: ${(e as Error).message}`)
    }
  }
  toast(`Removed ${ok}/${chosen.length} source(s)`)
}

async function showDuplicates(): Promise<void> {
  const sources = adapter.listSources()
  const groups = findDuplicateGroups(
    sources.map((s) => ({ id: s.id ?? s.title, title: s.title })),
  )
  if (groups.length === 0) {
    toast("No duplicate sources found (by title).")
    return
  }
  const names: string[] = []
  const toDelete: string[] = []
  for (const g of groups) {
    for (const dup of g.sources.slice(1)) {
      toDelete.push(dup.id)
      names.push(`\u2022 ${dup.title}`)
    }
  }
  if (!window.confirm(`Found ${groups.length} duplicate group(s). Remove ${toDelete.length} duplicate(s), keeping the first of each?\n\n${names.join("\n")}`)) return
  let ok = 0
  for (const id of toDelete) {
    try {
      await adapter.deleteSource(id)
      ok++
      await sleep(600)
    } catch (e) {
      toast((e as Error).message)
    }
  }
  toast(`Removed ${ok}/${toDelete.length} duplicate(s)`)
}

// ================= tiny helpers =================

function el(tag: string, cls: string, text: string): HTMLElement {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

function btn(label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = document.createElement("button")
  b.type = "button"
  b.className = `nblmqol-btn ${cls}`.trim()
  b.textContent = label
  b.addEventListener("click", onClick)
  return b
}

let toastTimer: number | undefined
export function toast(msg: string): void {
  let t = $("#nblmqol-toast")
  if (!t) {
    t = document.createElement("div")
    t.id = "nblmqol-toast"
    document.body.appendChild(t)
  }
  t.textContent = msg
  t.classList.add("nblmqol-show")
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t!.classList.remove("nblmqol-show"), 4000) as unknown as number
}
