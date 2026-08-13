/* 🎬 media-html bridge
 * Inclúyelo en tu proyecto: <script src="../bridge.js"></script>
 *
 * Hace 3 cosas:
 *  1. Lee project.json (mismo directorio) y expone CSS vars:
 *     --media-w / --media-h  → tu HTML/CSS siempre sabe su tamaño real.
 *  2. Escucha play/pause del panel (postMessage) y pausa TODAS las
 *     animaciones CSS (.media-paused) + dispara eventos JS
 *     'media:play' / 'media:pause' para animaciones con rAF.
 *  3. Avisa al panel con 'media:ready' cuando el lienzo está listo.
 *
 * También deja window.MEDIA = { width, height, fps, duration, paused }.
 */
(function () {
  var root = document.documentElement;
  var cfg = { width: 1280, height: 720, fps: 30, duration: 10 };

  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'project.json', false);
    xhr.send();
    if (xhr.status === 200) Object.assign(cfg, JSON.parse(xhr.responseText));
  } catch (e) { /* sin project.json → defaults */ }

  root.style.setProperty('--media-w', cfg.width + 'px');
  root.style.setProperty('--media-h', cfg.height + 'px');
  root.classList.add('media-ready');
  window.MEDIA = { width: cfg.width, height: cfg.height, fps: cfg.fps, duration: cfg.duration, paused: false };
  // aviso a los scripts del proyecto (ponte a la escucha de 'media:init')
  window.dispatchEvent(new Event('media:init'));

  // pausa global de animaciones CSS
  var style = document.createElement('style');
  style.textContent =
    '.media-paused, .media-paused * { animation-play-state: paused !important; }' +
    '.media-paused, .media-paused * { transition: none !important; }';
  document.head.appendChild(style);

  function setPaused(p) {
    window.MEDIA.paused = p;
    root.classList.toggle('media-paused', p);
    window.dispatchEvent(new Event(p ? 'media:pause' : 'media:play'));
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data || {};
    if (d.type === 'media:play') setPaused(false);
    else if (d.type === 'media:pause') setPaused(true);
  });

  // reenvío de interacción al panel (para grabación de presentaciones:
  // el panel manda los clicks/teclas reales al navegador que está grabando)
  function post(type, payload) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(Object.assign({ type: 'media:' + type }, payload), '*');
    }
  }
  document.addEventListener('click', function (e) {
    post('click', { x: e.clientX, y: e.clientY });
  });
  document.addEventListener('keydown', function (e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    post('key', { key: e.key, code: e.code });
  });

  if (window.parent && window.parent !== window) {
    window.parent.postMessage({
      type: 'media:ready',
      size: { width: cfg.width, height: cfg.height }
    }, '*');
  }
})();
