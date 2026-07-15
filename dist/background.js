"use strict";
(() => {
  // src/background.ts
  var expected = [];
  var directPending = /* @__PURE__ */ new Map();
  function settleDirect(downloadId, result) {
    const p = directPending.get(downloadId);
    if (!p) return;
    directPending.delete(downloadId);
    clearTimeout(p.timer);
    try {
      p.respond(result);
    } catch {
    }
  }
  function sanitize(name) {
    return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").replace(/\.+$/g, "").trim().slice(0, 140) || "NotebookLM file";
  }
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "notify") {
      chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: String(msg.title ?? "NotebookLM QoL"),
        message: String(msg.message ?? "")
      });
      sendResponse?.({ ok: true });
    } else if (msg?.type === "expectDownload") {
      const name = sanitize(String(msg.name ?? ""));
      if (expected[expected.length - 1]?.name !== name) {
        expected.push({ name, at: Date.now() });
      } else {
        expected[expected.length - 1].at = Date.now();
      }
      sendResponse?.({ ok: true });
    } else if (msg?.type === "directDownload") {
      const name = sanitize(String(msg.name ?? ""));
      try {
        chrome.downloads.download({ url: String(msg.url ?? "") }, (downloadId) => {
          if (chrome.runtime.lastError || downloadId === void 0) {
            sendResponse?.({ ok: false, error: chrome.runtime.lastError?.message ?? "download failed" });
            return;
          }
          const timer = setTimeout(() => {
            settleDirect(downloadId, { ok: true });
          }, 25e3);
          directPending.set(downloadId, { name, respond: sendResponse, timer });
        });
        return true;
      } catch (e) {
        sendResponse?.({ ok: false, error: e.message });
      }
    }
    return false;
  });
  chrome.downloads.onChanged?.addListener((delta) => {
    if (delta?.error?.current && directPending.has(delta.id)) {
      settleDirect(delta.id, { ok: false, error: String(delta.error.current) });
    }
  });
  chrome.downloads.onDeterminingFilename?.addListener(
    (item, suggest) => {
      const p = directPending.get(item.id);
      if (p) {
        const original2 = String(item.filename ?? "");
        const mime = String(item.mime ?? "");
        const isHtml = mime === "text/html" || /\.html?$/i.test(original2);
        if (isHtml) {
          suggest();
          settleDirect(item.id, { ok: false, error: "URL served an HTML page instead of the file" });
          try {
            chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }));
          } catch {
          }
          return;
        }
        const dot2 = original2.lastIndexOf(".");
        const ext2 = dot2 > 0 ? original2.slice(dot2) : "";
        suggest({ filename: `NotebookLM/${p.name}${ext2}`, conflictAction: "uniquify" });
        settleDirect(item.id, { ok: true });
        return;
      }
      const now = Date.now();
      while (expected.length && now - expected[0].at > 9e4) expected.shift();
      const fromNotebookLM = /notebooklm\.google\.com|googleusercontent\.com|usercontent\.google\.com|docs\.google\.com/.test(
        String(item.url ?? "") + String(item.referrer ?? "")
      );
      const next = expected.shift();
      if (!next || !fromNotebookLM) {
        suggest();
        return;
      }
      const original = String(item.filename ?? "");
      const dot = original.lastIndexOf(".");
      const ext = dot > 0 ? original.slice(dot) : "";
      suggest({ filename: `NotebookLM/${next.name}${ext}`, conflictAction: "uniquify" });
    }
  );
})();
