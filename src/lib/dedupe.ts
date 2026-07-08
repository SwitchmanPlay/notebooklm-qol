/**
 * Duplicate-source detection (pure logic, unit-tested).
 * Groups sources by normalized URL, and by normalized title for sources
 * without a URL (uploaded files, pasted text).
 */

export type SourceRef = {
  id: string
  title: string
  url?: string | null
}

export type DuplicateGroup = {
  /** "url" or "title" - what the group was matched on */
  matchedOn: "url" | "title"
  key: string
  /** Sources in original list order; the FIRST one is the suggested keeper. */
  sources: SourceRef[]
}

const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^igshid$/i,
  /^si$/i, // youtube share tracking
  /^ref(_src|_url)?$/i,
  /^source$/i,
  /^_hs(enc|mi)$/i,
]

function isTrackingParam(name: string): boolean {
  return TRACKING_PARAMS.some((re) => re.test(name))
}

/**
 * Normalize a URL so trivially-different copies compare equal:
 * lowercase scheme/host, strip `www.`, drop hash, drop tracking params,
 * sort remaining params, remove trailing slash, treat http/https as equal.
 * Special case: YouTube URLs normalize to the video id.
 */
export function normalizeUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null

  let host = u.hostname.toLowerCase().replace(/^www\./, "")

  // YouTube: compare by video id regardless of URL shape.
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0]
    if (id) return `youtube:${id}`
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    const id = u.searchParams.get("v") ?? (u.pathname.startsWith("/shorts/") ? u.pathname.split("/")[2] : null)
    if (id) return `youtube:${id}`
  }

  const params: Array<[string, string]> = []
  for (const [k, v] of u.searchParams.entries()) {
    if (!isTrackingParam(k)) params.push([k, v])
  }
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = params.length
    ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}`
    : ""

  let path = u.pathname.replace(/\/+$/, "")
  if (path === "") path = "/"

  return `${host}${path}${query}`
}

/** Case/whitespace-insensitive title normalization. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.(pdf|docx?|txt|md|epub|pptx?|csv)$/i, "")
    .trim()
}

export function findDuplicateGroups(sources: SourceRef[]): DuplicateGroup[] {
  const byUrl = new Map<string, SourceRef[]>()
  const byTitle = new Map<string, SourceRef[]>()

  for (const s of sources) {
    const nUrl = s.url ? normalizeUrl(s.url) : null
    if (nUrl) {
      const list = byUrl.get(nUrl) ?? []
      list.push(s)
      byUrl.set(nUrl, list)
    } else {
      const nTitle = normalizeTitle(s.title)
      if (!nTitle) continue
      const list = byTitle.get(nTitle) ?? []
      list.push(s)
      byTitle.set(nTitle, list)
    }
  }

  const groups: DuplicateGroup[] = []
  for (const [key, list] of byUrl) {
    if (list.length > 1) groups.push({ matchedOn: "url", key, sources: list })
  }
  for (const [key, list] of byTitle) {
    if (list.length > 1) groups.push({ matchedOn: "title", key, sources: list })
  }
  return groups
}

/** Convenience: ids that would be deleted (everything except each group's first). */
export function deletableIds(groups: DuplicateGroup[]): string[] {
  return groups.flatMap((g) => g.sources.slice(1).map((s) => s.id))
}
