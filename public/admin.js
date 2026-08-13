/* 🎬 media-html admin */
const $ = (s) => document.querySelector(s);
const state = { projects: [], current: null, playing: false, currentFile: null };

const select = $('#projectSelect');
const frame = $('#frame');
const wrap = $('#frameWrap');
const stage = $('#stage');

/* ---------- api key (escrituras) ---------- */
let mediaKey = localStorage.getItem('mhKey') || '';
function keyHdr() { return mediaKey ? { 'X-Media-Key': mediaKey } : {}; }

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}), ...keyHdr() };
  let r = await fetch(path, { ...opts, headers });
  if (r.status === 401 && !opts._retried) {
    const k = prompt('🔑 API key de media-html:');
    if (k) { localStorage.setItem('mhKey', k); mediaKey = k; return api(path, { ...opts, _retried: true }); }
  }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r;
}

/* ---------- proyectos ---------- */

async function loadProjects(keep) {
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
}

async function openProject(name) {
  const { project } = await (await api(`/api/projects/${name}`)).json();
  state.current = name;
  state.playing = false;
  $('#btnPlay').textContent = '▶ Play';
  frame.src = `/projects/${name}/index.html?media=1`;
  frame.dataset.w = project.width;
  frame.dataset.h = project.height;
  ['btnPlay', 'btnCapture', 'btnDownload', 'btnRec'].forEach(id => $(id).disabled = false);
  $('#status').textContent = `${project.name} · ${project.width}×${project.height}px · ${project.fps}fps · ${project.duration}s`;
  fit();
  loadFiles();
  loadAudio();
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
    const r = await fetch(`/api/projects/${state.current}/capture`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...keyHdr() },
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
