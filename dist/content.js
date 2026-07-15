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
  function onSettingsChanged(cb) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.settings) loadSettings().then(cb);
    });
  }
  async function getLocal(key, fallback) {
    if (!contextAlive()) return fallback;
    try {
      const raw = await chrome.storage.local.get(key);
      return raw?.[key] ?? fallback;
    } catch {
      return fallback;
    }
  }
  async function setLocal(key, value) {
    if (!contextAlive()) return;
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch {
    }
  }
  var KEYS = {
    batch: (notebookId) => `nblmqol.batch.${notebookId}`,
    renames: "nblmqol.pendingRenames",
    renamePref: "nblmqol.renamePref",
    lastType: "nblmqol.lastType",
    choices: (artifactType) => `nblmqol.choices.${artifactType}`
  };

  // src/content/dom.ts
  function $(sel, root = document) {
    return root.querySelector(sel);
  }
  function $$(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, opts = {}) {
    const { timeoutMs = 1e4, intervalMs = 150, what = "condition" } = opts;
    const start = Date.now();
    for (; ; ) {
      const v = fn();
      if (v) return v;
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
      await sleep(intervalMs);
    }
  }
  function textOf(el2) {
    return (el2?.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  function textWithoutIcons(el2) {
    if (!el2) return "";
    const clone = el2.cloneNode(true);
    clone.querySelectorAll("mat-icon").forEach((i) => i.remove());
    return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  function setInputValue(input, value) {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    desc?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function pressKey(el2, key) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el2.dispatchEvent(new KeyboardEvent(type, { key, code: key === "Enter" ? "Enter" : key, bubbles: true, cancelable: true }));
    }
  }
  function pressEscapeCompat(target = document.body) {
    const ev = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
    Object.defineProperty(ev, "keyCode", { get: () => 27 });
    Object.defineProperty(ev, "which", { get: () => 27 });
    target.dispatchEvent(ev);
  }
  function isVisible(el2) {
    return el2.offsetParent !== null || el2.getClientRects().length > 0;
  }
  function debounce(fn, ms) {
    let t;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }
  function realClick(el2) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el2.dispatchEvent(new PointerEvent("pointerdown", opts));
    el2.dispatchEvent(new MouseEvent("mousedown", opts));
    el2.dispatchEvent(new PointerEvent("pointerup", opts));
    el2.dispatchEvent(new MouseEvent("mouseup", opts));
    el2.click();
  }

  // src/content/selectors.ts
  var SEL = {
    // ---- Source panel ----
    sourceRow: ".single-source-container",
    sourceRowTitle: ".source-title",
    sourceCheckboxInput: ".select-checkbox-container input.mdc-checkbox__native-control",
    selectAllSourcesInput: 'input[aria-label="Select all sources"]',
    // id encodes the source uuid: source-item-more-button-<uuid>
    sourceMoreButton: 'button[id^="source-item-more-button-"]',
    // ---- Studio panel ----
    artifactItem: "artifact-library-item",
    // id encodes the artifact uuid: artifact-labels-<uuid>
    artifactLabels: 'span[id^="artifact-labels-"]',
    artifactTitle: ".artifact-title",
    // Inline rename input that replaces the title after clicking "Rename"
    artifactTitleInput: "input.artifact-title-input",
    artifactDetails: ".artifact-details",
    artifactIcon: "mat-icon.artifact-icon",
    artifactMoreButton: 'button[aria-label="More"]',
    artifactActions: ".artifact-actions",
    // "Create" buttons grid in the Studio panel
    createButtonHost: "basic-create-artifact-button",
    createButton: '.create-artifact-button-container[role="button"]',
    // ---- Material overlays (menus / dialogs / snackbars) ----
    overlayContainer: ".cdk-overlay-container",
    menuPanel: ".mat-mdc-menu-panel",
    menuItem: 'button.mat-mdc-menu-item, [role="menuitem"]',
    menuItemText: ".mat-mdc-menu-item-text",
    dialogContainer: "mat-dialog-container",
    snackbarLabel: ".mat-mdc-snack-bar-label, .mdc-snackbar__label",
    // ---- Customize dialog (configurable-form-dialog) ----
    customizeButton: 'button[aria-label^="Customize "]',
    configDialog: "configurable-form-dialog",
    controlWrapper: ".control-wrapper",
    controlLabel: ".control-label",
    radioButton: "mat-radio-button",
    tileLabelContainer: ".tile-label-container",
    dialogActionsButton: "mat-dialog-actions button",
    dialogCloseButton: 'button[aria-label="Close dialog"]',
    // ---- "View prompt and sources" dialog (source-attribution-dialog) ----
    attributionDialog: "source-attribution-dialog",
    attributionSourceTitle: ".source-chip .source-title"
  };
  var LABELS = {
    artifactRename: ["rename"],
    artifactViewSources: ["view prompt and sources", "view prompt & sources", "view prompt"],
    artifactDownload: ["download"],
    artifactDelete: ["delete"],
    sourceRemove: ["remove source", "delete source", "delete"],
    // Confirm-dialog buttons we are allowed to click (never "cancel"/"close")
    confirm: ["delete", "remove", "confirm", "yes"],
    cancelish: ["cancel", "close", "no", "keep"],
    rateLimit: ["limit", "try again later", "quota"],
    generate: ["generate", "create"]
  };
  var ICON_TO_TYPE = {
    audio_magic_eraser: "Audio Overview",
    video_magic_eraser: "Video Overview",
    subscriptions: "Video Overview",
    animated_images: "Video Overview",
    cards_star: "Flashcards",
    quiz: "Quiz",
    tablet: "Slide Deck",
    network_intel_node: "Mind Map",
    flowchart: "Mind Map",
    handyman: "Reports",
    lab_profile: "Reports",
    table: "Data Table",
    emoji_objects: "Infographic",
    stacked_bar_chart: "Infographic"
  };
  function sourceIdFromMoreButton(id) {
    if (!id) return null;
    const m = id.match(/^source-item-more-button-(.+)$/);
    return m ? m[1] : null;
  }
  function artifactIdFromLabels(id) {
    if (!id) return null;
    const m = id.match(/^artifact-labels-(.+)$/);
    return m ? m[1] : null;
  }

  // src/content/adapter.ts
  function listSources() {
    return $$(SEL.sourceRow).map((row) => {
      const more = $(SEL.sourceMoreButton, row);
      const checkbox = $(SEL.sourceCheckboxInput, row);
      return {
        id: sourceIdFromMoreButton(more?.id),
        title: textOf($(SEL.sourceRowTitle, row)),
        row,
        checkbox,
        checked: checkbox?.checked ?? false
      };
    });
  }
  function findSource(idOrTitle) {
    const all = listSources();
    return all.find((s) => s.id === idOrTitle) ?? all.find((s) => s.title === idOrTitle) ?? null;
  }
  async function applySourceSelection(wanted) {
    for (const s of listSources()) {
      const want = s.id != null && wanted.has(s.id) || wanted.has(s.title);
      if (s.checkbox && s.checkbox.checked !== want) {
        s.checkbox.click();
        await sleep(60);
      }
    }
    const bad = listSources().filter((s) => {
      const want = s.id != null && wanted.has(s.id) || wanted.has(s.title);
      return (s.checkbox?.checked ?? false) !== want;
    });
    if (bad.length > 0) throw new Error(`Could not set selection for: ${bad.map((b) => b.title).join(", ")}`);
  }
  async function deleteSource(idOrTitle) {
    const s = findSource(idOrTitle);
    if (!s) throw new Error(`Source not found: ${idOrTitle}`);
    const more = $(SEL.sourceMoreButton, s.row);
    if (!more) throw new Error(`No menu button on source: ${s.title}`);
    const menu = await openMenu(more);
    await clickMenuItem(menu, LABELS.sourceRemove);
    await confirmDialogIfAny();
    await waitFor(() => !document.contains(s.row) || !isVisible(s.row), {
      timeoutMs: 8e3,
      what: `source "${s.title}" to disappear`
    });
  }
  function listArtifacts() {
    return $$(SEL.artifactItem).map((el2) => {
      const labels = $(SEL.artifactLabels, el2);
      const icon = textOf($(SEL.artifactIcon, el2));
      return {
        id: artifactIdFromLabels(labels?.id),
        title: textOf($(SEL.artifactTitle, el2)),
        type: ICON_TO_TYPE[icon] ?? icon ?? "Artifact",
        el: el2
      };
    });
  }
  function artifactIds() {
    return new Set(listArtifacts().map((a) => a.id).filter((x) => !!x));
  }
  function findArtifact(id) {
    return listArtifacts().find((a) => a.id === id) ?? null;
  }
  async function waitForStableArtifacts(stableMs = 2500, timeoutMs = 15e3) {
    const start = Date.now();
    let last = artifactIds();
    let lastChange = Date.now();
    for (; ; ) {
      await sleep(500);
      const now = artifactIds();
      const changed = now.size !== last.size || [...now].some((id) => !last.has(id));
      if (changed) {
        last = now;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= stableMs) {
        return;
      }
      if (Date.now() - start > timeoutMs) return;
    }
  }
  async function openArtifactMenu(a) {
    a.el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    a.el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    const more = await waitFor(() => {
      const actions = $(SEL.artifactActions, a.el) ?? a.el;
      return $(SEL.artifactMoreButton, actions);
    }, { timeoutMs: 4e3, what: `menu button on "${a.title}"` });
    return openMenu(more);
  }
  var normalizeTitle = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  async function renameArtifact(id, newName) {
    const a = findArtifact(id);
    if (!a) throw new Error(`Artifact not found: ${id}`);
    const menu = await openArtifactMenu(a);
    const clicked = await clickMenuItemOptional(menu, LABELS.artifactRename);
    if (!clicked) {
      await closeMenus();
      throw new Error(`Rename not available yet for "${a.title}" (probably still generating)`);
    }
    const input = await waitFor(() => {
      const now = findArtifact(id);
      return now ? $(SEL.artifactTitleInput, now.el) : null;
    }, {
      timeoutMs: 5e3,
      what: "inline rename input"
    });
    input.focus();
    setInputValue(input, newName);
    pressKey(input, "Enter");
    input.blur();
    try {
      await waitFor(() => {
        const now = findArtifact(id);
        if (!now) return false;
        if ($(SEL.artifactTitleInput, now.el)) return false;
        return normalizeTitle(now.title) === normalizeTitle(newName);
      }, { timeoutMs: 6e3, intervalMs: 300, what: "rename to commit" });
    } catch {
      const now = findArtifact(id);
      console.warn(`[nblm-qol] rename didn't stick (will retry): wanted "${newName}", got "${now?.title ?? "?"}"`);
      throw new Error(`Rename did not stick for "${newName}"`);
    }
  }
  async function downloadArtifact(id) {
    const a = findArtifact(id);
    if (!a) throw new Error(`Artifact not found: ${id}`);
    const menu = await openArtifactMenu(a);
    const clicked = await clickMenuItemOptional(menu, LABELS.artifactDownload);
    if (!clicked) {
      await closeMenus();
      throw new Error(`No Download option for "${a.title}" (${a.type})`);
    }
  }
  async function deleteArtifact(id) {
    const a = findArtifact(id);
    if (!a) throw new Error(`Artifact not found: ${id}`);
    const menu = await openArtifactMenu(a);
    await clickMenuItem(menu, LABELS.artifactDelete);
    await confirmDialogIfAny();
    await waitFor(() => !findArtifact(id), { timeoutMs: 8e3, what: `artifact "${a.title}" to disappear` });
  }
  function listCreateOptions() {
    const out = [];
    for (const host of $$(SEL.createButtonHost)) {
      const btn2 = $(SEL.createButton, host);
      const label = btn2?.getAttribute("aria-label") ?? textOf(btn2);
      if (btn2 && label) out.push({ label, el: btn2 });
    }
    return out;
  }
  async function waitForNewArtifact(before, typeLabel, timeoutMs = 9e4) {
    return waitFor(
      () => {
        const err = detectRateLimit();
        if (err) throw new Error(err);
        for (const id of artifactIds()) if (!before.has(id)) return id;
        return null;
      },
      { timeoutMs, intervalMs: 400, what: `new ${typeLabel} to appear in Studio` }
    );
  }
  async function generateArtifactInteractive(typeLabel, choices, onWaitingForUser) {
    const opt = listCreateOptions().find((o) => o.label.toLowerCase() === typeLabel.toLowerCase());
    if (!opt) throw new Error(`Create button not found for type: ${typeLabel}`);
    const before = artifactIds();
    const wantsDialog = choices === null || Object.keys(choices).length > 0;
    const customize = wantsDialog ? findCustomizeButton(typeLabel) : null;
    const openDialogWith = async (trigger, timeoutMs) => {
      const dialogsBefore = new Set($$(SEL.dialogContainer));
      realClick(trigger);
      try {
        return await waitFor(
          () => $$(SEL.dialogContainer).find((d) => !dialogsBefore.has(d) && isVisible(d)) ?? null,
          { timeoutMs, what: "options dialog" }
        );
      } catch {
        return null;
      }
    };
    let dlg = null;
    if (customize) {
      dlg = await openDialogWith(customize, 5e3);
      if (!dlg) {
        console.warn(`[nblm-qol] ${typeLabel}: Customize button opened no dialog - using the plain create button`);
        dlg = await openDialogWith(opt.el, 3e3);
      }
    } else {
      dlg = await openDialogWith(opt.el, 3e3);
    }
    if (!dlg) console.info(`[nblm-qol] ${typeLabel}: no options dialog - NotebookLM generates this type with defaults`);
    let recorded = null;
    if (dlg) {
      await waitForDialogControls(dlg);
      let auto = false;
      if (choices !== null) {
        applyChoices(dlg, choices);
        await sleep(300);
        auto = clickGenerateIn(dlg);
        if (!auto) {
          await sleep(800);
          auto = clickGenerateIn(dlg);
        }
      }
      if (auto) {
        console.info(`[nblm-qol] ${typeLabel}: applied recorded options and pressed Generate`, choices);
        await waitFor(() => !document.contains(dlg) || !isVisible(dlg) ? true : null, {
          timeoutMs: 8e3,
          what: "options dialog to close"
        }).catch(() => void 0);
      } else {
        onWaitingForUser?.();
        console.info(`[nblm-qol] ${typeLabel}: waiting for you to confirm the options dialog`);
        recorded = await recordChoicesUntilClosed(dlg);
        console.info(`[nblm-qol] ${typeLabel}: recorded options`, recorded);
      }
    }
    let id;
    if (recorded !== null) {
      try {
        id = await waitForNewArtifact(before, typeLabel, 15e3);
      } catch {
        throw new Error("BATCH_CANCELLED: the options dialog was closed without generating");
      }
    } else {
      id = await waitForNewArtifact(before, typeLabel);
    }
    return { id, recordedChoices: recorded };
  }
  async function openOptionsDialog(typeLabel) {
    const opt = listCreateOptions().find((o) => o.label.toLowerCase() === typeLabel.toLowerCase());
    if (!opt) throw new Error(`Create button not found for type: ${typeLabel}`);
    const customize = findCustomizeButton(typeLabel);
    const openDialogWith = async (trigger, timeoutMs) => {
      const dialogsBefore = new Set($$(SEL.dialogContainer));
      realClick(trigger);
      try {
        return await waitFor(
          () => $$(SEL.dialogContainer).find((d) => !dialogsBefore.has(d) && isVisible(d)) ?? null,
          { timeoutMs, what: "options dialog" }
        );
      } catch {
        return null;
      }
    };
    let dlg = null;
    if (customize) {
      dlg = await openDialogWith(customize, 5e3);
      if (!dlg) {
        console.warn(`[nblm-qol] ${typeLabel}: Customize button opened no dialog - using the plain create button`);
        dlg = await openDialogWith(opt.el, 3e3);
      }
    } else {
      dlg = await openDialogWith(opt.el, 3e3);
    }
    if (dlg) await waitForDialogControls(dlg).catch(() => void 0);
    else console.info(`[nblm-qol] ${typeLabel}: no options dialog - generation starts immediately with defaults`);
    return { opened: !!dlg, dialog: dlg };
  }
  function findCustomizeButton(typeLabel) {
    const want = typeLabel.trim().toLowerCase();
    return $$(SEL.customizeButton).find((b) => {
      const label = (b.getAttribute("aria-label") ?? "").trim().toLowerCase();
      return label === `customize ${want}` || label.endsWith(` ${want}`);
    }) ?? null;
  }
  function clickGenerateIn(dlg) {
    const candidates = $$("button", dlg).filter((b) => {
      const t = textWithoutIcons(b).toLowerCase();
      return !!t && LABELS.generate.some((g) => t === g || t.startsWith(`${g} `));
    });
    const gen = candidates[candidates.length - 1];
    if (gen) realClick(gen);
    return !!gen;
  }
  function applyChoices(dlg, choices) {
    const entries = Object.entries(choices);
    if (entries.length === 0) return;
    const wrappers = $$(SEL.controlWrapper, dlg);
    for (const [group, value] of entries) {
      const scope = wrappers.find((w) => textOf($(SEL.controlLabel, w)) === group) ?? dlg;
      let done = false;
      for (const radio of $$(SEL.radioButton, scope)) {
        if (textWithoutIcons(radio) !== value) continue;
        const input = $('input[type="radio"]', radio);
        if (!input?.checked) realClick(input ?? radio);
        done = true;
        break;
      }
      if (done) continue;
      for (const tog of $$("mat-button-toggle", scope)) {
        if (textWithoutIcons(tog) !== value) continue;
        const btn2 = $("button", tog);
        const pressed = tog.classList.contains("mat-button-toggle-checked") || btn2?.getAttribute("aria-pressed") === "true";
        if (!pressed) realClick(btn2 ?? tog);
        break;
      }
    }
  }
  function snapshotChoices(dlg) {
    const out = {};
    for (const input of $$('input[type="radio"]', dlg)) {
      if (!input.checked) continue;
      const radio = input.closest("mat-radio-button");
      const option = textWithoutIcons(radio ?? input.parentElement);
      const cw = input.closest(SEL.controlWrapper);
      const group = (cw ? textOf($(SEL.controlLabel, cw)) : "") || input.closest('[role="radiogroup"]')?.getAttribute("aria-label") || "Format";
      if (option) out[group] = option;
    }
    for (const tog of $$("mat-button-toggle", dlg)) {
      const btn2 = $("button", tog);
      const pressed = tog.classList.contains("mat-button-toggle-checked") || btn2?.getAttribute("aria-pressed") === "true";
      if (!pressed) continue;
      const option = textWithoutIcons(tog);
      const cw = tog.closest(SEL.controlWrapper);
      const group = (cw ? textOf($(SEL.controlLabel, cw)) : "") || "Options";
      if (option) out[group] = option;
    }
    return out;
  }
  async function recordChoicesUntilClosed(dlg, timeoutMs = 3e5) {
    const start = Date.now();
    let last = {};
    while (document.contains(dlg) && isVisible(dlg)) {
      const snap = snapshotChoices(dlg);
      if (Object.keys(snap).length > 0) last = snap;
      if (Date.now() - start > timeoutMs) throw new Error("Options dialog was left open too long - job skipped");
      await sleep(300);
    }
    return last;
  }
  async function waitForDialogControls(dlg) {
    try {
      await waitFor(() => $$(SEL.controlWrapper, dlg).length > 0 ? true : null, {
        timeoutMs: 5e3,
        intervalMs: 150,
        what: "dialog controls"
      });
      await sleep(300);
    } catch {
    }
  }
  function detectRateLimit() {
    for (const el2 of $$(SEL.snackbarLabel)) {
      const t = textOf(el2).toLowerCase();
      if (LABELS.rateLimit.some((k) => t.includes(k))) return `NotebookLM says: ${textOf(el2)}`;
    }
    return null;
  }
  async function openMenu(trigger) {
    for (let attempt = 1; ; attempt++) {
      const panelsBefore = new Set($$(SEL.menuPanel));
      trigger.click();
      try {
        return await waitFor(
          () => $$(SEL.menuPanel).find((p) => !panelsBefore.has(p) && isVisible(p)) ?? null,
          { timeoutMs: attempt === 1 ? 2500 : 4e3, what: "menu to open" }
        );
      } catch (e) {
        if (attempt >= 2) throw e;
        await closeMenus();
        await sleep(400);
      }
    }
  }
  function menuItems(menu) {
    return $$(SEL.menuItem, menu).map((el2) => ({
      el: el2,
      label: (textOf($(SEL.menuItemText, el2)) || textOf(el2)).toLowerCase()
    }));
  }
  async function clickMenuItemOptional(menu, labels) {
    const items = menuItems(menu);
    for (const wanted of labels) {
      const hit = items.find((i) => i.label === wanted) ?? items.find((i) => i.label.includes(wanted));
      if (hit) {
        realClick(hit.el);
        await sleep(150);
        return true;
      }
    }
    return false;
  }
  async function clickMenuItem(menu, labels) {
    const ok = await clickMenuItemOptional(menu, labels);
    if (!ok) {
      await closeMenus();
      throw new Error(`Menu item not found: ${labels.join(" / ")}`);
    }
  }
  async function closeMenus() {
    pressEscapeCompat();
    const backdrop = $(".cdk-overlay-backdrop");
    backdrop?.click();
    await sleep(150);
  }
  async function confirmDialogIfAny() {
    let dialog = null;
    try {
      dialog = await waitFor(() => $$(SEL.dialogContainer).find(isVisible) ?? null, {
        timeoutMs: 2e3,
        what: "confirm dialog"
      });
    } catch {
      return;
    }
    const buttons = $$("button", dialog);
    const isCancel = (t) => LABELS.cancelish.some((c) => t === c || t.startsWith(c));
    const affirmative = buttons.find((b) => LABELS.confirm.some((c) => textOf(b).toLowerCase() === c)) ?? buttons.filter((b) => !isCancel(textOf(b).toLowerCase())).pop();
    if (!affirmative) throw new Error("Confirm dialog appeared but no affirmative button found");
    affirmative.click();
    await sleep(300);
  }
  function currentNotebookId() {
    const m = location.pathname.match(/\/notebook\/([a-f0-9-]+)/i);
    return m ? m[1] : null;
  }

  // src/lib/dedupe.ts
  var TRACKING_PARAMS = [
    /^utm_/i,
    /^fbclid$/i,
    /^gclid$/i,
    /^dclid$/i,
    /^msclkid$/i,
    /^mc_(cid|eid)$/i,
    /^igshid$/i,
    /^si$/i,
    // youtube share tracking
    /^ref(_src|_url)?$/i,
    /^source$/i,
    /^_hs(enc|mi)$/i
  ];
  function isTrackingParam(name) {
    return TRACKING_PARAMS.some((re) => re.test(name));
  }
  function normalizeUrl(raw) {
    let u;
    try {
      u = new URL(raw.trim());
    } catch {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    let host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      if (id) return `youtube:${id}`;
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      const id = u.searchParams.get("v") ?? (u.pathname.startsWith("/shorts/") ? u.pathname.split("/")[2] : null);
      if (id) return `youtube:${id}`;
    }
    const params = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (!isTrackingParam(k)) params.push([k, v]);
    }
    params.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
    let path = u.pathname.replace(/\/+$/, "");
    if (path === "") path = "/";
    return `${host}${path}${query}`;
  }
  function normalizeTitle2(title) {
    return title.toLowerCase().replace(/\s+/g, " ").trim().replace(/\.(pdf|docx?|txt|md|epub|pptx?|csv)$/i, "").trim();
  }
  function findDuplicateGroups(sources) {
    const byUrl = /* @__PURE__ */ new Map();
    const byTitle = /* @__PURE__ */ new Map();
    for (const s of sources) {
      const nUrl = s.url ? normalizeUrl(s.url) : null;
      if (nUrl) {
        const list = byUrl.get(nUrl) ?? [];
        list.push(s);
        byUrl.set(nUrl, list);
      } else {
        const nTitle = normalizeTitle2(s.title);
        if (!nTitle) continue;
        const list = byTitle.get(nTitle) ?? [];
        list.push(s);
        byTitle.set(nTitle, list);
      }
    }
    const groups = [];
    for (const [key, list] of byUrl) {
      if (list.length > 1) groups.push({ matchedOn: "url", key, sources: list });
    }
    for (const [key, list] of byTitle) {
      if (list.length > 1) groups.push({ matchedOn: "title", key, sources: list });
    }
    return groups;
  }

  // src/lib/queue.ts
  var MAX_ATTEMPTS = 2;
  function createBatch(args) {
    return {
      batchId: args.batchId,
      notebookId: args.notebookId,
      status: "idle",
      createdAt: args.now ?? Date.now(),
      jobs: args.sources.map((s, i) => ({
        id: `${args.batchId}:${i}`,
        sourceId: s.id,
        sourceTitle: s.title,
        artifactType: args.artifactType,
        state: "pending",
        attempts: 0
      }))
    };
  }
  function nextPending(batch) {
    return batch.jobs.find((j) => j.state === "pending") ?? null;
  }
  function startJob(batch, jobId) {
    return update(batch, jobId, (j) => {
      if (j.state !== "pending") throw new Error(`cannot start job in state ${j.state}`);
      return { ...j, state: "generating", attempts: j.attempts + 1 };
    }, { status: "running" });
  }
  function completeJob(batch, jobId, artifactId) {
    const next = update(batch, jobId, (j) => {
      if (j.state !== "generating") throw new Error(`cannot complete job in state ${j.state}`);
      return { ...j, state: "done", artifactId };
    });
    return finalizeIfDone(next);
  }
  function failJob(batch, jobId, error) {
    const next = update(batch, jobId, (j) => {
      if (j.state !== "generating") throw new Error(`cannot fail job in state ${j.state}`);
      return j.attempts < MAX_ATTEMPTS ? { ...j, state: "pending", error } : { ...j, state: "failed", error };
    });
    return finalizeIfDone(next);
  }
  function pauseForRateLimit(batch, jobId) {
    return update(batch, jobId, (j) => {
      if (j.state !== "generating") throw new Error(`cannot pause job in state ${j.state}`);
      return { ...j, state: "pending", attempts: Math.max(0, j.attempts - 1) };
    }, { status: "paused_rate_limit" });
  }
  function resume(batch) {
    if (batch.status !== "paused_rate_limit") return batch;
    return { ...batch, status: "running" };
  }
  function summary(batch) {
    const s = { total: batch.jobs.length, done: 0, failed: 0, pending: 0, generating: 0 };
    for (const j of batch.jobs) {
      if (j.state === "done") s.done++;
      else if (j.state === "failed") s.failed++;
      else if (j.state === "pending") s.pending++;
      else s.generating++;
    }
    return s;
  }
  function finalizeIfDone(batch) {
    const open = batch.jobs.some((j) => j.state === "pending" || j.state === "generating");
    return open ? batch : { ...batch, status: "finished" };
  }
  function update(batch, jobId, fn, patch) {
    const idx = batch.jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) throw new Error(`unknown job ${jobId}`);
    const jobs = batch.jobs.slice();
    jobs[idx] = fn(jobs[idx]);
    return { ...batch, jobs, ...patch ?? {} };
  }

  // src/content/batch.ts
  var running = false;
  var cancelRequested = false;
  function isRunning() {
    return running;
  }
  function requestCancel() {
    cancelRequested = true;
  }
  async function loadSavedBatch(notebookId) {
    return getLocal(KEYS.batch(notebookId), null);
  }
  async function clearBatch(notebookId) {
    await setLocal(KEYS.batch(notebookId), null);
  }
  async function startNewBatch(args) {
    const batch = createBatch({
      batchId: `batch-${Date.now()}`,
      notebookId: args.notebookId,
      artifactType: args.artifactType,
      sources: args.sources
    });
    await runBatch(batch, args.renameToSource, args.choices, args.events);
  }
  async function resumeBatch(saved, events) {
    await runBatch(resume(saved), saved.renameToSource ?? true, saved.choices, events);
  }
  async function runBatch(batch, renameToSource, choices, events) {
    if (running)
      throw new Error("A batch is already running \u2014 press \u201CStop after current job\u201D in the queue panel (bottom right) or wait for it to finish.");
    running = true;
    cancelRequested = false;
    const settings2 = await loadSettings();
    const persist = (b) => setLocal(KEYS.batch(b.notebookId), { ...b, renameToSource, choices });
    try {
      batch = { ...batch, status: "running" };
      await persist(batch);
      events.onUpdate(batch);
      let index = 0;
      for (; ; ) {
        if (cancelRequested) {
          batch = { ...batch, status: "idle" };
          await persist(batch);
          events.onUpdate(batch);
          notify("Batch stopped", "Remaining jobs were not started. You can resume from the queue panel.");
          return;
        }
        const job = nextPending(batch);
        if (!job) break;
        index++;
        batch = startJob(batch, job.id);
        await persist(batch);
        events.onUpdate(batch);
        try {
          await waitForStableArtifacts();
          await applySourceSelection(/* @__PURE__ */ new Set([job.sourceId, job.sourceTitle]));
          const res = await generateArtifactInteractive(
            job.artifactType,
            choices ?? null,
            () => events.onNotice?.(
              "NotebookLM is asking for options \u2014 pick them and press Generate. They'll be reused for the rest of this batch."
            )
          );
          if (res.recordedChoices) choices = res.recordedChoices;
          const artifactId = res.id;
          batch = completeJob(batch, job.id, artifactId);
          if (renameToSource) {
            const name = applyTemplate(settings2.template, {
              source: job.sourceTitle,
              type: job.artifactType,
              date: /* @__PURE__ */ new Date(),
              n: index
            });
            await addPendingRename({
              notebookId: batch.notebookId,
              artifactId,
              name,
              createdAt: Date.now()
            });
            tryApplyRenames();
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/BATCH_CANCELLED/.test(msg)) {
            batch = { ...failJob(batch, job.id, "cancelled \u2014 options dialog closed without generating"), status: "idle" };
            await persist(batch);
            events.onUpdate(batch);
            events.onNotice?.("Batch cancelled \u2014 the options dialog was closed without generating. No further jobs were started.");
            return;
          }
          if (/NotebookLM says:/.test(msg)) {
            batch = pauseForRateLimit(batch, job.id);
            await persist(batch);
            events.onUpdate(batch);
            notify("Batch paused", msg);
            return;
          }
          batch = failJob(batch, job.id, msg);
          console.warn(`[nblm-qol] job failed (${job.sourceTitle}):`, msg);
        }
        await persist(batch);
        events.onUpdate(batch);
        await sleep(1500);
      }
      await persist(batch);
      events.onUpdate(batch);
      const s = summary(batch);
      notify(
        "Batch generation started",
        `${s.done}/${s.total} generations kicked off${s.failed ? `, ${s.failed} failed` : ""}. Renaming happens automatically as they finish.`
      );
    } finally {
      running = false;
      cancelRequested = false;
    }
  }
  function notify(title, message) {
    try {
      chrome.runtime.sendMessage({ type: "notify", title, message });
    } catch {
    }
  }
  async function addPendingRename(r) {
    const all = await getLocal(KEYS.renames, []);
    all.push(r);
    await setLocal(KEYS.renames, all);
  }
  async function queueRename(notebookId, artifactId, name) {
    await addPendingRename({ notebookId, artifactId, name, createdAt: Date.now() });
    tryApplyRenames();
  }
  async function clearPendingRenames(notebookId) {
    const all = await getLocal(KEYS.renames, []);
    const keep = all.filter((r) => r.notebookId !== notebookId);
    await setLocal(KEYS.renames, keep);
    return all.length - keep.length;
  }
  var renameTimer;
  var applyingRenames = false;
  function startRenameLoop() {
    if (renameTimer != null) return;
    renameTimer = setInterval(tryApplyRenames, 25e3);
    tryApplyRenames();
  }
  async function tryApplyRenames() {
    if (applyingRenames || running) return;
    applyingRenames = true;
    try {
      const notebookId = currentNotebookId();
      if (!notebookId) return;
      const all = await getLocal(KEYS.renames, []);
      const dayAgo = Date.now() - 24 * 3600 * 1e3;
      const keep = [];
      let changed = false;
      for (const r of all) {
        if (r.createdAt < dayAgo) {
          changed = true;
          continue;
        }
        if (r.notebookId !== notebookId) {
          keep.push(r);
          continue;
        }
        const artifact = findArtifact(r.artifactId);
        if (!artifact) {
          keep.push(r);
          continue;
        }
        if (artifact.title === r.name) {
          changed = true;
          continue;
        }
        if (/^generating\b/i.test(artifact.title)) {
          keep.push(r);
          continue;
        }
        try {
          await renameArtifact(r.artifactId, r.name);
          changed = true;
          await sleep(400);
        } catch {
          keep.push(r);
        }
      }
      if (changed || keep.length !== all.length) await setLocal(KEYS.renames, keep);
    } finally {
      applyingRenames = false;
    }
  }
  async function pendingRenameCount(notebookId) {
    const all = await getLocal(KEYS.renames, []);
    return all.filter((r) => r.notebookId === notebookId).length;
  }

  // src/content/registry.ts
  var DEBUG = false;
  var dbg = (...args) => {
    if (DEBUG) console.info("[nblm-qol][registry]", ...args);
  };
  var artifacts = /* @__PURE__ */ new Map();
  function get(id) {
    return artifacts.get(id) ?? null;
  }
  function size() {
    return artifacts.size;
  }
  function sourceNamesFor(artifactId) {
    const a = artifacts.get(artifactId);
    if (!a || a.sourceIds.length === 0) return null;
    const byId = /* @__PURE__ */ new Map();
    for (const s of listSources()) if (s.id && s.title) byId.set(s.id, s.title);
    const names = a.sourceIds.map((id) => byId.get(id)).filter((x) => !!x);
    return names.length > 0 ? names : null;
  }
  var expectation = null;
  function armAutoRename(notebookId, template, typeLabel) {
    expectation = {
      notebookId,
      template,
      typeLabel: typeLabel ?? null,
      priorIds: /* @__PURE__ */ new Set([...artifacts.keys(), ...artifactIds()]),
      expectedSourceIds: null,
      renamed: /* @__PURE__ */ new Set(),
      n: 0,
      expiresAt: Date.now() + 30 * 60 * 1e3
    };
    dbg(`auto-rename armed (${expectation.priorIds.size} pre-existing artifacts excluded)`);
  }
  function disarmAutoRename() {
    expectation = null;
  }
  function processExpectation() {
    if (!expectation) return;
    if (Date.now() > expectation.expiresAt) {
      expectation = null;
      return;
    }
    for (const a of artifacts.values()) {
      if (expectation.priorIds.has(a.id) || expectation.renamed.has(a.id)) continue;
      if (a.sourceIds.length !== 1) continue;
      if (expectation.expectedSourceIds && !expectation.expectedSourceIds.has(a.sourceIds[0])) continue;
      const names = sourceNamesFor(a.id);
      if (!names) {
        dbg(`auto-rename: artifact ${a.id.slice(0, 8)} source id not resolvable in Sources panel yet - will retry`);
        continue;
      }
      expectation.renamed.add(a.id);
      expectation.n++;
      const name = applyTemplate(expectation.template, {
        source: names[0],
        type: expectation.typeLabel ?? a.type,
        date: /* @__PURE__ */ new Date(),
        n: expectation.n
      });
      dbg(`auto-rename: ${a.id.slice(0, 8)} "${a.title}" -> "${name}"`);
      void queueRename(expectation.notebookId, a.id, name);
    }
  }
  function init() {
    window.addEventListener("nblmqol-artifacts", (e) => {
      const detail = e.detail;
      let added = 0;
      for (const a of detail?.artifacts ?? []) {
        if (a && typeof a.id === "string" && a.id) {
          artifacts.set(a.id, a);
          added++;
        }
      }
      dbg(`update: ${added} artifact(s) received, total known: ${artifacts.size}`);
      processExpectation();
    });
    window.addEventListener("nblmqol-split-start", (e) => {
      const ids = (e.detail?.sourceIds ?? []).filter((x) => typeof x === "string");
      if (expectation && ids.length > 0) expectation.expectedSourceIds = new Set(ids);
    });
  }

  // src/content/ui.ts
  window.addEventListener("nblmqol-split-start", (e) => {
    const k = (e.detail?.sourceIds ?? []).length;
    if (k > 1) {
      toast(`\u26A1 Splitting your request into ${k} per-source generations\u2026`);
      showNetBatchPanel(k);
    }
  });
  window.addEventListener("nblmqol-split-done", (e) => {
    const d = e.detail ?? {};
    removeNetBatchPanel();
    if (d.aborted)
      toast(
        `Batch cancelled \u2014 ${d.succeeded ?? 0}/${d.total ?? 0} request(s) had already been sent (those keep generating and still get renamed).`
      );
    else if ((d.total ?? 0) > 1) toast(`\u26A1 Started ${d.succeeded}/${d.total} generations. Renames apply automatically as items finish.`);
  });
  function showNetBatchPanel(total) {
    removeNetBatchPanel();
    const panel = el("div", "", "");
    panel.id = "nblmqol-netbatch";
    panel.append(
      el("span", "", `\u26A1 Batch: sending ${total} generation requests\u2026`),
      btn(
        "Cancel remaining",
        () => {
          window.dispatchEvent(new CustomEvent("nblmqol-split-abort"));
          removeNetBatchPanel();
        },
        "nblmqol-danger"
      )
    );
    document.body.appendChild(panel);
    window.setTimeout(removeNetBatchPanel, 3 * 60 * 1e3);
  }
  function removeNetBatchPanel() {
    document.getElementById("nblmqol-netbatch")?.remove();
  }
  var lastSplitStartAt = 0;
  window.addEventListener("nblmqol-split-start", () => {
    lastSplitStartAt = Date.now();
  });
  var settings;
  async function initUi(s) {
    settings = s;
  }
  function updateSettings(s) {
    settings = s;
  }
  var selectedArtifacts = /* @__PURE__ */ new Set();
  var missingSince = /* @__PURE__ */ new Map();
  function ensureStudioUi() {
    if (!settings?.features.studioBulk) return;
    const items = listArtifacts();
    if (items.length === 0) return;
    for (const a of items) {
      if (!a.id || a.el.querySelector(".nblmqol-check")) continue;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "nblmqol-check";
      box.title = "Select for bulk actions (NotebookLM QoL)";
      box.checked = selectedArtifacts.has(a.id);
      const id = a.id;
      box.addEventListener("click", (e) => e.stopPropagation());
      box.addEventListener("change", () => {
        if (box.checked) selectedArtifacts.add(id);
        else selectedArtifacts.delete(id);
        a.el.classList.toggle("nblmqol-selected", box.checked);
        updateBulkBar();
      });
      a.el.classList.add("nblmqol-host");
      const zone = document.createElement("label");
      zone.className = "nblmqol-checkzone";
      zone.addEventListener("click", (e) => e.stopPropagation());
      zone.appendChild(box);
      a.el.appendChild(zone);
    }
    const ids = artifactIds();
    const now = Date.now();
    for (const id of [...selectedArtifacts]) {
      if (ids.has(id)) {
        missingSince.delete(id);
        continue;
      }
      const since = missingSince.get(id) ?? now;
      missingSince.set(id, since);
      if (now - since > 1e4) {
        selectedArtifacts.delete(id);
        missingSince.delete(id);
      }
    }
    ensureBulkBar();
    ensureStudioHeader();
    ensureBatchButton();
  }
  function ensureBulkBar() {
    const total = listArtifacts().filter((a) => a.id).length;
    let bar = $("#nblmqol-bulkbar");
    if (total === 0) {
      bar?.remove();
      for (const p of $$(".nblmqol-padscroll")) p.classList.remove("nblmqol-padscroll");
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "nblmqol-bulkbar";
      const count = el("span", "nblmqol-count", "");
      const actions = el("span", "nblmqol-bulkactions", "");
      actions.append(
        btn("Download", () => bulkDownload()),
        ...ENABLE_BULK_RENAME ? [btn("Rename by source", () => bulkRename(), "nblmqol-teal")] : [],
        btn("Delete", () => bulkDelete(), "nblmqol-danger"),
        btn("\u2715", () => clearSelection(), "nblmqol-ghost")
      );
      bar.append(count, actions);
      document.body.appendChild(bar);
    }
    updateBulkBar();
    padStudioList();
  }
  function padStudioList() {
    const bar = $("#nblmqol-bulkbar");
    const item = $(SEL.artifactItem);
    let target = null;
    if (bar && item) {
      let n = item.parentElement;
      while (n && n !== document.body) {
        const cs = getComputedStyle(n);
        if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
          target = n;
          break;
        }
        n = n.parentElement;
      }
      if (!target) target = item.parentElement;
    }
    for (const p of $$(".nblmqol-padscroll")) if (p !== target) p.classList.remove("nblmqol-padscroll");
    target?.classList.add("nblmqol-padscroll");
  }
  function updateBulkBar() {
    const sel = selectedArtifacts.size;
    const total = Math.max(artifactIds().size, sel);
    const setBox = (box) => {
      if (!box) return;
      box.checked = total > 0 && sel === total;
      box.indeterminate = sel > 0 && sel < total;
    };
    const bar = $("#nblmqol-bulkbar");
    if (bar) {
      const count = bar.querySelector(".nblmqol-count");
      if (count) count.textContent = sel > 0 ? `${sel}/${total} selected` : `${total} outputs`;
      bar.classList.toggle("nblmqol-empty", sel === 0);
    }
    const head = document.getElementById("nblmqol-studiohead");
    if (head) {
      setBox(head.querySelector("#nblmqol-selectall-top"));
      const count = head.querySelector(".nblmqol-count");
      if (count) count.textContent = sel > 0 ? `${sel}/${total} selected` : "";
      refreshPendingBadge();
    }
  }
  function setAllOutputs(on) {
    for (const a of listArtifacts()) {
      if (!a.id) continue;
      if (on) selectedArtifacts.add(a.id);
      else selectedArtifacts.delete(a.id);
      a.el.classList.toggle("nblmqol-selected", on);
      const rb = a.el.querySelector(".nblmqol-check");
      if (rb) rb.checked = on;
    }
    updateBulkBar();
  }
  var lastPendingCheck = 0;
  function refreshPendingBadge() {
    const now = Date.now();
    if (now - lastPendingCheck < 5e3) return;
    lastPendingCheck = now;
    const notebookId = currentNotebookId();
    const b = document.getElementById("nblmqol-pendbtn");
    if (!notebookId || !b) return;
    void pendingRenameCount(notebookId).then((n) => {
      b.style.display = n > 0 ? "" : "none";
      b.textContent = `\u2715 ${n} queued rename(s)`;
      b.title = "Cancel all queued renames for this notebook";
    });
  }
  async function cancelQueuedRenames() {
    const notebookId = currentNotebookId();
    if (!notebookId) return;
    const n = await clearPendingRenames(notebookId);
    toast(`Cancelled ${n} queued rename(s)`);
    lastPendingCheck = 0;
    refreshPendingBadge();
  }
  function ensureStudioHeader() {
    const firstItem = $(SEL.artifactItem);
    const listParent = firstItem?.parentElement;
    let head = document.getElementById("nblmqol-studiohead");
    if (!listParent) {
      head?.remove();
      return;
    }
    if (!head) {
      head = el("div", "", "");
      head.id = "nblmqol-studiohead";
      const lab = el("label", "", "");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.id = "nblmqol-selectall-top";
      lab.append(box, el("span", "", "Select all outputs"));
      const pend = btn("", () => void cancelQueuedRenames(), "nblmqol-ghost nblmqol-mini");
      pend.id = "nblmqol-pendbtn";
      pend.style.display = "none";
      head.append(lab, el("span", "nblmqol-count", ""), pend);
      lab.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const total = artifactIds().size;
        const on = total === 0 ? true : selectedArtifacts.size < total;
        setTimeout(() => setAllOutputs(on), 0);
      });
    }
    if (!head.isConnected || head.parentElement !== listParent) listParent.insertBefore(head, listParent.firstChild);
  }
  function clearSelection() {
    selectedArtifacts.clear();
    for (const a of listArtifacts()) {
      a.el.classList.remove("nblmqol-selected");
      const box = a.el.querySelector(".nblmqol-check");
      if (box) box.checked = false;
    }
    updateBulkBar();
  }
  async function bulkDownload() {
    const ids = [...selectedArtifacts];
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    let i = 0;
    toast(
      `Starting ${ids.length} download(s)\u2026 keep this tab open. If Chrome asks to allow multiple downloads, choose Allow!`
    );
    for (const id of ids) {
      i++;
      const a = findArtifact(id);
      const reg = get(id);
      if (reg?.downloadUrl && reg.status === "completed") {
        const name = a?.title || reg.title || "NotebookLM output";
        const resp = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ type: "directDownload", url: reg.downloadUrl, name }, (r) => {
              void chrome.runtime.lastError;
              resolve(r);
            });
          } catch {
            resolve(void 0);
          }
        });
        if (resp?.ok) {
          ok++;
          if (i < ids.length) await sleep(500);
          continue;
        }
      }
      if (!a) {
        failed++;
        toast("A selected output is not in the list right now (still generating?) - skipped");
        continue;
      }
      let done = false;
      for (let attempt = 1; attempt <= 2 && !done; attempt++) {
        try {
          chrome.runtime.sendMessage({ type: "expectDownload", name: a.title });
          await downloadArtifact(id);
          ok++;
          done = true;
        } catch (e) {
          await closeMenus();
          const m = e.message;
          if (/No Download option/i.test(m)) {
            skipped++;
            done = true;
            toast(`\u201C${a.title}\u201D (${a.type}) has no download option in NotebookLM \u2014 skipped`);
          } else if (attempt === 2) {
            failed++;
            toast(`Download failed for \u201C${a.title}\u201D: ${m}`);
          } else await sleep(1500);
        }
      }
      if (i < ids.length) await sleep(6e3);
    }
    const bits = [`Triggered ${ok}/${ids.length} download(s)`];
    if (skipped) bits.push(`${skipped} skipped (no download option)`);
    if (failed) bits.push(`${failed} failed`);
    toast(bits.join(", "));
  }
  var ENABLE_BULK_RENAME = true;
  async function bulkRename() {
    const all = listArtifacts().filter((a) => a.id && selectedArtifacts.has(a.id));
    const items = all.filter((a) => !/^generating\b/i.test(a.title));
    const skippedGen = all.length - items.length;
    if (items.length === 0) {
      toast("All selected outputs are still generating \u2014 try again when they finish.");
      return;
    }
    if (size() === 0) {
      toast("No source data captured yet \u2014 reload the page, let the outputs list load, then try again.");
      return;
    }
    if (items.length > 3 && !window.confirm(
      `Rename ${items.length} outputs to their source names using the template \u201C${settings.template}\u201D?

Queued renames keep applying even after a reload \u2014 you can cancel them from the header above the outputs list.`
    ))
      return;
    const notebookId = currentNotebookId();
    await waitForStableArtifacts().catch(() => void 0);
    let n = 0;
    let ok = 0;
    let queued = 0;
    let fromTitle = 0;
    for (const a of items) {
      n++;
      let sourceName = a.title;
      const srcs = sourceNamesFor(a.id);
      if (srcs && srcs.length > 0) sourceName = srcs.length === 1 ? srcs[0] : `${srcs[0]} +${srcs.length - 1}`;
      else fromTitle++;
      const name = applyTemplate(settings.template, { source: sourceName, type: a.type, date: /* @__PURE__ */ new Date(), n });
      console.info(`[nblm-qol][rename] ${n}/${items.length} id=${a.id} "${a.title}" sources=${JSON.stringify(srcs)} -> "${name}"`);
      try {
        await renameArtifact(a.id, name);
        ok++;
        await sleep(600);
      } catch (e1) {
        console.warn(`[nblm-qol][rename] attempt 1 failed for "${name}": ${e1.message} - retrying once`);
        await sleep(1200);
        try {
          await renameArtifact(a.id, name);
          ok++;
          await sleep(600);
        } catch (e2) {
          console.warn(`[nblm-qol][rename] attempt 2 failed for "${name}": ${e2.message} - queueing`);
          if (notebookId) {
            await queueRename(notebookId, a.id, name);
            queued++;
          }
        }
      }
    }
    const bits = [`Renamed ${ok}/${items.length}`];
    if (queued > 0) bits.push(`${queued} queued (applies automatically when ready)`);
    if (fromTitle > 0) bits.push(`${fromTitle} kept their current title (source not in the registry)`);
    if (skippedGen > 0) bits.push(`${skippedGen} still generating \u2014 skipped`);
    toast(bits.join(", "));
    clearSelection();
  }
  async function bulkDelete() {
    const items = listArtifacts().filter((a) => a.id && selectedArtifacts.has(a.id));
    const names = items.map((a) => `\u2022 ${a.title}`).join("\n");
    if (!window.confirm(`Delete ${items.length} Studio item(s)?

${names}`)) return;
    let ok = 0;
    for (const a of items) {
      try {
        await deleteArtifact(a.id);
        ok++;
        await sleep(500);
      } catch (e) {
        toast(`Delete failed for \u201C${a.title}\u201D: ${e.message}`);
      }
    }
    toast(`Deleted ${ok}/${items.length}`);
    clearSelection();
  }
  function ensureBatchButton() {
    if (!settings?.features.batchGenerate) return;
    const hosts = $$(SEL.createButtonHost);
    if (hosts.length === 0 || $("#nblmqol-batchbtn")) return;
    const grid = hosts[0].parentElement;
    if (!grid) return;
    const b = document.createElement("button");
    b.id = "nblmqol-batchbtn";
    b.type = "button";
    b.textContent = "\u26A1 Batch generate\u2026";
    b.title = "Generate one Studio item per source (NotebookLM QoL)";
    b.addEventListener("click", () => {
      openBatchModal().catch((e) => toast(e.message));
    });
    grid.after(b);
  }
  async function openBatchModal() {
    $("#nblmqol-modal")?.remove();
    const sources = listSources().filter((s) => s.title);
    const types = listCreateOptions();
    if (sources.length === 0) {
      toast("No sources found in this notebook.");
      return;
    }
    const overlay = el("div", "", "");
    overlay.id = "nblmqol-modal";
    const card = el("div", "nblmqol-card", "");
    overlay.appendChild(card);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    card.appendChild(el("h3", "", "Batch generate \u2014 one per source"));
    const typeRow = el("div", "nblmqol-row", "");
    typeRow.appendChild(el("label", "", "Type"));
    const select = document.createElement("select");
    for (const t of types) {
      const o = document.createElement("option");
      o.value = t.label;
      o.textContent = t.label;
      select.appendChild(o);
    }
    const lastType = await getLocal(KEYS.lastType, "");
    if (lastType && types.some((t) => t.label === lastType)) select.value = lastType;
    typeRow.appendChild(select);
    card.appendChild(typeRow);
    card.appendChild(
      el(
        "p",
        "nblmqol-hint",
        "After Start batch, NotebookLM's own options dialog opens ONCE. Everything you set there \u2014 format, language, custom prompt (focus, topic, slide deck description\u2026) \u2014 applies to EVERY item: your single Generate press is split into one generation per source."
      )
    );
    const nativeChecked = sources.filter((s) => s.checked);
    const mirror = nativeChecked.length > 0 && nativeChecked.length < sources.length;
    const listWrap = el("div", "nblmqol-sourcelist", "");
    const allRow = el("label", "nblmqol-source nblmqol-selectall", "");
    const allBox = document.createElement("input");
    allBox.type = "checkbox";
    allBox.checked = !mirror;
    allRow.append(allBox, el("span", "", "Select all"));
    listWrap.appendChild(allRow);
    const rowBoxes = [];
    for (const s of sources) {
      const row = el("label", "nblmqol-source", "");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = mirror ? s.checked : true;
      row.append(box, el("span", "", s.title));
      listWrap.appendChild(row);
      rowBoxes.push({ box, source: s });
    }
    const syncAllBox = () => {
      allBox.checked = rowBoxes.every((r) => r.box.checked);
    };
    allBox.addEventListener("change", () => rowBoxes.forEach((r) => r.box.checked = allBox.checked));
    rowBoxes.forEach((r) => r.box.addEventListener("change", syncAllBox));
    card.appendChild(listWrap);
    if (mirror) card.appendChild(el("p", "nblmqol-hint", "Pre-selected to match the sources checked in the Sources panel."));
    const renamePref = await getLocal(KEYS.renamePref, true);
    const renameRow = el("label", "nblmqol-row nblmqol-toggle", "");
    const renameBox = document.createElement("input");
    renameBox.type = "checkbox";
    renameBox.checked = renamePref;
    renameRow.append(renameBox, el("span", "", `Rename results using template (\u201C${settings.template}\u201D)`));
    card.appendChild(renameRow);
    const legacyRow = el("label", "nblmqol-row nblmqol-toggle", "");
    const legacyBox = document.createElement("input");
    legacyBox.type = "checkbox";
    legacyBox.checked = false;
    legacyRow.append(legacyBox, el("span", "", "Legacy mode (old click engine \u2014 only if the new mode fails; no language/custom prompt support)"));
    card.appendChild(legacyRow);
    card.appendChild(
      el(
        "p",
        "nblmqol-hint",
        "Requests are sent ~1.5s apart; generation continues in NotebookLM's own queue. Closing the options dialog without pressing Generate cancels the batch."
      )
    );
    const actions = el("div", "nblmqol-actions", "");
    actions.append(
      btn("Cancel", () => overlay.remove(), "nblmqol-ghost"),
      btn("Start batch", async () => {
        const chosen = rowBoxes.filter((r) => r.box.checked).map((r) => ({
          id: r.source.id ?? r.source.title,
          title: r.source.title
        }));
        if (chosen.length === 0) {
          toast("Pick at least one source.");
          return;
        }
        const notebookId = currentNotebookId();
        if (!notebookId) {
          toast("Could not detect notebook id from URL.");
          return;
        }
        await setLocal(KEYS.renamePref, renameBox.checked);
        await setLocal(KEYS.lastType, select.value);
        const legacy = legacyBox.checked;
        overlay.remove();
        if (legacy) {
          try {
            await startNewBatch({
              notebookId,
              artifactType: select.value,
              sources: chosen,
              renameToSource: renameBox.checked,
              events: { onUpdate: renderQueuePanel, onNotice: toast }
            });
          } catch (e) {
            toast(e.message);
          }
          return;
        }
        try {
          console.info(`[nblm-qol][batch] network batch: type="${select.value}" sources=${chosen.length}`, chosen.map((c) => c.title));
          await applySourceSelection(new Set(chosen.map((c) => c.id)));
          if (renameBox.checked) armAutoRename(notebookId, settings.template, select.value);
          else disarmAutoRename();
          const armedAt = Date.now();
          window.dispatchEvent(new CustomEvent("nblmqol-mode", { detail: { split: true } }));
          const res = await openOptionsDialog(select.value);
          if (res.opened) {
            toast(
              `Set the options, language and custom prompt for ${select.value}, then press Generate ONCE \u2014 it runs once per source (${chosen.length}). Closing the dialog cancels.`
            );
            watchDialogForCancel(res.dialog, armedAt);
          } else {
            toast(`${select.value} has no options dialog \u2014 splitting into ${chosen.length} per-source generations\u2026`);
          }
        } catch (e) {
          window.dispatchEvent(new CustomEvent("nblmqol-mode", { detail: { split: false } }));
          disarmAutoRename();
          toast(e.message);
        }
      })
    );
    card.appendChild(actions);
    document.body.appendChild(overlay);
  }
  function watchDialogForCancel(dlg, armedAt) {
    const watch = setInterval(() => {
      if (document.contains(dlg)) return;
      clearInterval(watch);
      setTimeout(() => {
        if (lastSplitStartAt >= armedAt) return;
        console.info("[nblm-qol][batch] dialog closed without generating - batch cancelled");
        window.dispatchEvent(new CustomEvent("nblmqol-mode", { detail: { split: false } }));
        disarmAutoRename();
        toast("Batch cancelled \u2014 the dialog was closed without generating.");
      }, 2e3);
    }, 500);
  }
  function renderQueuePanel(batch) {
    let panel = $("#nblmqol-queue");
    const s = summary(batch);
    const finished = batch.status === "finished";
    const stopped = batch.status === "idle";
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "nblmqol-queue";
      document.body.appendChild(panel);
    }
    panel.innerHTML = "";
    const head = el("div", "nblmqol-queue-head", "");
    const title = finished ? "Batch done" : stopped ? "Batch stopped" : batch.status === "paused_rate_limit" ? "Batch paused (rate limit)" : "Batch running\u2026";
    head.append(
      el("strong", "", title),
      el("span", "nblmqol-count", `${s.done}/${s.total} started${s.failed ? `, ${s.failed} failed` : ""}`)
    );
    const collapseB = btn(
      "\xBB",
      () => {
        queueCollapsed = true;
        applyQueueCollapsed();
      },
      "nblmqol-ghost"
    );
    collapseB.title = "Hide panel (a small tab stays on the right edge)";
    const closeB = btn("\u2715", async () => {
      panel.remove();
      document.getElementById("nblmqol-queue-tab")?.remove();
      if (finished || stopped) await clearBatch(batch.notebookId);
    }, "nblmqol-ghost");
    head.append(collapseB, closeB);
    panel.appendChild(head);
    const list = el("div", "nblmqol-queue-list", "");
    for (const j of batch.jobs) {
      const row = el("div", `nblmqol-job nblmqol-${j.state}`, "");
      const icon = j.state === "done" ? "\u2713" : j.state === "failed" ? "\u2717" : j.state === "generating" ? "\u25CF" : "\u25CB";
      row.append(el("span", "nblmqol-job-icon", icon), el("span", "nblmqol-job-title", j.sourceTitle));
      if (j.error && j.state === "failed") row.title = j.error;
      list.appendChild(row);
    }
    panel.appendChild(list);
    if (batch.status === "running" && isRunning()) {
      panel.appendChild(
        btn("Stop after current job", () => {
          requestCancel();
          toast("Stopping after the current job\u2026");
        }, "nblmqol-danger")
      );
    }
    if (batch.status === "paused_rate_limit" || stopped && s.pending > 0) {
      panel.appendChild(
        btn("Resume", async () => {
          try {
            const saved = await loadSavedBatch(batch.notebookId) ?? batch;
            await resumeBatch(saved, { onUpdate: renderQueuePanel, onNotice: toast });
          } catch (e) {
            toast(e.message);
          }
        })
      );
    }
    applyQueueCollapsed();
  }
  var queueCollapsed = false;
  function applyQueueCollapsed() {
    const panel = $("#nblmqol-queue");
    if (!panel) return;
    panel.classList.toggle("nblmqol-queue-collapsed", queueCollapsed);
    let tab = document.getElementById("nblmqol-queue-tab");
    if (queueCollapsed && !tab) {
      tab = el("button", "", "\xAB Batch");
      tab.id = "nblmqol-queue-tab";
      tab.onclick = () => {
        queueCollapsed = false;
        applyQueueCollapsed();
      };
      document.body.appendChild(tab);
    } else if (!queueCollapsed) {
      tab?.remove();
    }
  }
  async function offerResumeIfNeeded() {
    const notebookId = currentNotebookId();
    if (!notebookId) return;
    const saved = await loadSavedBatch(notebookId);
    if (!saved) return;
    const s = summary(saved);
    if (saved.status === "finished" || s.pending + s.generating === 0) return;
    renderQueuePanel({ ...saved, status: "idle" });
  }
  function ensureSourceUi() {
    if (!settings?.features.sourceBulk) return;
    const sources = listSources();
    const checkedCount = sources.filter((s) => s.checked).length;
    let bar = $("#nblmqol-srcbar");
    const show = sources.length > 0 && checkedCount > 0;
    if (!show) {
      if (bar && !bar.dataset.dupes) bar.remove();
      return;
    }
    const sig = `${checkedCount}/${sources.length}`;
    if (bar && bar.dataset.sig === sig) return;
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "nblmqol-srcbar";
      document.body.appendChild(bar);
    }
    bar.dataset.sig = sig;
    delete bar.dataset.dupes;
    bar.innerHTML = "";
    bar.append(
      el("span", "nblmqol-count", `${checkedCount} source(s) checked`),
      btn("Delete checked", () => bulkDeleteSources(), "nblmqol-danger"),
      btn("Find duplicates", () => showDuplicates(), "nblmqol-ghost")
    );
  }
  async function bulkDeleteSources() {
    const chosen = listSources().filter((s) => s.checked);
    const names = chosen.map((s) => `\u2022 ${s.title}`).join("\n");
    if (!window.confirm(`Remove ${chosen.length} source(s) from this notebook?

${names}`)) return;
    let ok = 0;
    for (const s of chosen) {
      try {
        await deleteSource(s.id ?? s.title);
        ok++;
        await sleep(600);
      } catch (e) {
        toast(`Failed on \u201C${s.title}\u201D: ${e.message}`);
      }
    }
    toast(`Removed ${ok}/${chosen.length} source(s)`);
  }
  async function showDuplicates() {
    const sources = listSources();
    const groups = findDuplicateGroups(
      sources.map((s) => ({ id: s.id ?? s.title, title: s.title }))
    );
    if (groups.length === 0) {
      toast("No duplicate sources found (by title).");
      return;
    }
    const names = [];
    const toDelete = [];
    for (const g of groups) {
      for (const dup of g.sources.slice(1)) {
        toDelete.push(dup.id);
        names.push(`\u2022 ${dup.title}`);
      }
    }
    if (!window.confirm(`Found ${groups.length} duplicate group(s). Remove ${toDelete.length} duplicate(s), keeping the first of each?

${names.join("\n")}`)) return;
    let ok = 0;
    for (const id of toDelete) {
      try {
        await deleteSource(id);
        ok++;
        await sleep(600);
      } catch (e) {
        toast(e.message);
      }
    }
    toast(`Removed ${ok}/${toDelete.length} duplicate(s)`);
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function btn(label, onClick, cls = "") {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `nblmqol-btn ${cls}`.trim();
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }
  var toastTimer;
  function toast(msg) {
    let t = $("#nblmqol-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "nblmqol-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("nblmqol-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("nblmqol-show"), 4e3);
  }

  // src/content/index.ts
  async function main() {
    console.info("[nblm-qol] NotebookLM QoL v1.3.1 active");
    init();
    const settings2 = await loadSettings();
    await initUi(settings2);
    onSettingsChanged((s) => updateSettings(s));
    const scan = debounce(() => {
      try {
        if (currentNotebookId()) {
          ensureStudioUi();
          ensureSourceUi();
        }
      } catch (e) {
        console.warn("[nblm-qol] scan error (feature disabled this tick):", e);
      }
    }, 350);
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        scan();
        if (currentNotebookId()) offerResumeIfNeeded();
      }
    }, 800);
    if (currentNotebookId()) {
      startRenameLoop();
      await offerResumeIfNeeded();
    } else {
      startRenameLoop();
    }
  }
  main().catch((e) => console.warn("[nblm-qol] init failed:", e));
})();
