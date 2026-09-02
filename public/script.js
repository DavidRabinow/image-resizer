const HISTORY_LIMIT = 5;
const STATS_KEY = 'stux-resizer-stats';

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

const subtitleTrigger = document.getElementById('subtitle-trigger');
const subtitleTarget  = document.getElementById('subtitle-target');
if (subtitleTrigger) subtitleTrigger.textContent = TRIGGER_SIZE + 'px';
if (subtitleTarget)  subtitleTarget.textContent  = TARGET_SIZE  + 'px';

const history = [];
let sessionStats = loadStats();

// ── PDF.js (ES module) ──
import * as pdfjsLib from '/vendor/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';

// ── Helpers ──

function defaultStats() {
  return { processed: 0, resized: 0, bytesSaved: 0, images: 0, pdfs: 0, docxs: 0 };
}

function loadStats() {
  try {
    const raw = sessionStorage.getItem(STATS_KEY);
    return raw ? { ...defaultStats(), ...JSON.parse(raw) } : defaultStats();
  } catch {
    return defaultStats();
  }
}

function saveStats() {
  sessionStorage.setItem(STATS_KEY, JSON.stringify(sessionStats));
  renderStats();
}

function renderStats() {
  if (statProcessed) statProcessed.textContent = String(sessionStats.processed);
  if (statResized)   statResized.textContent   = String(sessionStats.resized);
  if (statSaved)     statSaved.textContent     = fmtBytes(Math.max(0, sessionStats.bytesSaved));
}

function recordStats(result) {
  sessionStats.processed += 1;
  if (result.resized) sessionStats.resized += 1;
  if (result.origSize > result.blob.size) {
    sessionStats.bytesSaved += result.origSize - result.blob.size;
  }
  if (result.kind === 'image') sessionStats.images += 1;
  if (result.kind === 'pdf')   sessionStats.pdfs   += 1;
  if (result.kind === 'docx')  sessionStats.docxs  += 1;
  saveStats();
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

async function resizeBitmap(bitmap, onProgress) {
  const origW = bitmap.width;
  const origH = bitmap.height;
  const maxSide = Math.max(origW, origH);

  if (maxSide <= TRIGGER_SIZE) {
    return { origW, origH, newW: origW, newH: origH, resized: false, bitmap };
  }

  onProgress?.(0.7, `Scaling ${origW}×${origH} → target ${TARGET_SIZE}px…`);
  const ratio = TARGET_SIZE / maxSide;
  const newW = Math.round(origW * ratio);
  const newH = Math.round(origH * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = newW;
  canvas.height = newH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, newW, newH);
  if (typeof bitmap.close === 'function') bitmap.close();

  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  return { origW, origH, newW, newH, resized: true, blob };
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
  const result = await resizeBitmap(bitmap, onProgress);

  let blob;
  if (result.resized) {
    blob = result.blob;
  } else {
    blob = inputBlob;
    if (typeof bitmap.close === 'function') bitmap.close();
  }

  onProgress(0.95, 'Done.');
  const detail = result.resized
    ? `${result.origW}×${result.origH} → ${result.newW}×${result.newH} · ${fmtBytes(origSize)} → ${fmtBytes(blob.size)}`
    : `${result.origW}×${result.origH} · ${fmtBytes(blob.size)} (within ${TRIGGER_SIZE}px limit)`;

  return {
    kind: 'image',
    blob,
    origSize,
    resized: result.resized,
    filename: file.name,
    origW: result.origW,
    origH: result.origH,
    newW: result.newW,
    newH: result.newH,
    detail,
  };
}

async function resizeImageBlob(blob, path) {
  const file = new File([blob], path.split('/').pop(), { type: blob.type || 'application/octet-stream' });
  const { blob: inputBlob } = await normalizeToDecodableBlob(file);
  const bitmap = await decodeImage(inputBlob);
  const result = await resizeBitmap(bitmap);
  if (result.resized) {
    return { ...result, blob: result.blob };
  }
  if (typeof bitmap.close === 'function') bitmap.close();
  return { ...result, blob: inputBlob };
}

// ── PDF processing ──

async function resizePdfFile(file, onProgress) {
  onProgress(0.05, 'Loading PDF…');
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;
  const { PDFDocument } = PDFLib;

  let anyResized = false;
  const pageMeta = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const maxSide = Math.max(viewport.width, viewport.height);
    const needsResize = maxSide > TRIGGER_SIZE;
    if (needsResize) anyResized = true;
    pageMeta.push({ page, viewport, maxSide, needsResize });
    onProgress(0.05 + 0.15 * (i / numPages), `Analyzing page ${i} of ${numPages}…`);
  }

  if (!anyResized) {
    onProgress(0.95, 'No pages need resizing.');
    return {
      kind: 'pdf',
      blob: file,
      origSize: file.size,
      resized: false,
      filename: file.name,
      pages: numPages,
      detail: `${numPages} page${numPages === 1 ? '' : 's'} · ${fmtBytes(file.size)} (all within ${TRIGGER_SIZE}px limit)`,
    };
  }

  onProgress(0.22, 'Rendering and compressing pages…');
  const outPdf = await PDFDocument.create();

  for (let i = 0; i < pageMeta.length; i++) {
    const { page, viewport, maxSide, needsResize } = pageMeta[i];
    const scale = needsResize ? TARGET_SIZE / maxSide : 1;
    const scaled = page.getViewport({ scale });
    onProgress(0.22 + 0.7 * ((i + 1) / numPages), `Processing page ${i + 1} of ${numPages}…`);

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(scaled.width);
    canvas.height = Math.round(scaled.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaled }).promise;

    const jpegBytes = await canvasToJpegBytes(canvas, 0.88);
    const embedded = await outPdf.embedJpg(jpegBytes);
    const outPage = outPdf.addPage([canvas.width, canvas.height]);
    outPage.drawImage(embedded, { x: 0, y: 0, width: canvas.width, height: canvas.height });
  }

  onProgress(0.96, 'Building PDF…');
  const bytes = await outPdf.save();
  const blob = new Blob([bytes], { type: 'application/pdf' });

  return {
    kind: 'pdf',
    blob,
    origSize: file.size,
    resized: true,
    filename: file.name,
    pages: numPages,
    detail: `${numPages} page${numPages === 1 ? '' : 's'} resized · ${fmtBytes(file.size)} → ${fmtBytes(blob.size)}`,
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

  let imagesResized = 0;
  for (let i = 0; i < mediaPaths.length; i++) {
    const path = mediaPaths[i];
    onProgress(0.1 + 0.75 * (i / mediaPaths.length), `Image ${i + 1} of ${mediaPaths.length}…`);
    const data = await zip.file(path).async('blob');
    const result = await resizeImageBlob(data, path);
    if (result.resized) {
      zip.file(path, result.blob);
      imagesResized += 1;
    }
  }

  if (imagesResized === 0) {
    onProgress(0.95, 'No images needed resizing.');
    return {
      kind: 'docx',
      blob: file,
      origSize: file.size,
      resized: false,
      filename: file.name,
      imagesProcessed: mediaPaths.length,
      detail: `${mediaPaths.length} image${mediaPaths.length === 1 ? '' : 's'} · ${fmtBytes(file.size)} (all within ${TRIGGER_SIZE}px limit)`,
    };
  }

  onProgress(0.92, 'Repacking document…');
  const outBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });

  return {
    kind: 'docx',
    blob: outBlob,
    origSize: file.size,
    resized: true,
    filename: file.name,
    imagesProcessed: mediaPaths.length,
    imagesResized,
    detail: `${imagesResized} of ${mediaPaths.length} images resized · ${fmtBytes(file.size)} → ${fmtBytes(outBlob.size)}`,
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
  titleEl.textContent = result.resized
    ? `${kindLabel(result.kind)} resized — not copied yet`
    : `${kindLabel(result.kind)} ready — no resize needed`;
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
    downloadBlob(result.blob, outputFilename(result.filename, result.resized));
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
    meta.textContent = h.resized
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

renderStats();
