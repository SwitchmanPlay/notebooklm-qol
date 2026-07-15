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
import * as registry from "./registry.ts"

// v1.1: user feedback for split mode (armed via the batch modal, executed by
// the MAIN-world interceptor when the user presses Generate in NotebookLM's
// own dialog). `toast` is a hoisted function declaration, so this is safe.
window.addEventListener("nblmqol-split-start", (e: Event) => {
  const k = (((e as CustomEvent).detail?.sourceIds ?? []) as string[]).length
  if (k > 1) {
    toast(`\u26a1 Splitting your request into ${k} per-source generations\u2026`)
    showNetBatchPanel(k)
  }
})
window.addEventListener("nblmqol-split-done", (e: Event) => {
  const d = ((e as CustomEvent).detail ?? {}) as { succeeded?: number; total?: number; aborted?: boolean }
  removeNetBatchPanel()
  if (d.aborted)
    toast(
      `Batch cancelled \u2014 ${d.succeeded ?? 0}/${d.total ?? 0} request(s) had already been sent (those keep generating and still get renamed).`,
    )
  else if ((d.total ?? 0) > 1) toast(`\u26a1 Started ${d.succeeded}/${d.total} generations. Renames apply automatically as items finish.`)
})

// v1.3: while the fan-out is running (requests go out ~1.5s apart) show a
// small bottom-right panel with a Cancel button - previously there was no way
// to stop a batch once Generate was pressed.
function showNetBatchPanel(total: number): void {
  removeNetBatchPanel()
  const panel = el("div", "", "")
  panel.id = "nblmqol-netbatch"
  panel.append(
    el("span", "", `\u26a1 Batch: sending ${total} generation requests\u2026`),
    btn(
      "Cancel remaining",
      () => {
        window.dispatchEvent(new CustomEvent("nblmqol-split-abort"))
        removeNetBatchPanel()
      },
      "nblmqol-danger",
    ),
  )
  document.body.appendChild(panel)
  // Safety net: the send window is short - never leave the panel up forever.
  window.setTimeout(removeNetBatchPanel, 3 * 60 * 1000)
}

function removeNetBatchPanel(): void {
  document.getElementById("nblmqol-netbatch")?.remove()
}

// v1.2.1: timestamp of the most recent split start, tracked at module scope.
// The dialog-cancel watchdog previously attached its own one-shot listener,
// which MISSED splits that started before it was attached (fast Generate
// presses, dialog-less types) and falsely cancelled running batches mid
// fan-out - disarming auto-rename and leaving the remaining items unnamed.
let lastSplitStartAt = 0
window.addEventListener("nblmqol-split-start", () => {
  lastSplitStartAt = Date.now()
})

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
    for (const p of $$(".nblmqol-padscroll")) p.classList.remove("nblmqol-padscroll")
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
      // v1.1: renaming by source works again - source ids now come from the
      // network registry instead of the flaky "View prompt & sources" dialog.
      ...(ENABLE_BULK_RENAME ? [btn("Rename by source", () => bulkRename(), "nblmqol-teal")] : []),
      btn("Delete", () => bulkDelete(), "nblmqol-danger"),
      btn("\u2715", () => clearSelection(), "nblmqol-ghost"),
    )
    bar.append(count, actions)
    document.body.appendChild(bar)
  }
  updateBulkBar()
  padStudioList()
}

/**
 * v1.2.1: the floating bulk bar covered the last output rows, so the bottom
 * item was invisible/unselectable. Give the Studio scroll container extra
 * bottom padding whenever the bar is visible, so the last items can scroll
 * up above the bar. Idempotent: re-applied on every observer tick because
 * Angular re-renders the container.
 */
function padStudioList(): void {
  const bar = $("#nblmqol-bulkbar")
  const item = $(SEL.artifactItem)
  let target: HTMLElement | null = null
  if (bar && item) {
    let n: HTMLElement | null = item.parentElement
    while (n && n !== document.body) {
      const cs = getComputedStyle(n)
      if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
        target = n
        break
      }
      n = n.parentElement
    }
    if (!target) target = item.parentElement
  }
  for (const p of $$(".nblmqol-padscroll")) if (p !== target) p.classList.remove("nblmqol-padscroll")
  target?.classList.add("nblmqol-padscroll")
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
    // v1.3: network-first download. NotebookLM's own poll responses carry a
    // direct file URL for audio / video / infographic / slide deck outputs -
    // downloading that URL via chrome.downloads is instant (no menu clicks)
    // and keeps working while rows re-render.
    const reg = registry.get(id)
    if (reg?.downloadUrl && reg.status === "completed") {
      const name = a?.title || reg.title || "NotebookLM output"
      const resp = await new Promise<{ ok?: boolean; error?: string } | undefined>((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: "directDownload", url: reg.downloadUrl, name }, (r: any) => {
            void chrome.runtime.lastError // swallow "context invalidated" style errors
            resolve(r)
          })
        } catch {
          resolve(undefined)
        }
      })
      if (resp?.ok) {
        ok++
        if (i < ids.length) await sleep(500) // the fast path needs no menu-dance breathing room
        continue
      }
      // Direct download failed - fall through to the click path below.
    }
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

// v1.1: back ON. Renaming EXISTING outputs no longer opens any dialog - the
// MAIN-world interceptor reads each output's source ids straight from
// NotebookLM's own network responses (see interceptor.ts / registry.ts).
const ENABLE_BULK_RENAME = true

async function bulkRename(): Promise<void> {
  const all = adapter.listArtifacts().filter((a) => a.id && selectedArtifacts.has(a.id))
  // Still-generating outputs can't be renamed yet - skip them up front
  // (reselect them once they finish).
  const items = all.filter((a) => !/^generating\b/i.test(a.title))
  const skippedGen = all.length - items.length
  if (items.length === 0) {
    toast("All selected outputs are still generating \u2014 try again when they finish.")
    return
  }
  // v1.1: source names come from the network registry (registry.ts) - no
  // dialogs are opened anymore. The interceptor loads at document_start, so if
  // nothing was captured yet a reload fixes it.
  if (registry.size() === 0) {
    toast("No source data captured yet \u2014 reload the page, let the outputs list load, then try again.")
    return
  }
  // Guard against accidental "rename all 37 outputs" clicks.
  if (
    items.length > 3 &&
    !window.confirm(
      `Rename ${items.length} outputs to their source names using the template \u201c${settings.template}\u201d?\n\nQueued renames keep applying even after a reload \u2014 you can cancel them from the header above the outputs list.`,
    )
  )
    return
  const notebookId = adapter.currentNotebookId()
  // v1.2: let the Studio list settle before touching it - renaming while rows
  // re-render was the main source of missed/odd renames.
  await adapter.waitForStableArtifacts().catch(() => undefined)
  let n = 0
  let ok = 0
  let queued = 0
  let fromTitle = 0
  for (const a of items) {
    n++
    let sourceName = a.title
    const srcs = registry.sourceNamesFor(a.id!)
    if (srcs && srcs.length > 0) sourceName = srcs.length === 1 ? srcs[0] : `${srcs[0]} +${srcs.length - 1}`
    else fromTitle++ // be honest in the summary instead of silently using the title
    const name = applyTemplate(settings.template, { source: sourceName, type: a.type, date: new Date(), n })
    console.info(`[nblm-qol][rename] ${n}/${items.length} id=${a.id} "${a.title}" sources=${JSON.stringify(srcs)} -> "${name}"`)
    try {
      await adapter.renameArtifact(a.id!, name)
      ok++
      await sleep(600)
    } catch (e1) {
      // v1.2: one immediate retry after letting the list settle - a mid-rename
      // re-render was the main cause of "selected three, renamed one".
      console.warn(`[nblm-qol][rename] attempt 1 failed for "${name}": ${(e1 as Error).message} - retrying once`)
      await sleep(1200)
      try {
        await adapter.renameArtifact(a.id!, name)
        ok++
        await sleep(600)
      } catch (e2) {
        console.warn(`[nblm-qol][rename] attempt 2 failed for "${name}": ${(e2 as Error).message} - queueing`)
        // Queue it; the background loop retries every ~25s, survives reloads.
        if (notebookId) {
          await batchRunner.queueRename(notebookId, a.id!, name)
          queued++
        }
      }
    }
  }
  const bits = [`Renamed ${ok}/${items.length}`]
  if (queued > 0) bits.push(`${queued} queued (applies automatically when ready)`)
  if (fromTitle > 0) bits.push(`${fromTitle} kept their current title (source not in the registry)`)
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

  // v1.2: everything is configured ONCE in NotebookLM's own dialog - format,
  // language, custom prompt. The single Generate press is then split into one
  // request per source at the network level.
  card.appendChild(
    el(
      "p",
      "nblmqol-hint",
      "After Start batch, NotebookLM's own options dialog opens ONCE. Everything you set there \u2014 format, language, custom prompt (focus, topic, slide deck description\u2026) \u2014 applies to EVERY item: your single Generate press is split into one generation per source.",
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

  // v1.2: the old click-driven engine stays available as a fallback while the
  // network engine is being field-tested.
  const legacyRow = el("label", "nblmqol-row nblmqol-toggle", "")
  const legacyBox = document.createElement("input")
  legacyBox.type = "checkbox"
  legacyBox.checked = false
  legacyRow.append(legacyBox, el("span", "", "Legacy mode (old click engine \u2014 only if the new mode fails; no language/custom prompt support)"))
  card.appendChild(legacyRow)

  card.appendChild(
    el(
      "p",
      "nblmqol-hint",
      "Requests are sent ~1.5s apart; generation continues in NotebookLM's own queue. Closing the options dialog without pressing Generate cancels the batch.",
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
      const legacy = legacyBox.checked
      overlay.remove()

      if (legacy) {
        // Old v1.0 engine: click-driven, replays recorded Format picks per job.
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
        return
      }

      // v1.2 unified network batch: check the chosen sources, arm the split,
      // then open NotebookLM's own dialog ONCE. Format, language and custom
      // prompt all ride along in the real request, so they apply to every
      // per-source generation.
      try {
        console.info(`[nblm-qol][batch] network batch: type="${select.value}" sources=${chosen.length}`, chosen.map((c) => c.title))
        await adapter.applySourceSelection(new Set(chosen.map((c) => c.id)))
        if (renameBox.checked) registry.armAutoRename(notebookId, settings.template, select.value)
        else registry.disarmAutoRename()
        const armedAt = Date.now()
        window.dispatchEvent(new CustomEvent("nblmqol-mode", { detail: { split: true } }))
        const res = await adapter.openOptionsDialog(select.value)
        if (res.opened) {
          toast(
            `Set the options, language and custom prompt for ${select.value}, then press Generate ONCE \u2014 it runs once per source (${chosen.length}). Closing the dialog cancels.`,
          )
          watchDialogForCancel(res.dialog!, armedAt)
        } else {
          toast(`${select.value} has no options dialog \u2014 splitting into ${chosen.length} per-source generations\u2026`)
        }
      } catch (e) {
        // Disarm everything - never leave a stray split waiting.
        window.dispatchEvent(new CustomEvent("nblmqol-mode", { detail: { split: false } }))
        registry.disarmAutoRename()
        toast((e as Error).message)
      }
    }),
  )
  card.appendChild(actions)
  document.body.appendChild(overlay)
}

/**
 * v1.2: if the user closes NotebookLM's options dialog WITHOUT pressing
 * Generate, disarm the split so it can never hijack a later, unrelated
 * generation. A short grace period covers the normal case where the creation
 * request fires just as the dialog closes.
 */
function watchDialogForCancel(dlg: HTMLElement, armedAt: number): void {
  const watch = setInterval(() => {
    if (document.contains(dlg)) return // still open
    clearInterval(watch)
    setTimeout(() => {
      // v1.2.1: compare against the module-scope timestamp instead of a
      // per-watch listener - a split that started at ANY point after arming
      // (even before this watchdog was attached) means the batch is running.
      if (lastSplitStartAt >= armedAt) return
      console.info("[nblm-qol][batch] dialog closed without generating - batch cancelled")
      window.dispatchEvent(new CustomEvent("nblmqol-mode", { detail: { split: false } }))
      registry.disarmAutoRename()
      toast("Batch cancelled \u2014 the dialog was closed without generating.")
    }, 2000)
  }, 500)
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
  // v1.3: collapse the panel off-screen to the right; a small edge tab brings it back.
  const collapseB = btn(
    "\u00bb",
    () => {
      queueCollapsed = true
      applyQueueCollapsed()
    },
    "nblmqol-ghost",
  )
  collapseB.title = "Hide panel (a small tab stays on the right edge)"
  const closeB = btn("\u2715", async () => {
    panel!.remove()
    document.getElementById("nblmqol-queue-tab")?.remove()
    if (finished || stopped) await batchRunner.clearBatch(batch.notebookId)
  }, "nblmqol-ghost")
  head.append(collapseB, closeB)
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
  applyQueueCollapsed()
}

// v1.3: the queue panel can be swiped away to the right; a small edge tab
// reopens it. The flag lives at module scope so re-renders while the batch
// keeps running preserve the collapsed state.
let queueCollapsed = false

function applyQueueCollapsed(): void {
  const panel = $("#nblmqol-queue")
  if (!panel) return
  panel.classList.toggle("nblmqol-queue-collapsed", queueCollapsed)
  let tab = document.getElementById("nblmqol-queue-tab")
  if (queueCollapsed && !tab) {
    tab = el("button", "", "\u00ab Batch")
    tab.id = "nblmqol-queue-tab"
    tab.onclick = () => {
      queueCollapsed = false
      applyQueueCollapsed()
    }
    document.body.appendChild(tab)
  } else if (!queueCollapsed) {
    tab?.remove()
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
