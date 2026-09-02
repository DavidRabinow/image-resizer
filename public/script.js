const HISTORY_LIMIT = 5;
const STATS_POLL_MS = 15000;

const DEFAULT_TRIGGER = 1950;
const DEFAULT_TARGET  = 1800;
const MIN_WIDTH       = 200;
const MAX_WIDTH       = 8000;

function readParam(name, fallback) {
  const raw = new URL(window.location.href).searchParams.get(name);
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, MIN_WIDTH), MAX_WIDTH);
}

let TRIGGER_SIZE = readParam('trigger', DEFAULT_TRIGGER);
let TARGET_SIZE  = readParam('target',  DEFAULT_TARGET);
if (TARGET_SIZE > TRIGGER_SIZE) TARGET_SIZE = TRIGGER_SIZE;

const dropzone       = document.getElementById('dropzone');
const filepicker     = document.getElementById('filepicker');
const statusEl       = document.getElementById('status');
const historyEl      = document.getElementById('history');
const historyWrap    = document.getElementById('history-wrap');
const progressWrap   = document.getElementById('progress-wrap');
const progressFill   = document.getElementById('progress-fill');
const progressDetail = document.getElementById('progress-detail');
const statProcessed  = document.getElementById('stat-processed');
const statResized    = document.getElementById('stat-resized');
const statSaved      = document.getElementById('stat-saved');
const statDetail     = document.getElementById('stat-detail');
const statSession    = document.getElementById('stat-session');
const statLive       = document.getElementById('stat-live');

const subtitleTrigger = document.getElementById('subtitle-trigger');
const subtitleTarget  = document.getElementById('subtitle-target');
if (subtitleTrigger) subtitleTrigger.textContent = TRIGGER_SIZE + 'px';
if (subtitleTarget)  subtitleTarget.textContent  = TARGET_SIZE  + 'px';

const history = [];
let globalStats = defaultStats();
const sessionStats = defaultStats();

// ── PDF.js (ES module) ──
import * as pdfjsLib from '/vendor/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';

// ── Helpers ──

function defaultStats() {
  return {
    processed: 0,
    resized: 0,
    bytesIn: 0,
    bytesOut: 0,
    images: 0,
    pdfs: 0,
    docxs: 0,
    updatedAt: null,
  };
}

function bytesSaved(stats) {
  return Math.max(0, stats.bytesIn - stats.bytesOut);
}

function formatTypeBreakdown(stats) {
  const parts = [];
  if (stats.images) parts.push(`${stats.images} image${stats.images === 1 ? '' : 's'}`);
  if (stats.pdfs)   parts.push(`${stats.pdfs} PDF${stats.pdfs === 1 ? '' : 's'}`);
  if (stats.docxs)  parts.push(`${stats.docxs} DOCX`);
  return parts.length ? parts.join(' · ') : null;
}

function renderStats() {
  const saved = bytesSaved(globalStats);
  if (statProcessed) statProcessed.textContent = String(globalStats.processed);
  if (statResized)   statResized.textContent   = String(globalStats.resized);
  if (statSaved)     statSaved.textContent     = fmtBytes(saved);

  if (statDetail) {
    if (globalStats.processed === 0) {
      statDetail.textContent = 'Shared across all users — only counts and bytes, never file contents.';
    } else {
      const types = formatTypeBreakdown(globalStats);
      const inOut = `${fmtBytes(globalStats.bytesIn)} in → ${fmtBytes(globalStats.bytesOut)} out`;
      statDetail.textContent = types ? `${types} · ${inOut}` : inOut;
    }
  }

  if (statSession) {
    if (sessionStats.processed === 0) {
      statSession.textContent = '';
    } else {
      const sessSaved = bytesSaved(sessionStats);
      statSession.textContent = `Your visit: ${sessionStats.processed} file${sessionStats.processed === 1 ? '' : 's'}`
        + (sessSaved > 0 ? ` · ${fmtBytes(sessSaved)} saved` : '');
    }
  }
}

async function fetchGlobalStats() {
  const res = await fetch('/api/stats', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Stats unavailable (${res.status})`);
  return { ...defaultStats(), ...await res.json() };
}

async function refreshGlobalStats() {
  try {
    globalStats = await fetchGlobalStats();
    if (statLive) statLive.hidden = false;
    renderStats();
  } catch {
    if (statDetail) statDetail.textContent = 'Could not load community totals.';
    if (statLive) statLive.hidden = true;
  }
}

async function reportStats(result) {
  const res = await fetch('/api/stats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origSize: result.origSize,
      outSize: result.blob.size,
      optimized: !!(result.changed || result.resized || result.optimized),
      kind: result.kind,
    }),
  });
  if (!res.ok) throw new Error(`Stats report failed (${res.status})`);
  globalStats = { ...defaultStats(), ...await res.json() };
  renderStats();
}

async function recordStats(result) {
  const now = Date.now();
  sessionStats.processed += 1;
  if (result.resized) sessionStats.resized += 1;
  sessionStats.bytesIn  += result.origSize;
  sessionStats.bytesOut += result.blob.size;
  if (result.kind === 'image') sessionStats.images += 1;
  if (result.kind === 'pdf')   sessionStats.pdfs   += 1;
  if (result.kind === 'docx')  sessionStats.docxs  += 1;
  if (!sessionStats.firstUsed) sessionStats.firstUsed = now;
  sessionStats.lastUsed = now;
  renderStats();

  try {
    await reportStats(result);
    if (statLive) statLive.hidden = false;
  } catch {
    await refreshGlobalStats();
  }
}

function startStatsPolling() {
  refreshGlobalStats();
  setInterval(() => {
    if (document.visibilityState === 'visible') refreshGlobalStats();
  }, STATS_POLL_MS);
}

function fmtBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function kindLabel(kind) {
  if (kind === 'pdf') return 'PDF';
  if (kind === 'docx') return 'Document';
  return 'Image';
}

function outputFilename(name, resized) {
  const base = name || 'file';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext  = dot > 0 ? base.slice(dot) : '';
  return resized ? `${stem}-resized${ext}` : base;
}

function setProgress(pct, detail) {
  if (!progressWrap) return;
  progressWrap.hidden = false;
  progressFill.style.width = Math.min(100, Math.round(pct * 100)) + '%';
  if (detail) progressDetail.textContent = detail;
}

function hideProgress() {
  if (!progressWrap) return;
  progressWrap.hidden = true;
  progressFill.style.width = '0%';
  progressDetail.textContent = '';
}

async function writeBlobToClipboard(blob) {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    return { ok: false, reason: 'Clipboard not supported in this browser.' };
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message || 'Clipboard write blocked.' };
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── File type detection ──

const HEIC_EXT = /\.(heic|heif)$/i;
const HEIC_MIME = /^image\/hei[cf](?:-sequence)?$/i;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MEDIA_RE  = /^word\/media\/.+\.(png|jpe?g|gif|webp|tiff?)$/i;

function isHeicExtension(name) {
  return HEIC_EXT.test(name || '');
}

function isImageFile(file) {
  if (!file) return false;
  if (file.type.startsWith('image/')) return true;
  return isHeicExtension(file.name);
}

function isPdfFile(file) {
  if (!file) return false;
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
}

function isDocxFile(file) {
  if (!file) return false;
  return file.type === DOCX_MIME || /\.docx$/i.test(file.name || '');
}

function getFileKind(file) {
  if (isImageFile(file)) return 'image';
  if (isPdfFile(file))   return 'pdf';
  if (isDocxFile(file))  return 'docx';
  return null;
}

function isSupportedFile(file) {
  return getFileKind(file) !== null;
}

async function isHeicFile(file) {
  if (isHeicExtension(file.name)) return true;
  if (HEIC_MIME.test(file.type || '')) return true;
  if (typeof HeicTo?.isHeic === 'function') {
    try { return await HeicTo.isHeic(file); } catch (_) { /* fall through */ }
  }
  return false;
}

// ── Image processing ──

async function convertHeicToJpeg(file, onProgress) {
  if (typeof HeicTo !== 'function') {
    throw new Error('HEIC support failed to load. Refresh and try again.');
  }
  onProgress?.(0.12, 'Converting HEIC to JPEG…');
  const converted = await HeicTo({ blob: file, type: 'image/jpeg', quality: 0.92 });
  return converted instanceof Blob ? converted : converted[0];
}

async function normalizeToDecodableBlob(file, onProgress) {
  if (await isHeicFile(file)) {
    return {
      blob: await convertHeicToJpeg(file, onProgress),
      origSize: file.size,
    };
  }
  return { blob: file, origSize: file.size };
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch (_) { /* fall through */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image.')); };
    img.src = url;
  });
}

const JPEG_QUALITY = 0.88;

async function encodeCanvasSmallest(canvas) {
  const jpeg = await new Promise(r => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));
  const png  = await new Promise(r => canvas.toBlob(r, 'image/png'));
  const candidates = [jpeg, png].filter(Boolean);
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (a.size <= b.size ? a : b));
}

async function processImageBitmap(bitmap, onProgress) {
  const origW = bitmap.width;
  const origH = bitmap.height;
  const maxSide = Math.max(origW, origH);
  const dimensionResized = maxSide > TRIGGER_SIZE;
  const newW = dimensionResized ? Math.round(origW * TARGET_SIZE / maxSide) : origW;
  const newH = dimensionResized ? Math.round(origH * TARGET_SIZE / maxSide) : origH;

  onProgress?.(
    dimensionResized ? 0.7 : 0.75,
    dimensionResized ? `Scaling ${origW}×${origH}…` : 'Optimizing…',
  );

  const canvas = document.createElement('canvas');
  canvas.width = newW;
  canvas.height = newH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, newW, newH);
  if (typeof bitmap.close === 'function') bitmap.close();

  const blob = await encodeCanvasSmallest(canvas);
  if (!blob) throw new Error('Could not encode image.');
  return { origW, origH, newW, newH, dimensionResized, blob };
}

function pickSmallerBlob(inputBlob, candidate, dimensionResized) {
  if (dimensionResized) return candidate;
  return candidate.size < inputBlob.size ? candidate : inputBlob;
}

function describeImageResult(origSize, blob, dims, dimensionResized, optimized) {
  const sizePart = `${fmtBytes(origSize)} → ${fmtBytes(blob.size)}`;
  if (dimensionResized && optimized) {
    return `${dims.origW}×${dims.origH} → ${dims.newW}×${dims.newH} · ${sizePart}`;
  }
  if (dimensionResized) {
    return `${dims.origW}×${dims.origH} → ${dims.newW}×${dims.newH} · ${sizePart}`;
  }
  if (optimized) {
    return `${dims.origW}×${dims.origH} · ${sizePart}`;
  }
  return `${dims.origW}×${dims.origH} · ${fmtBytes(blob.size)} (already optimal)`;
}

async function canvasToJpegBytes(canvas, quality = 0.85) {
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
  return new Uint8Array(await blob.arrayBuffer());
}

async function resizeImageFile(file, onProgress) {
  onProgress(0.05, 'Reading image…');
  const { blob: inputBlob, origSize } = await normalizeToDecodableBlob(file, onProgress);
  onProgress(0.25, 'Decoding image…');
  const bitmap = await decodeImage(inputBlob);
  const processed = await processImageBitmap(bitmap, onProgress);
  const blob = pickSmallerBlob(inputBlob, processed.blob, processed.dimensionResized);
  const optimized = blob.size < inputBlob.size && !processed.dimensionResized;
  const changed = processed.dimensionResized || optimized;

  onProgress(0.95, 'Done.');
  return {
    kind: 'image',
    blob,
    origSize,
    resized: processed.dimensionResized,
    optimized,
    changed,
    filename: file.name,
    origW: processed.origW,
    origH: processed.origH,
    newW: processed.newW,
    newH: processed.newH,
    detail: describeImageResult(origSize, blob, processed, processed.dimensionResized, optimized),
  };
}

async function resizeImageBlob(blob, path) {
  const file = new File([blob], path.split('/').pop(), { type: blob.type || 'application/octet-stream' });
  const { blob: inputBlob } = await normalizeToDecodableBlob(file);
  const bitmap = await decodeImage(inputBlob);
  const processed = await processImageBitmap(bitmap);
  const out = pickSmallerBlob(inputBlob, processed.blob, processed.dimensionResized);
  const optimized = out.size < inputBlob.size && !processed.dimensionResized;
  return {
    ...processed,
    blob: out,
    resized: processed.dimensionResized,
    optimized,
    changed: processed.dimensionResized || optimized,
  };
}

// ── PDF processing ──

async function resizePdfFile(file, onProgress) {
  onProgress(0.05, 'Loading PDF…');
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;
  const { PDFDocument } = PDFLib;

  onProgress(0.2, 'Compressing pages…');
  const outPdf = await PDFDocument.create();
  let pagesChanged = 0;

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const maxSide = Math.max(viewport.width, viewport.height);
    const scale = maxSide > TRIGGER_SIZE ? TARGET_SIZE / maxSide : 1;
    const scaled = page.getViewport({ scale });
    onProgress(0.2 + 0.7 * (i / numPages), `Processing page ${i} of ${numPages}…`);

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(scaled.width);
    canvas.height = Math.round(scaled.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaled }).promise;

    const jpegBytes = await canvasToJpegBytes(canvas, JPEG_QUALITY);
    const embedded = await outPdf.embedJpg(jpegBytes);
    const outPage = outPdf.addPage([canvas.width, canvas.height]);
    outPage.drawImage(embedded, { x: 0, y: 0, width: canvas.width, height: canvas.height });
    if (scale < 1) pagesChanged += 1;
  }

  onProgress(0.96, 'Building PDF…');
  const bytes = await outPdf.save();
  const outBlob = new Blob([bytes], { type: 'application/pdf' });
  const optimized = outBlob.size < file.size;
  const blob = optimized ? outBlob : file;
  const changed = optimized || pagesChanged > 0;

  return {
    kind: 'pdf',
    blob,
    origSize: file.size,
    resized: pagesChanged > 0,
    optimized: optimized && pagesChanged === 0,
    changed,
    filename: file.name,
    pages: numPages,
    detail: changed
      ? `${numPages} page${numPages === 1 ? '' : 's'} · ${fmtBytes(file.size)} → ${fmtBytes(blob.size)}`
      : `${numPages} page${numPages === 1 ? '' : 's'} · ${fmtBytes(file.size)} (already optimal)`,
  };
}

// ── DOCX processing ──

async function resizeDocxFile(file, onProgress) {
  onProgress(0.05, 'Opening document…');
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const mediaPaths = Object.keys(zip.files).filter(p => MEDIA_RE.test(p));

  if (mediaPaths.length === 0) {
    onProgress(0.95, 'No embedded images found.');
    return {
      kind: 'docx',
      blob: file,
      origSize: file.size,
      resized: false,
      filename: file.name,
      imagesProcessed: 0,
      detail: `${fmtBytes(file.size)} · no embedded images to resize`,
    };
  }

  let imagesChanged = 0;
  for (let i = 0; i < mediaPaths.length; i++) {
    const path = mediaPaths[i];
    onProgress(0.1 + 0.75 * (i / mediaPaths.length), `Image ${i + 1} of ${mediaPaths.length}…`);
    const data = await zip.file(path).async('blob');
    const result = await resizeImageBlob(data, path);
    if (result.changed && result.blob.size <= data.size) {
      zip.file(path, result.blob);
      imagesChanged += 1;
    }
  }

  onProgress(0.92, 'Repacking document…');
  const outBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const optimized = outBlob.size < file.size;
  const blob = optimized ? outBlob : file;
  const changed = optimized || imagesChanged > 0;

  return {
    kind: 'docx',
    blob,
    origSize: file.size,
    resized: imagesChanged > 0,
    optimized: optimized && imagesChanged === 0,
    changed,
    filename: file.name,
    imagesProcessed: mediaPaths.length,
    imagesChanged,
    detail: changed
      ? `${imagesChanged} of ${mediaPaths.length} images optimized · ${fmtBytes(file.size)} → ${fmtBytes(blob.size)}`
      : `${mediaPaths.length} image${mediaPaths.length === 1 ? '' : 's'} · ${fmtBytes(file.size)} (already optimal)`,
  };
}

// ── UI ──

function clearStatus() { statusEl.innerHTML = ''; }

function renderResult(result) {
  clearStatus();
  const row = document.createElement('div');
  row.className = 'status__row status__row--ok';

  const msgWrap = document.createElement('div');
  msgWrap.className = 'status__msg';

  const titleEl = document.createElement('span');
  titleEl.className = 'status__title';
  titleEl.textContent = result.changed
    ? `${kindLabel(result.kind)} optimized — not copied yet`
    : `${kindLabel(result.kind)} ready — already optimal`;
  msgWrap.appendChild(titleEl);

  const detailEl = document.createElement('span');
  detailEl.className = 'status__detail';
  detailEl.textContent = result.detail;
  msgWrap.appendChild(detailEl);

  const hintEl = document.createElement('span');
  hintEl.className = 'status__hint';
  hintEl.textContent = result.kind === 'image'
    ? 'Use Copy or Download below when you are ready.'
    : 'Use Download below to save the file.';
  msgWrap.appendChild(hintEl);

  row.appendChild(msgWrap);

  const actions = document.createElement('div');
  actions.className = 'status__actions';

  if (result.kind === 'image') {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'status__btn status__btn--primary';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy to clipboard';
    copyBtn.addEventListener('click', async () => {
      const res = await writeBlobToClipboard(result.blob);
      copyBtn.textContent = res.ok ? 'Copied' : 'Copy failed';
      copyBtn.disabled = res.ok;
      setTimeout(() => {
        copyBtn.textContent = 'Copy to clipboard';
        copyBtn.disabled = false;
      }, 2000);
    });
    actions.appendChild(copyBtn);
  }

  const dlBtn = document.createElement('button');
  dlBtn.className = 'status__btn' + (result.kind === 'image' ? '' : ' status__btn--primary');
  dlBtn.type = 'button';
  dlBtn.textContent = 'Download';
  dlBtn.addEventListener('click', () => {
    downloadBlob(result.blob, outputFilename(result.filename, result.changed));
    dlBtn.textContent = 'Downloaded';
    setTimeout(() => { dlBtn.textContent = 'Download'; }, 1500);
  });
  actions.appendChild(dlBtn);

  row.appendChild(actions);
  statusEl.appendChild(row);
}

function renderError(title, detail) {
  clearStatus();
  const row = document.createElement('div');
  row.className = 'status__row status__row--err';
  const msgWrap = document.createElement('div');
  msgWrap.className = 'status__msg';
  const titleEl = document.createElement('span');
  titleEl.className = 'status__title';
  titleEl.textContent = title;
  msgWrap.appendChild(titleEl);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'status__detail';
    d.textContent = detail;
    msgWrap.appendChild(d);
  }
  row.appendChild(msgWrap);
  statusEl.appendChild(row);
}

function pushHistory(entry) {
  history.unshift(entry);
  while (history.length > HISTORY_LIMIT) {
    const dropped = history.pop();
    if (dropped?.thumbUrl) URL.revokeObjectURL(dropped.thumbUrl);
  }
  renderHistory();
}

function renderHistory() {
  if (history.length === 0) { historyWrap.hidden = true; return; }
  historyWrap.hidden = false;
  historyEl.innerHTML = '';

  history.forEach((h) => {
    const item = document.createElement('div');
    item.className = 'history__item';

    if (h.kind === 'image' && h.thumbUrl) {
      const img = document.createElement('img');
      img.className = 'history__thumb';
      img.src = h.thumbUrl;
      img.alt = '';
      item.appendChild(img);
    } else {
      const badge = document.createElement('div');
      badge.className = 'history__badge';
      badge.textContent = h.kind === 'pdf' ? 'PDF' : h.kind === 'docx' ? 'DOCX' : 'IMG';
      item.appendChild(badge);
    }

    const meta = document.createElement('div');
    meta.className = 'history__meta';
    meta.textContent = h.changed
      ? `${h.detail.split('·')[0].trim()} · ${fmtBytes(h.blob.size)}`
      : fmtBytes(h.blob.size);
    item.appendChild(meta);

    const btns = document.createElement('div');
    btns.className = 'history__btns';

    if (h.kind === 'image') {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'history__btn';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const res = await writeBlobToClipboard(h.blob);
        copyBtn.textContent = res.ok ? 'Copied' : 'Failed';
      });
      btns.appendChild(copyBtn);
    }

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'history__btn';
    dlBtn.textContent = 'Save';
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadBlob(h.blob, outputFilename(h.filename, h.resized));
    });
    btns.appendChild(dlBtn);

    item.appendChild(btns);
    historyEl.appendChild(item);
  });
}

async function processFile(file) {
  const kind = getFileKind(file);
  if (!kind) throw new Error(`Unsupported file type (${file.type || file.name}).`);

  dropzone.classList.add('dropzone--busy');
  setProgress(0, 'Starting…');

  try {
    let result;
    if (kind === 'image') result = await resizeImageFile(file, setProgress);
    else if (kind === 'pdf') result = await resizePdfFile(file, setProgress);
    else result = await resizeDocxFile(file, setProgress);

    setProgress(1, 'Complete.');
    recordStats(result);
    renderResult(result);

    const historyEntry = { ...result };
    if (kind === 'image') {
      historyEntry.thumbUrl = URL.createObjectURL(result.blob);
    }
    pushHistory(historyEntry);
  } catch (e) {
    renderError('Could not process file', e?.message || String(e));
  } finally {
    hideProgress();
    dropzone.classList.remove('dropzone--busy');
  }
}

async function processFiles(files) {
  const supported = files.filter(isSupportedFile);
  if (supported.length === 0) return;
  for (const f of supported) {
    await processFile(f);
  }
}

// ── Events ──

['dragenter', 'dragover'].forEach(ev => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add('dropzone--drag');
  });
});
['dragleave', 'dragend'].forEach(ev => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dropzone--drag');
  });
});
dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropzone.classList.remove('dropzone--drag');

  const files = Array.from(e.dataTransfer?.files || []).filter(isSupportedFile);
  if (files.length === 0) {
    renderError('No supported file in drop', 'Drop an image, PDF, or DOCX file.');
    return;
  }
  await processFiles(files);
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop',     (e) => e.preventDefault());

dropzone.addEventListener('click', () => filepicker.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    filepicker.click();
  }
});
filepicker.addEventListener('change', async (e) => {
  await processFiles(Array.from(e.target.files || []));
  e.target.value = '';
});

window.addEventListener('paste', async (e) => {
  const files = Array.from(e.clipboardData?.items || [])
    .filter(it => it.kind === 'file')
    .map(it => it.getAsFile())
    .filter(isSupportedFile);
  if (files.length > 0) {
    e.preventDefault();
    await processFiles(files);
  }
});

startStatsPolling();
