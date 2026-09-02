const HISTORY_LIMIT = 3;

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
// Target must not exceed trigger — otherwise we'd "resize up", which is nonsense.
if (TARGET_SIZE > TRIGGER_SIZE) TARGET_SIZE = TRIGGER_SIZE;

const dropzone     = document.getElementById('dropzone');
const filepicker   = document.getElementById('filepicker');
const statusEl     = document.getElementById('status');
const historyEl    = document.getElementById('history');
const historyWrap  = document.getElementById('history-wrap');

const subtitleTrigger = document.getElementById('subtitle-trigger');
const subtitleTarget  = document.getElementById('subtitle-target');
if (subtitleTrigger) subtitleTrigger.textContent = TRIGGER_SIZE + 'px';
if (subtitleTarget)  subtitleTarget.textContent  = TARGET_SIZE  + 'px';

const history = [];

function fmtBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

async function writeBlobToClipboard(blob) {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    return { ok: false, reason: 'Clipboard API not supported in this browser.' };
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message || 'Clipboard write blocked.' };
  }
}

const HEIC_EXT = /\.(heic|heif)$/i;
const HEIC_MIME = /^image\/hei[cf](?:-sequence)?$/i;

function isHeicExtension(name) {
  return HEIC_EXT.test(name || '');
}

function isImageFile(file) {
  if (!file) return false;
  if (file.type.startsWith('image/')) return true;
  return isHeicExtension(file.name);
}

async function isHeicFile(file) {
  if (isHeicExtension(file.name)) return true;
  if (HEIC_MIME.test(file.type || '')) return true;
  if (typeof HeicTo?.isHeic === 'function') {
    try { return await HeicTo.isHeic(file); } catch (_) { /* fall through */ }
  }
  return false;
}

async function convertHeicToJpeg(file) {
  if (typeof HeicTo !== 'function') {
    throw new Error('HEIC support failed to load. Refresh and try again.');
  }
  const converted = await HeicTo({ blob: file, type: 'image/jpeg', quality: 0.92 });
  return converted instanceof Blob ? converted : converted[0];
}

async function normalizeToDecodableBlob(file) {
  if (await isHeicFile(file)) {
    return { blob: await convertHeicToJpeg(file), origSize: file.size, convertedFromHeic: true };
  }
  return { blob: file, origSize: file.size, convertedFromHeic: false };
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

async function resizeIfNeeded(file) {
  if (!isImageFile(file)) {
    throw new Error(`Not an image (type: ${file.type || 'unknown'}).`);
  }

  const { blob: inputBlob, origSize } = await normalizeToDecodableBlob(file);
  const bitmap = await decodeImage(inputBlob);
  const origW  = bitmap.width;
  const origH  = bitmap.height;

  // Claude API rejects images where EITHER dimension exceeds the cap, so we
  // resize based on the longest side, not just width.
  const maxSide = Math.max(origW, origH);

  let blob, newW, newH, resized;

  if (maxSide <= TRIGGER_SIZE) {
    // Pass through untouched. Avoids re-encoding cost and preserves bytes.
    // HEIC/HEIF are already converted to JPEG above so clipboard/history stay compatible.
    blob = inputBlob;
    newW = origW;
    newH = origH;
    resized = false;
  } else {
    const ratio = TARGET_SIZE / maxSide;
    newW = Math.round(origW * ratio);
    newH = Math.round(origH * ratio);
    const canvas = document.createElement('canvas');
    canvas.width  = newW;
    canvas.height = newH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, newW, newH);
    blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    resized = true;
  }

  if (typeof bitmap.close === 'function') bitmap.close();

  return { blob, origW, origH, newW, newH, resized, origSize };
}

function clearStatus() { statusEl.innerHTML = ''; }

function renderStatus({ ok, title, detail, blob }) {
  clearStatus();
  const row = document.createElement('div');
  row.className = 'status__row ' + (ok ? 'status__row--ok' : 'status__row--err');

  const icon = document.createElement('span');
  icon.className = 'status__icon';
  icon.textContent = ok ? '✓' : '!';
  row.appendChild(icon);

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

  if (blob) {
    const btn = document.createElement('button');
    btn.className = 'status__copy';
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      const res = await writeBlobToClipboard(blob);
      btn.textContent = res.ok ? 'Copied' : 'Failed';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    });
    row.appendChild(btn);
  }

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
    item.title = 'Click to copy this version to your clipboard';

    const img = document.createElement('img');
    img.className = 'history__thumb';
    img.src = h.thumbUrl;
    img.alt = '';
    item.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'history__meta';
    meta.textContent = h.resized
      ? `${h.origW}×${h.origH} → ${h.newW}×${h.newH} · ${fmtBytes(h.blob.size)}`
      : `${h.origW}×${h.origH} · ${fmtBytes(h.blob.size)}`;
    item.appendChild(meta);

    const copied = document.createElement('div');
    copied.className = 'history__copied';
    copied.textContent = 'Copied';
    item.appendChild(copied);

    item.addEventListener('click', async () => {
      const res = await writeBlobToClipboard(h.blob);
      if (res.ok) {
        item.classList.add('history__item--copied');
        setTimeout(() => item.classList.remove('history__item--copied'), 900);
      }
    });

    historyEl.appendChild(item);
  });
}

async function processFile(file) {
  dropzone.classList.add('dropzone--busy');
  try {
    const result = await resizeIfNeeded(file);
    const writeRes = await writeBlobToClipboard(result.blob);

    const detail = result.resized
      ? `${result.origW}×${result.origH} → ${result.newW}×${result.newH}  ·  ${fmtBytes(result.origSize)} → ${fmtBytes(result.blob.size)}`
      : `${result.origW}×${result.origH}  ·  ${fmtBytes(result.blob.size)} (within ${TRIGGER_SIZE}px limit)`;

    if (writeRes.ok) {
      renderStatus({
        ok: true,
        title: result.resized ? 'Resized and copied to clipboard' : 'Copied to clipboard',
        detail,
        blob: result.blob,
      });
    } else {
      renderStatus({
        ok: false,
        title: result.resized ? 'Resize complete — clipboard unavailable' : 'Ready — clipboard unavailable',
        detail: `${detail}  ·  ${writeRes.reason} Use Copy to retry.`,
        blob: result.blob,
      });
    }

    pushHistory({
      ...result,
      thumbUrl: URL.createObjectURL(result.blob),
    });
  } catch (e) {
    renderStatus({
      ok: false,
      title: 'Could not process image',
      detail: e?.message || String(e),
    });
  } finally {
    dropzone.classList.remove('dropzone--busy');
  }
}

async function processFiles(files) {
  // Serial so the LAST processed image lands on the clipboard.
  for (const f of files) {
    if (!isImageFile(f)) continue;
    await processFile(f);
  }
}

// Drag and drop
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

  const files = Array.from(e.dataTransfer?.files || []).filter(isImageFile);
  if (files.length === 0) {
    renderStatus({
      ok: false,
      title: 'No image in drop',
      detail: 'Drop an image file or paste from clipboard.',
    });
    return;
  }
  await processFiles(files);
});

// Prevent accidental navigation when dropping outside the dropzone
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop',     (e) => e.preventDefault());

// Click to pick
dropzone.addEventListener('click', () => filepicker.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    filepicker.click();
  }
});
filepicker.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  await processFiles(files);
  e.target.value = '';
});

// Cmd+V paste anywhere on the page
window.addEventListener('paste', async (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const files = items
    .filter(it => it.kind === 'file')
    .map(it => it.getAsFile())
    .filter(isImageFile);
  if (files.length > 0) {
    e.preventDefault();
    await processFiles(files);
  }
});
