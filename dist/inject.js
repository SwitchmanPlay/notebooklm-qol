"use strict";
(() => {
  // src/content/inject.ts
  var s = document.createElement("script");
  s.src = chrome.runtime.getURL("dist/interceptor.js");
  s.async = false;
  (document.head ?? document.documentElement).appendChild(s);
  s.addEventListener("load", () => s.remove());
})();
