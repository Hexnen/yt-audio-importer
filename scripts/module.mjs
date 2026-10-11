const ID = "yt-audio-importer";
const { ApplicationV2 } = foundry.applications.api;
const HELPER_REQUIRED = "1.1.0"; // minimum helper version this module works with
const HELPER_LATEST = "1.1.2";   // helper version attached to this module release (download link)
const HELPER_FILE = `foundry-yt-helper-v${HELPER_LATEST}.exe`;
const HELPER_URL = `https://github.com/Hexnen/yt-audio-importer/releases/latest/download/${HELPER_FILE}`;
const cmpVer = (a, b) => {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

/** @returns {Promise<{state:"ok"|"outdated"|"missing", version?:string}>} */
async function checkHelper() {
  const helper = game.settings.get(ID, "helperUrl").replace(/\/$/, "");
  let j;
  try {
    const r = await fetch(`${helper}/health`);
    j = await r.json().catch(() => null);
  } catch { return { state: "missing" }; }
  if (!j?.version || j.version === "dev") return { state: j?.version === "dev" ? "ok" : "outdated", version: j?.version };
  return { state: cmpVer(j.version, HELPER_REQUIRED) < 0 ? "outdated" : "ok", version: j.version };
}

/** Throws a noHelper error (missing or outdated) unless a compatible helper answers. */
async function requireHelper() {
  const c = await checkHelper();
  if (c.state === "ok") return;
  const url = game.settings.get(ID, "helperUrl");
  const e = new Error(c.state === "outdated" ? t("YTA.Outdated", { found: c.version ?? "?", need: HELPER_REQUIRED }) : t("YTA.NoHelper", { url }));
  e.noHelper = true;
  e.outdated = c.state === "outdated";
  throw e;
}
const FP = () => foundry.applications.apps.FilePicker.implementation;
const t = (k, d) => (d ? game.i18n.format(k, d) : game.i18n.localize(k));
const FORMATS = { ogg: "ogg (Vorbis) – works everywhere", opus: "opus – recommended (best quality, smallest)", mp3: "mp3", m4a: "m4a (aac)" };

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(ID, key, { scope: "world", config: true, ...data });
  reg("helperUrl", { name: "YTA.Set.Helper", hint: "YTA.Set.HelperHint", type: new foundry.data.fields.StringField({ initial: "http://localhost:30077" }) });
  reg("folder", { name: "YTA.Set.Folder", hint: "YTA.Set.FolderHint", type: new foundry.data.fields.StringField({ initial: "assets/youtube" }) });
  reg("format", { name: "YTA.Set.Format", type: new foundry.data.fields.StringField({ initial: "opus", choices: FORMATS }) });
  reg("addToPlaylist", { name: "YTA.Set.AddToPlaylist", hint: "YTA.Set.AddHint", type: new foundry.data.fields.BooleanField({ initial: true }) });
});

Hooks.on("renderPlaylistDirectory", (app, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html[0];
  if (root.querySelector(".yta-open")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "yta-open";
  btn.innerHTML = `<i class="fa-brands fa-youtube"></i> ${t("YTA.Button")}`;
  btn.addEventListener("click", () => YtImporter.open());
  const header = root.querySelector(".directory-header .header-actions") ?? root.querySelector(".directory-header") ?? root;
  header.append(btn);
});

async function ensureFolder(path) {
  let cur = "";
  for (const part of path.split("/").filter(Boolean)) {
    cur = cur ? `${cur}/${part}` : part;
    try { await FP().createDirectory("data", cur); } catch { /* already exists */ }
  }
}

/** Upload with progress (FilePicker.upload cannot report it). */
function uploadWithProgress(file, target, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.set("source", "data");
    fd.set("target", target);
    fd.set("upload", file);
    fd.set("options", JSON.stringify({}));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", foundry.utils.getRoute("upload"));
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total * 100);
    xhr.onload = () => {
      try {
        const r = JSON.parse(xhr.responseText);
        if (xhr.status >= 400 || r.error || !r.path) return reject(new Error(r.error ?? r.message ?? xhr.statusText ?? "Upload failed"));
        resolve(r);
      } catch { reject(new Error(xhr.statusText || "Upload failed")); }
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(fd);
  });
}

function fetchWithProgress(url, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.responseType = "blob";
    xhr.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total * 100);
    xhr.onload = () => (xhr.status < 400 ? resolve({ blob: xhr.response, name: xhr.getResponseHeader("X-Filename") }) : reject(new Error(xhr.statusText)));
    xhr.onerror = () => reject(new Error("fetch failed"));
    xhr.send();
  });
}

class YtImporter extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "yt-audio-importer",
    window: { title: "YTA.Title", icon: "fa-brands fa-youtube" },
    position: { width: 480, height: "auto" }
  };

  /** One window at a time (fixed application id). */
  static open() { return (this._inst ??= new YtImporter()).render({ force: true }); }

  async _renderHTML() {
    const fmt = game.settings.get(ID, "format");
    const folder = game.settings.get(ID, "folder");
    const opts = Object.entries(FORMATS).map(([k, v]) => `<option value="${k}" ${k === fmt ? "selected" : ""}>${v}</option>`).join("");
    const bar = (k, label) => `<div class="yta-step" data-step="${k}" style="margin:4px 0">
        <label style="font-size:12px">${label} <span class="yta-pct"></span></label>
        <progress max="100" value="0" style="width:100%"></progress></div>`;
    const wrap = document.createElement("form");
    wrap.className = "standard-form";
    wrap.innerHTML = `
      <div class="form-group"><label>${t("YTA.Url")}</label>
        <div class="form-fields"><input type="text" name="url" placeholder="https://www.youtube.com/watch?v= / playlist?list="></div></div>
      <p class="yta-detect" style="font-size:11px;margin:0 0 4px 0;opacity:.8"></p>
      <div class="form-group"><label>${t("YTA.Set.Folder")}</label>
        <div class="form-fields"><file-picker name="folder" type="folder" value="${foundry.utils.escapeHTML(folder)}"></file-picker></div></div>
      <div class="form-group"><label>${t("YTA.Playlist")}</label>
        <div class="form-fields"><select name="playlist"><option value="">YouTube (${t("YTA.Auto")})</option>${game.playlists.map(p => `<option value="${p.id}">${foundry.utils.escapeHTML(p.name)}</option>`).join("")}</select></div></div>
      <div class="form-group"><label>${t("YTA.Set.Format")}</label>
        <div class="form-fields"><select name="format">${opts}</select></div></div>
      <div class="yta-progress" hidden>
        <div class="yta-step" data-step="playlist" hidden style="margin:4px 0">
          <label style="font-size:12px">${t("YTA.Step.Playlist")} <span class="yta-pct"></span></label>
          <progress max="100" value="0" style="width:100%"></progress></div>
        <p class="yta-title" style="margin:6px 0;font-weight:bold"></p>
        ${bar("download", t("YTA.Step.Download"))}${bar("convert", t("YTA.Step.Convert"))}
        ${bar("transfer", t("YTA.Step.Transfer"))}${bar("upload", t("YTA.Step.Upload"))}
        <p class="yta-status" style="margin:6px 0"></p>
      </div>
      <p class="yta-helper" style="font-size:11px;margin:4px 0"></p>
      <footer class="form-footer">
        <button type="button" class="yta-go" data-mode="sound" disabled><i class="fa-solid fa-music"></i> ${t("YTA.ImportSound")}</button>
        <button type="button" class="yta-go" data-mode="playlist" disabled><i class="fa-solid fa-list"></i> ${t("YTA.ImportPlaylist")}</button>
        <button type="button" class="yta-cancel" hidden><i class="fa-solid fa-stop"></i> ${t("YTA.Cancel")}</button>
      </footer>`;
    return wrap;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    const input = result.elements.url;
    const note = result.querySelector(".yta-detect");
    const [soundBtn, listBtn] = result.querySelectorAll(".yta-go");
    const update = () => {
      const d = detectLink(input.value);
      soundBtn.disabled = !d.video;
      listBtn.disabled = !d.list;
      soundBtn.classList.toggle("default", d.video && !d.list);
      listBtn.classList.toggle("default", d.list && !d.video);
      note.textContent = d.list && d.video ? t("YTA.Detect.Both") : d.list ? t("YTA.Detect.List") : d.video ? t("YTA.Detect.Video") : "";
    };
    input.addEventListener("input", update);
    input.addEventListener("paste", () => setTimeout(update));
    result.addEventListener("click", ev => {
      const btn = ev.target.closest(".yta-go");
      if (btn && !btn.disabled) this.#run(result, btn.dataset.mode);
      if (ev.target.closest(".yta-cancel")) this.cancelled = true;
    });
    update();
    const hs = result.querySelector(".yta-helper");
    const link = `<a href="${HELPER_URL}" target="_blank" rel="noopener"><i class="fa-solid fa-download"></i> ${t("YTA.GetHelper")}</a>`;
    checkHelper().then(c => {
      hs.innerHTML = c.state === "ok" ? `<i class="fa-solid fa-circle-check"></i> ${t("YTA.Helper.Ok", { v: c.version })}`
        : c.state === "outdated" ? `<i class="fa-solid fa-triangle-exclamation"></i> ${t("YTA.Helper.Outdated", { found: c.version ?? "?", need: HELPER_REQUIRED })} ${link}`
        : `<i class="fa-solid fa-circle-xmark"></i> ${t("YTA.Helper.Missing")} ${link}`;
    });
  }

  async #run(form, mode) {
    const url = form.elements.url.value.trim();
    if (!url) return;
    const folder = (form.elements.folder.value || "assets/youtube").replace(/^\/+|\/+$/g, "");
    const format = form.elements.format.value;
    await game.settings.set(ID, "folder", folder);
    await game.settings.set(ID, "format", format);

    const box = form.querySelector(".yta-progress");
    const status = box.querySelector(".yta-status");
    const goBtns = form.querySelectorAll(".yta-go");
    const cancelBtn = form.querySelector(".yta-cancel");
    const bars = Object.fromEntries(["playlist", "download", "convert", "transfer", "upload"].map(k => {
      const el = box.querySelector(`[data-step=${k}]`);
      return [k, (v, indeterminate) => {
        const p = el.querySelector("progress");
        if (indeterminate) p.removeAttribute("value"); else p.value = v;
        el.querySelector(".yta-pct").textContent = indeterminate ? "…" : `${Math.round(v)}%`;
      }];
    }));
    const resetItem = () => ["download", "convert", "transfer", "upload"].forEach(k => bars[k](0));
    const isList = mode === "playlist";
    box.hidden = false;
    box.querySelector("[data-step=playlist]").hidden = !isList;
    goBtns.forEach(b => (b.disabled = true));
    cancelBtn.hidden = !isList;
    this.cancelled = false;
    status.textContent = "";
    resetItem();
    const common = {
      folder, format, playlist: form.elements.playlist.value,
      onTitle: ti => (box.querySelector(".yta-title").textContent = ti),
      onStep: (k, v, ind) => bars[k](v, ind)
    };
    try {
      if (isList) {
        const res = await importPlaylist(url, {
          ...common, isCancelled: () => this.cancelled,
          onItem: (i, n, title) => { resetItem(); bars.playlist((i - 1) / n * 100); box.querySelector(".yta-title").textContent = `${i}/${n} - ${title}`; }
        });
        bars.playlist(100);
        status.textContent = t("YTA.PlaylistDone", { ok: res.ok, total: res.total, failed: res.failed.length, skipped: res.skipped, name: res.playlist.name });
      } else {
        const sound = await importAudio(url, common);
        status.textContent = t("YTA.Done", { path: sound.path });
      }
    } catch (err) {
      status.textContent = t("YTA.Err", { msg: err.message });
      if (err.noHelper) offerHelper(err);
    } finally {
      cancelBtn.hidden = true;
      form.elements.url.dispatchEvent(new Event("input"));
    }
  }
}

/** What does this text look like? { video, list } (client-side hint only; the helper is authoritative). */
function detectLink(text) {
  const s = String(text ?? "").trim();
  if (!s) return { video: false, list: false };
  if (/^[\w-]{11}$/.test(s)) return { video: true, list: false };
  const list = /[?&]list=[\w-]{10,}/.test(s);
  const known = /[?&]v=[\w-]{11}/.test(s) || /youtu\.be\/[\w-]{11}/.test(s) || /\/(shorts|live|embed|v|e|vi|video|watch)\/[\w-]{11}/.test(s);
  const other = !list && /(^|\/\/|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)\/./i.test(s) && !/\/(channel|c|user|@)/i.test(s); // e.g. /clip/..., helper decides
  return { video: known || other, list };
}

function noHelper(url) {
  const e = new Error(t("YTA.NoHelper", { url }));
  e.noHelper = true;
  return e;
}

/** Offer the helper download when it is not running. */
async function offerHelper(err) {
  const go = await foundry.applications.api.DialogV2.confirm({
    window: { title: t(err?.outdated ? "YTA.OutdatedTitle" : "YTA.NoHelperTitle"), icon: "fa-solid fa-triangle-exclamation" },
    content: `<p>${t(err?.outdated ? "YTA.OutdatedBody" : "YTA.NoHelperBody", { need: HELPER_REQUIRED })}</p>`,
    yes: { label: t("YTA.GetHelper"), icon: "fa-solid fa-download" },
    no: { label: t("YTA.Close") },
    rejectClose: false
  });
  if (go) window.open(HELPER_URL, "_blank", "noopener");
}

/** Same title, different video -> keep both: append [videoId] when the name is already taken in the folder. */
async function uniqueName(folder, name, link) {
  let listing;
  try { listing = await FP().browse("data", folder); } catch { return name; }
  const taken = new Set();
  for (const f of listing.files ?? []) {
    const b = f.split("/").pop();
    taken.add(b.toLowerCase());
    try { taken.add(decodeURIComponent(b).toLowerCase()); } catch { /* keep raw */ }
  }
  if (!taken.has(name.toLowerCase())) return name;
  let vid = null;
  try { vid = new URL(link).searchParams.get("v"); } catch { /* not a URL */ }
  const dot = name.lastIndexOf(".");
  return `${name.slice(0, dot)} [${vid ?? Date.now()}]${name.slice(dot)}`;   // same video again -> same suffixed name, overwrites its own copy
}

/** Original link as the user pasted it (a bare video ID becomes a watch URL). */
function originalLink(text) {
  const s = text.trim();
  return /^[\w-]{11}$/.test(s) ? `https://www.youtube.com/watch?v=${s}` : s;
}

/** Sound description (HTML): thumbnail, channel, clickable original link. */
function describe(link, meta) {
  const esc = foundry.utils.escapeHTML;
  const safe = u => (/^https?:\/\//i.test(u ?? "") ? esc(u) : null);
  if (meta.thumbnail) meta = { ...meta, thumbnail: meta.thumbnail.split("?")[0] };
  const out = [];
  if (safe(meta.thumbnail)) out.push(`<p><img src="${safe(meta.thumbnail)}" alt="${esc(meta.title ?? "")}" style="max-width:100%"></p>`);
  if (meta.channel) out.push(`<p>${t("YTA.Channel")}: ${safe(meta.channelUrl) ? `<a href="${safe(meta.channelUrl)}" target="_blank" rel="noopener">${esc(meta.channel)}</a>` : esc(meta.channel)}</p>`);
  const href = safe(link) ?? safe(meta.url);
  out.push(href ? `<p><a href="${href}" target="_blank" rel="noopener">${href}</a></p>` : `<p>${esc(link)}</p>`);
  return out.join("");
}

/**
 * Full pipeline: helper job -> file -> Foundry upload -> PlaylistSound (description = original link).
 * @param {string} url
 * @param {{folder?:string, format?:string, playlist?:string|Playlist, onTitle?:Function, onStep?:Function}} opts
 */
export async function importAudio(url, opts = {}) {
  const helper = game.settings.get(ID, "helperUrl").replace(/\/$/, "");
  const folder = (opts.folder ?? game.settings.get(ID, "folder")).replace(/^\/+|\/+$/g, "");
  const format = opts.format ?? game.settings.get(ID, "format");
  const step = opts.onStep ?? (() => {});
  const link = originalLink(url);
  if (!opts.skipCheck) await requireHelper();

  let r;
  try {
    r = await fetch(`${helper}/jobs?format=${format}&url=${encodeURIComponent(link)}`, { method: "POST" });
  } catch { throw noHelper(helper); }
  if (!r.ok) throw new Error(await r.text());
  const { id } = await r.json();

  let meta = {};
  await new Promise((resolve, reject) => {
    const es = new EventSource(`${helper}/jobs/${id}/events`);
    es.onmessage = e => {
      const d = JSON.parse(e.data);
      if (d.title) opts.onTitle?.(d.title);
      if (d.stage === "download") step("download", d.percent);
      else if (d.stage === "setup") opts.onTitle?.(t("YTA.Setup"));
      else if (d.stage === "convert") { step("download", 100); step("convert", 0, true); }
      else if (d.stage === "done") { meta = d.meta ?? {}; step("download", 100); step("convert", 100); es.close(); resolve(); }
      else if (d.stage === "error") { es.close(); reject(new Error(d.message)); }
    };
    es.onerror = () => { es.close(); reject(noHelper(helper)); };
  });

  const { blob, name: rawName } = await fetchWithProgress(`${helper}/jobs/${id}/file`, v => step("transfer", v));
  step("transfer", 100);
  const name = decodeURIComponent(rawName ?? `youtube-${Date.now()}.${format}`);
  const file = new File([blob], name, { type: blob.type || "audio/ogg" });
  await ensureFolder(folder);
  const fileName = await uniqueName(folder, name, meta.url ?? link);
  const toUpload = fileName === name ? file : new File([blob], fileName, { type: file.type });
  const up = await uploadWithProgress(toUpload, folder, v => step("upload", v));
  step("upload", 100);
  const path = up.path;

  let pl = opts.playlist;
  if (typeof pl === "string" && pl) pl = game.playlists.get(pl);
  if (!(pl instanceof Playlist)) pl = game.playlists.getName("YouTube") ?? await Playlist.create({ name: "YouTube" });
  const [sound] = await pl.createEmbeddedDocuments("PlaylistSound", [{
    name: name.replace(/\.[^.]+$/, ""), path, description: describe(link, meta)
  }]);
  if (!opts.quiet) ui.notifications.info(t("YTA.Done", { path }));
  return sound;
}

/**
 * Import every video of a YouTube playlist into a Foundry playlist (new one named after it unless opts.playlist is given).
 * Sequential; one failing video does not stop the rest.
 */
export async function importPlaylist(url, opts = {}) {
  await requireHelper();
  const helper = game.settings.get(ID, "helperUrl").replace(/\/$/, "");
  let r;
  try { r = await fetch(`${helper}/playlist?url=${encodeURIComponent(originalLink(url))}`); } catch { throw noHelper(helper); }
  if (!r.ok) throw new Error(await r.text());
  const info = await r.json();
  if (!info.entries.length) throw new Error(t("YTA.EmptyPlaylist"));

  let pl = opts.playlist;
  if (typeof pl === "string" && pl) pl = game.playlists.get(pl);
  if (!(pl instanceof Playlist)) pl = game.playlists.getName(info.title) ?? await Playlist.create({ name: info.title });
  const baseFolder = (opts.folder ?? game.settings.get(ID, "folder")).replace(/^\/+|\/+$/g, "");
  const folder = `${baseFolder}/${info.title.replace(/[^\p{L}\p{N}._ -]+/gu, "_").trim().slice(0, 60) || "playlist"}`;

  const failed = [];
  let ok = 0, skipped = 0;
  const n = info.entries.length;
  for (let i = 0; i < n; i++) {
    if (opts.isCancelled?.()) break;
    const e = info.entries[i];
    opts.onItem?.(i + 1, n, e.title);
    if (pl.sounds.some(s => s.description?.includes(e.id))) { skipped++; continue; }
    try {
      await importAudio(`https://www.youtube.com/watch?v=${e.id}`, { ...opts, folder, playlist: pl, quiet: true, skipCheck: true });
      ok++;
    } catch (err) {
      if (err.noHelper) throw err;
      failed.push({ title: e.title, error: err.message });
    }
  }
  ui.notifications.info(t("YTA.PlaylistDone", { ok, total: n, failed: failed.length, skipped, name: pl.name }));
  return { ok, total: n, failed, skipped, playlist: pl };
}

/** Right-click a playlist -> Paste from YouTube: clipboard link straight into that playlist. */
Hooks.on("getPlaylistContextOptions", (app, options) => {
  options.push({
    label: "YTA.Paste",
    icon: "fa-brands fa-youtube",
    visible: () => game.user.isGM,
    onClick: async (event, header) => {
      const playlistId = header.closest("[data-entry-id]")?.dataset.entryId;
      const playlist = game.playlists.get(playlistId);
      if (!playlist) return;
      let text = "";
      try { text = (await navigator.clipboard.readText()).trim(); } catch { /* no permission / insecure context */ }
      if (!text) {
        text = await foundry.applications.api.DialogV2.prompt({
          window: { title: t("YTA.Paste"), icon: "fa-brands fa-youtube" },
          content: `<div class="form-group"><label>${t("YTA.Url")}</label><input type="text" name="url" autofocus></div>`,
          ok: { callback: (ev, btn) => btn.form.elements.url.value.trim() },
          rejectClose: false
        });
        if (!text) return;
      }
      const note = ui.notifications.info(t("YTA.Working"), { progress: true });
      const pct = { download: 0, convert: 0, transfer: 0, upload: 0 };
      const W = { download: 0.6, convert: 0.15, transfer: 0.05, upload: 0.2 };
      let title = "";
      const refresh = () => note?.update?.({ message: `${title || t("YTA.Working")}`, pct: Object.keys(pct).reduce((a, k) => a + pct[k] * W[k], 0) / 100 });
      try {
        const cb = { playlist, onTitle: x => { title = x; refresh(); }, onStep: (k, v, ind) => { if (!ind) pct[k] = v; refresh(); } };
        const d = detectLink(text);
        if (d.list && !d.video) {
          await importPlaylist(text, { ...cb, onItem: (i, n, ti) => { Object.keys(pct).forEach(k => (pct[k] = 0)); title = `${i}/${n} - ${ti}`; refresh(); } });
        } else {
          await importAudio(text, cb);
        }
      } catch (err) {
        ui.notifications.error(t("YTA.Err", { msg: err.message }));
        if (err.noHelper) offerHelper(err);
      } finally {
        note?.update?.({ pct: 1 });
        setTimeout(() => ui.notifications.remove?.(note), 500);
      }
    }
  });
});

Hooks.once("ready", () => { game.modules.get(ID).api = { importAudio, importPlaylist, open: () => YtImporter.open() }; });
