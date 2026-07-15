/**
 * Runs at document_start (isolated world). Its only job is to inject the
 * MAIN-world interceptor before NotebookLM's own code starts making requests.
 * See interceptor.ts for what the interceptor does.
 */
const s = document.createElement("script")
s.src = chrome.runtime.getURL("dist/interceptor.js")
s.async = false
;(document.head ?? document.documentElement).appendChild(s)
s.addEventListener("load", () => s.remove())

export {}
