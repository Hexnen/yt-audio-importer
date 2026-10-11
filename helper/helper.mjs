// YouTube Audio Helper - single exe (Node SEA). Keeps a small local server for the Foundry module.
// Downloads yt-dlp/ffmpeg into %LOCALAPPDATA%\yt-audio-helper on first use. Close the window to stop it.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveYouTube, resolvePlaylist } from "./yt-url.mjs";

const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";
const PORT = Number(process.env.YTA_PORT ?? 30077);
const DIR = process.env.YTA_HOME ?? join(process.env.LOCALAPPDATA ?? tmpdir(), "yt-audio-helper");
const BIN = join(DIR, "bin");
const YTDLP = join(BIN, "yt-dlp.exe");
const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const FFMPEG_URL = "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip";

mkdirSync(BIN, { recursive: true });
const log = m => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);

// ---------- dependencies ----------
async function download(url, dest) {
  log(`downloading ${url}`);
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`Download failed (${r.status}): ${url}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
}
const run = (exe, args, timeout) => new Promise(resolve => {
  const p = spawn(exe, args, { windowsHide: true, stdio: "ignore" });
  const timer = setTimeout(() => p.kill(), timeout);
  p.on("error", () => { clearTimeout(timer); resolve(); });
  p.on("close", () => { clearTimeout(timer); resolve(); });
});
const has = exe => spawnSync("where", [exe], { windowsHide: true }).status === 0;
let ffmpegDir = null;

async function ensureDeps() {
  if (!existsSync(YTDLP)) await download(YTDLP_URL, YTDLP);
  else { log("updating yt-dlp"); await run(YTDLP, ["-U"], 120000); } // YouTube breaks old versions often
  if (existsSync(join(BIN, "ffmpeg.exe"))) ffmpegDir = BIN;
  else if (has("ffmpeg") && has("ffprobe")) ffmpegDir = null;
  else {
    const zip = join(DIR, "ffmpeg.zip"), tmp = join(DIR, "ffmpeg-x");
    await download(FFMPEG_URL, zip);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    if (spawnSync(join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe"), ["-xf", zip, "-C", tmp], { windowsHide: true }).status !== 0) throw new Error("Could not unpack ffmpeg");
    const root = readdirSync(tmp)[0];
    for (const f of ["ffmpeg.exe", "ffprobe.exe"]) renameSync(join(tmp, root, "bin", f), join(BIN, f));
    rmSync(tmp, { recursive: true, force: true });
    rmSync(zip, { force: true });
    ffmpegDir = BIN;
  }
  log("ready");
}
let deps = null;
const ready = () => (deps ??= ensureDeps().catch(e => { deps = null; throw e; }));
ready().catch(e => log("setup failed: " + e.message));

// ---------- server ----------
const FORMATS = { mp3: "mp3", ogg: "vorbis", m4a: "m4a", opus: "opus" };
const MIME = { mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4", opus: "audio/ogg" };
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Private-Network": "true",
  "Access-Control-Expose-Headers": "X-Filename"
};
const jobs = new Map();

function emit(job, ev) {
  job.last = ev;
  for (const r of job.clients) r.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (ev.stage === "done" || ev.stage === "error") for (const r of job.clients) r.end();
}

function startJob(target, fmt) {
  const job = { id: randomUUID(), clients: new Set(), last: { stage: "starting", percent: 0 }, dir: null, file: null, fmt };
  jobs.set(job.id, job);
  (async () => {
    try {
      emit(job, { stage: "setup" });
      await ready();
      job.dir = await mkdtemp(join(tmpdir(), "yta-"));
      const args = ["--no-playlist", "--newline", "-x", "--audio-format", FORMATS[fmt], "--audio-quality", fmt === "ogg" ? "5" : "0",
        "--print-to-file", "%(.{title,channel,uploader,channel_url,uploader_url,thumbnail,webpage_url,id})j", join(job.dir, "meta.json"),
        ...(ffmpegDir ? ["--ffmpeg-location", ffmpegDir] : []),
        "-o", join(job.dir, "%(title).120B.%(ext)s"), "--", target.href];
      log(`job ${target.href} -> ${fmt}`);
      const p = spawn(YTDLP, args, { windowsHide: true });
      let title = "", err = "", buf = "";
      const onLine = line => {
        let m;
        if ((m = line.match(/\[download\] Destination: (.+)$/))) title = basename(m[1], extname(m[1]));
        else if ((m = line.match(/\[download\]\s+([\d.]+)%/))) emit(job, { stage: "download", percent: Number(m[1]), title });
        else if (/^\[(ExtractAudio|VideoConvertor|Fixup)/.test(line)) emit(job, { stage: "convert", percent: null, title });
      };
      p.stdout.on("data", d => { buf += d; const l = buf.split(/\r?\n/); buf = l.pop(); l.forEach(onLine); });
      p.stderr.on("data", d => (err += d));
      const code = await new Promise((res, rej) => { p.on("error", rej); p.on("close", res); });
      if (code !== 0) throw new Error(err.split("\n").filter(Boolean).pop() ?? `yt-dlp exit ${code}`);
      const file = (await readdir(job.dir)).find(f => f !== "meta.json");
      if (!file) throw new Error("No output file");
      job.file = file;
      let meta = {};
      try { meta = JSON.parse(await readFile(join(job.dir, "meta.json"), "utf8")); } catch { /* optional */ }
      emit(job, { stage: "done", percent: 100, title, meta: {
        title: meta.title, channel: meta.channel ?? meta.uploader, channelUrl: meta.channel_url ?? meta.uploader_url,
        thumbnail: meta.thumbnail ?? (meta.id ? `https://i.ytimg.com/vi/${meta.id}/hqdefault.jpg` : null), url: meta.webpage_url
      } });
    } catch (e) {
      log("job failed: " + e.message);
      emit(job, { stage: "error", message: String(e.message ?? e) });
    }
  })();
  setTimeout(() => cleanup(job), 15 * 60 * 1000).unref();
  return job;
}

function cleanup(job) {
  jobs.delete(job.id);
  if (job.dir) rm(job.dir, { recursive: true, force: true }).catch(() => {});
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...cors, "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST" });
    return res.end();
  }
  const u = new URL(req.url, "http://x");
  const parts = u.pathname.split("/").filter(Boolean);

  if (u.pathname === "/" || u.pathname === "/health") {
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, name: "yt-audio-helper", version: VERSION }));
  }

  if (u.pathname === "/playlist") {
    try {
      const target = resolvePlaylist(u.searchParams.get("url"));
      await ready();
      const out = await new Promise((resolve, reject) => {
        const p = spawn(YTDLP, ["--flat-playlist", "--dump-single-json", "--no-warnings", "--playlist-end", "300", "--", target.href], { windowsHide: true });
        let o = "", e = "";
        p.stdout.on("data", d => (o += d));
        p.stderr.on("data", d => (e += d));
        p.on("error", reject);
        p.on("close", c => (c === 0 ? resolve(o) : reject(new Error(e.split("\n").filter(Boolean).pop() ?? `yt-dlp exit ${c}`))));
      });
      const j = JSON.parse(out);
      const entries = (j.entries ?? []).filter(x => x?.id && /^[\w-]{11}$/.test(x.id)).map(x => ({ id: x.id, title: x.title ?? x.id }));
      res.writeHead(200, { ...cors, "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ title: j.title ?? "YouTube playlist", channel: j.channel ?? j.uploader ?? null, entries }));
    } catch (e) {
      res.writeHead(400, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
      return res.end(String(e.message));
    }
  }

  if (req.method === "POST" && u.pathname === "/jobs") {
    try {
      const target = resolveYouTube(u.searchParams.get("url"));
      const fmt = u.searchParams.get("format") ?? "opus";
      if (!FORMATS[fmt]) throw new Error("Bad format");
      const job = startJob(target, fmt);
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id: job.id }));
    } catch (e) {
      res.writeHead(400, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
      return res.end(String(e.message));
    }
  }

  const job = parts[0] === "jobs" ? jobs.get(parts[1]) : null;
  if (!job) { res.writeHead(404, cors); return res.end("Unknown job"); }

  if (parts[2] === "events") {
    res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(`data: ${JSON.stringify(job.last)}\n\n`);
    if (job.last.stage === "done" || job.last.stage === "error") return res.end();
    job.clients.add(res);
    req.on("close", () => job.clients.delete(res));
    return;
  }

  if (parts[2] === "file" && job.file) {
    const data = await readFile(join(job.dir, job.file));
    const safe = job.file.replace(/[^\p{L}\p{N}._ \-()\[\]',!&]+/gu, "_");
    res.writeHead(200, { ...cors, "Content-Type": MIME[job.fmt], "Content-Length": data.length, "X-Filename": encodeURIComponent(safe) });
    res.end(data);
    cleanup(job);
    return;
  }
  res.writeHead(409, cors);
  res.end("Not ready");
});

server.on("error", e => {
  log(e.code === "EADDRINUSE" ? "Helper is already running on this port." : "server: " + e.message);
  setTimeout(() => process.exit(e.code === "EADDRINUSE" ? 0 : 1), 3000);
});
server.listen(PORT, "127.0.0.1", () => log(`YouTube Audio Helper ${VERSION} running on http://localhost:${PORT} - keep this window open, close it to stop.`));
