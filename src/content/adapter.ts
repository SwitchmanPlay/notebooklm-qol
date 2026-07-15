/**
 * Adapter layer: every NotebookLM action the extension performs, implemented
 * via DOM automation. If NotebookLM's UI changes, fix selectors.ts / this file
 * only. Every public function throws with a readable message on failure so the
 * queue can mark jobs failed instead of hanging.
 */
import { SEL, LABELS, ICON_TO_TYPE, sourceIdFromMoreButton, artifactIdFromLabels } from "./selectors.ts"
import { $, $$, waitFor, sleep, textOf, textWithoutIcons, setInputValue, pressKey, pressEscapeCompat, isVisible, realClick } from "./dom.ts"

export type SourceInfo = {
  id: string | null
  title: string
  row: HTMLElement
  checkbox: HTMLInputElement | null
  checked: boolean
}

export type ArtifactInfo = {
  id: string | null
  title: string
  type: string
  el: HTMLElement
}

// ---------------- Sources ----------------

export function listSources(): SourceInfo[] {
  return $$(SEL.sourceRow).map((row) => {
    const more = $(SEL.sourceMoreButton, row)
    const checkbox = $(SEL.sourceCheckboxInput, row) as HTMLInputElement | null
    return {
      id: sourceIdFromMoreButton(more?.id),
      title: textOf($(SEL.sourceRowTitle, row)),
      row,
      checkbox,
      checked: checkbox?.checked ?? false,
    }
  })
}

function findSource(idOrTitle: string): SourceInfo | null {
  const all = listSources()
  return all.find((s) => s.id === idOrTitle) ?? all.find((s) => s.title === idOrTitle) ?? null
}

/** Make sure exactly the given sources are checked (by id, falling back to title). */
export async function applySourceSelection(wanted: Set<string>): Promise<void> {
  for (const s of listSources()) {
    const want = (s.id != null && wanted.has(s.id)) || wanted.has(s.title)
    if (s.checkbox && s.checkbox.checked !== want) {
      s.checkbox.click()
      await sleep(60)
    }
  }
  // verify
  const bad = listSources().filter((s) => {
    const want = (s.id != null && wanted.has(s.id)) || wanted.has(s.title)
    return (s.checkbox?.checked ?? false) !== want
  })
  if (bad.length > 0) throw new Error(`Could not set selection for: ${bad.map((b) => b.title).join(", ")}`)
}

export async function deleteSource(idOrTitle: string): Promise<void> {
  const s = findSource(idOrTitle)
  if (!s) throw new Error(`Source not found: ${idOrTitle}`)
  const more = $(SEL.sourceMoreButton, s.row)
  if (!more) throw new Error(`No menu button on source: ${s.title}`)
  const menu = await openMenu(more)
  await clickMenuItem(menu, LABELS.sourceRemove)
  await confirmDialogIfAny()
  // wait until the row is gone
  await waitFor(() => !document.contains(s.row) || !isVisible(s.row), {
    timeoutMs: 8000,
    what: `source "${s.title}" to disappear`,
  })
}

// ---------------- Studio artifacts ----------------

export function listArtifacts(): ArtifactInfo[] {
  return $$(SEL.artifactItem).map((el) => {
    const labels = $(SEL.artifactLabels, el)
    const icon = textOf($(SEL.artifactIcon, el))
    return {
      id: artifactIdFromLabels(labels?.id),
      title: textOf($(SEL.artifactTitle, el)),
      type: ICON_TO_TYPE[icon] ?? icon ?? "Artifact",
      el,
    }
  })
}

export function artifactIds(): Set<string> {
  return new Set(listArtifacts().map((a) => a.id).filter((x): x is string => !!x))
}

export function findArtifact(id: string): ArtifactInfo | null {
  return listArtifacts().find((a) => a.id === id) ?? null
}

/**
 * Wait until no new artifacts have appeared for `stableMs`. Prevents a late
 * artifact from a previous generation being attributed to the next job
 * (which crossed renames in v0.1).
 */
export async function waitForStableArtifacts(stableMs = 2500, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  let last = artifactIds()
  let lastChange = Date.now()
  for (;;) {
    await sleep(500)
    const now = artifactIds()
    const changed = now.size !== last.size || [...now].some((id) => !last.has(id))
    if (changed) {
      last = now
      lastChange = Date.now()
    } else if (Date.now() - lastChange >= stableMs) {
      return
    }
    if (Date.now() - start > timeoutMs) return // best effort
  }
}

async function openArtifactMenu(a: ArtifactInfo): Promise<HTMLElement> {
  // The actions container may only render on hover; dispatch mouseover first.
  a.el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }))
  a.el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
  const more = await waitFor(() => {
    const actions = $(SEL.artifactActions, a.el) ?? a.el
    return $(SEL.artifactMoreButton, actions)
  }, { timeoutMs: 4000, what: `menu button on "${a.title}"` })
  return openMenu(more)
}

const normalizeTitle = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase()

export async function renameArtifact(id: string, newName: string): Promise<void> {
  const a = findArtifact(id)
  if (!a) throw new Error(`Artifact not found: ${id}`)
  const menu = await openArtifactMenu(a)
  const clicked = await clickMenuItemOptional(menu, LABELS.artifactRename)
  if (!clicked) {
    await closeMenus()
    throw new Error(`Rename not available yet for "${a.title}" (probably still generating)`)
  }
  // v1.2: re-find the row fresh on every tick - `a.el` can be a stale,
  // detached node if the list re-rendered right after the menu click. This
  // silently broke renames ("selected three, only one got renamed").
  const input = (await waitFor(() => {
    const now = findArtifact(id)
    return now ? $(SEL.artifactTitleInput, now.el) : null
  }, {
    timeoutMs: 5000,
    what: "inline rename input",
  })) as HTMLInputElement
  input.focus()
  setInputValue(input, newName)
  pressKey(input, "Enter")
  input.blur()
  // Wait for the inline input to close and the title to settle. Right after
  // Enter, Angular briefly renders an empty/old title - that is NOT a failure.
  try {
    await waitFor(() => {
      const now = findArtifact(id)
      if (!now) return false // list may be partially re-rendered - keep waiting, never assume success
      if ($(SEL.artifactTitleInput, now.el)) return false // still editing
      return normalizeTitle(now.title) === normalizeTitle(newName)
    }, { timeoutMs: 6000, intervalMs: 300, what: "rename to commit" })
  } catch {
    const now = findArtifact(id)
    console.warn(`[nblm-qol] rename didn't stick (will retry): wanted "${newName}", got "${now?.title ?? "?"}"`)
    throw new Error(`Rename did not stick for "${newName}"`)
  }
}

export async function downloadArtifact(id: string): Promise<void> {
  const a = findArtifact(id)
  if (!a) throw new Error(`Artifact not found: ${id}`)
  const menu = await openArtifactMenu(a)
  const clicked = await clickMenuItemOptional(menu, LABELS.artifactDownload)
  if (!clicked) {
    await closeMenus()
    throw new Error(`No Download option for "${a.title}" (${a.type})`)
  }
}

export async function deleteArtifact(id: string): Promise<void> {
  const a = findArtifact(id)
  if (!a) throw new Error(`Artifact not found: ${id}`)
  const menu = await openArtifactMenu(a)
  await clickMenuItem(menu, LABELS.artifactDelete)
  await confirmDialogIfAny()
  await waitFor(() => !findArtifact(id), { timeoutMs: 8000, what: `artifact "${a.title}" to disappear` })
}

// ---------------- Generation ----------------

export type CreateOption = { label: string; el: HTMLElement }

/** Enumerate the Studio "create" buttons dynamically (never hardcode the list). */
export function listCreateOptions(): CreateOption[] {
  const out: CreateOption[] = []
  for (const host of $$(SEL.createButtonHost)) {
    const btn = $(SEL.createButton, host)
    const label = btn?.getAttribute("aria-label") ?? textOf(btn)
    if (btn && label) out.push({ label, el: btn })
  }
  return out
}

async function waitForNewArtifact(before: Set<string>, typeLabel: string, timeoutMs = 90_000): Promise<string> {
  return waitFor(
    () => {
      const err = detectRateLimit()
      if (err) throw new Error(err)
      for (const id of artifactIds()) if (!before.has(id)) return id
      return null
    },
    { timeoutMs, intervalMs: 400, what: `new ${typeLabel} to appear in Studio` },
  )
}

// ---- Generation: "choose options once, apply to all" ----

export type DialogChoices = Record<string, string>

/**
 * Click the create button for the given type. If NotebookLM opens an options
 * dialog:
 *  - with recorded `choices`: apply them and press Generate automatically;
 *  - with `choices === null` (first job of a batch): leave the dialog to the
 *    USER, record what they pick, and return the picks so the caller can
 *    reuse them for the remaining jobs.
 */
export async function generateArtifactInteractive(
  typeLabel: string,
  choices: DialogChoices | null,
  onWaitingForUser?: () => void,
): Promise<{ id: string; recordedChoices: DialogChoices | null }> {
  const opt = listCreateOptions().find((o) => o.label.toLowerCase() === typeLabel.toLowerCase())
  if (!opt) throw new Error(`Create button not found for type: ${typeLabel}`)
  const before = artifactIds()

  // v0.5: some types (Audio Overview, Mind Map) start generating IMMEDIATELY
  // from the plain create tile and never show options - their options live
  // behind a separate "Customize <type>" pencil button. So whenever we want a
  // dialog (first job, or replaying recorded picks), prefer that button.
  const wantsDialog = choices === null || Object.keys(choices).length > 0
  const customize = wantsDialog ? findCustomizeButton(typeLabel) : null

  const openDialogWith = async (trigger: HTMLElement, timeoutMs: number): Promise<HTMLElement | null> => {
    const dialogsBefore = new Set($$(SEL.dialogContainer))
    realClick(trigger)
    try {
      return await waitFor(
        () => $$(SEL.dialogContainer).find((d) => !dialogsBefore.has(d) && isVisible(d)) ?? null,
        { timeoutMs, what: "options dialog" },
      )
    } catch {
      return null // no dialog appeared
    }
  }

  let dlg: HTMLElement | null = null
  if (customize) {
    dlg = await openDialogWith(customize, 5000)
    if (!dlg) {
      console.warn(`[nblm-qol] ${typeLabel}: Customize button opened no dialog - using the plain create button`)
      dlg = await openDialogWith(opt.el, 3000)
    }
  } else {
    dlg = await openDialogWith(opt.el, 3000)
  }
  if (!dlg) console.info(`[nblm-qol] ${typeLabel}: no options dialog - NotebookLM generates this type with defaults`)

  let recorded: DialogChoices | null = null
  if (dlg) {
    await waitForDialogControls(dlg)
    let auto = false
    if (choices !== null) {
      applyChoices(dlg, choices)
      await sleep(300)
      auto = clickGenerateIn(dlg)
      if (!auto) {
        await sleep(800)
        auto = clickGenerateIn(dlg)
      }
    }
    if (auto) {
      console.info(`[nblm-qol] ${typeLabel}: applied recorded options and pressed Generate`, choices)
      await waitFor(() => (!document.contains(dlg!) || !isVisible(dlg!) ? true : null), {
        timeoutMs: 8000,
        what: "options dialog to close",
      }).catch(() => undefined)
    } else {
      // First job (or the Generate button wasn't found): hand over to the user.
      onWaitingForUser?.()
      console.info(`[nblm-qol] ${typeLabel}: waiting for you to confirm the options dialog`)
      recorded = await recordChoicesUntilClosed(dlg)
      console.info(`[nblm-qol] ${typeLabel}: recorded options`, recorded)
    }
  }
  // v0.6: if the USER closed the dialog without pressing Generate, no
  // artifact will ever appear. A real generation shows its placeholder row
  // within a few seconds, so a short wait is enough to tell them apart -
  // instead of blocking the queue for 90s and leaving the batch "running".
  let id: string
  if (recorded !== null) {
    try {
      id = await waitForNewArtifact(before, typeLabel, 15_000)
    } catch {
      throw new Error("BATCH_CANCELLED: the options dialog was closed without generating")
    }
  } else {
    id = await waitForNewArtifact(before, typeLabel)
  }
  return { id, recordedChoices: recorded }
}

/**
 * v1.2 (unified network batch): open NotebookLM's own options dialog for a
 * type and hand it ENTIRELY to the user - nothing is recorded or replayed.
 * The armed network interceptor splits the user's single Generate press into
 * one request per checked source, so format, language and custom prompts all
 * apply to every item.
 *
 * Returns whether a dialog opened, plus the dialog element so the caller can
 * watch for "closed without generating". For dialog-less types the plain
 * create button starts generation immediately (the interceptor must already
 * be armed BEFORE calling this).
 */
export async function openOptionsDialog(typeLabel: string): Promise<{ opened: boolean; dialog: HTMLElement | null }> {
  const opt = listCreateOptions().find((o) => o.label.toLowerCase() === typeLabel.toLowerCase())
  if (!opt) throw new Error(`Create button not found for type: ${typeLabel}`)
  const customize = findCustomizeButton(typeLabel)
  const openDialogWith = async (trigger: HTMLElement, timeoutMs: number): Promise<HTMLElement | null> => {
    const dialogsBefore = new Set($$(SEL.dialogContainer))
    realClick(trigger)
    try {
      return await waitFor(
        () => $$(SEL.dialogContainer).find((d) => !dialogsBefore.has(d) && isVisible(d)) ?? null,
        { timeoutMs, what: "options dialog" },
      )
    } catch {
      return null
    }
  }
  let dlg: HTMLElement | null = null
  if (customize) {
    dlg = await openDialogWith(customize, 5000)
    if (!dlg) {
      console.warn(`[nblm-qol] ${typeLabel}: Customize button opened no dialog - using the plain create button`)
      dlg = await openDialogWith(opt.el, 3000)
    }
  } else {
    dlg = await openDialogWith(opt.el, 3000)
  }
  if (dlg) await waitForDialogControls(dlg).catch(() => undefined)
  else console.info(`[nblm-qol] ${typeLabel}: no options dialog - generation starts immediately with defaults`)
  return { opened: !!dlg, dialog: dlg }
}

/** The "Customize <type>" pencil next to a create tile (not every type has one). */
function findCustomizeButton(typeLabel: string): HTMLElement | null {
  const want = typeLabel.trim().toLowerCase()
  return (
    $$(SEL.customizeButton).find((b) => {
      const label = (b.getAttribute("aria-label") ?? "").trim().toLowerCase()
      return label === `customize ${want}` || label.endsWith(` ${want}`)
    }) ?? null
  )
}

/** Find and press the dialog's Generate/Create button (searches ALL buttons). */
function clickGenerateIn(dlg: HTMLElement): boolean {
  const candidates = $$("button", dlg).filter((b) => {
    const t = textWithoutIcons(b).toLowerCase()
    return !!t && LABELS.generate.some((g) => t === g || t.startsWith(`${g} `))
  })
  const gen = candidates[candidates.length - 1]
  if (gen) realClick(gen)
  return !!gen
}

/** Click the radio options matching previously recorded picks. */
function applyChoices(dlg: HTMLElement, choices: DialogChoices): void {
  const entries = Object.entries(choices)
  if (entries.length === 0) return
  const wrappers = $$(SEL.controlWrapper, dlg)
  for (const [group, value] of entries) {
    // Prefer the control group with the matching label; fall back to the
    // whole dialog if NotebookLM renamed its labels.
    const scope = wrappers.find((w) => textOf($(SEL.controlLabel, w)) === group) ?? dlg
    let done = false
    for (const radio of $$(SEL.radioButton, scope)) {
      if (textWithoutIcons(radio) !== value) continue
      const input = $('input[type="radio"]', radio) as HTMLInputElement | null
      if (!input?.checked) realClick(input ?? radio)
      done = true
      break
    }
    if (done) continue
    // v0.8: button-toggle groups (Length, Level of detail, Orientation...)
    for (const tog of $$("mat-button-toggle", scope)) {
      if (textWithoutIcons(tog) !== value) continue
      const btn = $("button", tog)
      const pressed =
        tog.classList.contains("mat-button-toggle-checked") || btn?.getAttribute("aria-pressed") === "true"
      if (!pressed) realClick(btn ?? tog)
      break
    }
  }
}

/** Snapshot the currently selected radio options, grouped by control label. */
function snapshotChoices(dlg: HTMLElement): DialogChoices {
  const out: DialogChoices = {}
  for (const input of $$('input[type="radio"]', dlg)) {
    if (!(input as HTMLInputElement).checked) continue
    const radio = input.closest("mat-radio-button") as HTMLElement | null
    const option = textWithoutIcons(radio ?? (input.parentElement as HTMLElement))
    const cw = input.closest(SEL.controlWrapper) as HTMLElement | null
    const group =
      (cw ? textOf($(SEL.controlLabel, cw)) : "") ||
      (input.closest('[role="radiogroup"]') as HTMLElement | null)?.getAttribute("aria-label") ||
      "Format"
    if (option) out[group] = option
  }
  // v0.8: "Length", "Level of detail", "Orientation" are mat-button-toggle
  // groups, NOT radios - they were silently never recorded before ("changed
  // length from default to short and it didn't apply").
  for (const tog of $$("mat-button-toggle", dlg)) {
    const btn = $("button", tog)
    const pressed =
      tog.classList.contains("mat-button-toggle-checked") || btn?.getAttribute("aria-pressed") === "true"
    if (!pressed) continue
    const option = textWithoutIcons(tog)
    const cw = tog.closest(SEL.controlWrapper) as HTMLElement | null
    const group = (cw ? textOf($(SEL.controlLabel, cw)) : "") || "Options"
    if (option) out[group] = option
  }
  return out
}

/** Poll the user's selections until the dialog closes (Generate pressed). */
async function recordChoicesUntilClosed(dlg: HTMLElement, timeoutMs = 300_000): Promise<DialogChoices> {
  const start = Date.now()
  let last: DialogChoices = {}
  while (document.contains(dlg) && isVisible(dlg)) {
    const snap = snapshotChoices(dlg)
    if (Object.keys(snap).length > 0) last = snap
    if (Date.now() - start > timeoutMs) throw new Error("Options dialog was left open too long - job skipped")
    await sleep(300)
  }
  return last
}

/**
 * NotebookLM renders a dialog's controls asynchronously - the container shows
 * up before the radio groups exist. Parsing too early was why v0.2 reported
 * "this type has no format options" for every type.
 */
async function waitForDialogControls(dlg: HTMLElement): Promise<void> {
  try {
    await waitFor(() => ($$(SEL.controlWrapper, dlg).length > 0 ? true : null), {
      timeoutMs: 5000,
      intervalMs: 150,
      what: "dialog controls",
    })
    await sleep(300) // let radio states settle
  } catch {
    // dialog genuinely has no controls
  }
}

/** Visually hide CDK overlays while we drive them programmatically. */
let overlayHideCount = 0
function hideOverlays(on: boolean): void {
  overlayHideCount = Math.max(0, overlayHideCount + (on ? 1 : -1))
  document.documentElement.classList.toggle("nblmqol-hide-overlays", overlayHideCount > 0)
}

/** Ref-counted overlay hiding for multi-step operations driven by ui.ts. */
export function setOverlaysHidden(on: boolean): void {
  hideOverlays(on)
}

/**
 * v0.7: force-close ANY visible Material dialog. A stuck "prompt & sources"
 * dialog blocks every later click and gets misread as the sources of the
 * NEXT artifact - the "renames everything to the same file" bug.
 */
export async function forceCloseDialogs(): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const open = $$("mat-dialog-container").filter(isVisible)
    if (open.length === 0) return true
    for (const dlg of open) {
      const close = $(SEL.dialogCloseButton, dlg)
      if (close) realClick(close)
    }
    await sleep(400)
    if (!$$("mat-dialog-container").some(isVisible)) return true
    pressEscapeCompat()
    await sleep(400)
    $(".cdk-overlay-backdrop")?.click()
    await sleep(300)
  }
  const stuck = $$("mat-dialog-container").some(isVisible)
  if (stuck) console.warn("[nblm-qol] a NotebookLM dialog refused to close")
  return !stuck
}

async function closeDialog(dlg: HTMLElement): Promise<void> {
  const gone = () => (!document.contains(dlg) || !isVisible(dlg) ? true : null)
  if (gone()) return
  // 1) The close button can render a moment after the dialog itself.
  try {
    const close = await waitFor(() => $(SEL.dialogCloseButton, dlg), { timeoutMs: 2500, what: "dialog close button" })
    realClick(close)
    await waitFor(gone, { timeoutMs: 2500, what: "dialog to close" })
    return
  } catch {
    /* fall through */
  }
  // 2) Escape with legacy keyCode (what Material's handler actually checks),
  // dispatched on the dialog itself so CDK's overlay keydown handler sees it.
  pressEscapeCompat(dlg)
  try {
    await waitFor(gone, { timeoutMs: 1500, what: "dialog to close" })
    return
  } catch {
    /* fall through */
  }
  // 3) Backdrop click as a last resort.
  $(".cdk-overlay-backdrop")?.click()
  try {
    await waitFor(gone, { timeoutMs: 1500, what: "dialog to close" })
  } catch {
    console.warn("[nblm-qol] could not close a NotebookLM dialog")
  }
}

/**
 * Read the real source names behind an artifact via its "View prompt and
 * sources" dialog. Works for outputs that predate the extension. Returns null
 * when the menu item or dialog is unavailable (e.g. still generating).
 */
export async function getArtifactSources(id: string): Promise<string[] | null> {
  const a = findArtifact(id)
  if (!a) return null
  // Still generating -> no menu, no sources. Bail out instead of timing out.
  if (/^generating\b/i.test(a.title)) return null
  hideOverlays(true)
  try {
    // v0.7: a dialog left over from a PREVIOUS item would be misread as this
    // artifact's sources ("renames the same file" bug) - close anything open.
    await forceCloseDialogs()
    // v0.9: DROPPED the "must be a brand-new dialog element" identity check.
    // When the dialog opens late (heavy notebooks) or Angular reuses the
    // element, that check rejected a perfectly good dialog forever - the
    // "Timed out waiting for prompt & sources dialog" loop. Instead we make
    // sure nothing is open BEFORE clicking, so any dialog that appears is ours.
    let dlg: HTMLElement | null = null
    for (let attempt = 0; attempt < 2 && !dlg; attempt++) {
      if (!(await forceCloseDialogs())) throw new Error("a stuck dialog would not close")
      await sleep(300)
      const menu = await openArtifactMenu(a)
      const clicked = await clickMenuItemOptional(menu, LABELS.artifactViewSources)
      if (!clicked) {
        await closeMenus()
        return null
      }
      try {
        dlg = await waitFor(() => $$(SEL.attributionDialog).find(isVisible) ?? null, {
          timeoutMs: attempt === 0 ? 12_000 : 20_000,
          what: "prompt & sources dialog",
        })
      } catch (e) {
        if (attempt === 1) throw e
        await closeMenus()
      }
    }
    if (!dlg) return null
    const dialog: HTMLElement = dlg
    // source chips render async, like everything else in this app
    try {
      await waitFor(() => ($$(SEL.attributionSourceTitle, dialog).length > 0 ? true : null), {
        timeoutMs: 4000,
        what: "source chips",
      })
    } catch {
      /* no chips - sources may have been removed from the notebook */
    }
    const titles = $$(SEL.attributionSourceTitle, dialog).map(textOf).filter(Boolean)
    await closeDialog(dialog)
    console.info("[nblm-qol] artifact sources:", titles)
    return titles
  } catch (e) {
    console.warn("[nblm-qol] could not read an artifact's sources:", e instanceof Error ? e.message : e)
    return null
  } finally {
    // v0.7: never unhide a STUCK dialog - it would sit over the page,
    // swallow every later click AND be misread as the next item's sources.
    await forceCloseDialogs()
    hideOverlays(false)
  }
}

export function detectRateLimit(): string | null {
  for (const el of $$(SEL.snackbarLabel)) {
    const t = textOf(el).toLowerCase()
    if (LABELS.rateLimit.some((k) => t.includes(k))) return `NotebookLM says: ${textOf(el)}`
  }
  return null
}

// ---------------- Menus & dialogs ----------------

async function openMenu(trigger: HTMLElement): Promise<HTMLElement> {
  // Material sometimes swallows the first click (e.g. it only dismisses a
  // lingering tooltip/ripple) - retry once before giving up.
  for (let attempt = 1; ; attempt++) {
    const panelsBefore = new Set($$(SEL.menuPanel))
    trigger.click()
    try {
      return await waitFor(
        () => $$(SEL.menuPanel).find((p) => !panelsBefore.has(p) && isVisible(p)) ?? null,
        { timeoutMs: attempt === 1 ? 2500 : 4000, what: "menu to open" },
      )
    } catch (e) {
      if (attempt >= 2) throw e
      await closeMenus()
      await sleep(400)
    }
  }
}

function menuItems(menu: HTMLElement): Array<{ el: HTMLElement; label: string }> {
  return $$(SEL.menuItem, menu).map((el) => ({
    el,
    label: (textOf($(SEL.menuItemText, el)) || textOf(el)).toLowerCase(),
  }))
}

async function clickMenuItemOptional(menu: HTMLElement, labels: readonly string[]): Promise<boolean> {
  const items = menuItems(menu)
  for (const wanted of labels) {
    const hit = items.find((i) => i.label === wanted) ?? items.find((i) => i.label.includes(wanted))
    if (hit) {
      realClick(hit.el)
      await sleep(150)
      return true
    }
  }
  return false
}

async function clickMenuItem(menu: HTMLElement, labels: readonly string[]): Promise<void> {
  const ok = await clickMenuItemOptional(menu, labels)
  if (!ok) {
    await closeMenus()
    throw new Error(`Menu item not found: ${labels.join(" / ")}`)
  }
}

export async function closeMenus(): Promise<void> {
  pressEscapeCompat()
  const backdrop = $(".cdk-overlay-backdrop")
  backdrop?.click()
  await sleep(150)
}

/**
 * If NotebookLM shows a confirmation dialog, click its affirmative button.
 * Never clicks cancel-ish buttons; resolves quietly when no dialog shows up.
 */
async function confirmDialogIfAny(): Promise<void> {
  let dialog: HTMLElement | null = null
  try {
    dialog = await waitFor(() => $$(SEL.dialogContainer).find(isVisible) ?? null, {
      timeoutMs: 2000,
      what: "confirm dialog",
    })
  } catch {
    return // no dialog -> nothing to confirm
  }
  const buttons = $$("button", dialog)
  const isCancel = (t: string) => LABELS.cancelish.some((c) => t === c || t.startsWith(c))
  const affirmative =
    buttons.find((b) => LABELS.confirm.some((c) => textOf(b).toLowerCase() === c)) ??
    buttons.filter((b) => !isCancel(textOf(b).toLowerCase())).pop()
  if (!affirmative) throw new Error("Confirm dialog appeared but no affirmative button found")
  affirmative.click()
  await sleep(300)
}

// ---------------- Context ----------------

export function currentNotebookId(): string | null {
  const m = location.pathname.match(/\/notebook\/([a-f0-9-]+)/i)
  return m ? m[1] : null
}
