"use strict";
(() => {
  // src/background.ts
  var expected = [];
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
    }
    return false;
  });
  chrome.downloads.onDeterminingFilename?.addListener(
    (item, suggest) => {
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
