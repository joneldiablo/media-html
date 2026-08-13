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
    try {
      const r = await api(`/api/projects/${state.current}/record/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      recState = await r.json();
      recStart = Date.now();
      $('#btnRec').textContent = '⏹ Stop';
      $('#btnRec').classList.add('danger', 'recording');
      recTimerInt = setInterval(() => {
        $('#status').textContent = `● GRABANDO ${state.current} · ${Math.round((Date.now() - recStart) / 1000)}s · ${recState.fps}fps · clicks y teclas se graban`;
      }, 500);
    } catch (e) { alert('no pude iniciar grabación: ' + e.message); }
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
