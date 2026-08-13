# 🎬 media-html

Panel para crear **contenido media con HTML** (presentaciones, promos, slides animados) y convertirlo en **MP4** con un navegador headless + ffmpeg. Es la versión casera y visual de HyperFrames: en vez de CLI + renders programáticos, tienes un **panel web** donde ves el lienzo en vivo, haces **clicks reales** (que se reenvían a un navegador oculto que graba), y al parar obtienes el video.

**Estado:** funcional (v0.1.0) · servidor en `~/media-html/` · PM2 `media-html` · puerto **8010** · público en `https://media.diablitodevops.com` (túnel Cloudflare vía Extensa).

---

## 🚀 Quick start

```bash
cd ~/media-html
npm install          # express + archiver + puppeteer-core (ya instalado)
npm start            # o: pm2 start ~/ecosystem.config.js --only media-html
# → 🎬 media-html en http://localhost:8010
```

**Requisitos de Chrome** (rutas absolutas, ver [Binarios](#-binarios-de-chrome)):

| Uso | Binario | Notas |
|---|---|---|
| Grabadora (puppeteer) | `/home/diablo/chrome-for-testing/chrome-linux64/chrome` (v148) | Chrome completo |
| Captura PNG (`--screenshot`) | headless-shell v152 de HyperFrames | El `--screenshot` del v148 **se cuelga** |

Env vars (`.env`, NO commitear):

| Variable | Uso |
|---|---|
| `MEDIA_HTML_API_KEY` | Requerida en header `X-Media-Key` para POST/PUT `/api/*` (si vacía, no hay auth) |
| `MEDIA_HTML_CHROME` / `MEDIA_HTML_CHROME_REC` | Overrides de binarios (defaults: los de arriba) |
| `PORT` / `HOST` | 8010 / 0.0.0.0 |

---

## 🧱 Cómo funciona

### Convención de proyecto

Cada proyecto es una carpeta en `projects/<nombre>/`:

```
projects/mi-proyecto/
├── project.json   # { name, width, height, fps, duration }
└── index.html     # tu lienzo (puede incluir ../bridge.js)
```

- El lienzo SIEMPRE sabe su tamaño real: `bridge.js` lee `project.json` y define CSS vars `--media-w` / `--media-h` + `window.MEDIA = {width, height, fps, duration, paused}`.
- `bridge.js` (incluirlo con `<script src="../bridge.js"></script>`) además:
  - Pausa/reanuda animaciones CSS (clase `.media-paused`) y dispara `media:play` / `media:pause` / `media:init` (para animaciones con rAF o JS).
  - Reenvía clicks y teclas al panel (`postMessage`) para la grabación de presentaciones.
- El panel admin (`/`) muestra el proyecto en un iframe escalado; ▶/⏸ pausa animaciones; 📸 captura PNG en el segundo `t`; ⬇ descarga el zip del proyecto; ✎ edita archivos; ● **Grabar** inicia la grabación.

### Rutas

| Ruta | Qué hace |
|---|---|
| `/` | Panel admin (`public/`) |
| `/projects/*` | Estáticos de proyectos (los sirve Express) |
| `GET /api/projects` | Lista proyectos (con metadatos) |
| `POST /api/projects` | Crea proyecto (slugify + clamps width/height/fps/duration) |
| `GET /api/projects/:name` | Detalle + lista de archivos |
| `GET/PUT/POST /api/projects/:name/file?path=` | Leer / guardar / crear archivo (anti path-traversal) |
| `POST /api/projects/:name/capture` | PNG en `at` segundos (headless-shell + `--virtual-time-budget`) |
| `GET /api/projects/:name/download` | ZIP del proyecto |
| `POST /api/projects/:name/record/{start,click,key,stop,abort}` | Grabadora (abajo) |

Escrituras (POST/PUT) requieren header `X-Media-Key` con `MEDIA_HTML_API_KEY` (el admin la pide 1 vez y la guarda en localStorage `mhKey`).

---

## 🎥 Motor de grabación (el corazón del proyecto)

**Flujo:** el panel reenvía clicks/teclas reales del preview → `record/click|key` → el navegador headless los ejecuta (`Input.dispatchMouseEvent`) mientras captura frames → `record/stop` → ffmpeg arma el MP4.

### Captura en 2 capas

1. **Screencast CDP** (`Page.startScreencast`, jpeg q85): Chrome emite frames **solo cuando hay movimiento** (compositor sucio) — ~30-50fps en animaciones/clicks, que es justo lo que importa. Incluye `metadata.timestamp` real.
2. **Heartbeat de 1s** (`page.screenshot`, jpeg q80): si pasan >0.8s sin frames (página estática), captura 1 frame — las pausas "muertas" no se pierden.

Frames a **disco** (tmp, no RAM): `media-rec-*/f<seq>.jpg`. ⚠️ Grabación de ~15 min ≈ **1.5-2GB de JPEGs** (se borran al parar/abortar).

### Codificación con difusión de error (VFR)

- ⛔ **El concat demuxer de ffmpeg IGNORA las directivas `duration`** con imágenes (fuerza 25fps fijo) → video acelerado/distorsionado. NO usarlo.
- ✅ Fix: `-f image2pipe -framerate <fps-real-promedio>` + **duplicación por difusión de error**: cada frame se repite `floor(acc + dur*fps)` veces (`acc` acumula el residuo). El ritmo real de los clicks queda fiel al segundo. Frames con 0 dups se descartan.
- El `fps` real = frames capturados / segundos transcurridos (los 24/30 config del proyecto son irrelevantes para grabar).

### Respuesta de `record/stop`

- El MP4 se descarga directo + **copia pública** en `/mnt/480ssd/public-files/videos/media-html/` (URL en header `X-Media-Url`, frames en `X-Media-Frames`, fps real en `X-Media-Fps`).

---

## 📸 Captura PNG

`POST /capture` corre el headless-shell v152 con `--virtual-time-budget` (adelanta timers/animaciones hasta el segundo pedido) y `--screenshot`. Budget = 800ms + `at`*1000ms.

---

## 🧠 Lecciones aprendidas (LÉELAS antes de tocar código)

1. **Emojis invisibles en headless (2026-08-13):** el servidor no tenía fuente de emojis (`fonts-noto-color-emoji` faltaba) → Chrome headless renderiza emojis con **0 píxeles** (ni cuadros). FIX ya aplicado: `sudo apt-get install -y fonts-noto-color-emoji`. Si un video sale sin "íconos", revisa esto primero.
2. **NO hay bloqueo de red en puppeteer** (verificado empíricamente 2026-08-13): CDN SVGs (simpleicons), Font Awesome (cdnjs), Google Fonts y data:URIs cargan y renderizan en la grabadora y en la captura. No agregar request interception "para ahorrar red" — no existe y rompería recursos externos.
3. **`<use href="external.svg#id">` NO funciona en Chrome** (limitación del navegador, cross-document use no soportado). Usar `<img>`, `background-image` o SVG inline.
4. **El `--screenshot` del chrome-for-testing v148 se cuelga** (hasta con file://). Para capturas usar el headless-shell v152 de HyperFrames. La grabadora (puppeteer) sí usa el v148 completo sin problema.
5. **ffmpeg concat ≠ imágenes:** ver sección grabación. Usar image2pipe + duplicación por difusión de error.
6. **Pacing:** el viejo motor (screenshot por click) rendía ~8fps reales en 1920×1080 — si se codifica a 24/30fps el video sale 3× acelerado. Siempre medir fps real = frames/segundos.
7. **Puppeteer-core 24** — `puppeteer.launch()` requiere `executablePath` explícito (no hay navegador descargado).
8. **Selector `.fa` de Font Awesome 6:** matchea solo el literal `fa`; los iconos se usan como `<i class="fa-solid fa-rocket">`. Para estilarlos: `.fa-solid { font-size: ... }`.
9. **Auth:** si `MEDIA_HTML_API_KEY` está vacía, los writes no piden llave (útil en dev, inseguro en prod).
10. **QA visual:** para ver frames sin API de visión, usar análisis de píxeles (ffmpeg → rawvideo rgb24 → contar píxeles por color esperado) o `ollama run gemma4:e2b-ctx128` local (ojo: `OLLAMA_HOST` puede apuntar a una IP rara del sandbox; forzar `OLLAMA_HOST=http://localhost:11434`).

---

## 📦 Binarios de Chrome

```js
// server.js (constantes)
const CHROME_SHELL   = '/home/diablo/.cache/hyperframes/chrome/chrome-headless-shell/linux-152.0.7928.2/chrome-headless-shell-linux64/chrome-headless-shell';
const CHROME_FALLBACK= '/home/diablo/chrome-for-testing/chrome-linux64/chrome';
const CHROME_REC     = process.env.MEDIA_HTML_CHROME_REC || CHROME_FALLBACK;
```

- **Captura PNG** → `CHROME` (headless-shell v152, ~3× más rápido, exit 0).
- **Grabadora** → `CHROME_REC` (chrome completo v148, el shell no sirve para puppeteer+screencast).

---

## 🚀 Despliegue

- **PM2:** `media-html` en `/home/diablo/ecosystem.config.js` (puerto 8010, `pm2 restart media-html`).
- **Túnel:** `media.diablitodevops.com` → `192.168.0.80:8010` (ingress en `/etc/cloudflared/config.yml` de **Extensa**, antes del catch-all; reiniciar con `sudo systemctl restart cloudflared`).
- **Copia pública de videos:** `/mnt/480ssd/public-files/videos/media-html/` → `https://baal.diablitodevops.com/files/videos/media-html/<archivo>`.

---

## 🧪 Proyectos de ejemplo

- `projects/demo/` — 1920×1080, orbes animados + card glassmorphism (muestra `--media-w/h`).
- `projects/presentacion-demo/` — 3 slides con navegación por clicks (clic derecho = siguiente), barra de progreso. El caso de uso principal de la grabadora.

Los proyectos de usuario NO se versionan (ver `.gitignore`); estos dos quedan como referencia.

---

## 🗺️ Roadmap / pendientes

- [ ] PIN/expiración para la API key si algún día se expone a internet sin auth
- [ ] Botón "generar MP4" programático (render de duración fija sin interacción)
- [ ] QA automático de frames tras cada grabación (pixel-check por colores esperados)
