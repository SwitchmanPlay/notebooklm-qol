/** Small DOM utilities. No NotebookLM-specific knowledge here. */

export function $(sel: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector(sel) as HTMLElement | null
}

export function $$(sel: string, root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll(sel)) as HTMLElement[]
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function waitFor<T>(
  fn: () => T | null | undefined | false,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<T> {
  const { timeoutMs = 10_000, intervalMs = 150, what = "condition" } = opts
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v as T
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await sleep(intervalMs)
  }
}

export function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim()
}

/** Text content with material icons (ligature text) stripped out. */
export function textWithoutIcons(el: Element | null | undefined): string {
  if (!el) return ""
  const clone = el.cloneNode(true) as HTMLElement
  clone.querySelectorAll("mat-icon").forEach((i) => i.remove())
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim()
}

/** Set an input's value the way Angular expects (native setter + input event). */
export function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const desc = Object.getOwnPropertyDescriptor(proto, "value")
  desc?.set?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

export function pressKey(el: Element, key: string): void {
  for (const type of ["keydown", "keypress", "keyup"]) {
    el.dispatchEvent(new KeyboardEvent(type, { key, code: key === "Enter" ? "Enter" : key, bubbles: true, cancelable: true }))
  }
}

/**
 * Synthetic Escape that Angular Material/CDK actually accepts: their overlay
 * handlers check the legacy `keyCode` property, which is 0 on plain synthetic
 * KeyboardEvents. This is why a normal Escape dispatch fails to close dialogs.
 */
export function pressEscapeCompat(target: HTMLElement = document.body): void {
  const ev = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })
  Object.defineProperty(ev, "keyCode", { get: () => 27 })
  Object.defineProperty(ev, "which", { get: () => 27 })
  target.dispatchEvent(ev)
}

export function isVisible(el: HTMLElement): boolean {
  return el.offsetParent !== null || el.getClientRects().length > 0
}

/** Debounced callback helper. */
export function debounce(fn: () => void, ms: number): () => void {
  let t: number | undefined
  return () => {
    clearTimeout(t)
    t = setTimeout(fn, ms) as unknown as number
  }
}

/**
 * Full pointer+mouse event sequence. Some Material buttons (dialog close,
 * radio tiles) ignore a bare .click() because they listen on pointer events.
 */
export function realClick(el: HTMLElement): void {
  const opts = { bubbles: true, cancelable: true, view: window }
  el.dispatchEvent(new PointerEvent("pointerdown", opts))
  el.dispatchEvent(new MouseEvent("mousedown", opts))
  el.dispatchEvent(new PointerEvent("pointerup", opts))
  el.dispatchEvent(new MouseEvent("mouseup", opts))
  el.click()
}
