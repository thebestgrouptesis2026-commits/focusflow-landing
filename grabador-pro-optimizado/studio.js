/* Grabador Pro — estudio de grabación optimizado para equipos Intel.
 * Reemplazo completo de studio.js; no requiere cambiar HTML, CSS ni manifest.
 * Perfil inicial: 720p/15 FPS, sin previsualización, cámara ni audio duplicado.
 * Los ajustes ligeros se aplican una vez; después se respetan tus cambios.
 */
(() => {
  'use strict';
  const $ = (s, d = document) => d.querySelector(s);
  const $$ = (s, d = document) => [...d.querySelectorAll(s)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  const DEFAULTS = {
    surface: 'monitor', sysAudio: true, mic: true, micId: '', noise: true,
    cam: false, camId: '', panel: 'none',
    quality: '720', fps: '15', format: 'auto', livePreview: false,
    dest: 'downloads', subfolder: 'Grabaciones', saveAs: false,
    pattern: '{fecha} {hora} - {nombre}',
    countdown: '3', maxMin: '0', audioOnly: false, saveMarkers: true,
  };
  const SURF = { monitor: 'Pantalla', window: 'Ventana', browser: 'Pestaña' };
  const RES = { 720: [1280, 720, 3e6], 1080: [1920, 1080, 5e6], 1440: [2560, 1440, 8e6], 2160: [3840, 2160, 12e6] };
  const LIGHT_PROFILE_VERSION = 1;
  const LIGHT_PROFILE = { quality: '720', fps: '15', format: 'auto', cam: false, panel: 'none', audioOnly: false, livePreview: false };
  const targetFps = () => clamp(Number(S.fps) || 15, 5, 60);
  const ICON = {
    pause: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    flag: '<svg viewBox="0 0 24 24"><path d="M6 21V4m0 0h10l-2 4 2 4H6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    micOff: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" opacity=".45"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    shot: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.2"/></svg>',
  };

  let S = { ...DEFAULTS };
  let dirHandle = null;
  let micStream = null, camStream = null;
  let previewAC = null, micAnPrev = null;
  let R = null;            // grabación en curso
  let lastDone = null;     // última grabación terminada
  let library = [];
  const tempFiles = new Set();

  /* ================= utilidades ================= */
  function toast(t, err = false, ms = 2600) {
    const e = $('#toast');
    e.textContent = t;
    e.classList.toggle('err', !!err);
    e.classList.add('on');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => e.classList.remove('on'), ms);
  }
  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return [h, m, x].map((v) => String(v).padStart(2, '0')).join(':');
  };
  const fmtShort = (s) => (s >= 3600 ? fmtTime(s) : fmtTime(s).slice(3));
  const fmtSize = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
  const sanitize = (s) => String(s).replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/^[.\s-]+|[.\s]+$/g, '').slice(0, 140);
  const subPath = () => String(S.subfolder || '').split(/[\/\\]+/).map(sanitize).filter((p) => p && p !== '..' && p !== '.').join('/');
  const dlPath = (name) => (subPath() ? subPath() + '/' : '') + name;

  /* ---------- IndexedDB (la carpeta elegida se guarda aquí) ---------- */
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('grabador-pro', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function kv(key, value) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', value === undefined ? 'readonly' : 'readwrite');
      const st = tx.objectStore('kv');
      const rq = value === undefined ? st.get(key) : st.put(value, key);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }

  /* ================= ajustes ================= */
  const save = () => chrome.storage.local.set({ settings: S });
  function bindSettings() {
    for (const id of ['sysAudio', 'mic', 'noise', 'cam', 'saveAs', 'audioOnly', 'saveMarkers']) {
      const el = $('#' + id);
      el.checked = !!S[id];
      el.onchange = () => { S[id] = el.checked; save(); onSettingChange(id); };
    }
    for (const id of ['panel', 'quality', 'fps', 'format', 'countdown', 'maxMin', 'subfolder', 'pattern', 'micId', 'camId']) {
      const el = $('#' + id);
      el.value = S[id];
      const ev = el.tagName === 'INPUT' ? 'input' : 'change';
      el.addEventListener(ev, () => { S[id] = el.value; save(); onSettingChange(id); });
    }
    $$('#surface button').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === S.surface);
      b.onclick = () => { S.surface = b.dataset.v; save(); $$('#surface button').forEach((x) => x.classList.toggle('on', x === b)); onSettingChange('surface'); };
    });
    $('#destFolder').checked = S.dest === 'folder';
    $('#destDl').checked = S.dest === 'downloads';
    for (const r of $$('input[name=dest]')) r.onchange = () => { S.dest = r.value; save(); renderDest(); };
  }
  // Añadimos los controles desde JS: compatibles con el studio.html existente.
  function addPerformanceControls() {
    const fps = $('#fps');
    if (![...fps.options].some((o) => o.value === '15')) {
      const option = document.createElement('option');
      option.value = '15'; option.textContent = '15 FPS · menor consumo';
      fps.prepend(option);
    }
    const box = document.createElement('div');
    box.id = 'performanceControls';
    box.style.cssText = 'padding:12px;margin-bottom:14px;border:1px solid #64748b;border-radius:10px;display:grid;gap:10px';
    const title = document.createElement('strong');
    title.textContent = 'Menor consumo para tu Mac';
    const hint = document.createElement('small');
    hint.textContent = 'Recomendado: 720p · 15 FPS · cámara y panel flotante apagados. Para reuniones web, elige Pestaña.';
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'btn';
    button.textContent = 'Aplicar ajustes ligeros';
    button.onclick = async () => {
      if (R || starting) return;
      Object.assign(S, LIGHT_PROFILE);
      for (const id of ['quality', 'fps', 'format', 'panel']) $('#' + id).value = S[id];
      for (const id of ['cam', 'audioOnly']) $('#' + id).checked = S[id];
      $('#livePreviewSetting').checked = S.livePreview;
      await save();
      await refreshCam();
      renderHints(); renderReadiness();
      toast('720p / 15 FPS. Vista previa, cámara, panel y audio adicional apagados.');
    };
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.id = 'livePreviewSetting';
    checkbox.checked = !!S.livePreview;
    checkbox.onchange = () => { S.livePreview = checkbox.checked; save(); };
    label.append(checkbox, ' Mostrar vista previa mientras grabo (consume más recursos)');
    box.append(title, hint, button, label);
    $('#config').prepend(box);
  }

  function onSettingChange(id) {
    if (id === 'mic' || id === 'micId' || id === 'noise') refreshMic();
    if (id === 'cam' || id === 'camId') refreshCam();
    renderHints();
    renderReadiness();
  }
  function renderHints() {
    $('#surfaceHint').textContent = {
      monitor: 'Graba todo lo que ves en tu Mac, incluidas otras apps (Zoom de escritorio, Keynote…). Chrome te pedirá elegir la pantalla.',
      window: 'Graba solo una ventana, por ejemplo la app de Zoom o un documento.',
      browser: 'Graba una pestaña con su audio. Para Meet es la opción más fiable: deja marcado «Compartir audio de la pestaña».',
    }[S.surface];
    const m = pickMime(true);
    $('#formatHint').textContent = m.ext === 'mp4'
      ? 'Se usará MP4 (H.264 + AAC): se abre en QuickTime y se envía por WhatsApp, Mail o Slack sin convertir.'
      : (S.format === 'mp4' ? 'Este Chrome no puede grabar MP4 (H.264); se usará WebM. ' : 'Se usará WebM, priorizando VP8 + Opus para reducir carga; ') + 'se reproduce en Chrome y VLC, QuickTime no lo abre.';
    $('#micRow').classList.toggle('off', !S.mic);
    $('#noiseRow').style.display = S.mic ? '' : 'none';
    $('#camRow').classList.toggle('off', !S.cam);
    $('#patternPreview').textContent = buildBase({ surface: S.surface, name: $('#recName').value }) + '.' + m.ext;
  }

  /* ================= destino ================= */
  async function folderPerm() {
    if (!dirHandle) return 'none';
    try { return await dirHandle.queryPermission({ mode: 'readwrite' }); } catch (_) { return 'none'; }
  }
  async function renderDest() {
    $('#folderBox').classList.toggle('off', S.dest !== 'folder');
    $('#dlBox').classList.toggle('off', S.dest !== 'downloads');
    $('#folderName').textContent = dirHandle ? dirHandle.name : 'Ninguna elegida';
    const p = await folderPerm();
    $('#grantFolder').hidden = !(dirHandle && p !== 'granted');
    renderReadiness();
  }
  $('#pickFolder').onclick = async () => {
    try {
      const h = await window.showDirectoryPicker({ id: 'grabaciones', mode: 'readwrite', startIn: 'videos' });
      dirHandle = h;
      await kv('dir', h);
      S.dest = 'folder'; save();
      $('#destFolder').checked = true;
      renderDest();
      toast('Se guardará en «' + h.name + '»');
    } catch (e) {
      if (e.name !== 'AbortError') toast('No se pudo usar esa carpeta: ' + e.message + '. Prueba con una subcarpeta (p.ej. Películas › Grabaciones).', true, 5000);
    }
  };
  $('#grantFolder').onclick = async () => {
    try { await dirHandle.requestPermission({ mode: 'readwrite' }); } catch (_) {}
    renderDest();
  };

  /* ================= dispositivos y medidores ================= */
  async function listDevices() {
    let devs = [];
    try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (_) {}
    const fill = (sel, kind, cur) => {
      const list = devs.filter((d) => d.kind === kind);
      sel.innerHTML = '';
      const def = document.createElement('option');
      def.value = ''; def.textContent = 'Predeterminado del sistema';
      sel.appendChild(def);
      list.forEach((d, i) => {
        if (d.deviceId === 'default' || d.deviceId === 'communications') return;
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || (kind === 'audioinput' ? 'Micrófono ' : 'Cámara ') + (i + 1);
        sel.appendChild(o);
      });
      sel.value = list.some((d) => d.deviceId === cur) ? cur : '';
    };
    fill($('#micId'), 'audioinput', S.micId);
    fill($('#camId'), 'videoinput', S.camId);
  }
  navigator.mediaDevices.addEventListener('devicechange', listDevices);

  async function getMedia(kind, id, extra) {
    const base = kind === 'audio'
      ? { echoCancellation: S.noise, noiseSuppression: S.noise, autoGainControl: S.noise, ...extra }
      : { width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 360 }, frameRate: { ideal: 15, max: 15 }, ...extra };
    try {
      return await navigator.mediaDevices.getUserMedia({ [kind]: id ? { ...base, deviceId: { exact: id } } : base });
    } catch (e) {
      if (id && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) return navigator.mediaDevices.getUserMedia({ [kind]: base });
      throw e;
    }
  }
  async function refreshMic() {
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    micStream = null; micAnPrev = null;
    if (S.mic) {
      try {
        micStream = await getMedia('audio', S.micId);
        previewAC = previewAC || new AudioContext();
        micAnPrev = analyser(previewAC, previewAC.createMediaStreamSource(micStream));
      } catch (e) {
        toast('Sin acceso al micrófono (' + e.name + '). Revisa Ajustes del Sistema › Privacidad › Micrófono.', true, 5000);
      }
    }
    listDevices();
    renderReadiness();
  }
  async function refreshCam() {
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
    if (S.cam) {
      try { camStream = await getMedia('video', S.camId); }
      catch (e) { toast('Sin acceso a la cámara (' + e.name + ').', true, 4000); }
    }
    $('#camVideo').srcObject = camStream;
    $('#camPrev').classList.toggle('cam', !!camStream);
    listDevices();
    renderReadiness();
  }
  function analyser(ac, src) {
    const an = ac.createAnalyser();
    an.fftSize = 256;
    src.connect(an);
    an._buf = new Float32Array(an.fftSize);
    return an;
  }
  function level(an) {
    if (!an) return 0;
    an.getFloatTimeDomainData(an._buf);
    let s = 0;
    for (const v of an._buf) s += v * v;
    const db = 20 * Math.log10(Math.sqrt(s / an._buf.length) + 1e-8);
    return clamp((db + 60) / 60, 0, 1);
  }
  function meterLoop() {
    if (!document.hidden) {
      $('#micMeter').style.width = level(R ? null : micAnPrev) * 100 + '%';
      if (R) {
        $('#sysMeter').style.width = level(R.sysAn) * 100 + '%';
        $('#micMeter2').style.width = (R.muted ? 0 : level(R.micAn)) * 100 + '%';
      }
    }
    // Medidores a 10 Hz, no a los 60/120 Hz de la pantalla.
    setTimeout(meterLoop, document.hidden ? 1000 : 100);
  }

  function renderReadiness() {
    const box = $('#readiness');
    box.innerHTML = '';
    const chip = (t, cls) => { const s = document.createElement('span'); s.textContent = t; if (cls) s.className = cls; box.appendChild(s); };
    chip(SURF[S.surface] + (S.sysAudio ? ' + audio' : ''));
    chip(S.mic ? (micStream ? 'Micrófono ✓' : 'Micrófono sin permiso') : 'Sin micrófono', S.mic ? (micStream ? 'ok' : 'bad') : '');
    if (S.cam) chip(camStream ? 'Cámara ✓' : 'Cámara sin permiso', camStream ? 'ok' : 'bad');
    if (S.dest === 'folder') {
      folderPerm().then((p) => {
        chip(dirHandle ? '📁 ' + dirHandle.name + (p === 'granted' ? ' ✓' : ' (falta permiso)') : '📁 elige carpeta', dirHandle && p === 'granted' ? 'ok' : 'bad');
      });
    } else chip('Descargas/' + (subPath() || ''), 'ok');
  }

  /* ================= formato y nombre ================= */
  function pickMime(hasAudio) {
    // Solo MP4 con H.264 (+AAC): es lo que abren QuickTime, WhatsApp y Mail. Nada de "video/mp4" genérico (podría ser VP9).
    const mp4 = hasAudio
      ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1.420028,mp4a.40.2', 'video/mp4;codecs=avc1.4d0028,mp4a.40.2', 'video/mp4;codecs=avc1.640028,mp4a.40.2']
      : ['video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.420028', 'video/mp4;codecs=avc1.4d0028', 'video/mp4;codecs=avc1.640028'];
    const webm = hasAudio
      ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
      : ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
    // Soporte de H.264 no garantiza aceleración por hardware; depende de Chrome/macOS.
    const order = S.format === 'webm' ? [...webm, ...mp4] : [...mp4, ...webm];
    for (const m of order) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return { mime: m, ext: m.startsWith('video/mp4') ? 'mp4' : 'webm' };
    return { mime: '', ext: 'webm' };
  }
  function pickAudioMime() {
    for (const m of ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm']) {
      if (MediaRecorder.isTypeSupported(m)) return { mime: m, ext: m.startsWith('audio/mp4') ? 'm4a' : 'webm' };
    }
    return null;
  }
  function buildBase({ surface, name, date = new Date() }) {
    const p = (n) => String(n).padStart(2, '0');
    const vars = {
      fecha: `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`,
      hora: `${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`,
      nombre: (name || '').trim() || 'Grabación',
      fuente: SURF[surface] || 'Pantalla',
    };
    return sanitize((S.pattern || DEFAULTS.pattern).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))) || 'Grabación';
  }

  /* ================= escritura en disco ================= */
  async function uniqueIn(dir, name) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; i < 200; i++) {
      const n = i === 1 ? name : `${stem} (${i})${ext}`;
      try { await dir.getFileHandle(n); } catch (e) { if (e.name === 'NotFoundError' || e.name === 'TypeError') return n; throw e; }
    }
    return `${stem} ${Date.now()}${ext}`;
  }
  /** Archivo que se va escribiendo a trozos: en la carpeta elegida, o en almacenamiento interno (OPFS) para luego pasarlo a Descargas. */
  async function openSink(name) {
    let dir, fname;
    if (S.dest === 'folder') { dir = dirHandle; fname = await uniqueIn(dir, name); }
    else { dir = await navigator.storage.getDirectory(); fname = Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '-' + name; tempFiles.add(fname); }
    const fh = await dir.getFileHandle(fname, { create: true });
    const w = await fh.createWritable();
    const sink = { dest: S.dest, dir, fh, w, name: S.dest === 'folder' ? fname : name, tmp: S.dest === 'folder' ? null : fname, bytes: 0, q: Promise.resolve(), err: null };
    sink.write = (blob) => {
      sink.bytes += blob.size;
      sink.q = sink.q.then(() => sink.w.write(blob)).catch((e) => { sink.err = sink.err || e; });
    };
    sink.close = async () => { await sink.q; await sink.w.close(); };
    return sink;
  }
  function waitDownload(id) {
    return new Promise((resolve) => {
      const done = async (state) => {
        chrome.downloads.onChanged.removeListener(on);
        const [it] = await chrome.downloads.search({ id });
        resolve({ state, path: it ? it.filename : '', error: it && it.error });
      };
      const on = (d) => {
        if (d.id !== id || !d.state) return;
        if (d.state.current === 'complete') done('complete');
        else if (d.state.current === 'interrupted') done('interrupted');
      };
      chrome.downloads.onChanged.addListener(on);
      chrome.downloads.search({ id }).then(([it]) => { if (it && it.state !== 'in_progress') done(it.state); });
    });
  }
  async function toDownloads(blobOrFile, name, saveAs) {
    const url = URL.createObjectURL(blobOrFile);
    try {
      const id = await chrome.downloads.download({ url, filename: dlPath(name), saveAs: !!saveAs, conflictAction: 'uniquify' });
      const st = await waitDownload(id);
      return { downloadId: id, ...st };
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  }
  /** Cierra un sink y lo deja en su sitio final. */
  async function finalizeSink(sink, saveAs) {
    await sink.close();
    const file = await sink.fh.getFile();
    if (sink.dest === 'folder') return { file, name: sink.name, where: dirHandle.name };
    const r = await toDownloads(file, sink.name, saveAs);
    if (r.state !== 'complete') throw new Error(r.error === 'USER_CANCELED' ? 'Guardado cancelado' : 'La descarga falló (' + (r.error || r.state) + ')');
    return { file, name: r.path.split('/').pop() || sink.name, path: r.path, downloadId: r.downloadId, where: 'Descargas' };
  }
  async function saveBlob(name, blob) {
    if (S.dest === 'folder') {
      const n = await uniqueIn(dirHandle, name);
      const fh = await dirHandle.getFileHandle(n, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      return { name: n };
    }
    const r = await toDownloads(blob, name, false);
    return { name: (r.path || name).split('/').pop(), path: r.path };
  }
  async function cleanTemp(keep) {
    try {
      const root = await navigator.storage.getDirectory();
      for await (const [n, h] of root.entries()) {
        if (h.kind !== 'file' || !/^\d{13}-[a-z0-9]{5}-/.test(n)) continue;   // solo temporales propios
        if (keep && keep.has(n)) continue;
        await root.removeEntry(n).catch(() => {});
        tempFiles.delete(n);
      }
    } catch (_) {}
  }

  /* ================= grabación ================= */
  const elapsed = () => (R && R.t0 ? ((R.pausedAt || performance.now()) - R.t0 - R.pausedTotal) / 1000 : 0);

  function setState(state) {
    document.body.dataset.state = state;
    const pill = $('#pill');
    pill.className = 'pill ' + ({ recording: 'rec', countdown: 'rec', paused: 'paused', saving: 'saving' }[state] || '');
    pill.textContent = { idle: 'Listo', countdown: 'Preparando…', recording: '● Grabando', paused: 'En pausa', saving: 'Guardando…', done: 'Guardado' }[state];
    $('#vIdle').hidden = !(state === 'idle');
    $('#vRec').hidden = !['countdown', 'recording', 'paused', 'saving'].includes(state);
    $('#vDone').hidden = state !== 'done';
    $('#config').classList.toggle('locked', ['countdown', 'recording', 'paused', 'saving'].includes(state));
    $('#vRec').classList.toggle('paused', state === 'paused');
    $('#recLabel').textContent = state === 'paused' ? 'PAUSA' : state === 'saving' ? 'GUARDANDO' : 'REC';
    document.title = state === 'recording' ? '● Grabando — Grabador Pro' : state === 'paused' ? '❚❚ Pausa — Grabador Pro' : 'Grabador Pro';
    chrome.runtime.sendMessage({ type: 'state', state, elapsed: elapsed() }).catch(() => {});
    if (R) R.state = state;
    if (['countdown', 'done', 'idle'].includes(state)) window.scrollTo({ top: 0, behavior: 'smooth' });
    updatePip();
  }

  function displayOptions() {
    const [w, h] = RES[S.quality] || RES[720];
    const fps = targetFps();
    return {
      video: { displaySurface: S.surface, width: { max: w }, height: { max: h }, frameRate: { ideal: fps, max: fps } },
      audio: S.sysAudio ? { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      systemAudio: S.sysAudio ? 'include' : 'exclude',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include',
      preferCurrentTab: false,
    };
  }

  /* Tamaño de grabación FIJO.
     Si la pestaña/ventana cambia de tamaño mientras grabas (maximizar la pestaña de Meet, quien comparte pantalla,
     pasar a pantalla completa…), la pista capturada cambia de resolución y MediaRecorder (H.264/VP9) no lo soporta:
     el vídeo se llena de bloques y rayas. Solución: pasar cada fotograma por un lienzo de tamaño constante
     (con bandas negras si cambia la proporción) y grabar ese lienzo. Va por eventos de fotograma, así que sigue
     funcionando aunque la pestaña del estudio esté en segundo plano. */
  function makeFixedStream(vt, W, H, fps) {
    W &= ~1; H &= ~1;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('No se pudo crear el lienzo de grabación');
    const reader = new MediaStreamTrackProcessor({ track: vt, maxBufferSize: 1 }).readable.getReader();
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    const out = canvas.captureStream(0);
    const track = out.getVideoTracks()[0];
    try { track.contentHint = 'detail'; } catch (_) {}
    const interval = 1000 / fps;
    let stopped = false, paused = false, lastDraw = performance.now(), nextDraw = 0, lw = 0, lh = 0;
    const push = () => { try { track.requestFrame(); } catch (_) {} lastDraw = performance.now(); };
    (async () => {
      try {
        while (!stopped) {
          const { value: f, done } = await reader.read();
          if (done) break;
          try {
            const now = performance.now();
            // Descarta antes de escalar/dibujar. Siempre libera el VideoFrame.
            if (stopped || paused || now + 1 < nextDraw) continue;
            const sw = f.displayWidth || f.codedWidth, sh = f.displayHeight || f.codedHeight;
            if (sw && sh) {
              const k = Math.min(W / sw, H / sh);
              const dw = Math.max(2, Math.round(sw * k) & ~1), dh = Math.max(2, Math.round(sh * k) & ~1);
              if (dw !== lw || dh !== lh) {
                ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); lw = dw; lh = dh;
              }
              ctx.drawImage(f, (W - dw) >> 1, (H - dh) >> 1, dw, dh);
              push();
              nextDraw = Math.max(nextDraw + interval, now + interval / 2);
            }
          } finally { f.close(); }
        }
      } catch (e) {
        if (!stopped) {
          // No ocultar un fallo del lienzo que dejaría el vídeo congelado.
          console.error('Captura de tamaño fijo interrumpida:', e);
          toast('Se interrumpió la captura: se guardará lo grabado.', true, 7000);
          stop();
        }
      } finally {
        try { reader.releaseLock(); } catch (_) {}
      }
    })();
    const keep = setInterval(() => {
      if (!stopped && !paused && performance.now() - lastDraw > 1000) push();
    }, 1000);
    return {
      track,
      setPaused(value) { paused = value; nextDraw = 0; },
      stop() {
        stopped = true; clearInterval(keep);
        try { reader.cancel().catch(() => {}); } catch (_) {}
        try { track.stop(); } catch (_) {}
      },
    };
  }
  const wantCamPanel = () => S.panel !== 'none' && S.cam && !!camStream;
  const pipSize = () => (wantCamPanel() ? { width: 260, height: 260 } : { width: 380, height: 64 });

  let starting = false;
  async function start() {
    if (R || starting) return;
    starting = true;
    $('#start').disabled = true;
    try { await startCapture(); }
    finally { starting = false; $('#start').disabled = false; }
  }

  async function startCapture() {
    if (!window.MediaRecorder) { toast('Este navegador no permite grabar.', true); return; }
    if (S.dest === 'folder') {
      if (!dirHandle) { toast('Elige primero una carpeta de destino (o usa Descargas).', true); return; }
      if ((await folderPerm()) !== 'granted') {
        try { await dirHandle.requestPermission({ mode: 'readwrite' }); } catch (_) {}
        renderDest();
        if ((await folderPerm()) !== 'granted') { toast('Sin permiso para escribir en «' + dirHandle.name + '».', true); return; }
        toast('Permiso concedido. Pulsa Grabar de nuevo.');
        return;
      }
    }
    const ac = new AudioContext();
    let dispP;
    try { dispP = navigator.mediaDevices.getDisplayMedia(displayOptions()); }
    catch (e) { dispP = Promise.reject(e); }
    const pipP = (S.panel !== 'none' && 'documentPictureInPicture' in window)
      ? window.documentPictureInPicture.requestWindow(pipSize()).catch(() => null)
      : Promise.resolve(null);
    let display;
    try { display = await dispP; }
    catch (e) {
      ac.close();
      pipP.then((w) => w && w.close());
      toast(e.name === 'NotAllowedError' ? 'Grabación cancelada (o Chrome no tiene permiso de «Grabación de pantalla» en tu Mac).' : 'No se pudo capturar: ' + e.message, e.name !== 'NotAllowedError', 5000);
      return;
    }
    const vt = display.getVideoTracks()[0];
    // Algunos selectores ignoran las preferencias iniciales. Limitar también la pista.
    const [captureW, captureH] = RES[S.quality] || RES[720];
    try {
      await vt.applyConstraints({ width: { max: captureW }, height: { max: captureH }, frameRate: { max: targetFps() } });
    } catch (e) { console.warn('El capturador no admite todos los límites; el lienzo limitará la salida.', e); }
    const surface = (vt.getSettings && vt.getSettings().displaySurface) || S.surface;
    try { vt.contentHint = 'detail'; } catch (_) {}

    R = {
      state: 'countdown', display, ac, surface, t0: 0, pausedAt: 0, pausedTotal: 0,
      markers: [], shots: 0, muted: false, pip: null, warned: false, peak: 0,
      name: $('#recName').value, startDate: new Date(), extras: [],
    };
    // --- mezcla de audio ---
    const dest = ac.createMediaStreamDestination();
    const sysTracks = display.getAudioTracks();
    if (S.sysAudio && sysTracks.length) {
      const src = ac.createMediaStreamSource(new MediaStream(sysTracks));
      src.connect(dest);
      R.sysAn = analyser(ac, src);
    }
    if (S.mic && micStream && micStream.getAudioTracks().length) {
      const src = ac.createMediaStreamSource(micStream);
      R.micGain = ac.createGain();
      src.connect(R.micGain).connect(dest);
      R.micAn = analyser(ac, src);
    }
    ac.resume().catch(() => {});
    R.audioTracks = (R.sysAn || R.micGain) ? dest.stream.getAudioTracks() : [];
    if (!sysTracks.length && S.sysAudio) {
      showWarn(surface === 'browser'
        ? 'La pestaña se comparte sin audio: no marcaste «Compartir audio de la pestaña». Se grabará solo tu micrófono.'
        : 'Chrome no ofreció audio del sistema para esta ' + (surface === 'window' ? 'ventana' : 'pantalla') + ' en tu Mac: se grabará solo tu micrófono. Para Meet/Zoom web, elige la pestaña de la reunión.');
    } else hideWarn();

    vt.addEventListener('ended', () => stop());
    // Evita una segunda representación continua de la pantalla en el estudio.
    const live = $('#liveVideo');
    live.srcObject = S.livePreview ? new MediaStream([vt]) : null;
    live.hidden = !S.livePreview;
    let previewHint = $('#lowLagPreviewHint');
    if (!previewHint) {
      previewHint = document.createElement('p');
      previewHint.id = 'lowLagPreviewHint'; previewHint.className = 'hint';
      previewHint.textContent = 'Vista previa apagada para reducir consumo. La pantalla se sigue grabando.';
      live.after(previewHint);
    }
    previewHint.hidden = !!S.livePreview;
    if (previewAC && previewAC.state === 'running') previewAC.suspend().catch(() => {});
    $('#markers').innerHTML = '';
    R.pip = await pipP;
    if (R.pip) setupPip(R.pip);
    setState('countdown');

    // --- cuenta atrás ---
    const n = +S.countdown || 0;
    for (let i = n; i > 0; i--) {
      if (!R || R.cancel) break;
      $('#cd').hidden = false; $('#cd').textContent = i;
      pipCountdown(i);
      await sleep(1000);
    }
    $('#cd').hidden = true; pipCountdown(0);
    if (!R || R.cancel) { cleanupCapture(); R = null; setState('idle'); return; }

    // --- grabadores ---
    try {
      const { mime, ext } = pickMime(R.audioTracks.length > 0);
      R.ext = ext;
      R.base = buildBase({ surface, name: R.name, date: R.startDate });
      R.sink = await openSink(R.base + '.' + ext);
      const [w, h, bits] = RES[S.quality] || RES[720];
      const fps = targetFps();
      const vbits = Math.round(bits * Math.pow(fps / 30, 0.7));
      let recVideo = vt;
      if (typeof MediaStreamTrackProcessor === 'function') {
        try { R.fixed = makeFixedStream(vt, w, h, fps); recVideo = R.fixed.track; }
        catch (e) { console.warn('Tamaño fijo no disponible, grabo directo:', e); R.fixed = null; }
      }
      R.recorder = new MediaRecorder(new MediaStream([recVideo, ...R.audioTracks]), { mimeType: mime || undefined, videoBitsPerSecond: vbits, audioBitsPerSecond: 96000, videoKeyFrameIntervalDuration: 2000 });
      R.recorder.ondataavailable = (e) => { if (e.data && e.data.size) R.sink.write(e.data); };
      R.recorder.onerror = (e) => { toast('Error del grabador: ' + ((e.error && e.error.message) || 'desconocido'), true, 5000); stop(); };
      R.mime = R.recorder.mimeType || mime;
      if (S.audioOnly && R.audioTracks.length) {
        const am = pickAudioMime();
        if (am) {
          R.aSink = await openSink(R.base + ' - audio.' + am.ext);
          R.aRecorder = new MediaRecorder(new MediaStream(R.audioTracks), { mimeType: am.mime, audioBitsPerSecond: 96000 });
          R.aRecorder.ondataavailable = (e) => { if (e.data && e.data.size) R.aSink.write(e.data); };
        }
      }
      R.recorder.start(1000);
      if (R.aRecorder) R.aRecorder.start(1000);
      R.t0 = performance.now();
      setState('recording');
      lastMinute = -1;
      R.tick = setInterval(tick, 500);
    } catch (e) {
      toast('No se pudo iniciar la grabación: ' + e.message, true, 6000);
      cleanupCapture();
      R = null;
      setState('idle');
    }
  }

  let lastMinute = -1;
  function tick() {
    if (!R) return;
    const t = elapsed();
    $('#timer').textContent = fmtTime(t);
    updatePip();
    const m = Math.floor(t / 60);
    if (m !== lastMinute) { lastMinute = m; chrome.runtime.sendMessage({ type: 'state', state: R.state, elapsed: t }).catch(() => {}); }
    // aviso si no se oye nada en los primeros segundos
    if (R.state === 'recording' && t < 15) R.peak = Math.max(R.peak, level(R.sysAn), R.muted ? 0 : level(R.micAn));
    if (!R.warned && t >= 15 && R.audioTracks.length && R.peak < 0.08) {
      R.warned = true;
      showWarn('No se detecta sonido en los primeros 15 s. Revisa que el micrófono no esté silenciado y que hayas compartido el audio.');
    }
    if (R.sink && R.sink.err && !R.sinkWarned) { R.sinkWarned = true; toast('Error escribiendo el archivo: ' + R.sink.err.message, true, 8000); }
    const max = +S.maxMin || 0;
    if (max && t >= max * 60 && R.state === 'recording') { toast('Límite de ' + max + ' min alcanzado'); stop(); }
  }
  function showWarn(t) { const w = $('#warn'); w.textContent = '⚠ ' + t; w.hidden = false; }
  function hideWarn() { $('#warn').hidden = true; }

  function togglePause() {
    if (!R || !R.recorder) return;
    if (R.state === 'recording') {
      R.recorder.pause(); if (R.aRecorder) R.aRecorder.pause();
      if (R.fixed) R.fixed.setPaused(true);
      R.pausedAt = performance.now();
      setState('paused');
      $('#pause').textContent = 'Reanudar';
    } else if (R.state === 'paused') {
      R.pausedTotal += performance.now() - R.pausedAt;
      R.pausedAt = 0;
      if (R.fixed) R.fixed.setPaused(false);
      R.recorder.resume(); if (R.aRecorder) R.aRecorder.resume();
      setState('recording');
      $('#pause').textContent = 'Pausar';
    }
  }
  function toggleMute() {
    if (!R || !R.micGain) { toast('No hay micrófono en esta grabación'); return; }
    R.muted = !R.muted;
    R.micGain.gain.value = R.muted ? 0 : 1;
    $('#mute').textContent = R.muted ? 'Activar micro' : 'Silenciar micro';
    $('#mute').classList.toggle('on', R.muted);
    updatePip();
  }
  function addMarker() {
    if (!R || !['recording', 'paused'].includes(R.state)) return;
    const m = { t: elapsed(), label: 'Marcador ' + (R.markers.length + 1) };
    R.markers.push(m);
    renderMarkers($('#markers'), R.markers, true);
    toast('⚑ ' + m.label + ' — ' + fmtShort(m.t));
    pipFlash();
  }
  function renderMarkers(ul, list, editable) {
    ul.innerHTML = '';
    list.forEach((m) => {
      const li = document.createElement('li');
      const c = document.createElement('code'); c.textContent = fmtShort(m.t);
      li.appendChild(c);
      if (editable) {
        const inp = document.createElement('input');
        inp.value = m.label;
        inp.oninput = () => { m.label = inp.value; };
        li.appendChild(inp);
      } else {
        const sp = document.createElement('span'); sp.textContent = m.label;
        li.appendChild(sp);
        li.style.cursor = 'pointer';
        li.onclick = () => { const p = $('#player'); p.currentTime = m.t; p.play(); };
      }
      ul.appendChild(li);
    });
  }
  async function screenshot() {
    if (!R || !R.display) return;
    let bmp = null, fallbackVideo = null;
    try {
      const vt = R.display.getVideoTracks()[0];
      if (window.ImageCapture) { try { bmp = await new ImageCapture(vt).grabFrame(); } catch (_) {} }
      // Captura puntual incluso con la vista previa apagada.
      let v = $('#liveVideo');
      if (!bmp && !v.srcObject) {
        fallbackVideo = document.createElement('video');
        fallbackVideo.muted = true; fallbackVideo.playsInline = true;
        fallbackVideo.srcObject = new MediaStream([vt]);
        await fallbackVideo.play();
        v = fallbackVideo;
      }
      const w = bmp ? bmp.width : v.videoWidth, h = bmp ? bmp.height : v.videoHeight;
      const cv = new OffscreenCanvas(w, h);
      cv.getContext('2d').drawImage(bmp || v, 0, 0);
      const blob = await cv.convertToBlob({ type: 'image/png' });
      R.shots++;
      const r = await saveBlob(`${R.base || buildBase({ surface: R.surface, name: R.name, date: R.startDate })} - captura ${R.shots}.png`, blob);
      R.extras.push(r.name);
      toast('Captura guardada: ' + r.name);
      pipFlash();
    } catch (e) { toast('No se pudo guardar la captura: ' + e.message, true); }
    finally {
      if (bmp) bmp.close();
      if (fallbackVideo) { fallbackVideo.pause(); fallbackVideo.srcObject = null; }
    }
  }

  function cleanupCapture() {
    if (!R) return;
    clearInterval(R.tick);
    try { if (R.fixed) R.fixed.stop(); } catch (_) {}
    try { R.display.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { R.ac.close(); } catch (_) {}
    try { if (R.pip) R.pip.close(); } catch (_) {}
    $('#liveVideo').srcObject = null;
    if ($('#lowLagPreviewHint')) $('#lowLagPreviewHint').hidden = true;
    if (previewAC && previewAC.state === 'suspended') previewAC.resume().catch(() => {});
  }

  async function stop() {
    if (!R || R.stopping) return;
    if (R.state === 'countdown') { R.cancel = true; return; }
    R.stopping = true;
    if (R.state === 'paused') { R.pausedTotal += performance.now() - R.pausedAt; R.pausedAt = 0; }
    const duration = elapsed();
    setState('saving');
    $('#pause').textContent = 'Pausar';
    $('#mute').textContent = 'Silenciar micro'; $('#mute').classList.remove('on');
    const stopRec = (r) => (!r || r.state === 'inactive') ? Promise.resolve() : new Promise((res) => { r.addEventListener('stop', res, { once: true }); r.stop(); });
    await Promise.all([stopRec(R.recorder), stopRec(R.aRecorder)]);
    cleanupCapture();
    const rec = R;
    try {
      const main = await finalizeSink(rec.sink, S.saveAs);
      const extras = [...rec.extras];
      if (rec.aSink) { const a = await finalizeSink(rec.aSink, false); extras.push(a.name); }
      if (S.saveMarkers && rec.markers.length) {
        const txt = chaptersText(rec, main.name, duration);
        const r = await saveBlob(rec.base + ' - marcadores.txt', new Blob([txt], { type: 'text/plain' }));
        extras.push(r.name);
      }
      const entry = {
        id: Date.now(), name: main.name, dest: rec.sink.dest, where: main.where, path: main.path || '',
        downloadId: main.downloadId || null, size: main.file.size, duration, date: rec.startDate.getTime(),
        mime: rec.mime, surface: rec.surface, markers: rec.markers, extras,
      };
      library = [entry, ...library].slice(0, 40);
      await chrome.storage.local.set({ library });
      R = null;
      showDone(entry, main.file);
      chrome.runtime.sendMessage({ type: 'saved', name: entry.name, text: `${entry.name} · ${fmtShort(duration)} · ${fmtSize(entry.size)} → ${entry.path || '📁 ' + entry.where}` }).catch(() => {});
    } catch (e) {
      R = null;
      // En modo Descargas el vídeo sigue a salvo en el almacenamiento interno: se ofrece guardarlo de nuevo.
      let file = null;
      try { file = await rec.sink.fh.getFile(); } catch (_) {}
      if (file && rec.sink.tmp) {
        toast(e.message + '. La grabación no se ha perdido: pulsa «Guardar…».', true, 7000);
        showDone({ id: Date.now(), name: rec.sink.name, dest: 'temp', where: 'sin guardar', path: '', downloadId: null, size: file.size, duration, date: rec.startDate.getTime(), mime: rec.mime, surface: rec.surface, markers: rec.markers, extras: [] }, file);
      } else {
        toast('Error al guardar: ' + e.message, true, 9000);
        setState('idle');
      }
    }
  }
  $('#saveAgain').onclick = async () => {
    if (!lastDone) return;
    try {
      const r = await toDownloads(lastDone.file, lastDone.entry.name, true);
      if (r.state !== 'complete') throw new Error(r.error === 'USER_CANCELED' ? 'cancelado' : r.error || r.state);
      const entry = { ...lastDone.entry, dest: 'downloads', where: 'Descargas', path: r.path, downloadId: r.downloadId, name: r.path.split('/').pop() };
      library = [entry, ...library].slice(0, 40);
      await chrome.storage.local.set({ library });
      showDone(entry, lastDone.file);
      toast('Guardado en ' + r.path);
    } catch (e) { toast('No se guardó: ' + e.message, true); }
  };
  function chaptersText(rec, fileName, duration) {
    const lines = [
      `Grabación: ${fileName}`,
      `Fecha: ${rec.startDate.toLocaleString()}`,
      `Duración: ${fmtTime(duration)}`,
      '',
      'Capítulos (formato YouTube):',
      '00:00 Inicio',
      ...rec.markers.map((m) => `${fmtShort(m.t)} ${m.label}`),
    ];
    return lines.join('\n') + '\n';
  }

  /* ================= vista final ================= */
  function showDone(entry, file) {
    lastDone = { entry, file };
    const p = $('#player');
    if (p.src) URL.revokeObjectURL(p.src);
    p.src = URL.createObjectURL(file);
    fixDuration(p);
    $('#doneName').textContent = entry.name;
    $('#doneMeta').textContent = `${fmtTime(entry.duration)} · ${fmtSize(entry.size)} · ${entry.path ? entry.path : '📁 ' + entry.where}` + (entry.extras.length ? ` · también: ${entry.extras.join(', ')}` : '');
    const dl = entry.dest === 'downloads' && entry.downloadId != null;
    $('#openFile').hidden = !dl;
    $('#showFile').hidden = !dl;
    $('#share').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    $('#saveAgain').hidden = entry.dest !== 'temp';
    renderMarkers($('#doneMarkers'), entry.markers, false);
    renderLibrary();
    setState('done');
  }
  function fixDuration(v) {   // WebM de MediaRecorder no trae duración: forzarla para poder saltar
    v.addEventListener('loadedmetadata', function f() {
      v.removeEventListener('loadedmetadata', f);
      if (v.duration === Infinity) {
        v.currentTime = 1e101;
        v.addEventListener('timeupdate', function g() { v.removeEventListener('timeupdate', g); v.currentTime = 0; });
      }
    });
  }
  async function shareFile(file, title) {
    try { await navigator.share({ files: [file], title }); }
    catch (e) { if (e.name !== 'AbortError') toast('No se pudo compartir: ' + e.message, true); }
  }
  $('#share').onclick = () => lastDone && shareFile(lastDone.file, lastDone.entry.name);
  $('#openFile').onclick = () => lastDone && chrome.downloads.open(lastDone.entry.downloadId);
  $('#showFile').onclick = () => lastDone && chrome.downloads.show(lastDone.entry.downloadId);
  $('#again').onclick = () => {
    const p = $('#player');
    p.pause();
    if (lastDone && lastDone.entry.dest === 'temp' && !confirm('Esta grabación aún no se ha guardado. ¿Descartarla?')) return;
    p.removeAttribute('src'); p.load();
    lastDone = null;
    cleanTemp();
    setState('idle');
  };

  /* ================= biblioteca ================= */
  async function renderLibrary() {
    const ul = $('#library');
    ul.innerHTML = '';
    if (!library.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Aún no hay grabaciones.'; ul.appendChild(li); return; }
    const ids = library.filter((e) => e.downloadId != null).map((e) => e.downloadId);
    const exist = new Map();
    for (const id of ids) { try { const [d] = await chrome.downloads.search({ id }); exist.set(id, !!(d && d.exists)); } catch (_) {} }
    for (const e of library) {
      const li = document.createElement('li');
      const nm = document.createElement('div'); nm.className = 'nm';
      const b = document.createElement('b'); b.textContent = e.name; b.title = e.path || e.where;
      const sp = document.createElement('span');
      sp.textContent = `${new Date(e.date).toLocaleString()} · ${fmtTime(e.duration)} · ${fmtSize(e.size)} · ${e.dest === 'folder' ? '📁 ' + e.where : 'Descargas'}${e.markers && e.markers.length ? ' · ⚑' + e.markers.length : ''}`;
      nm.append(b, sp);
      li.appendChild(nm);
      const btn = (t, fn) => { const x = document.createElement('button'); x.className = 'btn'; x.textContent = t; x.onclick = fn; li.appendChild(x); };
      if (e.downloadId != null) {
        if (exist.get(e.downloadId) === false) { const s = document.createElement('span'); s.className = 'hint'; s.textContent = 'movido o borrado'; li.appendChild(s); }
        else {
          btn('Abrir', () => chrome.downloads.open(e.downloadId));
          btn('Finder', () => chrome.downloads.show(e.downloadId));
        }
      } else if (e.dest === 'folder') {
        btn('Ver', async () => {
          try {
            if (!dirHandle || dirHandle.name !== e.where) throw new Error('la carpeta «' + e.where + '» ya no es la elegida');
            if ((await folderPerm()) !== 'granted') await dirHandle.requestPermission({ mode: 'readwrite' });
            const f = await (await dirHandle.getFileHandle(e.name)).getFile();
            showDone(e, f);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          } catch (err) { toast('No se pudo abrir: ' + err.message, true, 4000); }
        });
      }
      ul.appendChild(li);
    }
  }
  $('#clearLib').onclick = async () => { library = []; await chrome.storage.local.set({ library }); renderLibrary(); };

  /* ================= panel flotante (Document Picture-in-Picture) ================= */
  const PIP_CSS = `
    *{box-sizing:border-box}
    html,body{margin:0;height:100%;background:#111317;color:#fff;font:600 13px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;overflow:hidden;user-select:none}
    video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}
    .ctl{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:6px;padding:8px 10px;background:linear-gradient(transparent,rgba(0,0,0,.75))}
    body.bar .ctl{inset:0;background:#16181d;padding:0 12px}
    body.cam .ctl{opacity:0;transition:opacity .15s}
    body.cam:hover .ctl{opacity:1}
    .dot{width:10px;height:10px;border-radius:50%;background:#e5484d;animation:b 1.2s infinite;flex:none}
    body.paused .dot{animation:none;background:#f5a524}
    @keyframes b{50%{opacity:.25}}
    .t{font:600 15px ui-monospace,"SF Mono",Menlo,monospace;flex:1;min-width:58px}
    body.cam .t{font-size:13px}
    button{width:34px;height:34px;flex:none;border:0;border-radius:9px;background:rgba(255,255,255,.12);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
    button:hover{background:rgba(255,255,255,.22)}
    button svg{width:18px;height:18px;fill:currentColor}
    button.stop{background:#e5484d}
    button.on{background:#7a5a12}
    body.cam button{width:30px;height:30px}
    .cd{position:absolute;inset:0;display:none;align-items:center;justify-content:center;font-size:96px;font-weight:800;background:rgba(0,0,0,.55);z-index:2}
    body.bar .cd{font-size:34px}
    .cd.on{display:flex}
    .flash{position:absolute;inset:0;box-shadow:inset 0 0 0 4px #fff;opacity:0;transition:opacity .4s;pointer-events:none;z-index:3}
    .flash.on{opacity:1;transition:none}`;

  function setupPip(win) {
    const d = win.document;
    const st = d.createElement('style');
    st.textContent = PIP_CSS;
    d.head.appendChild(st);
    d.title = 'Grabador Pro';
    const cam = wantCamPanel();
    d.body.className = cam ? 'cam' : 'bar';
    d.body.innerHTML = `${cam ? '<video autoplay muted playsinline></video>' : ''}
      <div class="cd"></div><div class="flash"></div>
      <div class="ctl"><span class="dot"></span><span class="t">00:00</span>
        <button data-a="pause" title="Pausar / reanudar">${ICON.pause}</button>
        <button data-a="mark" title="Marcador">${ICON.flag}</button>
        <button data-a="shot" title="Captura">${ICON.shot}</button>
        <button data-a="mute" title="Silenciar micrófono">${ICON.mic}</button>
        <button data-a="stop" class="stop" title="Detener y guardar">${ICON.stop}</button></div>`;
    if (cam) d.querySelector('video').srcObject = camStream;
    d.querySelectorAll('button[data-a]').forEach((b) => {
      b.addEventListener('click', () => ({ pause: togglePause, mark: addMarker, shot: screenshot, mute: toggleMute, stop })[b.dataset.a]());
    });
    win.addEventListener('pagehide', () => { if (R && R.pip === win) R.pip = null; });
    updatePip();
  }
  function updatePip() {
    if (!R || !R.pip) return;
    const d = R.pip.document;
    const t = d.querySelector('.t');
    if (t) t.textContent = fmtShort(elapsed());
    d.body.classList.toggle('paused', R.state === 'paused');
    const pb = d.querySelector('[data-a=pause]');
    if (pb && pb.dataset.state !== R.state) {
      pb.dataset.state = R.state;
      pb.innerHTML = R.state === 'paused' ? ICON.play : ICON.pause;
    }
    const mb = d.querySelector('[data-a=mute]');
    if (mb && mb.dataset.muted !== String(R.muted)) {
      mb.dataset.muted = String(R.muted);
      mb.innerHTML = R.muted ? ICON.micOff : ICON.mic;
      mb.classList.toggle('on', R.muted);
      mb.style.display = R.micGain ? '' : 'none';
    }
  }
  function pipCountdown(n) {
    if (!R || !R.pip) return;
    const cd = R.pip.document.querySelector('.cd');
    cd.textContent = n || '';
    cd.classList.toggle('on', n > 0);
  }
  function pipFlash() {
    if (!R || !R.pip) return;
    const f = R.pip.document.querySelector('.flash');
    f.classList.add('on');
    setTimeout(() => f.classList.remove('on'), 60);
  }

  /* ================= eventos ================= */
  $('#start').onclick = start;
  $('#stop').onclick = stop;
  $('#pause').onclick = togglePause;
  $('#mute').onclick = toggleMute;
  $('#marker').onclick = addMarker;
  $('#shot').onclick = screenshot;
  $('#recName').addEventListener('input', renderHints);
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'cmd') return;
    if (msg.cmd === 'toggle-recording') { if (R) stop(); }
    else if (msg.cmd === 'pause-recording') togglePause();
    else if (msg.cmd === 'add-marker') addMarker();
  });
  window.addEventListener('beforeunload', (e) => {
    if (R && ['recording', 'paused', 'saving', 'countdown'].includes(R.state)) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ================= inicio ================= */
  (async () => {
    const st = await chrome.storage.local.get(['settings', 'library']);
    S = { ...DEFAULTS, ...(st.settings || {}) };
    // Actualizar una sola vez los ajustes antiguos (1080p/30 FPS, etc.).
    // Conserva carpeta, micrófono, nombres e historial. No borra grabaciones.
    if ((Number(st.settings && st.settings.lowLagVersion) || 0) < LIGHT_PROFILE_VERSION) {
      Object.assign(S, LIGHT_PROFILE, { lowLagVersion: LIGHT_PROFILE_VERSION });
      await save();
    }
    library = st.library || [];
    try { dirHandle = (await kv('dir')) || null; } catch (_) {}
    if (S.dest === 'folder' && !dirHandle) S.dest = 'downloads';
    addPerformanceControls();
    bindSettings();
    renderHints();
    renderDest();
    renderLibrary();
    setState('idle');
    meterLoop();
    cleanTemp();
    await Promise.all([refreshMic(), refreshCam()]);
    try {
      const cmds = await chrome.commands.getAll();
      const map = Object.fromEntries(cmds.map((c) => [c.name, c.shortcut]));
      const kb = $$('#vRec .hint kbd');
      ['toggle-recording', 'pause-recording', 'add-marker'].forEach((n, i) => { if (kb[i]) kb[i].textContent = map[n] || 'sin atajo'; });
    } catch (_) {}
    if (!localStorage.getItem('gp-seen')) { $('#macHelp').open = true; try { localStorage.setItem('gp-seen', '1'); } catch (_) {} }
  })();
})();
