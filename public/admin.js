/* 🎬 media-html admin */
const $ = (s) => document.querySelector(s);
const state = { projects: [], current: null, playing: false, currentFile: null };

const select = $('#projectSelect');
const frame = $('#frame');
const wrap = $('#frameWrap');
const stage = $('#stage');

/* ---------- api (con login por sesión; la cookie viaja sola) ---------- */

async function api(path, opts = {}) {
  let r = await fetch(path, { ...opts, headers: { ...(opts.headers || {}) } });
  if (r.status === 401 && !opts._retried) {
    await requestLogin(); // si cancela, lanza y el llamador hace catch
    return api(path, { ...opts, _retried: true });
  }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r;
}

/* ---------- pantalla de login (sin prompt de token) ---------- */

let loginModalPromise = null;
function requestLogin() {
  if (loginModalPromise) return loginModalPromise;
  loginModalPromise = new Promise((resolve, reject) => {
    const modal = $('#loginModal');
    const errEl = $('#loginError');
    errEl.textContent = '';
    modal.classList.remove('hidden');
    const cleanup = (ok) => {
      modal.classList.add('hidden');
      $('#loginForm').removeEventListener('submit', onSubmit);
      $('#loginCancel').removeEventListener('click', onCancel);
      $('#loginPass').value = '';
      loginModalPromise = null;
      ok ? resolve() : reject(new Error('inicia sesión para continuar'));
    };
    const onSubmit = async (e) => {
      e.preventDefault();
      errEl.textContent = '';
      try {
        const r = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user: $('#loginUser').value, password: $('#loginPass').value })
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          errEl.textContent = j.error || 'credenciales incorrectas';
          return;
        }
        cleanup(true);
      } catch { errEl.textContent = 'error de red, reintenta'; }
    };
    const onCancel = () => cleanup(false);
    $('#loginForm').addEventListener('submit', onSubmit);
    $('#loginCancel').addEventListener('click', onCancel);
    setTimeout(() => $('#loginUser').focus(), 50);
  });
  return loginModalPromise;
}

$('#btnLogout').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  location.reload();
});

/* ---------- proyectos ---------- */

async function loadProjects(keep) {
  try {
    const { projects } = await (await api('/api/projects')).json();
    state.projects = projects;
    select.innerHTML = '';
    for (const p of projects) {
      const o = document.createElement('option');
      o.value = p.name;
      o.textContent = `${p.name} · ${p.width}×${p.height}`;
      select.appendChild(o);
    }
    const target = keep || projects.find(p => p.name === state.current) || projects[projects.length - 1];
    if (target) { select.value = target.name; await openProject(target.name); }
    else $('#status').textContent = 'sin proyectos — crea uno con ＋ Nuevo';
  } catch (e) {
    $('#status').textContent = '🔒 ' + e.message;
  }
}

async function openProject(name) {
  const { project } = await (await api(`/api/projects/${name}`)).json();
  state.current = name;
  state.playing = false;
  $('#btnPlay').textContent = '▶ Play';
  frame.src = `/projects/${name}/index.html?media=1`;
  frame.dataset.w = project.width;
  frame.dataset.h = project.height;
  // 🎬 candado de video: si el proyecto trae <video>, los botones se habilitan
  // SOLO cuando los videos estén buffereados (grabación fluida).
  // Si NO hay <video>, se habilitan de inmediato.
  const prep = await armButtons();
  $('#status').textContent = `${project.name} · ${project.width}×${project.height}px · ${project.fps}fps · ${project.duration}s${prep}`;
  fit();
  loadFiles();
  loadAudio();
}

/* ---------- candado de video embebido ---------- */

function setButtonsEnabled(on) {
  ['btnPlay', 'btnCapture', 'btnDownload', 'btnRec'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
}

async function armButtons() {
  // esperar a que el iframe cargue el proyecto
  const projectUrl = `/projects/${state.current}/index.html`;
  const isLoaded = () => {
    try {
      const d = frame.contentDocument;
      return d && d.URL && d.URL.includes(projectUrl) && d.readyState === 'complete';
    } catch { return false; }
  };
  if (!isLoaded()) {
    await new Promise(res => {
      frame.addEventListener('load', res, { once: true });
      setTimeout(res, 10000); // fallback: nunca colgar el panel
    });
  }
  let videos = [];
  try {
    const d = frame.contentDocument;
    if (d) videos = [...d.querySelectorAll('video')];
  } catch { videos = []; }
  // sin <video> → todo activo ya
  if (!videos.length) { setButtonsEnabled(true); return ''; }
  // candado: forzar carga y esperar buffer completo (máx 45s, como el server)
  for (const v of videos) {
    if (v.preload === 'none') v.preload = 'auto';
    if (v.readyState < 1) { try { v.load(); } catch {} }
  }
  const buffered = () => videos.every(v =>
    v.readyState === 4 ||
    (v.buffered.length && Number.isFinite(v.duration) && v.duration > 0 &&
     v.buffered.end(v.buffered.length - 1) >= v.duration - 0.3));
  if (buffered()) { setButtonsEnabled(true); return ` · video embebido listo ✓ (${videos.length})`; }
  $('#status').textContent = `⏳ cargando ${videos.length} video(s) embebido(s)…`;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    if (buffered()) { setButtonsEnabled(true); return ` · video embebido listo ✓ (${videos.length})`; }
  }
  // si los videos no terminan, habilitar igual (el server fuerza el buffer al grabar)
  setButtonsEnabled(true);
  return ` · video embebido parcial ⚠️ (${videos.length})`;
}

/* ---------- escala ---------- */

function fit() {
  if (!state.current) return;
  const w = +frame.dataset.w, h = +frame.dataset.h;
  const sw = stage.clientWidth - 24, sh = stage.clientHeight - 24;
  const s = Math.min(sw / w, sh / h);
  wrap.style.width = (w * s) + 'px';
  wrap.style.height = (h * s) + 'px';
  frame.style.width = w + 'px';
  frame.style.height = h + 'px';
  frame.style.transform = `scale(${s})`;
  $('#scaleInfo').textContent = `escala ${(s * 100).toFixed(0)}%`;
}
window.addEventListener('resize', fit);

/* ---------- play / pausa ---------- */

$('#btnPlay').addEventListener('click', () => {
  state.playing = !state.playing;
  frame.contentWindow.postMessage({ type: 'media:' + (state.playing ? 'play' : 'pause') }, '*');
  $('#btnPlay').textContent = state.playing ? '⏸ Pausa' : '▶ Play';
});

/* ---------- captura ---------- */

$('#btnCapture').addEventListener('click', async () => {
  const at = Math.max(0, +($('#capAt').value || 0));
  $('#btnCapture').textContent = '⏳…';
  try {
    const r = await api(`/api/projects/${state.current}/capture`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ at })
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'captura falló');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.current}@${at}s.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { alert('captura falló: ' + e.message); }
  $('#btnCapture').textContent = '📸 Capturar';
});

/* ---------- descarga ---------- */

$('#btnDownload').addEventListener('click', () => {
  window.location = `/api/projects/${state.current}/download`;
});

/* ---------- grabación (presentaciones) ---------- */

let recState = null, recTimerInt = null, recStart = 0;

$('#btnRec').addEventListener('click', async () => {
  if (!recState) {
    $('#btnRec').textContent = '⏳ preparando…';
    $('#btnRec').disabled = true;
    try {
      const r = await api(`/api/projects/${state.current}/record/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      recState = await r.json();
      recState._prep = recState.prepared && recState.prepared.videos
        ? ` · video embebido ${recState.prepared.buffered ? 'listo ✓' : 'parcial ⚠️'} (${recState.prepared.videos})`
        : '';
      recStart = Date.now();
      $('#btnRec').textContent = '⏹ Stop';
      $('#btnRec').classList.add('danger', 'recording');
      recTimerInt = setInterval(() => {
        $('#status').textContent = `● GRABANDO ${state.current} · ${Math.round((Date.now() - recStart) / 1000)}s${recState._prep} · clicks y teclas se graban`;
      }, 500);
    } catch (e) { alert('no pude iniciar grabación: ' + e.message); }
    $('#btnRec').textContent = '● Grabar';
    $('#btnRec').classList.remove('danger', 'recording');
    $('#btnRec').disabled = false;
  } else {
    clearInterval(recTimerInt);
    $('#btnRec').textContent = '⏳…';
    try {
      const r = await fetch(`/api/projects/${state.current}/record/stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...keyHdr() },
        body: JSON.stringify({ sessionId: recState.sessionId })
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'stop falló');
      const url = r.headers.get('X-Media-Url') || '';
      const frames = r.headers.get('X-Media-Frames') || '?';
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${state.current}.mp4`;
      a.click();
      URL.revokeObjectURL(a.href);
      $('#status').textContent = `🎬 video listo (${frames} frames)` + (url ? ` · copia pública: ${url}` : '');
    } catch (e) { alert('stop falló: ' + e.message); }
    recState = null;
    $('#btnRec').textContent = '● Grabar';
    $('#btnRec').classList.remove('danger', 'recording');
  }
});

/* ---------- nuevo proyecto ---------- */

const modal = $('#modal');
$('#btnNew').addEventListener('click', () => modal.classList.remove('hidden'));
$('#npCancel').addEventListener('click', () => modal.classList.add('hidden'));
$('#newForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('#npName').value.trim(),
        width: +$('#npW').value, height: +$('#npH').value,
        fps: +$('#npFps').value, duration: +$('#npDur').value
      })
    });
    modal.classList.add('hidden');
    $('#npName').value = '';
    await loadProjects();
  } catch (err) { alert(err.message); }
});

/* ---------- editor ---------- */

$('#btnEditor').addEventListener('click', () => $('#editor').classList.toggle('hidden'));

async function loadFiles() {
  const { files } = await (await api(`/api/projects/${state.current}/files`)).json();
  const ul = $('#fileList');
  ul.innerHTML = '';
  for (const f of files) {
    const li = document.createElement('li');
    li.textContent = f;
    li.dataset.path = f;
    li.addEventListener('click', () => openFile(f));
    ul.appendChild(li);
  }
  if (state.currentFile && files.includes(state.currentFile)) openFile(state.currentFile);
  else { state.currentFile = null; $('#fileContent').value = ''; $('#btnSave').disabled = true; $('#fileStatus').textContent = ''; }
}

async function openFile(p) {
  state.currentFile = p;
  const { content } = await (await api(`/api/projects/${state.current}/file?path=${encodeURIComponent(p)}`)).json();
  $('#fileContent').value = content;
  $('#btnSave').disabled = false;
  $('#fileStatus').textContent = p;
  [...$('#fileList').children].forEach(li => li.classList.toggle('active', li.dataset.path === p));
}

$('#btnSave').addEventListener('click', async () => {
  await api(`/api/projects/${state.current}/file?path=${encodeURIComponent(state.currentFile)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: $('#fileContent').value })
  });
  $('#fileStatus').textContent = '💾 guardado ' + new Date().toLocaleTimeString();
});

/* ---------- upload binario (audio/video/imágenes) ---------- */

$('#btnUpload').addEventListener('click', async () => {
  const inp = $('#fileUpload');
  const f = inp.files[0];
  if (!f) return;
  $('#fileStatus').textContent = `⬆ subiendo ${f.name}…`;
  try {
    const r = await fetch(`/api/projects/${state.current}/upload?path=${encodeURIComponent(f.name)}`, {
      method: 'POST', headers: keyHdr(), body: f
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'upload falló');
    $('#fileStatus').textContent = `✅ ${f.name} subido`;
    inp.value = '';
    await loadFiles();
    loadAudio();
  } catch (e) { alert('upload falló: ' + e.message); }
});

/* ---------- audio del video (pistas de project.json) ---------- */

let audioFiles = [];

async function loadAudio() {
  const files = (await (await api(`/api/projects/${state.current}/files`)).json()).files;
  audioFiles = files.filter(f => /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f));
  let meta = {};
  try { meta = JSON.parse((await (await api(`/api/projects/${state.current}/file?path=${encodeURIComponent('project.json')}`)).json()).content); } catch {}
  const tracks = Array.isArray(meta.audio) ? meta.audio : [];
  $('#audioRows').innerHTML = '';
  if (!tracks.length) $('#audioRows').innerHTML = '<div class="audio-empty">sin pistas — añade música/voz (mp3/wav/ogg)</div>';
  tracks.forEach((t, i) => $('#audioRows').appendChild(audioRow(t, i)));
}

function audioRow(t, i) {
  const row = document.createElement('div');
  row.className = 'audio-row';
  const sel = document.createElement('select');
  sel.id = 'aFile' + i;
  const opts = audioFiles.length ? audioFiles : [t.file || ''];
  for (const f of opts) {
    const o = document.createElement('option');
    o.value = f; o.textContent = f;
    if (f === t.file) o.selected = true;
    sel.appendChild(o);
  }
  if (audioFiles.length) {
    const o = document.createElement('option');
    o.value = t.file || ''; o.textContent = t.file || '(archivo no encontrado)';
    if (!audioFiles.includes(t.file)) o.selected = true;
    sel.appendChild(o);
  }
  const num = (name, val, ph) => {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '0.1'; inp.min = '0';
    inp.value = val ?? ''; inp.placeholder = ph;
    inp.className = 'a-' + name; inp.id = 'a' + name + i;
    return inp;
  };
  const at = num('at', t.at, 's');
  at.title = 'segundo donde empieza';
  const vol = num('vol', t.volume, 'vol');
  vol.title = 'volumen (1 = normal)';
  const fi = num('fi', t.fadeIn, 'fadeIn');
  const fo = num('fo', t.fadeOut, 'fadeOut');
  const del = document.createElement('button');
  del.className = 'btn small danger';
  del.textContent = '✕';
  del.addEventListener('click', () => row.remove());
  row.append(sel, at, vol, fi, fo, del);
  return row;
}

$('#btnAudioAdd').addEventListener('click', () => {
  $('#audioRows').querySelector('.audio-empty')?.remove();
  $('#audioRows').appendChild(audioRow({ file: audioFiles[0] || '', at: 0, volume: 1 }, $('#audioRows').children.length));
});

$('#btnAudioSave').addEventListener('click', async () => {
  try {
    const { content } = await (await api(`/api/projects/${state.current}/file?path=${encodeURIComponent('project.json')}`)).json();
    const meta = JSON.parse(content);
    const tracks = [...$('#audioRows').children].map(row => ({
      file: row.querySelector('select').value,
      at: +row.querySelector('.a-at').value || 0,
      volume: +row.querySelector('.a-vol').value || 1,
      fadeIn: +row.querySelector('.a-fi').value || 0,
      fadeOut: +row.querySelector('.a-fo').value || 0
    })).filter(t => t.file);
    meta.audio = tracks;
    await api(`/api/projects/${state.current}/file?path=${encodeURIComponent('project.json')}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: JSON.stringify(meta, null, 2) })
    });
    $('#audioStatus').textContent = '💾 audio guardado ' + new Date().toLocaleTimeString();
    loadAudio();
  } catch (e) { alert('no pude guardar audio: ' + e.message); }
});

$('#newFileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = $('#newFileName').value.trim();
  if (!p) return;
  try {
    await api(`/api/projects/${state.current}/file?path=${encodeURIComponent(p)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '' })
    });
    $('#newFileName').value = '';
    await loadFiles();
  } catch (err) { alert(err.message); }
});

/* ---------- mensajes del iframe ---------- */

window.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'media:ready') fit();
  if (d.type === 'media:click' && recState) {
    fetch(`/api/projects/${state.current}/record/click`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...keyHdr() },
      body: JSON.stringify({ sessionId: recState.sessionId, x: d.x, y: d.y })
    }).catch(() => {});
  }
  if (d.type === 'media:key' && recState) {
    fetch(`/api/projects/${state.current}/record/key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...keyHdr() },
      body: JSON.stringify({ sessionId: recState.sessionId, key: d.key })
    }).catch(() => {});
  }
});

/* ---------- init ---------- */

select.addEventListener('change', () => { if (select.value) openProject(select.value); });
loadProjects();
