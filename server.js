#!/usr/bin/env node
/**
 * 🎬 media-html — panel para crear contenido media con HTML
 *
 * Rutas:
 *   /            → panel admin (public/)
 *   /projects    → estáticos de proyectos (projects/)
 *   /api         → API (listar, crear, archivos, capturar, descargar)
 *
 * Convención de proyecto: carpeta en projects/ con project.json
 *   { "name": "demo", "width": 1920, "height": 1080, "fps": 30, "duration": 10 }
 * y su index.html (puede incluir ../bridge.js para play/pause + vars CSS).
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const archiver = require('archiver');
const puppeteer = require('puppeteer-core');

const ROOT = __dirname;

// .env manual (sin dependencia) — después de ROOT
(function loadEnv() {
  try {
    const envFile = path.join(ROOT, '.env');
    if (!fs.existsSync(envFile)) return;
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { console.error('[env]', e.message); }
})();

const PUBLIC_DIR = path.join(ROOT, 'public');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const PORT = Number(process.env.PORT || 8010);
const HOST = process.env.HOST || '0.0.0.0';
// headless-shell de HyperFrames (v152) — probado, el --screenshot del chrome-for-testing v148 se cuelga
const CHROME_SHELL = '/home/diablo/.cache/hyperframes/chrome/chrome-headless-shell/linux-152.0.7928.2/chrome-headless-shell-linux64/chrome-headless-shell';
const CHROME_FALLBACK = '/home/diablo/chrome-for-testing/chrome-linux64/chrome';
const CHROME = process.env.MEDIA_HTML_CHROME || (fs.existsSync(CHROME_SHELL) ? CHROME_SHELL : CHROME_FALLBACK);
const IS_SHELL = CHROME.includes('chrome-headless-shell');
// para la grabadora (CDP/puppeteer) el chrome completo funciona bien
const CHROME_REC = process.env.MEDIA_HTML_CHROME_REC || CHROME_FALLBACK;
const API_KEY = process.env.MEDIA_HTML_API_KEY || '';
const BASE_URL = `http://127.0.0.1:${PORT}`;

const app = express();
app.use(express.json({ limit: '4mb' }));

/* ---------------- helpers ---------------- */

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'proyecto';
}

function projectDir(name) {
  const p = path.resolve(PROJECTS_DIR, name);
  if (p !== PROJECTS_DIR && !p.startsWith(PROJECTS_DIR + path.sep)) throw new Error('ruta inválida');
  return p;
}

function safeResolve(dir, rel) {
  const p = path.resolve(dir, String(rel || ''));
  if (p !== dir && !p.startsWith(dir + path.sep)) throw new Error('ruta inválida');
  return p;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

function listProjects() {
  return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => {
      const dir = path.join(PROJECTS_DIR, d.name);
      const meta = readJson(path.join(dir, 'project.json')) || {};
      let st = { mtimeMs: 0 };
      try { st = fs.statSync(dir); } catch {}
      return { name: d.name, ...meta, updatedAt: st.mtimeMs };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/* ---------------- estáticos ---------------- */

app.use('/projects', express.static(PROJECTS_DIR));
// ⚠️ el panel NO debe cachearse en el navegador (Cloudflare impone 4h de
// browser-cache por zona; si algún día se pone 'respect origin', esto ya
// manda no-cache y los cambios de admin.js se ven al instante).
app.use((req, res, next) => {
  if (req.path === '/' || /^\/(index\.html|admin\.js|admin\.css)$/.test(req.path)) {
    res.setHeader('Cache-Control', 'no-cache');
  }
  next();
});
app.use(express.static(PUBLIC_DIR));

/* ---------------- auth para escritura (API público) ---------------- */

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.headers['x-media-key'] === API_KEY) return next();
  return res.status(401).json({ ok: false, error: 'API key requerida (header X-Media-Key)' });
}

app.post('/api/*', requireKey);
app.put('/api/*', requireKey);

/* ---------------- API: proyectos ---------------- */

app.get('/api/projects', (req, res) => {
  res.json({ ok: true, projects: listProjects() });
});

app.get('/api/projects/:name', (req, res) => {
  try {
    const dir = projectDir(req.params.name);
    if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, error: 'no existe' });
    const meta = readJson(path.join(dir, 'project.json')) || {};
    res.json({ ok: true, project: { name: req.params.name, ...meta, files: walk(dir) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/projects', (req, res) => {
  try {
    const { name, width = 1280, height = 720, fps = 30, duration = 10 } = req.body || {};
    const slug = slugify(name);
    const dir = projectDir(slug);
    if (fs.existsSync(dir)) return res.status(409).json({ ok: false, error: `ya existe '${slug}'` });
    fs.mkdirSync(dir, { recursive: true });
    const w = Math.max(16, Math.min(7680, Number(width) || 1280));
    const h = Math.max(16, Math.min(4320, Number(height) || 720));
    const meta = { name: slug, width: w, height: h, fps: Math.max(1, Math.min(120, Number(fps) || 30)), duration: Math.max(1, Math.min(3600, Number(duration) || 10)) };
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(meta, null, 2));
    fs.writeFileSync(path.join(dir, 'index.html'), templateHtml(meta));
    res.json({ ok: true, project: { ...meta, files: walk(dir) } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------------- API: archivos del proyecto ---------------- */

app.get('/api/projects/:name/files', (req, res) => {
  try {
    const dir = projectDir(req.params.name);
    if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, error: 'no existe' });
    res.json({ ok: true, files: walk(dir) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/api/projects/:name/file', (req, res) => {
  try {
    const dir = projectDir(req.params.name);
    const p = safeResolve(dir, req.query.path);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return res.status(404).json({ ok: false, error: 'no existe' });
    res.json({ ok: true, path: req.query.path, content: fs.readFileSync(p, 'utf8') });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.put('/api/projects/:name/file', (req, res) => {
  try {
    const dir = projectDir(req.params.name);
    const p = safeResolve(dir, req.query.path);
    if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'no existe' });
    fs.writeFileSync(p, String(req.body?.content ?? ''));
    const st = fs.statSync(dir);
    res.json({ ok: true, updatedAt: st.mtimeMs });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/projects/:name/file', (req, res) => {
  try {
    const dir = projectDir(req.params.name);
    const p = safeResolve(dir, req.query.path);
    if (fs.existsSync(p)) return res.status(409).json({ ok: false, error: 'ya existe' });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(req.body?.content ?? ''));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* upload binario (audio/video/imágenes): body crudo con content-type propio */
app.post('/api/projects/:name/upload', (req, res) => {
  try {
    const dir = projectDir(req.params.name);
    const p = safeResolve(dir, req.query.path);
    if (fs.existsSync(p)) return res.status(409).json({ ok: false, error: 'ya existe' });
    const chunks = [];
    let size = 0;
    const MAX = 100 * 1024 * 1024;
    let done = false;
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > MAX) { done = true; req.destroy(new Error('archivo muy grande')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, Buffer.concat(chunks));
        res.json({ ok: true, size });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });
    req.on('error', () => { if (!done) { done = true; res.status(400).json({ ok: false, error: 'upload falló' }); } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------------- API: captura PNG (chrome headless) ---------------- */

app.post('/api/projects/:name/capture', (req, res) => {
  try {
    const dir = projectDir(req.params.name);
    const meta = readJson(path.join(dir, 'project.json'));
    if (!meta) return res.status(404).json({ ok: false, error: 'sin project.json' });
    const at = Math.max(0, Math.min(3600, Number(req.body?.at) || 0));
    const url = `${BASE_URL}/projects/${encodeURIComponent(req.params.name)}/index.html?media=1`;
    const out = path.join(os.tmpdir(), `media-html-${crypto.randomBytes(6).toString('hex')}.png`);
    const prof = path.join(os.tmpdir(), `media-html-prof-${crypto.randomBytes(4).toString('hex')}`);
    const budget = 800 + at * 1000;
    const args = [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--run-all-compositor-stages-before-draw',
      `--user-data-dir=${prof}`,
      `--virtual-time-budget=${budget}`,
      `--window-size=${meta.width},${meta.height}`,
      `--screenshot=${out}`,
      url
    ];
    if (!IS_SHELL) args.unshift('--headless');
    execFile(CHROME, args, { timeout: 45000 }, (err) => {
      fs.rmSync(prof, { recursive: true, force: true });
      if (err || !fs.existsSync(out)) {
        return res.status(500).json({ ok: false, error: 'falló captura: ' + (err?.message || 'sin archivo') });
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}@${at}s.png"`);
      fs.createReadStream(out).pipe(res).on('finish', () => fs.unlink(out, () => {}));
    });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------------- API: descarga zip ---------------- */

app.get('/api/projects/:name/download', (req, res) => {
  try {
    const dir = projectDir(req.params.name);
    if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, error: 'no existe' });
    res.attachment(`${req.params.name}.zip`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (e) => { console.error('[zip]', e.message); res.destroy(e); });
    archive.pipe(res);
    archive.directory(dir, false);
    archive.finalize();
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------------- API: grabación de presentaciones ----------------
 * Graba en tiempo real un proyecto headless: el panel reenvía los clicks/teclas
 * reales del preview al navegador oculto, que captura frames a N fps.
 * Stop → ffmpeg → MP4 + copia en /mnt/480ssd/public-files/videos/media-html/
 */

const rec = {
  active: false, sessionId: null, browser: null, page: null, client: null,
  dir: null, seq: 0, times: [], lastTs: 0, heartbeat: null,
  project: null, startedAt: 0, stopTimer: null, maxMs: 15 * 60 * 1000
};

function recReset() {
  clearInterval(rec.heartbeat);
  clearTimeout(rec.stopTimer);
  rec.active = false; rec.sessionId = null; rec.browser = null; rec.page = null; rec.client = null;
  rec.dir = null; rec.seq = 0; rec.times = []; rec.lastTs = 0; rec.heartbeat = null;
  rec.project = null; rec.stopTimer = null;
}

app.post('/api/projects/:name/record/start', async (req, res) => {
  try {
    if (rec.active) return res.status(409).json({ ok: false, error: 'ya hay una grabación activa' });
    const dir = projectDir(req.params.name);
    const meta = readJson(path.join(dir, 'project.json'));
    if (!meta) return res.status(404).json({ ok: false, error: 'sin project.json' });
    const url = `${BASE_URL}/projects/${encodeURIComponent(req.params.name)}/index.html?media=1`;
    const browser = await puppeteer.launch({
      executablePath: CHROME_REC,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: meta.width, height: meta.height, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    // ⏳ video embebido: forzar descarga completa ANTES de grabar (para que corra fluido)
    let prepared = { videos: 0, buffered: true };
    try { prepared = await ensureVideosBuffered(page, 45000); } catch (e) { console.error('[rec] preload video:', e.message); }
    await new Promise(r => setTimeout(r, 600));
    const client = await page.createCDPSession();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-rec-'));
    rec.active = true;
    rec.sessionId = crypto.randomBytes(8).toString('hex');
    rec.browser = browser; rec.page = page; rec.client = client; rec.dir = tmpDir;
    rec.project = req.params.name; rec.startedAt = Date.now();
    rec.seq = 0; rec.times = []; rec.lastTs = 0;
    // screencast: frames solo cuando hay movimiento (el compositor está sucio)
    // ⚠️ ts SIEMPRE en wall-clock (Date.now/1000) para mezclar con el heartbeat
    client.on('Page.screencastFrame', ({ data, sessionId: fId }) => {
      if (!rec.active) return;
      const seq = rec.seq++;
      try { fs.writeFileSync(path.join(tmpDir, `f${seq}.jpg`), Buffer.from(data, 'base64')); } catch {}
      const ts = Date.now() / 1000;
      rec.times.push({ seq, ts });
      rec.lastTs = ts;
      client.send('Page.screencastFrameAck', { sessionId: fId }).catch(() => {});
    });
    client.send('Page.startScreencast', { format: 'jpeg', quality: 85 }).catch(e => console.error('[rec] screencast:', e.message));
    // heartbeat: si no hay frames (página estática), captura 1fps para no perder las pausas
    rec.heartbeat = setInterval(async () => {
      if (!rec.active) return;
      const now = Date.now() / 1000;
      if (now - rec.lastTs < 0.8) return;
      try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 80 });
        if (!rec.active) return;
        const seq = rec.seq++;
        try { fs.writeFileSync(path.join(tmpDir, `f${seq}.jpg`), buf); } catch {}
        rec.times.push({ seq, ts: now });
        rec.lastTs = now;
      } catch (e) { /* noop */ }
    }, 1000);
    rec.stopTimer = setTimeout(() => { stopRecording(rec.sessionId, true).catch(() => {}); }, rec.maxMs);
    res.json({ ok: true, sessionId: rec.sessionId, width: meta.width, height: meta.height, prepared });
  } catch (e) {
    if (rec.browser) rec.browser.close().catch(() => {});
    recReset();
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/projects/:name/record/click', async (req, res) => {
  try {
    if (!rec.active || req.body?.sessionId !== rec.sessionId) return res.status(409).json({ ok: false, error: 'sin sesión activa' });
    const { x, y } = req.body;
    await rec.page.mouse.move(Number(x), Number(y));
    await rec.page.mouse.down();
    await rec.page.mouse.up();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/projects/:name/record/key', async (req, res) => {
  try {
    if (!rec.active || req.body?.sessionId !== rec.sessionId) return res.status(409).json({ ok: false, error: 'sin sesión activa' });
    const k = String(req.body?.key || '');
    if (k) { await rec.page.keyboard.down(k); await rec.page.keyboard.up(k); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ---------------- grabación: preload de videos embebidos ----------------
 * Si el proyecto tiene <video>, se fuerza la descarga completa ANTES de
 * empezar a grabar (seek al final y regreso) → corre fluido durante la
 * captura, sin stutter por red.
 */

async function ensureVideosBuffered(page, timeoutMs) {
  const hasVideos = await page.evaluate(() => document.querySelectorAll('video').length > 0);
  if (!hasVideos) return { videos: 0, buffered: true };
  return Promise.race([
    page.evaluate(async () => {
      const vs = [...document.querySelectorAll('video')];
      for (const v of vs) {
        if (v.preload === 'none') v.preload = 'auto';
        if (v.readyState < 1) { try { v.load(); } catch {} }
      }
      // esperar metadata de todos
      await Promise.all(vs.map(v => v.readyState >= 1 ? Promise.resolve() : new Promise(r => {
        const h = () => r();
        v.addEventListener('loadedmetadata', h, { once: true });
        setTimeout(() => r(), 8000);
      })));
      // forzar buffer completo: seek al final y volver a la posición original
      for (const v of vs) {
        const orig = v.currentTime;
        try {
          const bufferedOk = v.buffered.length && Number.isFinite(v.duration) && v.duration > 0 && v.buffered.end(v.buffered.length - 1) >= v.duration - 0.3;
          if (!bufferedOk && Number.isFinite(v.duration) && v.duration > 0) {
            v.currentTime = Math.max(0, v.duration - 0.05);
            await new Promise(r => { v.addEventListener('seeked', r, { once: true }); setTimeout(() => r(), 4000); });
          }
        } catch {}
        try { if (Math.abs(v.currentTime - orig) > 0.5) v.currentTime = orig; } catch {}
      }
      const buffered = vs.every(v => v.readyState === 4 || (v.buffered.length && Number.isFinite(v.duration) && v.buffered.end(v.buffered.length - 1) >= v.duration - 0.3));
      return { videos: vs.length, buffered, durations: vs.map(v => Number.isFinite(v.duration) ? Math.round(v.duration) : null) };
    }),
    new Promise(r => setTimeout(() => r({ videos: -1, buffered: false, timeout: true }), timeoutMs))
  ]);
}

/* ---------------- grabación: mux de pistas de audio ----------------
 * project.json puede declarar: "audio": [{file, at, volume, fadeIn, fadeOut}]
 * Al codificar el video, se mezclan las pistas con adelay/amix/loudnorm
 * (estilo del pipeline: I=-13.5, TP=-0.3). Determinista, sin audio del SO.
 */

function probeDur(file) {
  try {
    const r = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', timeout: 15000 });
    const d = parseFloat(r.trim());
    return Number.isFinite(d) ? d : null;
  } catch { return null; }
}

async function muxAudio(videoFile, tracks, dir) {
  const videoDur = await probeDur(videoFile);
  if (!videoDur) return null;
  const out = path.join(path.dirname(videoFile), path.basename(videoFile, '.mp4') + '-audio.mp4');
  const inputs = ['-y', '-i', videoFile];
  const filters = [];
  const labels = [];
  let valid = 0;
  for (const t of tracks) {
    const file = path.join(dir, t.file);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { console.warn('[rec] pista de audio no existe:', t.file); continue; }
    const n = valid + 1;
    inputs.push('-i', file);
    let f = `[${n}:a]aresample=48000`;
    const vol = Number(t.volume ?? 1);
    if (vol !== 1) f += `,volume=${vol}`;
    const at = Math.max(0, Number(t.at) || 0);
    if (at > 0) f += `,adelay=${Math.round(at * 1000)}:all=1`;
    const fi = Math.max(0, Number(t.fadeIn) || 0);
    if (fi > 0) f += `,afade=t=in:st=0:d=${fi}`;
    const fo = Math.max(0, Number(t.fadeOut) || 0);
    if (fo > 0) {
      const td = await probeDur(file);
      const st = td ? Math.max(0, td - fo) : 0;
      f += `,afade=t=out:st=${st}:d=${fo}`;
    }
    f += `[m${n}]`;
    filters.push(f); labels.push(`[m${n}]`); valid++;
  }
  if (!valid) return null;
  if (valid === 1) filters.push(`${labels[0]}loudnorm=I=-13.5:TP=-0.3:LRA=11,aresample=48000[a]`);
  else filters.push(`${labels.join('')}amix=inputs=${valid}:normalize=0,loudnorm=I=-13.5:TP=-0.3:LRA=11,aresample=48000[a]`);
  const args = inputs.concat(['-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(videoDur), '-movflags', '+faststart', out]);
  await new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 300000, maxBuffer: 1e7 }, (err) => err ? reject(err) : resolve());
  });
  return out;
}

async function stopRecording(sessionId, auto) {
  if (!rec.active || rec.sessionId !== sessionId) return { ok: false, error: 'sin sesión activa' };
  clearInterval(rec.heartbeat);
  clearTimeout(rec.stopTimer);
  const client = rec.client, browser = rec.browser, project = rec.project;
  const dir = rec.dir, times = rec.times, startedAt = rec.startedAt;
  rec.active = false; rec.sessionId = null; rec.browser = null; rec.page = null; rec.client = null;
  try { if (client) await client.send('Page.stopScreencast'); } catch {}
  try { await browser.close(); } catch {}
  if (auto) console.log('[rec] auto-stop por límite de tiempo');
  if (times.length < 2) { fs.rmSync(dir, { recursive: true, force: true }); return { ok: false, error: 'muy pocos frames capturados' }; }
  times.sort((a, b) => a.ts - b.ts);
  const elapsedSec = Math.max(0.5, (Date.now() - startedAt) / 1000);
  const startWall = startedAt / 1000;
  const fps = Math.min(120, Math.max(1, times.length / elapsedSec)); // fps real promedio
  const out0 = path.join(os.tmpdir(), `${project}-${Date.now()}.mp4`);
  await new Promise((resolve, reject) => {
    const ff = execFile('ffmpeg', [
      '-y', '-f', 'image2pipe', '-framerate', String(fps),
      '-i', 'pipe:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out0
    ], { timeout: 180000, maxBuffer: 1e7 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
    // difusión de error: cada frame se repite según su duración real (0 = se descarta)
    // la línea de tiempo cubre TODO el elapsed: primer frame desde t=0, último hasta stop
    let acc = 0;
    let idx = 0;
    const writeFrame = () => {
      if (idx >= times.length) { ff.stdin.end(); return; }
      const t = times[idx];
      const rel = t.ts - startWall; // segundos desde que arrancó la grabación
      let dur;
      // duraciones CRUDAS (sin clamp mínimo: a 30fps los gaps son 0.033s y un
      // clamp a 0.05 infla la duración +50%; los dups=0 los descarta la difusión)
      if (idx === 0) dur = Math.min(10, times[1].ts - startWall);                  // cubre desde t=0
      else if (idx === times.length - 1) dur = Math.min(10, Math.max(0, elapsedSec - rel)); // hasta el stop
      else dur = Math.min(5, Math.max(0, times[idx + 1].ts - t.ts));
      const dups = Math.floor(acc + dur * fps);
      acc = acc + dur * fps - dups;
      idx++;
      if (dups <= 0) { writeFrame(); return; }
      let buf = null;
      try { buf = fs.readFileSync(path.join(dir, `f${t.seq}.jpg`)); } catch { writeFrame(); return; }
      let n = 0;
      const pump = () => {
        while (n < dups) {
          n++;
          if (!ff.stdin.write(buf)) {
            ff.stdin.once('drain', pump);
            return;
          }
        }
        writeFrame();
      };
      pump();
    };
    writeFrame();
  });
  fs.rmSync(dir, { recursive: true, force: true });
  // 🎵 mezclar pistas de audio declaradas en project.json
  let out = out0;
  let audioInfo = { tracks: 0, mixed: false };
  try {
    const meta = readJson(path.join(projectDir(project), 'project.json')) || {};
    const tracks = (meta.audio || []).filter(t => t && t.file);
    if (tracks.length) {
      const mixed = await muxAudio(out, tracks, projectDir(project));
      if (mixed) { audioInfo = { tracks: tracks.length, mixed: true }; fs.rmSync(out, { force: true }); out = mixed; }
    }
  } catch (e) { console.error('[rec] mux audio:', e.message); }
  const avgFps = Math.round(fps * 10) / 10;
  return { ok: true, file: out, fps: avgFps, frames: times.length, project, audio: audioInfo };
}

app.post('/api/projects/:name/record/stop', async (req, res) => {
  try {
    const r = await stopRecording(req.body?.sessionId, false);
    if (!r.ok) return res.status(409).json(r);
    let publicUrl = '';
    try {
      const destDir = '/mnt/480ssd/public-files/videos/media-html';
      fs.mkdirSync(destDir, { recursive: true });
      const fname = `${r.project}-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.mp4`;
      fs.copyFileSync(r.file, path.join(destDir, fname));
      publicUrl = `https://baal.diablitodevops.com/files/videos/media-html/${fname}`;
    } catch (e) { console.error('[rec] copia a public-files falló:', e.message); }
    res.setHeader('X-Media-Url', publicUrl);
    res.setHeader('X-Media-Frames', String(r.frames));
    res.setHeader('X-Media-Fps', String(r.fps));
    res.setHeader('X-Media-Audio', r.audio?.mixed ? `${r.audio.tracks} pistas mezcladas` : 'sin audio');
    res.attachment(`${r.project}.mp4`);
    fs.createReadStream(r.file).pipe(res).on('finish', () => fs.unlink(r.file, () => {}));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/projects/:name/record/abort', async (req, res) => {
  try {
    if (!rec.active || req.body?.sessionId !== rec.sessionId) return res.status(409).json({ ok: false, error: 'sin sesión activa' });
    const browser = rec.browser, client = rec.client;
    recReset();
    try { if (client) await client.send('Page.stopScreencast'); } catch {}
    try { await browser.close(); } catch {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ---------------- template de proyecto nuevo ---------------- */

function templateHtml({ name, width, height }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${name}</title>
<style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; }
  body {
    display: grid; place-items: center;
    font-family: system-ui, sans-serif;
    color: #fff;
    background:
      radial-gradient(1200px 600px at 20% 10%, rgba(124,58,237,.55), transparent 60%),
      radial-gradient(1000px 500px at 80% 90%, rgba(6,182,212,.45), transparent 60%),
      #0b0e14;
  }
  .card {
    text-align: center; padding: 4rem 6rem;
    border: 1px solid rgba(255,255,255,.15);
    border-radius: 2rem;
    background: rgba(255,255,255,.06);
    backdrop-filter: blur(8px);
    box-shadow: 0 30px 80px rgba(0,0,0,.5);
    animation: float 3s ease-in-out infinite;
  }
  h1 { font-size: 3.5rem; letter-spacing: .02em; }
  .size { margin-top: 1rem; font-size: 1.6rem; opacity: .75; font-variant-numeric: tabular-nums; }
  .hint { margin-top: .6rem; font-size: 1rem; opacity: .5; }
  @keyframes float {
    0%, 100% { transform: translateY(0) rotate(0deg); }
    50% { transform: translateY(-14px) rotate(.6deg); }
  }
</style>
</head>
<body>
  <div class="card">
    <h1>${name}</h1>
    <div class="size"><span id="w"></span> × <span id="h"></span> px</div>
    <div class="hint">tu lienzo: ${width}×${height}px · edita projects/${name}/index.html</div>
  </div>
  <script>
    // el bridge dispara 'media:init' cuando ya definió --media-w / --media-h
    function showSize() {
      document.getElementById('w').textContent = getComputedStyle(document.documentElement).getPropertyValue('--media-w').trim().replace('px','');
      document.getElementById('h').textContent = getComputedStyle(document.documentElement).getPropertyValue('--media-h').trim().replace('px','');
    }
    window.addEventListener('media:init', showSize);
  </script>
  <script src="../bridge.js"></script>
</body>
</html>`;
}

/* ---------------- arranque ---------------- */

app.listen(PORT, HOST, () => {
  console.log(`🎬 media-html en http://localhost:${PORT}`);
  console.log(`   /  (panel admin)   /projects (estáticos)   /api`);
});
