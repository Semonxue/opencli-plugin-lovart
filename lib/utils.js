import { AuthRequiredError } from "@jackwener/opencli/errors";
import zlib from "zlib";
const LOVART_DOMAIN = "www.lovart.ai";
const LOVART_HOMEPAGE = "https://www.lovart.ai/zh/home";
const LOVART_PROJECTS = "https://www.lovart.ai/zh/projects";
function unwrapEvaluateResult(value) {
  if (value && typeof value === "object" && "session" in value && "data" in value) {
    return value.data;
  }
  return value;
}
const POPOVER_TIMEOUT_MS = 5e3;
async function readLovartMe(page) {
  await page.goto(LOVART_HOMEPAGE);
  await page.wait({ selector: '[data-testid="primaryColumn"], body', timeoutMs: 8e3 });
  const trigger = unwrapEvaluateResult(await page.evaluate(
    `(() => !!document.querySelector('[data-testid="avatar-trigger"]'))()`
  ));
  if (!trigger) {
    throw new AuthRequiredError(LOVART_DOMAIN, "Lovart avatar trigger not found. Are you logged in to lovart.ai?");
  }
  await page.click('[data-testid="avatar-trigger"]');
  let raw = null;
  for (let i = 0; i < POPOVER_TIMEOUT_MS / 250; i++) {
    raw = unwrapEvaluateResult(await page.evaluate(
      `(() => {
                const pop = document.querySelector('[data-testid="avatar-popover-content"]');
                if (!pop) return null;
                const lines = (pop.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
                return lines;
            })()`
    ));
    if (Array.isArray(raw) && raw.length) break;
    await page.wait(0.25);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AuthRequiredError(LOVART_DOMAIN, "Lovart avatar popover did not open. Are you logged in?");
  }
  return [parseMeRows(raw)];
}
function parseMeRows(lines) {
  if (!Array.isArray(lines) || !lines.length) {
    throw new AuthRequiredError(LOVART_DOMAIN, "Lovart popover returned no content.");
  }
  const name = lines[0] || "";
  const email = (lines[1] || "").includes("@") ? lines[1] : "";
  let plan = "";
  let credits = "";
  for (let i = 0; i < lines.length; i++) {
    if (/^\d+$/.test(lines[i])) {
      credits = lines[i];
      for (let j = 0; j < i; j++) {
        if (lines[j] && lines[j] !== name && lines[j] !== email) {
          plan = lines[j];
          break;
        }
      }
      break;
    }
  }
  return {
    name,
    email,
    plan,
    credits,
    profile_url: `${LOVART_DOMAIN}/zh/profile`,
    signout_visible: lines.includes("\u9000\u51FA\u767B\u5F55")
  };
}
async function readLovartProjects(page, { limit = 200 } = {}) {
  await page.goto(LOVART_PROJECTS);
  await page.wait({ selector: "body", timeoutMs: 8e3 });
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 200;
  const rows = await fetchAllProjects(page, safeLimit);
  return rows;
}
const LIST_PAGE_SIZE = 30;
const LIST_BODY = JSON.stringify({ page: 1, pageSize: LIST_PAGE_SIZE });
async function fetchAllProjects(page, limit) {
  const collected = [];
  let pageNum = 1;
  while (collected.length < limit && pageNum < 50) {
    const payload = JSON.stringify({ page: pageNum, pageSize: LIST_PAGE_SIZE });
    const result = unwrapEvaluateResult(await page.evaluate(`
            (async () => {
                const tok = (document.cookie.match(/usertoken=([^;]+)/) || [])[1] || '';
                if (!tok) return { ok: false, error: 'usertoken cookie missing' };
                let resp;
                try {
                    resp = await fetch('/api/canva/project/lovartProjectList?timestamp=' + Date.now(), {
                        method: 'POST',
                        headers: { 'token': tok, 'x-language': 'zh', 'Content-Type': 'application/json' },
                        body: ${JSON.stringify(payload)},
                        credentials: 'include',
                    });
                } catch (e) {
                    return { ok: false, error: 'fetch failed: ' + String(e && e.message || e) };
                }
                if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status, status: resp.status };
                let body;
                try { body = await resp.json(); } catch (e) { return { ok: false, error: 'malformed JSON' }; }
                if (body?.code !== 0 && body?.code !== '0') {
                    return { ok: false, error: 'API code ' + body?.code + ' ' + (body?.msg || '') };
                }
                return {
                    ok: true,
                    items: Array.isArray(body?.data?.data) ? body.data.data : [],
                    total: body?.data?.total || 0,
                    hasMore: Boolean(body?.data?.hasMore),
                };
            })()
        `));
    if (!result || !result.ok) {
      throw new AuthRequiredError(LOVART_DOMAIN, result?.error || "Lovart projects API failed.");
    }
    const items = Array.isArray(result.items) ? result.items : [];
    for (const it of items) {
      if (!it?.projectId || !it?.projectName) continue;
      collected.push(mapListItem(it));
      if (collected.length >= limit) break;
    }
    if (!result.hasMore || items.length === 0) break;
    pageNum++;
  }
  return collected;
}
function mapListItem(it) {
  return {
    id: it.projectId,
    name: it.projectName,
    url: `https://www.lovart.ai/canvas?projectId=${it.projectId}`,
    picCount: it.picCount || 0,
    isFavorite: Boolean(it.isFavorite),
    projectType: it.projectType || 0,
    updated: formatDate(it.updateTime)
  };
}
function formatDate(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
function decompressCanvasData(raw) {
  if (!raw || !raw.startsWith("SHAKKERDATA://")) return null;
  try {
    const b64 = raw.slice("SHAKKERDATA://".length);
    const compressed = Buffer.from(b64, "base64");
    const decompressed = zlibGunzip(compressed);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(decompressed);
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function zlibGunzip(buf) {
  if (buf[0] === 31 && buf[1] === 139) return zlib.gunzipSync(buf);
  return zlib.inflateSync(buf);
}
const LIST_KINDS = /* @__PURE__ */ new Set(["all", "image", "video", "upload"]);
const LIST_KIND_TREE = "all-tree";
const LIST_ALIASES = {
  images: "image",
  videos: "video",
  uploads: "upload",
  trees: "all-tree",
  tree: "all-tree"
};
function resolveListKind(raw) {
  const v = String(raw ?? "").toLowerCase();
  if (!v) return "";
  const normalized = LIST_ALIASES[v] ?? v;
  return LIST_KINDS.has(normalized) ? normalized : "";
}
async function queryProjectFromNode(page, projectId) {
  const wrapped = await page.evaluate(`
        (async () => {
            const tok = (document.cookie.match(/usertoken=([^;]+)/) || [])[1] || '';
            if (!tok) return { ok: false, error: 'usertoken cookie missing' };
            const body = JSON.stringify({ projectId: ${JSON.stringify(projectId)} });
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const resp = await fetch('/api/canva/project/queryProject', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'token': tok,
                            'x-language': 'zh',
                        },
                        body,
                        credentials: 'include',
                    });
                    const json = await resp.json();
                    if (json?.code === 0 || json?.code === '0') {
                        return { ok: true, data: json.data };
                    }
                    if (json?.code === 401 && attempt === 0) continue;
                    return { ok: false, error: 'API code ' + json?.code + ' ' + (json?.msg || ''), data: json?.data };
                } catch (e) {
                    return { ok: false, error: 'fetch failed: ' + String(e && e.message || e) };
                }
            }
        })()
    `);
  return unwrapEvaluateResult(wrapped);
}
async function readLovartProject(page, projectId) {
  const result = await queryProjectFromNode(page, projectId);
  if (!result || !result.ok) {
    throw new AuthRequiredError(
      LOVART_DOMAIN,
      result?.error || "Lovart queryProject API failed."
    );
  }
  const d = result.data;
  const raw = d.canvas ?? "";
  let canvasDataV1 = null;
  if (raw) {
    if (raw.startsWith("SHAKKERDATA://")) {
      canvasDataV1 = decompressCanvasData(raw);
    } else {
      try {
        canvasDataV1 = JSON.parse(raw);
      } catch {
      }
    }
  }
  if (!canvasDataV1) {
    canvasDataV1 = await readCanvasFromLocalStorage(page, projectId);
  }
  const { genImages, genVideos, userImages, groupCount } = parseCanvasAssets(canvasDataV1);
  let allAssets = [...genImages, ...genVideos, ...userImages];
  if (allAssets.length === 0) {
    allAssets = await readImagesFromDOM(page, projectId).then(
      (imgs) => imgs.map((img) => ({
        shapeId: "",
        url: img.url,
        w: img.w,
        h: img.h,
        kind: img.type === "generator" ? "gen-image" : img.type === "user" ? "user-image" : "gen-image"
      }))
    );
  }
  return {
    projectId: d.projectId || projectId,
    projectName: d.projectName ?? "",
    url: `https://www.lovart.ai/canvas?projectId=${d.projectId || projectId}`,
    projectType: d.projectType ?? 3,
    version: d.version ?? "",
    isValidProject: false,
    isTitleChanged: false,
    isNewProject: false,
    canvasDataV1,
    genImages,
    genVideos,
    userImages,
    groupCount
  };
}
async function readCanvasFromLocalStorage(page, projectId) {
  const raw = unwrapEvaluateResult(await page.evaluate(
    (pid) => {
      try {
        const key = "tldraw/" + pid;
        let raw2 = localStorage.getItem(key);
        if (!raw2) {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.includes(pid)) {
              raw2 = localStorage.getItem(k);
              break;
            }
          }
        }
        return raw2 ?? null;
      } catch {
        return null;
      }
    },
    projectId
  ));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.tldrawSnapshot) {
      return parsed;
    }
  } catch {
  }
  return null;
}
async function readImagesFromDOM(page, projectId) {
  const images = [];
  const imgResults = unwrapEvaluateResult(
    await page.evaluate(`
            () => {
                const imgs = Array.from(document.querySelectorAll('img'));
                return imgs.map(img => ({
                    src: img.currentSrc || img.src,
                    width: img.naturalWidth || img.width || 0,
                    height: img.naturalHeight || img.height || 0,
                }));
            }
        `)
  );
  if (Array.isArray(imgResults)) {
    for (const img of imgResults) {
      if (!img.src || !img.src.startsWith("http")) continue;
      let kind = "gen-image";
      if (img.src.includes("/artifacts/generator/")) kind = "gen-image";
      else if (img.src.includes("/artifacts/user/")) kind = "user-image";
      else if (img.src.includes("/artifacts/agent/")) kind = "gen-image";
      else continue;
      images.push({ shapeId: "", url: img.src, w: img.width, h: img.height, kind });
    }
  }
  return images;
}
function parseCanvasAssets(canvasDataV1) {
  const genImages = [];
  const genVideos = [];
  const userImages = [];
  let groupCount = 0;
  if (!canvasDataV1) return { genImages, genVideos, userImages, groupCount };
  const store = canvasDataV1.tldrawSnapshot?.document?.store;
  if (!store || typeof store !== "object") return { genImages, genVideos, userImages, groupCount };
  for (const [, raw] of Object.entries(store)) {
    if (!raw || typeof raw !== "object") continue;
    const shape = raw;
    const stype = String(shape.type ?? "");
    const props = shape.props;
    if (stype === "c-image") {
      const url = String(props?.url ?? "");
      if (!url) continue;
      const asset = { shapeId: String(shape.id), url, w: Number(props?.w ?? 0), h: Number(props?.h ?? 0), kind: "gen-image" };
      if (url.includes("/artifacts/generator/")) genImages.push(asset);
      else if (url.includes("/artifacts/user/")) userImages.push({ ...asset, kind: "user-image" });
    } else if (stype === "c-video") {
      const mp4Url = String(props?.url ?? "");
      if (mp4Url) genVideos.push({ shapeId: String(shape.id), url: mp4Url, w: Number(props?.w ?? 0), h: Number(props?.h ?? 0), kind: "gen-video" });
    } else if (stype === "c-group") {
      groupCount++;
    }
  }
  return { genImages, genVideos, userImages, groupCount };
}
function parseCanvasTree(canvasDataV1, projectName, projectId, projectType, projectUrl) {
  const store = canvasDataV1?.tldrawSnapshot?.document?.store;
  const rows = [];
  const summary = {
    id: "summary",
    parent: null,
    type: "summary",
    source: "\u2014",
    size: "\u2014",
    name: projectName || "\u2014",
    duration: null,
    task: "\u2014",
    url: projectUrl || "\u2014"
  };
  if (!store || typeof store !== "object") {
    return {
      summary,
      rows: [summary],
      counts: { aiImages: 0, aiVideos: 0, uploads: 0, containers: 0, frameChildren: 0 }
    };
  }
  const byId = {};
  for (const [k, v] of Object.entries(store)) {
    if (v && typeof v === "object") byId[k] = v;
  }
  const containers = [];
  for (const [id, raw] of Object.entries(byId)) {
    const t = String(raw.type ?? "");
    if (t === "frame" || t === "group") {
      containers.push({ id, raw, kind: t });
    }
  }
  const sortByPos = (a, b) => {
    const ay = Number(a.y ?? 0), by = Number(b.y ?? 0);
    if (ay !== by) return ay - by;
    return Number(a.x ?? 0) - Number(b.x ?? 0);
  };
  containers.sort((a, b) => sortByPos(a.raw, b.raw));
  let aiImages = 0, aiVideos = 0, uploads = 0, frameChildren = 0;
  const lastTaskPerContainer = /* @__PURE__ */ new Map();
  for (const { id, raw, kind } of containers) {
    const props = raw.props ?? {};
    const w = Number(props.w ?? 0), h = Number(props.h ?? 0);
    const name = String(props.name ?? "\u2014").trim() || "\u2014";
    const containerRow = {
      id,
      parent: null,
      type: kind,
      source: "\u2014",
      size: w > 0 && h > 0 ? `${Math.round(w)}\xD7${Math.round(h)}` : "\u2014",
      name,
      duration: null,
      task: "\u2014",
      url: "\u2014"
    };
    rows.push(containerRow);
    const children = [];
    for (const [cid, cs] of Object.entries(byId)) {
      if (cs.parentId === id) children.push(cs);
    }
    children.sort(sortByPos);
    for (const cs of children) {
      const ct = String(cs.type ?? "");
      const cp = cs.props ?? {};
      const cName = String(cp.name ?? "").trim() || "(unnamed)";
      const cUrl = String(cp.url ?? "");
      const cTask = String(cp.generatorTaskId ?? "");
      const cw = Number(cp.w ?? 0), ch = Number(cp.h ?? 0);
      const source = String(cs.meta?.source ?? "\u2014");
      const dur = cp.duration != null ? Number(cp.duration) : null;
      let rowKind = "c-image";
      if (ct === "c-video") rowKind = "c-video";
      else if (ct === "c-image") rowKind = "c-image";
      else continue;
      const isGenerator = cUrl.includes("/artifacts/generator/");
      const isUser = cUrl.includes("/artifacts/user/");
      if (!isGenerator && !isUser && rowKind === "c-image") continue;
      if (isGenerator && rowKind === "c-image") aiImages++;
      else if (isGenerator && rowKind === "c-video") aiVideos++;
      else if (isUser) uploads++;
      if (kind === "frame") frameChildren++;
      if (cTask) lastTaskPerContainer.set(id, cTask);
      const url = cUrl || "\u2014";
      const size = cw > 0 && ch > 0 ? `${Math.round(cw)}\xD7${Math.round(ch)}` : "\u2014";
      rows.push({
        id: String(cs.id ?? `${id}:${rows.length}`),
        parent: id,
        type: rowKind,
        source,
        size,
        name: cName,
        duration: rowKind === "c-video" ? dur : null,
        task: cTask ? cTask.slice(0, 8) : "\u2014",
        url
      });
    }
  }
  const topLevel = [];
  for (const cs of Object.values(byId)) {
    if (cs.parentId !== "page:page") continue;
    const ct = String(cs.type ?? "");
    if (ct !== "c-image" && ct !== "c-video") continue;
    topLevel.push(cs);
  }
  topLevel.sort(sortByPos);
  let lastTopTask = "";
  for (const cs of topLevel) {
    const ct = String(cs.type ?? "");
    const cp = cs.props ?? {};
    const cName = String(cp.name ?? "").trim() || "(unnamed)";
    const cUrl = String(cp.url ?? "");
    const cTask = String(cp.generatorTaskId ?? "");
    const cw = Number(cp.w ?? 0), ch = Number(cp.h ?? 0);
    const source = String(cs.meta?.source ?? "\u2014");
    const dur = cp.duration != null ? Number(cp.duration) : null;
    const isGenerator = cUrl.includes("/artifacts/generator/");
    const isUser = cUrl.includes("/artifacts/user/");
    if (!isGenerator && !isUser && ct === "c-image") continue;
    if (isGenerator && ct === "c-image") aiImages++;
    else if (isGenerator && ct === "c-video") aiVideos++;
    else if (isUser) uploads++;
    if (cTask) lastTopTask = cTask;
    const url = cUrl || "\u2014";
    const size = cw > 0 && ch > 0 ? `${Math.round(cw)}\xD7${Math.round(ch)}` : "\u2014";
    rows.push({
      id: String(cs.id ?? `top:${rows.length}`),
      parent: null,
      type: ct === "c-video" ? "c-video" : "c-image",
      source,
      size,
      name: cName,
      duration: ct === "c-video" ? dur : null,
      task: cTask ? cTask.slice(0, 8) : "\u2014",
      url
    });
  }
  const counts = {
    aiImages,
    aiVideos,
    uploads,
    containers: containers.length,
    frameChildren
  };
  return { summary, rows: [summary, ...rows], counts };
}
async function dumpLovartProjectPage(page, projectId, outputPath) {
  const canvasUrl = `https://www.lovart.ai/canvas?projectId=${projectId}`;
  await page.goto(canvasUrl);
  await page.wait({ selector: "body", timeoutMs: 8e3 });
  await page.wait(3e3);
  const fs = await import("fs");
  const dump = unwrapEvaluateResult(await page.evaluate(
    (pid) => {
      const result = {};
      const ls = {};
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i) || "";
          const v = localStorage.getItem(k) || "";
          ls[k] = v.length > 2e3 ? v.slice(0, 2e3) + "... [TRUNCATED]" : v;
        }
      } catch {
        ls["_error"] = "inaccessible";
      }
      result["localStorage"] = ls;
      const ss = {};
      try {
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i) || "";
          const v = sessionStorage.getItem(k) || "";
          ss[k] = v.length > 2e3 ? v.slice(0, 2e3) + "... [TRUNCATED]" : v;
        }
      } catch {
        ss["_error"] = "inaccessible";
      }
      result["sessionStorage"] = ss;
      const stateGlobals = {};
      const stateKeys = [
        "__REDUX__",
        "__STATE__",
        "__INITIAL_STATE__",
        "__NEXT_DATA__",
        "__NUXT__",
        "__TLDRAW__",
        "reduxStore",
        "store",
        "__canvas__",
        "__tldraw__",
        "__lovart__",
        "__studio__"
      ];
      for (const key of stateKeys) {
        try {
          const val = window[key];
          if (val !== void 0) {
            const str = typeof val === "string" ? val : JSON.stringify(val);
            stateGlobals[key] = str.length > 3e3 ? str.slice(0, 3e3) + "... [TRUNCATED]" : str;
          }
        } catch {
        }
      }
      result["stateGlobals"] = stateGlobals;
      const allEls = document.querySelectorAll("*");
      const tagCounts = {};
      allEls.forEach((el) => {
        const tag = el.tagName.toLowerCase();
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      });
      const dataAttrs = /* @__PURE__ */ new Set();
      const ariaAttrs = /* @__PURE__ */ new Set();
      allEls.forEach((el) => {
        Array.from(el.attributes).forEach((attr) => {
          if (attr.name.startsWith("data-")) dataAttrs.add(attr.name);
          if (attr.name.startsWith("aria-")) ariaAttrs.add(attr.name);
        });
      });
      result["domStats"] = {
        totalElements: allEls.length,
        tagCounts,
        dataAttributes: Array.from(dataAttrs).sort(),
        ariaAttributes: Array.from(ariaAttrs).sort(),
        imgs: document.querySelectorAll("img").length,
        videos: document.querySelectorAll("video").length,
        iframes: document.querySelectorAll("iframe").length,
        svgs: document.querySelectorAll("svg").length,
        tldrawElements: Array.from(allEls).filter((el) => Array.from(el.attributes).some((a) => a.name.startsWith("data-tldraw"))).map((el) => ({
          tag: el.tagName,
          attrs: Array.from(el.attributes).map((a) => ({ n: a.name, v: a.value.slice(0, 100) }))
        }))
      };
      try {
        const entries = performance.getEntriesByType("resource");
        result["performanceEntries"] = entries.filter((e) => e.name.includes("lovart") || e.name.includes("canva") || e.name.includes("canas")).map((e) => ({
          name: e.name.slice(0, 200),
          type: e.initiatorType,
          duration: Math.round(e.duration)
        }));
      } catch {
        result["performanceEntries"] = [];
      }
      return result;
    },
    projectId
  ));
  const apiRaw = unwrapEvaluateResult(await page.evaluate(
    async (pid) => {
      const tok = (document.cookie.match(/usertoken=([^;]+)/) || [])[1] || "";
      if (!tok) return { error: "no usertoken" };
      try {
        const resp = await fetch("/api/canva/project/queryProject", {
          method: "POST",
          headers: { "Content-Type": "application/json", "token": tok, "x-language": "zh" },
          body: JSON.stringify({ projectId: pid }),
          credentials: "include"
        });
        const body = await resp.json();
        return { status: resp.status, code: body?.code, msg: body?.msg, data: body?.data };
      } catch (e) {
        return { error: e?.message || String(e) };
      }
    },
    projectId
  ));
  dump["queryProject_raw"] = apiRaw;
  fs.writeFileSync(outputPath, JSON.stringify(dump, null, 2), "utf-8");
  console.error(`[dumpLovartProjectPage] Wrote ${outputPath}`);
}
export {
  LIST_ALIASES,
  LIST_KINDS,
  LIST_KIND_TREE,
  LOVART_DOMAIN,
  LOVART_HOMEPAGE,
  LOVART_PROJECTS,
  decompressCanvasData,
  dumpLovartProjectPage,
  parseCanvasAssets,
  parseCanvasTree,
  parseMeRows,
  readLovartMe,
  readLovartProject,
  readLovartProjects,
  resolveListKind,
  unwrapEvaluateResult
};
