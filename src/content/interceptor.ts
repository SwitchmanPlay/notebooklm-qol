/**
 * MAIN-world network interceptor (new in v1.1).
 *
 * Runs in the page context (injected via <script src> at document_start, see
 * inject.ts). It never touches chrome.* APIs and talks to the content script
 * exclusively through window CustomEvents:
 *
 *   emits   "nblmqol-artifacts"   { artifacts: RegistryArtifact[] }
 *   emits   "nblmqol-split-start" { sourceIds: string[] }
 *   emits   "nblmqol-split-done"  { succeeded, total, sourceIds }
 *   listens "nblmqol-mode"        { split: boolean }
 *
 * Two jobs:
 *
 * 1. PASSIVE TAP - NotebookLM's own polling (batchexecute RPC "gArtLc")
 *    already contains, for every Studio output: its id, title, type, status,
 *    download url and THE SOURCE IDS IT WAS GENERATED FROM. We parse those
 *    responses as they fly by. This replaces the v0.x approach of opening the
 *    "View prompt & sources" dialog per artifact, which kept timing out.
 *
 * 2. SPLIT MODE (one-shot, armed by the content script) - when the user
 *    presses Generate in NotebookLM's own dialog, the outgoing creation
 *    request (RPC "R7cb6c") carries ALL checked source ids. We rewrite the
 *    original request to the FIRST source only (so the page gets a perfectly
 *    normal response and stays in sync) and replay the request once per
 *    remaining source in the background, gently spaced. Every format option
 *    AND custom text prompt the user typed rides along unchanged, because we
 *    replay the exact request NotebookLM built.
 *
 * If Google renames these RPC ids the interceptor degrades silently: no
 * splitting, no source data - the DOM-based features keep working.
 */

type RawArtifact = {
  id: string
  title: string
  type: string
  status: string
  sourceIds: string[]
  downloadUrl: string | null
}

type ParsedRequest = { sourceIds: string[]; outer: unknown[] }

;(() => {
  const STUDIO_RPC = "R7cb6c" // Studio artifact creation
  const POLL_RPC = "gArtLc" // Studio artifact list / polling

  const TYPE_BY_CODE: Record<number, string> = {
    1: "Audio Overview",
    2: "Report",
    3: "Video Overview",
    4: "Flashcards", // v1.3: quiz & flashcards SHARE code 4 - subtype detected below
    7: "Infographic",
    8: "Slide Deck",
    9: "Data Table",
    10: "Mind Map",
  }

  // Set to true for a verbose debug build. Filter the console by [nblm-qol].
  const DEBUG = false
  const dbg = (...args: unknown[]): void => {
    if (DEBUG) console.info("[nblm-qol][net]", ...args)
  }

  let splitArmed = false
  let armedAt = 0
  window.addEventListener("nblmqol-mode", (e: Event) => {
    splitArmed = !!(e as CustomEvent).detail?.split
    armedAt = Date.now()
    dbg(splitArmed ? "split mode ARMED" : "split mode disarmed")
  })
  // Safety valve: an armed split expires after 10 minutes so it can never
  // hijack an unrelated generation hours later.
  const splitActive = (): boolean => splitArmed && Date.now() - armedAt < 10 * 60 * 1000

  // v1.3: user-requested abort of an in-flight fan-out (Cancel button in the
  // batch panel). Checked between fan-out requests.
  let splitAborted = false
  window.addEventListener("nblmqol-split-abort", () => {
    splitAborted = true
    dbg("split abort requested")
  })

  const emit = (name: string, detail: unknown): void => {
    window.dispatchEvent(new CustomEvent(name, { detail }))
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const flattenIds = (arr: unknown): string[] => {
    const out: string[] = []
    const walk = (x: unknown): void => {
      if (typeof x === "string") out.push(x)
      else if (Array.isArray(x)) x.forEach(walk)
    }
    walk(arr)
    return [...new Set(out)]
  }

  // ---------------- passive artifact tap ----------------

  function parseArtifacts(responseText: string): RawArtifact[] {
    const artifacts: RawArtifact[] = []
    try {
      const clean = responseText.replace(/^\)\]\}'\n?/, "")
      for (const line of clean.split("\n")) {
        if (!line.trim() || /^\d+$/.test(line.trim())) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (!Array.isArray(parsed)) continue
        for (const item of parsed) {
          if (!Array.isArray(item) || item[0] !== "wrb.fr" || item[1] !== POLL_RPC || typeof item[2] !== "string") continue
          let data: unknown
          try {
            data = JSON.parse(item[2])
          } catch {
            continue
          }
          if (!Array.isArray(data) || !Array.isArray((data as unknown[])[0])) continue
          for (const a of (data as unknown[][])[0]) {
            if (!Array.isArray(a) || a.length < 5 || typeof a[0] !== "string") continue
            const typeCode = a[2] as number
            // v1.3: quiz & flashcards share NotebookLM type code 4. The
            // subtype lives in the options tuple: a[9][1][0] = 1 (flashcards)
            // or 2 (quiz). Fall back to "Flashcards" when unreadable.
            let typeLabel = TYPE_BY_CODE[typeCode] ?? `type ${typeCode}`
            try {
              if (typeCode === 4 && Array.isArray(a[9]) && Array.isArray((a[9] as unknown[])[1])) {
                const sub = ((a[9] as unknown[])[1] as unknown[])[0]
                if (sub === 2) typeLabel = "Quiz"
                else if (sub === 1) typeLabel = "Flashcards"
              }
            } catch {
              /* the label is a nice-to-have */
            }
            let downloadUrl: string | null = null
            try {
              if (typeCode === 1 && Array.isArray(a[6]) && typeof a[6][3] === "string") downloadUrl = a[6][3] // audio
              if (typeCode === 3 && Array.isArray(a[8]) && typeof a[8][3] === "string") downloadUrl = a[8][3] // video
              if (typeCode === 7 && Array.isArray(a[14])) {
                const img = (a[14] as unknown[][])[2]?.[0]
                if (Array.isArray(img) && Array.isArray(img[1]) && typeof img[1][0] === "string") downloadUrl = img[1][0] // infographic
              }
              if (typeCode === 8 && Array.isArray(a[16])) {
                if (typeof a[16][0] === "string" && a[16][0].startsWith("http")) downloadUrl = a[16][0] // slide deck
                else if (typeof a[16][3] === "string") downloadUrl = a[16][3]
              }
            } catch {
              /* download url is a nice-to-have */
            }
            artifacts.push({
              id: a[0],
              title: typeof a[1] === "string" ? a[1] : "",
              type: typeLabel,
              status: a[4] === 1 ? "in_progress" : a[4] === 3 ? "completed" : `status ${a[4]}`,
              sourceIds: flattenIds(a[3]),
              downloadUrl,
            })
          }
        }
      }
    } catch {
      /* a parse bug must never break the page */
    }
    return artifacts
  }

  function tapResponseText(text: string): void {
    if (text.indexOf(POLL_RPC) === -1) return
    const artifacts = parseArtifacts(text)
    if (artifacts.length > 0) {
      dbg(`poll response: ${artifacts.length} artifact(s)`, artifacts.map((a) => `${a.id.slice(0, 8)} "${a.title}" [${a.status}] sources=${a.sourceIds.length}`))
      emit("nblmqol-artifacts", { artifacts })
    }
  }

  // ---------------- split mode ----------------

  function parseStudioRequest(bodyText: string): ParsedRequest | null {
    try {
      const m = bodyText.match(/f\.req=([^&]+)/)
      if (!m) return null
      const outer = JSON.parse(decodeURIComponent(m[1])) as unknown[]
      const rpcArray = (Array.isArray(outer[0]) ? outer[0] : outer) as unknown[]
      for (const item of rpcArray) {
        if (!Array.isArray(item) || item[0] !== STUDIO_RPC || typeof item[1] !== "string") continue
        const params = JSON.parse(item[1])
        const nested = params?.[2]?.[3]
        const sourceIds: string[] = []
        if (Array.isArray(nested)) {
          for (const n of nested) {
            if (Array.isArray(n) && Array.isArray(n[0]) && typeof n[0][0] === "string") sourceIds.push(n[0][0])
          }
        }
        if (sourceIds.length > 0) return { sourceIds, outer }
      }
    } catch {
      /* not the request we thought it was */
    }
    return null
  }

  /** Rebuild the request body targeting a single source. Source ids live in up
   * to four spots depending on artifact type (audio/video/report keep copies
   * inside their option blocks). */
  function buildBodyFor(originalBody: string, parsed: ParsedRequest, sourceId: string): string {
    const outer = JSON.parse(JSON.stringify(parsed.outer)) as unknown[]
    const rpcArray = (Array.isArray(outer[0]) ? outer[0] : outer) as any[]
    for (const item of rpcArray) {
      if (!Array.isArray(item) || item[0] !== STUDIO_RPC) continue
      const params = JSON.parse(item[1])
      if (params?.[2]?.[3]) params[2][3] = [[[sourceId]]]
      if (Array.isArray(params?.[2]?.[6]?.[1]) && params[2][6][1][3]) params[2][6][1][3] = [[sourceId]] // audio options
      if (Array.isArray(params?.[2]?.[8]?.[2]) && params[2][8][2][0]) params[2][8][2][0] = [[sourceId]] // video options
      if (Array.isArray(params?.[2]?.[7]?.[1]) && params[2][7][1][3]) params[2][7][1][3] = [[sourceId]] // report options
      item[1] = JSON.stringify(params)
      break
    }
    return originalBody.replace(/f\.req=[^&]+/, "f.req=" + encodeURIComponent(JSON.stringify(outer)))
  }

  // ---------------- fetch hook ----------------

  const origFetch = window.fetch

  // v1.4: template of the page's most recent authenticated batchexecute POST.
  // We reuse its URL params (bl, authuser, source-path) and auth token to
  // build our own rename requests - always fresh, no token scraping needed.
  let lastBatchexecute: { url: string; body: string } | null = null
  const captureBatchexecute = (url: string, body: unknown): void => {
    if (typeof body !== "string") return
    if (url.indexOf("/data/batchexecute") === -1) return
    if (!/(^|&)at=/.test(body)) return
    lastBatchexecute = { url, body }
  }

  // v1.4: network rename via NotebookLM's own rename RPC (instant, no menu
  // clicks, no focus stealing). The content script asks via
  // nblmqol-rename-request and gets nblmqol-rename-result back; on failure it
  // falls back to the DOM rename path.
  const RENAME_RPC = "rc3d8d"
  window.addEventListener("nblmqol-rename-request", (e: Event) => {
    const d = ((e as CustomEvent).detail ?? {}) as { reqId?: string; artifactId?: string; title?: string }
    void (async () => {
      let ok = false
      try {
        if (!lastBatchexecute || !d.artifactId || typeof d.title !== "string") throw new Error("no captured request to build from")
        const at = /(?:^|&)at=([^&]+)/.exec(lastBatchexecute.body)?.[1]
        if (!at) throw new Error("no auth token captured")
        const u = new URL(lastBatchexecute.url, location.origin)
        u.searchParams.set("rpcids", RENAME_RPC)
        u.searchParams.set("_reqid", String(Math.floor(9e5 * Math.random()) + 1e5))
        const freq = JSON.stringify([[[RENAME_RPC, JSON.stringify([[d.artifactId, d.title], [["title"]]]), null, "generic"]]])
        const r = await origFetch.call(window, u.toString(), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: `f.req=${encodeURIComponent(freq)}&at=${at}`, // `at` stays URL-encoded exactly as captured
        })
        const text = await r.text()
        ok = r.ok && text.indexOf('"wrb.fr"') !== -1
        dbg(`network rename ${String(d.artifactId).slice(0, 8)} -> "${d.title}": ${ok ? "OK" : `FAILED HTTP ${r.status}`}`)
      } catch (err) {
        dbg("network rename failed:", err)
      }
      emit("nblmqol-rename-result", { reqId: d.reqId, ok })
    })()
  })

  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
    if (url.indexOf("batchexecute") === -1) return origFetch.call(window, input as RequestInfo, init)
    if (typeof init?.body === "string") captureBatchexecute(url, init.body)

    if (splitActive() && url.indexOf(STUDIO_RPC) !== -1 && init?.body) {
      const bodyText = typeof init.body === "string" ? init.body : await new Blob([init.body as BlobPart]).text()
      const parsed = parseStudioRequest(bodyText)
      if (!parsed) dbg("creation request seen but source ids not parseable - passing through unchanged")
      if (parsed) {
        dbg(`splitting fetch creation request into ${parsed.sourceIds.length} single-source request(s)`, parsed.sourceIds)
        splitArmed = false // one-shot: never split a request the user didn't arm
        splitAborted = false
        const ids = parsed.sourceIds
        emit("nblmqol-split-start", { sourceIds: ids })
        // The page itself performs a normal single-source request (first
        // source) and receives a REAL response - its UI stays in sync.
        const firstBody = ids.length > 1 ? buildBodyFor(bodyText, parsed, ids[0]) : bodyText
        const firstResponse = origFetch.call(window, input as RequestInfo, Object.assign({}, init, { body: firstBody }))
        void (async () => {
          let succeeded = 0
          try {
            succeeded = (await firstResponse).ok ? 1 : 0
          } catch {
            /* the page sees the same error */
          }
          for (let i = 1; i < ids.length; i++) {
            if (splitAborted) {
              dbg(`fan-out aborted by user after ${i}/${ids.length} request(s)`)
              emit("nblmqol-split-done", { succeeded, total: ids.length, sourceIds: ids, aborted: true })
              return
            }
            await sleep(1500) // be gentle - NotebookLM rate-limits bursts
            try {
              const r = await origFetch.call(window, input as RequestInfo, Object.assign({}, init, { body: buildBodyFor(bodyText, parsed, ids[i]) }))
              if (r.ok) succeeded++
              dbg(`fan-out ${i + 1}/${ids.length} source=${ids[i]} -> HTTP ${r.status}`)
            } catch (err) {
              dbg(`fan-out ${i + 1}/${ids.length} source=${ids[i]} FAILED`, err)
            }
          }
          dbg(`split done: ${succeeded}/${ids.length} requests accepted`)
          emit("nblmqol-split-done", { succeeded, total: ids.length, sourceIds: ids })
        })()
        return firstResponse
      }
    }

    const response = await origFetch.call(window, input as RequestInfo, init)
    try {
      tapResponseText(await response.clone().text())
    } catch {
      /* passive tap only */
    }
    return response
  }

  // ---------------- XHR hook ----------------

  type TaggedXhr = XMLHttpRequest & { _nqUrl?: string; _nqHeaders?: Array<[string, string]> }

  const proto = XMLHttpRequest.prototype
  const origOpen = proto.open
  const origSend = proto.send
  const origSetHeader = proto.setRequestHeader

  proto.open = function (this: TaggedXhr) {
    this._nqUrl = String(arguments[1] ?? "")
    this._nqHeaders = []
    return (origOpen as any).apply(this, arguments)
  }

  proto.setRequestHeader = function (this: TaggedXhr, name: string, value: string) {
    this._nqHeaders?.push([name, value])
    return (origSetHeader as any).apply(this, arguments)
  }

  proto.send = function (this: TaggedXhr, body?: Document | XMLHttpRequestBodyInit | null) {
    const url = this._nqUrl ?? ""
    if (url.indexOf("batchexecute") !== -1) {
      captureBatchexecute(url, body)
      this.addEventListener("load", () => {
        try {
          if (typeof this.responseText === "string") tapResponseText(this.responseText)
        } catch {
          /* passive tap only */
        }
      })

      if (splitActive() && url.indexOf(STUDIO_RPC) !== -1 && typeof body === "string") {
        const parsed = parseStudioRequest(body)
        if (parsed) {
          splitArmed = false
          splitAborted = false
          const ids = parsed.sourceIds
          dbg(`splitting XHR creation request into ${ids.length} single-source request(s)`, ids)
          emit("nblmqol-split-start", { sourceIds: ids })
          if (ids.length > 1) {
            const headers = Object.fromEntries(this._nqHeaders ?? [])
            void (async () => {
              let succeeded = 1 // the original XHR below carries the first source
              for (let i = 1; i < ids.length; i++) {
                if (splitAborted) {
                  dbg(`fan-out aborted by user after ${i}/${ids.length} request(s)`)
                  emit("nblmqol-split-done", { succeeded: Math.max(succeeded, 0), total: ids.length, sourceIds: ids, aborted: true })
                  return
                }
                await sleep(1500)
                try {
                  const r = await origFetch.call(window, url, {
                    method: "POST",
                    headers,
                    body: buildBodyFor(body, parsed, ids[i]),
                    credentials: "include",
                  })
                  if (!r.ok) succeeded-- // keep the honest count >= number that worked
                  else succeeded++
                  dbg(`fan-out ${i + 1}/${ids.length} source=${ids[i]} -> HTTP ${r.status}`)
                } catch (err) {
                  dbg(`fan-out ${i + 1}/${ids.length} source=${ids[i]} FAILED`, err)
                }
              }
              dbg(`split done: ~${Math.max(succeeded, 0)}/${ids.length} requests accepted`)
              emit("nblmqol-split-done", { succeeded: Math.max(succeeded, 0), total: ids.length, sourceIds: ids })
            })()
            return origSend.call(this, buildBodyFor(body, parsed, ids[0]))
          }
          emit("nblmqol-split-done", { succeeded: 1, total: 1, sourceIds: ids })
        }
      }
    }
    return (origSend as any).apply(this, arguments)
  }

  console.info("[nblm-qol] network interceptor active")
})()

export {}
