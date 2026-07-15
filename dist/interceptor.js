"use strict";
(() => {
  // src/content/interceptor.ts
  (() => {
    const STUDIO_RPC = "R7cb6c";
    const POLL_RPC = "gArtLc";
    const TYPE_BY_CODE = {
      1: "Audio Overview",
      2: "Report",
      3: "Video Overview",
      4: "Flashcards",
      // v1.3: quiz & flashcards SHARE code 4 - subtype detected below
      7: "Infographic",
      8: "Slide Deck",
      9: "Data Table",
      10: "Mind Map"
    };
    const DEBUG = false;
    const dbg = (...args) => {
      if (DEBUG) console.info("[nblm-qol][net]", ...args);
    };
    let splitArmed = false;
    let armedAt = 0;
    window.addEventListener("nblmqol-mode", (e) => {
      splitArmed = !!e.detail?.split;
      armedAt = Date.now();
      dbg(splitArmed ? "split mode ARMED" : "split mode disarmed");
    });
    const splitActive = () => splitArmed && Date.now() - armedAt < 10 * 60 * 1e3;
    let splitAborted = false;
    window.addEventListener("nblmqol-split-abort", () => {
      splitAborted = true;
      dbg("split abort requested");
    });
    const emit = (name, detail) => {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const flattenIds = (arr) => {
      const out = [];
      const walk = (x) => {
        if (typeof x === "string") out.push(x);
        else if (Array.isArray(x)) x.forEach(walk);
      };
      walk(arr);
      return [...new Set(out)];
    };
    function parseArtifacts(responseText) {
      const artifacts = [];
      try {
        const clean = responseText.replace(/^\)\]\}'\n?/, "");
        for (const line of clean.split("\n")) {
          if (!line.trim() || /^\d+$/.test(line.trim())) continue;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (!Array.isArray(parsed)) continue;
          for (const item of parsed) {
            if (!Array.isArray(item) || item[0] !== "wrb.fr" || item[1] !== POLL_RPC || typeof item[2] !== "string") continue;
            let data;
            try {
              data = JSON.parse(item[2]);
            } catch {
              continue;
            }
            if (!Array.isArray(data) || !Array.isArray(data[0])) continue;
            for (const a of data[0]) {
              if (!Array.isArray(a) || a.length < 5 || typeof a[0] !== "string") continue;
              const typeCode = a[2];
              let typeLabel = TYPE_BY_CODE[typeCode] ?? `type ${typeCode}`;
              try {
                if (typeCode === 4 && Array.isArray(a[9]) && Array.isArray(a[9][1])) {
                  const sub = a[9][1][0];
                  if (sub === 2) typeLabel = "Quiz";
                  else if (sub === 1) typeLabel = "Flashcards";
                }
              } catch {
              }
              let downloadUrl = null;
              try {
                if (typeCode === 1 && Array.isArray(a[6]) && typeof a[6][3] === "string") downloadUrl = a[6][3];
                if (typeCode === 3 && Array.isArray(a[8]) && typeof a[8][3] === "string") downloadUrl = a[8][3];
                if (typeCode === 7 && Array.isArray(a[14])) {
                  const img = a[14][2]?.[0];
                  if (Array.isArray(img) && Array.isArray(img[1]) && typeof img[1][0] === "string") downloadUrl = img[1][0];
                }
                if (typeCode === 8 && Array.isArray(a[16])) {
                  if (typeof a[16][0] === "string" && a[16][0].startsWith("http")) downloadUrl = a[16][0];
                  else if (typeof a[16][3] === "string") downloadUrl = a[16][3];
                }
              } catch {
              }
              artifacts.push({
                id: a[0],
                title: typeof a[1] === "string" ? a[1] : "",
                type: typeLabel,
                status: a[4] === 1 ? "in_progress" : a[4] === 3 ? "completed" : `status ${a[4]}`,
                sourceIds: flattenIds(a[3]),
                downloadUrl
              });
            }
          }
        }
      } catch {
      }
      return artifacts;
    }
    function tapResponseText(text) {
      if (text.indexOf(POLL_RPC) === -1) return;
      const artifacts = parseArtifacts(text);
      if (artifacts.length > 0) {
        dbg(`poll response: ${artifacts.length} artifact(s)`, artifacts.map((a) => `${a.id.slice(0, 8)} "${a.title}" [${a.status}] sources=${a.sourceIds.length}`));
        emit("nblmqol-artifacts", { artifacts });
      }
    }
    function parseStudioRequest(bodyText) {
      try {
        const m = bodyText.match(/f\.req=([^&]+)/);
        if (!m) return null;
        const outer = JSON.parse(decodeURIComponent(m[1]));
        const rpcArray = Array.isArray(outer[0]) ? outer[0] : outer;
        for (const item of rpcArray) {
          if (!Array.isArray(item) || item[0] !== STUDIO_RPC || typeof item[1] !== "string") continue;
          const params = JSON.parse(item[1]);
          const nested = params?.[2]?.[3];
          const sourceIds = [];
          if (Array.isArray(nested)) {
            for (const n of nested) {
              if (Array.isArray(n) && Array.isArray(n[0]) && typeof n[0][0] === "string") sourceIds.push(n[0][0]);
            }
          }
          if (sourceIds.length > 0) return { sourceIds, outer };
        }
      } catch {
      }
      return null;
    }
    function buildBodyFor(originalBody, parsed, sourceId) {
      const outer = JSON.parse(JSON.stringify(parsed.outer));
      const rpcArray = Array.isArray(outer[0]) ? outer[0] : outer;
      for (const item of rpcArray) {
        if (!Array.isArray(item) || item[0] !== STUDIO_RPC) continue;
        const params = JSON.parse(item[1]);
        if (params?.[2]?.[3]) params[2][3] = [[[sourceId]]];
        if (Array.isArray(params?.[2]?.[6]?.[1]) && params[2][6][1][3]) params[2][6][1][3] = [[sourceId]];
        if (Array.isArray(params?.[2]?.[8]?.[2]) && params[2][8][2][0]) params[2][8][2][0] = [[sourceId]];
        if (Array.isArray(params?.[2]?.[7]?.[1]) && params[2][7][1][3]) params[2][7][1][3] = [[sourceId]];
        item[1] = JSON.stringify(params);
        break;
      }
      return originalBody.replace(/f\.req=[^&]+/, "f.req=" + encodeURIComponent(JSON.stringify(outer)));
    }
    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.indexOf("batchexecute") === -1) return origFetch.call(window, input, init);
      if (splitActive() && url.indexOf(STUDIO_RPC) !== -1 && init?.body) {
        const bodyText = typeof init.body === "string" ? init.body : await new Blob([init.body]).text();
        const parsed = parseStudioRequest(bodyText);
        if (!parsed) dbg("creation request seen but source ids not parseable - passing through unchanged");
        if (parsed) {
          dbg(`splitting fetch creation request into ${parsed.sourceIds.length} single-source request(s)`, parsed.sourceIds);
          splitArmed = false;
          splitAborted = false;
          const ids = parsed.sourceIds;
          emit("nblmqol-split-start", { sourceIds: ids });
          const firstBody = ids.length > 1 ? buildBodyFor(bodyText, parsed, ids[0]) : bodyText;
          const firstResponse = origFetch.call(window, input, Object.assign({}, init, { body: firstBody }));
          void (async () => {
            let succeeded = 0;
            try {
              succeeded = (await firstResponse).ok ? 1 : 0;
            } catch {
            }
            for (let i = 1; i < ids.length; i++) {
              if (splitAborted) {
                dbg(`fan-out aborted by user after ${i}/${ids.length} request(s)`);
                emit("nblmqol-split-done", { succeeded, total: ids.length, sourceIds: ids, aborted: true });
                return;
              }
              await sleep(1500);
              try {
                const r = await origFetch.call(window, input, Object.assign({}, init, { body: buildBodyFor(bodyText, parsed, ids[i]) }));
                if (r.ok) succeeded++;
                dbg(`fan-out ${i + 1}/${ids.length} source=${ids[i]} -> HTTP ${r.status}`);
              } catch (err) {
                dbg(`fan-out ${i + 1}/${ids.length} source=${ids[i]} FAILED`, err);
              }
            }
            dbg(`split done: ${succeeded}/${ids.length} requests accepted`);
            emit("nblmqol-split-done", { succeeded, total: ids.length, sourceIds: ids });
          })();
          return firstResponse;
        }
      }
      const response = await origFetch.call(window, input, init);
      try {
        tapResponseText(await response.clone().text());
      } catch {
      }
      return response;
    };
    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    const origSetHeader = proto.setRequestHeader;
    proto.open = function() {
      this._nqUrl = String(arguments[1] ?? "");
      this._nqHeaders = [];
      return origOpen.apply(this, arguments);
    };
    proto.setRequestHeader = function(name, value) {
      this._nqHeaders?.push([name, value]);
      return origSetHeader.apply(this, arguments);
    };
    proto.send = function(body) {
      const url = this._nqUrl ?? "";
      if (url.indexOf("batchexecute") !== -1) {
        this.addEventListener("load", () => {
          try {
            if (typeof this.responseText === "string") tapResponseText(this.responseText);
          } catch {
          }
        });
        if (splitActive() && url.indexOf(STUDIO_RPC) !== -1 && typeof body === "string") {
          const parsed = parseStudioRequest(body);
          if (parsed) {
            splitArmed = false;
            splitAborted = false;
            const ids = parsed.sourceIds;
            dbg(`splitting XHR creation request into ${ids.length} single-source request(s)`, ids);
            emit("nblmqol-split-start", { sourceIds: ids });
            if (ids.length > 1) {
              const headers = Object.fromEntries(this._nqHeaders ?? []);
              void (async () => {
                let succeeded = 1;
                for (let i = 1; i < ids.length; i++) {
                  if (splitAborted) {
                    dbg(`fan-out aborted by user after ${i}/${ids.length} request(s)`);
                    emit("nblmqol-split-done", { succeeded: Math.max(succeeded, 0), total: ids.length, sourceIds: ids, aborted: true });
                    return;
                  }
                  await sleep(1500);
                  try {
                    const r = await origFetch.call(window, url, {
                      method: "POST",
                      headers,
                      body: buildBodyFor(body, parsed, ids[i]),
                      credentials: "include"
                    });
                    if (!r.ok) succeeded--;
                    else succeeded++;
                    dbg(`fan-out ${i + 1}/${ids.length} source=${ids[i]} -> HTTP ${r.status}`);
                  } catch (err) {
                    dbg(`fan-out ${i + 1}/${ids.length} source=${ids[i]} FAILED`, err);
                  }
                }
                dbg(`split done: ~${Math.max(succeeded, 0)}/${ids.length} requests accepted`);
                emit("nblmqol-split-done", { succeeded: Math.max(succeeded, 0), total: ids.length, sourceIds: ids });
              })();
              return origSend.call(this, buildBodyFor(body, parsed, ids[0]));
            }
            emit("nblmqol-split-done", { succeeded: 1, total: 1, sourceIds: ids });
          }
        }
      }
      return origSend.apply(this, arguments);
    };
    console.info("[nblm-qol] network interceptor active");
  })();
})();
