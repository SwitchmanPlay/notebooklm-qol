/**
 * Rename-template engine (pure logic, unit-tested).
 *
 * Supported variables:
 *   {source} - title of the source used (truncated)
 *   {type}   - artifact type label, e.g. "Audio Overview"
 *   {date}   - YYYY-MM-DD
 *   {n}      - batch index (1-based)
 */

export const DEFAULT_TEMPLATE = "{source} \u2014 {type}"

export const MAX_SOURCE_LEN = 60
export const MAX_NAME_LEN = 120

export type TemplateVars = {
  source?: string
  type?: string
  date?: Date
  n?: number
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  // Cut on a word boundary when possible, append ellipsis.
  const cut = s.slice(0, max)
  const lastSpace = cut.lastIndexOf(" ")
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut
  return `${base.trimEnd()}\u2026`
}

function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** Strip characters that break UI display or filenames; collapse whitespace. */
export function cleanName(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]/g, " ") // control chars
    .replace(/\s+/g, " ")
    .trim()
}

export function applyTemplate(template: string, vars: TemplateVars): string {
  const source = truncate(cleanName(vars.source ?? ""), MAX_SOURCE_LEN)
  const type = cleanName(vars.type ?? "")
  const date = formatDate(vars.date ?? new Date())
  const n = vars.n != null ? String(vars.n) : ""

  const out = template
    .replaceAll("{source}", source)
    .replaceAll("{type}", type)
    .replaceAll("{date}", date)
    .replaceAll("{n}", n)

  const cleaned = cleanName(out)
  return cleaned.length > MAX_NAME_LEN ? truncate(cleaned, MAX_NAME_LEN) : cleaned
}

/**
 * Ensure `name` is unique within `existing` (case-insensitive) by appending
 * " (2)", " (3)", ... like file managers do.
 */
export function uniqueName(name: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].map((e) => e.toLowerCase()))
  if (!taken.has(name.toLowerCase())) return name
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/** Sanitize a name for use as a filename inside the ZIP. */
export function toFilename(name: string, ext: string): string {
  const safe = cleanName(name)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\.+$/g, "")
    .trim()
  const base = safe.length > 0 ? safe : "untitled"
  return ext ? `${base}.${ext.replace(/^\./, "")}` : base
}

/** Live preview shown in settings next to the template input. */
export function templatePreview(template: string): string {
  return applyTemplate(template, {
    source: "Chapter 3 \u2014 Neural Networks",
    type: "Audio Overview",
    date: new Date(),
    n: 1,
  })
}
