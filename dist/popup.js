"use strict";
(() => {
  // src/lib/template.ts
  var DEFAULT_TEMPLATE = "{source} \u2014 {type}";
  var MAX_SOURCE_LEN = 60;
  var MAX_NAME_LEN = 120;
  function truncate(s, max) {
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
    return `${base.trimEnd()}\u2026`;
  }
  function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function cleanName(s) {
    return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  }
  function applyTemplate(template, vars) {
    const source = truncate(cleanName(vars.source ?? ""), MAX_SOURCE_LEN);
    const type = cleanName(vars.type ?? "");
    const date = formatDate(vars.date ?? /* @__PURE__ */ new Date());
    const n = vars.n != null ? String(vars.n) : "";
    const out = template.replaceAll("{source}", source).replaceAll("{type}", type).replaceAll("{date}", date).replaceAll("{n}", n);
    const cleaned = cleanName(out);
    return cleaned.length > MAX_NAME_LEN ? truncate(cleaned, MAX_NAME_LEN) : cleaned;
  }
  function templatePreview(template) {
    return applyTemplate(template, {
      source: "Chapter 3 \u2014 Neural Networks",
      type: "Audio Overview",
      date: /* @__PURE__ */ new Date(),
      n: 1
    });
  }

  // src/lib/settings.ts
  var DEFAULT_SETTINGS = {
    template: DEFAULT_TEMPLATE,
    features: {
      studioBulk: true,
      batchGenerate: true,
      sourceBulk: true
    }
  };
  function contextAlive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }
  async function loadSettings() {
    let raw;
    try {
      if (contextAlive()) raw = await chrome.storage.sync.get("settings");
    } catch {
    }
    const s = raw?.settings ?? {};
    return {
      template: typeof s.template === "string" && s.template.trim() ? s.template : DEFAULT_SETTINGS.template,
      features: { ...DEFAULT_SETTINGS.features, ...s.features ?? {} }
    };
  }
  async function saveSettings(s) {
    await chrome.storage.sync.set({ settings: s });
  }

  // src/popup.ts
  var $ = (id) => document.getElementById(id);
  async function main() {
    const settings = await loadSettings();
    $("template").value = settings.template;
    $("f-studioBulk").checked = settings.features.studioBulk;
    $("f-batchGenerate").checked = settings.features.batchGenerate;
    $("f-sourceBulk").checked = settings.features.sourceBulk;
    renderPreview();
    let t;
    const save = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const s = {
          template: $("template").value.trim() || settings.template,
          features: {
            studioBulk: $("f-studioBulk").checked,
            batchGenerate: $("f-batchGenerate").checked,
            sourceBulk: $("f-sourceBulk").checked
          }
        };
        await saveSettings(s);
        const saved = document.getElementById("saved");
        saved.textContent = "Saved \u2713";
        setTimeout(() => saved.textContent = "", 1500);
      }, 350);
    };
    $("template").addEventListener("input", () => {
      renderPreview();
      save();
    });
    for (const id of ["f-studioBulk", "f-batchGenerate", "f-sourceBulk"]) {
      $(id).addEventListener("change", save);
    }
  }
  function renderPreview() {
    const el = document.getElementById("preview");
    try {
      el.textContent = `Preview: ${templatePreview($("template").value || "")}`;
    } catch {
      el.textContent = "";
    }
  }
  main();
})();
