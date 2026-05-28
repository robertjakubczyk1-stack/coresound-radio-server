
import dns from "node:dns";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import express from "express";
import cors from "cors";

dns.setServers(["1.1.1.1", "8.8.8.8"]);
dns.setDefaultResultOrder("ipv4first");

const VERSION = "v15-hls-broadcast-engine-2026-05-28";
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const STREAM_BITRATE = process.env.STREAM_BITRATE || "96k";
const MAX_TRACKS = Number.parseInt(process.env.MAX_TRACKS || "500", 10);
const MAX_PLAYLIST_TRACKS = Number.parseInt(process.env.MAX_FFMPEG_PLAYLIST_TRACKS || "120", 10);
const HLS_BATCH_SIZE = Number.parseInt(process.env.HLS_BATCH_SIZE || "6", 10);
const HLS_SEGMENT_TIME = Number.parseInt(process.env.HLS_SEGMENT_TIME || "6", 10);
const HLS_LIST_SIZE = Number.parseInt(process.env.HLS_LIST_SIZE || "10", 10);
const DOWNLOAD_TIMEOUT_MS = Number.parseInt(process.env.DOWNLOAD_TIMEOUT_MS || "60000", 10);
const MAX_DOWNLOAD_BYTES = Number.parseInt(process.env.MAX_DOWNLOAD_BYTES || String(90 * 1024 * 1024), 10);
const RADIO_START_DELAY_MS = Number.parseInt(process.env.RADIO_START_DELAY_MS || "3000", 10);
const RESTART_DELAY_MS = Number.parseInt(process.env.BROADCAST_RESTART_DELAY_MS || "5000", 10);
const HLS_DIR = path.join(os.tmpdir(), "coresound-hls");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

let cachedTracks = [];
let cachedAt = 0;
let hlsRunning = false;
let hlsLoopPromise = null;
let stopRequested = false;
let currentFfmpeg = null;
let currentTrack = null;
let startedAt = null;
let lastSegmentAt = null;
let lastError = null;
let batchNo = 0;

function ensureDir() {
  fs.mkdirSync(HLS_DIR, { recursive: true });
}

function cleanHls(full = false) {
  ensureDir();
  const now = Date.now();
  for (const f of fs.readdirSync(HLS_DIR)) {
    const p = path.join(HLS_DIR, f);
    try {
      const s = fs.statSync(p);
      if (full || now - s.mtimeMs > 10 * 60 * 1000) fs.unlinkSync(p);
    } catch {}
  }
}

function normalizeAudioUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const dropbox = ["dropbox.com", "www.dropbox.com", "dl.dropboxusercontent.com"].includes(url.hostname);
    if (!dropbox) return raw;
    if (url.hostname !== "dl.dropboxusercontent.com") url.hostname = "dl.dropboxusercontent.com";
    url.searchParams.delete("dl");
    url.searchParams.delete("raw");
    url.searchParams.delete("st");
    return url.toString();
  } catch {
    return raw
      .replace("https://www.dropbox.com", "https://dl.dropboxusercontent.com")
      .replace("https://dropbox.com", "https://dl.dropboxusercontent.com")
      .replace("?dl=0", "")
      .replace("&dl=0", "")
      .replace("?raw=1", "")
      .replace("&raw=1", "")
      .replace(/([?&])st=[^&]+&?/g, "$1")
      .replace(/[?&]$/, "");
  }
}

function first(...xs) {
  for (const x of xs) {
    const v = String(x || "").trim();
    if (v) return v;
  }
  return "";
}

function mapTrack(row) {
  return {
    id: String(row?.id || crypto.randomUUID()),
    title: String(row?.title || row?.name || "Bez tytułu"),
    artistName: first(row?.artist_name, row?.artistName, row?.artist, "CoreSound"),
    genre: row?.genre || row?.category || null,
    audioUrl: normalizeAudioUrl(first(row?.stream_url, row?.audio_url, row?.file_url, row?.url, row?.audioUrl, row?.streamUrl)),
    coverUrl: first(row?.cover_url, row?.avatar_url, row?.artist_avatar_url, row?.image_url) || null,
    status: row?.status || null,
  };
}

function isPlayableStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  if (!s) return true;
  return ["active", "published", "visible", "approved", "public", "live"].includes(s);
}

function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function supabase(pathname) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing Supabase variables");
  const url = `${SUPABASE_URL}${pathname}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: "application/json",
  };
  try {
    const r = await fetch(url, { headers });
    const text = await r.text();
    if (!r.ok) throw new Error(`REST ${r.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : null;
  } catch (e) {
    // IPv4 HTTPS fallback for Railway DNS issues.
    const u = new URL(url);
    return await new Promise((resolve, reject) => {
      const req = https.request({
        method: "GET", hostname: u.hostname, port: 443, path: `${u.pathname}${u.search}`, family: 4, timeout: 15000, headers
      }, (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`REST https ${res.statusCode}: ${text.slice(0,500)}`));
          try { resolve(text ? JSON.parse(text) : null); } catch (err) { reject(err); }
        });
      });
      req.on("timeout", () => req.destroy(new Error("HTTPS timeout")));
      req.on("error", reject);
      req.end();
    });
  }
}

async function getTracks(force = false) {
  const now = Date.now();
  if (!force && cachedTracks.length && now - cachedAt < 60000) return cachedTracks;

  const q = new URLSearchParams();
  q.set("select", "*");
  q.set("limit", String(MAX_TRACKS));
  q.set("order", "created_at.desc");

  let rows;
  try {
    rows = await supabase(`/rest/v1/tracks?${q.toString()}&status=in.(active,published,visible,approved,public,live)`);
  } catch {
    rows = await supabase(`/rest/v1/tracks?${q.toString()}`);
  }

  const tracks = (Array.isArray(rows) ? rows : [])
    .filter(r => isPlayableStatus(r?.status))
    .map(mapTrack)
    .filter(t => t.id && t.audioUrl)
    .slice(0, MAX_PLAYLIST_TRACKS);

  if (!tracks.length) throw new Error("No playable tracks found");
  cachedTracks = shuffle(tracks);
  cachedAt = now;
  return cachedTracks;
}

async function downloadTrack(track) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const file = path.join(os.tmpdir(), `coresound-hls-${crypto.randomUUID()}.audio`);
  try {
    const r = await fetch(track.audioUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "CoreSoundRadioServer/1.0", Accept: "audio/*,*/*" }
    });
    const type = String(r.headers.get("content-type") || "").toLowerCase();
    if (!r.ok) throw new Error(`download_http_${r.status}`);
    if (type.includes("text/html")) throw new Error("html_instead_of_audio");
    if (!r.body) throw new Error("empty_body");

    const out = fs.createWriteStream(file);
    const reader = r.body.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) throw new Error(`too_large_${total}`);
      if (!out.write(Buffer.from(value))) await new Promise(resolve => out.once("drain", resolve));
    }
    await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
    const stat = fs.statSync(file);
    if (stat.size < 1024) throw new Error(`too_small_${stat.size}`);
    return { ...track, localPath: file, localSize: stat.size };
  } catch (e) {
    try { fs.unlinkSync(file); } catch {}
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function writeConcat(batch) {
  const f = path.join(os.tmpdir(), `coresound-hls-batch-${crypto.randomUUID()}.ffconcat`);
  const lines = ["ffconcat version 1.0"];
  for (const t of batch) lines.push(`file '${String(t.localPath).replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(f, lines.join("\n") + "\n", "utf8");
  return f;
}

function runFfmpegHls(batch, concatFile) {
  return new Promise(resolve => {
    ensureDir();
    const batchId = String(++batchNo).padStart(8, "0");
    const index = path.join(HLS_DIR, "index.m3u8");
    const segment = path.join(HLS_DIR, `seg_${batchId}_%05d.ts`);

    currentTrack = {
      id: batch[0]?.id || null,
      title: batch[0]?.title || "CoreSound Radio",
      artistName: batch[0]?.artistName || "CoreSound",
      genre: batch[0]?.genre || null,
      coverUrl: batch[0]?.coverUrl || null,
    };

    const args = [
      "-hide_banner", "-loglevel", "warning", "-nostdin",
      "-re",
      "-f", "concat", "-safe", "0", "-i", concatFile,
      "-vn", "-ac", "2", "-ar", "44100",
      "-c:a", "aac", "-b:a", STREAM_BITRATE,
      "-f", "hls",
      "-hls_time", String(HLS_SEGMENT_TIME),
      "-hls_list_size", String(HLS_LIST_SIZE),
      "-hls_flags", "delete_segments+append_list+omit_endlist+program_date_time+discont_start",
      "-hls_segment_filename", segment,
      index
    ];

    console.log(`[CoreSound HLS] FFmpeg batch ${batchId}, tracks=${batch.length}`);
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    currentFfmpeg = ff;
    let err = "";

    ff.stderr.on("data", chunk => {
      const text = Buffer.from(chunk).toString("utf8");
      err += text;
      if (err.length > 4000) err = err.slice(-4000);
      console.warn("[CoreSound HLS] ffmpeg:", text.trim());
      if (text.includes(".ts") || text.includes("Opening")) lastSegmentAt = new Date().toISOString();
    });
    ff.on("error", e => {
      currentFfmpeg = null;
      resolve({ ok: false, error: e.message });
    });
    ff.on("close", code => {
      currentFfmpeg = null;
      resolve({ ok: code === 0, code, error: err.slice(-1000) });
    });
  });
}

async function hlsLoop() {
  ensureDir();
  cleanHls(true);
  startedAt = new Date().toISOString();

  let tracks = await getTracks(true);
  let idx = 0;
  let fail = 0;

  while (!stopRequested) {
    cleanHls(false);
    const batch = [];
    let attempts = 0;

    while (batch.length < HLS_BATCH_SIZE && attempts < HLS_BATCH_SIZE * 12) {
      attempts++;
      if (idx >= tracks.length) {
        tracks = shuffle(await getTracks(false));
        idx = 0;
      }
      const t = tracks[idx++];
      try {
        console.log(`[CoreSound HLS] downloading ${t.title}`);
        batch.push(await downloadTrack(t));
      } catch (e) {
        console.warn(`[CoreSound HLS] download skipped ${t.id}:`, e.message || e);
      }
    }

    if (!batch.length) throw new Error("No downloaded tracks for HLS batch");

    let concat = null;
    try {
      concat = writeConcat(batch);
      const result = await runFfmpegHls(batch, concat);
      if (result.ok) fail = 0;
      else {
        fail++;
        lastError = result.error || `ffmpeg_${result.code}`;
        console.warn("[CoreSound HLS] batch failed:", lastError);
      }
    } finally {
      for (const t of batch) try { fs.unlinkSync(t.localPath); } catch {}
      try { if (concat) fs.unlinkSync(concat); } catch {}
    }

    if (fail >= 3) {
      cachedTracks = [];
      tracks = await getTracks(true);
      idx = 0;
      fail = 0;
    }
  }
}

function ensureHlsRunning() {
  if (hlsRunning || hlsLoopPromise) return;
  stopRequested = false;
  hlsRunning = true;
  hlsLoopPromise = hlsLoop()
    .catch(e => {
      lastError = e.message || String(e);
      console.warn("[CoreSound HLS] loop crashed:", lastError);
    })
    .finally(() => {
      hlsRunning = false;
      hlsLoopPromise = null;
      currentFfmpeg = null;
      setTimeout(() => ensureHlsRunning(), RESTART_DELAY_MS);
    });
}

function hlsReady() {
  return fs.existsSync(path.join(HLS_DIR, "index.m3u8"));
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "coresound-radio-server",
    version: VERSION,
    mode: "hls-broadcast",
    hlsRunning,
    hlsReady: hlsReady(),
    currentTrack,
    startedAt,
    lastSegmentAt,
    lastError,
    time: new Date().toISOString(),
  });
});

app.get("/debug", (_req, res) => {
  ensureHlsRunning();
  res.json({
    ok: true,
    version: VERSION,
    hlsRunning,
    hlsReady: hlsReady(),
    hlsDir: HLS_DIR,
    hlsFiles: fs.existsSync(HLS_DIR) ? fs.readdirSync(HLS_DIR).slice(-40) : [],
    currentTrack,
    startedAt,
    lastSegmentAt,
    lastError,
    cachedTracks: cachedTracks.length,
    settings: { STREAM_BITRATE, HLS_BATCH_SIZE, HLS_SEGMENT_TIME, HLS_LIST_SIZE, DOWNLOAD_TIMEOUT_MS, MAX_PLAYLIST_TRACKS },
  });
});

app.get("/now", (_req, res) => {
  ensureHlsRunning();
  res.json({ ok: true, version: VERSION, hlsRunning, hlsReady: hlsReady(), track: currentTrack, lastSegmentAt, lastError });
});

app.post("/admin/restart", (_req, res) => {
  stopRequested = true;
  try { currentFfmpeg?.kill("SIGTERM"); } catch {}
  cleanHls(true);
  setTimeout(() => ensureHlsRunning(), 500);
  res.json({ ok: true, version: VERSION });
});

app.get("/live", (_req, res) => res.redirect(302, "/hls/index.m3u8"));

app.get("/hls/index.m3u8", (req, res, next) => {
  ensureHlsRunning();
  if (!hlsReady()) return res.status(503).type("text/plain").send("CoreSound HLS warming up. Refresh in a few seconds.");
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});

app.use("/hls", express.static(HLS_DIR, {
  setHeaders(res, file) {
    if (file.endsWith(".m3u8")) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    }
    if (file.endsWith(".ts")) {
      res.setHeader("Content-Type", "video/mp2t");
      res.setHeader("Cache-Control", "public, max-age=60");
    }
  }
}));

app.get("/player", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CoreSound HLS Test</title>
<style>body{background:#050505;color:white;font-family:Arial;margin:0;min-height:100vh;display:grid;place-items:center}.box{width:min(92vw,520px);background:#111;border:1px solid #333;border-radius:24px;padding:24px}button{background:#00f2ea;border:0;border-radius:999px;padding:12px 20px;font-weight:900}audio{width:100%;margin-top:20px}pre{white-space:pre-wrap;background:#000;color:#0f0;padding:12px;border-radius:12px;font-size:12px;max-height:240px;overflow:auto}</style>
</head><body><div class="box"><h1>CoreSound HLS Test</h1><p>Test HLS przez hls.js.</p><button onclick="start()">Start radio</button><audio id="a" controls playsinline></audio><pre id="l">waiting...</pre></div>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<script>
const audio=document.getElementById('a'), log=document.getElementById('l'), src='/hls/index.m3u8';
function w(x){log.textContent=new Date().toLocaleTimeString()+' '+x+'\\n'+log.textContent}
async function start(){
  w('start');
  if(audio.canPlayType('application/vnd.apple.mpegurl')) audio.src=src;
  else if(window.Hls && Hls.isSupported()){ const hls=new Hls({liveSyncDurationCount:3}); hls.loadSource(src); hls.attachMedia(audio); hls.on(Hls.Events.ERROR,(_,d)=>w('HLS error '+JSON.stringify(d))); }
  else return w('HLS unsupported');
  try{await audio.play();w('play ok')}catch(e){w('play error '+e.message)}
}
audio.onplaying=()=>w('playing'); audio.onwaiting=()=>w('waiting'); audio.onerror=()=>w('audio error');
</script></body></html>`);
});

app.use((_req, res) => res.status(404).json({ ok: false, version: VERSION, error: "Not found" }));

app.listen(PORT, () => {
  ensureDir();
  console.log(`[CoreSound HLS] ${VERSION} listening on ${PORT}`);
  setTimeout(() => ensureHlsRunning(), RADIO_START_DELAY_MS);
});
