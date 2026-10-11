const ID = "yt-audio-importer";
const { ApplicationV2 } = foundry.applications.api;
const HELPER_URL = "https://github.com/Hexnen/yt-audio-importer/releases/latest/download/helper.exe";
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
  btn.addEventListener("click", () => new YtImporter().render({ force: true }));
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
        if (xhr.status >= 400 || r.status === "error") return reject(new Error(r.message ?? xhr.statusText));
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
        <div class="form-fields"><input type="text" name="url" placeholder="https://www.youtube.com/watch?v="></div></div>
      <div class="form-group"><label>${t("YTA.Set.Folder")}</label>
        <div class="form-fields"><file-picker name="folder" type="folder" value="${foundry.utils.escapeHTML(folder)}"></file-picker></div></div>
      <div class="form-group"><label>${t("YTA.Playlist")}</label>
        <div class="form-fields"><select name="playlist"><option value="">YouTube (${t("YTA.Auto")})</option>${game.playlists.map(p => `<option value="${p.id}">${foundry.utils.escapeHTML(p.name)}</option>`).join("")}</select></div></div>
      <div class="form-group"><label>${t("YTA.Set.Format")}</label>
        <div class="form-fields"><select name="format">${opts}</select></div></div>
      <div class="yta-progress" hidden>
        <p class="yta-title" style="margin:6px 0;font-weight:bold"></p>
        ${bar("download", t("YTA.Step.Download"))}${bar("convert", t("YTA.Step.Convert"))}
        ${bar("transfer", t("YTA.Step.Transfer"))}${bar("upload", t("YTA.Step.Upload"))}
        <p class="yta-status" style="margin:6px 0"></p>
      </div>
      <p style="font-size:11px;margin:4px 0"><a href="${HELPER_URL}" target="_blank" rel="noopener"><i class="fa-solid fa-download"></i> ${t("YTA.GetHelper")}</a></p>
      <footer class="form-footer"><button type="submit" class="yta-go"><i class="fa-solid fa-download"></i> ${t("YTA.Download")}</button></footer>`;
    return wrap;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    result.addEventListener("submit", ev => { ev.preventDefault(); this.#run(result); });
  }

  async #run(form) {
    const url = form.elements.url.value.trim();
    if (!url) return;
    const folder = (form.elements.folder.value || "assets/youtube").replace(/^\/+|\/+$/g, "");
    const format = form.elements.format.value;
    await game.settings.set(ID, "folder", folder);
    await game.settings.set(ID, "format", format);

    const box = form.querySelector(".yta-progress");
    const status = box.querySelector(".yta-status");
    const goBtn = form.querySelector(".yta-go");
    const bars = Object.fromEntries(["download", "convert", "transfer", "upload"].map(k => {
      const el = box.querySelector(`[data-step=${k}]`);
      return [k, (v, indeterminate) => {
        const p = el.querySelector("progress");
        if (indeterminate) p.removeAttribute("value"); else p.value = v;
        el.querySelector(".yta-pct").textContent = indeterminate ? "…" : `${Math.round(v)}%`;
      }];
    }));
    box.hidden = false;
    goBtn.disabled = true;
    status.textContent = "";
    try {
      const sound = await importAudio(url, {
        folder, format, playlist: form.elements.playlist.value,
        onTitle: ti => (box.querySelector(".yta-title").textContent = ti),
        onStep: (k, v, ind) => bars[k](v, ind)
      });
      status.textContent = t("YTA.Done", { path: sound.path });
    } catch (err) {
      status.textContent = t("YTA.Err", { msg: err.message });
      if (err.noHelper) offerHelper();
    } finally {
      goBtn.disabled = false;
    }
  }
}

function noHelper(url) {
  const e = new Error(t("YTA.NoHelper", { url }));
  e.noHelper = true;
  return e;
}

/** Offer the helper download when it is not running. */
async function offerHelper() {
  const go = await foundry.applications.api.DialogV2.confirm({
    window: { title: t("YTA.NoHelperTitle"), icon: "fa-solid fa-triangle-exclamation" },
    content: `<p>${t("YTA.NoHelperBody")}</p>`,
    yes: { label: t("YTA.GetHelper"), icon: "fa-solid fa-download" },
    no: { label: t("YTA.Close") },
    rejectClose: false
  });
  if (go) window.open(HELPER_URL, "_blank", "noopener");
}

/** Original link as the user pasted it (a bare video ID becomes a watch URL). */
function originalLink(text) {
  const s = text.trim();
  return /^[\w-]{11}$/.test(s) ? `https://www.youtube.com/watch?v=${s}` : s;
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

  let r;
  try {
    r = await fetch(`${helper}/jobs?format=${format}&url=${encodeURIComponent(link)}`, { method: "POST" });
  } catch { throw noHelper(helper); }
  if (!r.ok) throw new Error(await r.text());
  const { id } = await r.json();

  await new Promise((resolve, reject) => {
    const es = new EventSource(`${helper}/jobs/${id}/events`);
    es.onmessage = e => {
      const d = JSON.parse(e.data);
      if (d.title) opts.onTitle?.(d.title);
      if (d.stage === "download") step("download", d.percent);
      else if (d.stage === "setup") opts.onTitle?.(t("YTA.Setup"));
      else if (d.stage === "convert") { step("download", 100); step("convert", 0, true); }
      else if (d.stage === "done") { step("download", 100); step("convert", 100); es.close(); resolve(); }
      else if (d.stage === "error") { es.close(); reject(new Error(d.message)); }
    };
    es.onerror = () => { es.close(); reject(noHelper(helper)); };
  });

  const { blob, name: rawName } = await fetchWithProgress(`${helper}/jobs/${id}/file`, v => step("transfer", v));
  step("transfer", 100);
  const name = decodeURIComponent(rawName ?? `youtube-${Date.now()}.${format}`);
  const file = new File([blob], name, { type: blob.type || "audio/ogg" });
  await ensureFolder(folder);
  const up = await uploadWithProgress(file, folder, v => step("upload", v));
  step("upload", 100);
  const path = up?.path ?? `${folder}/${name}`;

  let pl = opts.playlist;
  if (typeof pl === "string" && pl) pl = game.playlists.get(pl);
  if (!(pl instanceof Playlist)) pl = game.playlists.getName("YouTube") ?? await Playlist.create({ name: "YouTube" });
  const [sound] = await pl.createEmbeddedDocuments("PlaylistSound", [{
    name: name.replace(/\.[^.]+$/, ""), path, description: link
  }]);
  ui.notifications.info(t("YTA.Done", { path }));
  return sound;
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
        await importAudio(text, {
          playlist, onTitle: x => { title = x; refresh(); },
          onStep: (k, v, ind) => { if (!ind) pct[k] = v; refresh(); }
        });
      } catch (err) {
        ui.notifications.error(t("YTA.Err", { msg: err.message }));
        if (err.noHelper) offerHelper();
      } finally {
        note?.update?.({ pct: 1 });
        setTimeout(() => ui.notifications.remove?.(note), 500);
      }
    }
  });
});

Hooks.once("ready", () => { game.modules.get(ID).api = { importAudio, open: () => new YtImporter().render({ force: true }) }; });
