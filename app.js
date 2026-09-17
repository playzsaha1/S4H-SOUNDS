'use strict';
const $ = id => document.getElementById(id);
const state = { file: null, format: 'wav', busy: false, downloads: [], job: null, theme: 'dark' };
const formats = [...document.querySelectorAll('[data-format]')];
const sizeLabel = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

function route(focus = false) {
  const path = location.pathname.replace(/\/$/, '') || '/';
  const app = path === '/app' || path === '/app/downloads';
  const privacy = path === '/privacy';
  const known = ['/', '/privacy', '/app', '/app/downloads'].includes(path);
  document.querySelectorAll('[data-view]').forEach(el => { el.hidden = el.dataset.view !== (known ? path : 'not-found'); });
  $('publicNav').hidden = app || privacy;
  $('privacyNav').hidden = !privacy;
  $('appNav').hidden = !app;
  $('headerStart').hidden = app || privacy;
  $('publicFooter').hidden = app;
  document.body.classList.toggle('app-active', app);
  document.querySelectorAll('nav [data-route]').forEach(a => {
    if (a.pathname === path) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
    a.classList.toggle('active', a.pathname === path);
  });
  document.title = `S4H-SOUNDS | ${({'/': 'Local audio tools', '/app': 'Converter', '/privacy': 'Privacy', '/app/downloads': 'Recent Downloads'})[path] || 'Page not found'}`;
  if (focus) { $('content').focus({ preventScroll: true }); window.scrollTo(0, 0); }
  if (app || path === '/') refreshCount();
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-route]');
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  history.pushState({}, '', a.href);
  route(true);
});
window.addEventListener('popstate', () => route(true));
function theme(value) {
  state.theme = value;
  document.body.dataset.theme = value;
  $('themeToggle').textContent = value === 'dark' ? '☀ Light mode' : '☾ Dark mode';
  $('themeToggle').setAttribute('aria-label', `Switch to ${value === 'dark' ? 'light' : 'dark'} mode`);
  try { localStorage.setItem('s4h-theme', value); } catch { /* Storage may be disabled. */ }
}
$('themeToggle').onclick = () => theme(state.theme === 'dark' ? 'light' : 'dark');
let savedTheme;
try { savedTheme = localStorage.getItem('s4h-theme'); } catch { /* Use default. */ }
theme(savedTheme === 'light' ? 'light' : 'dark');

function log(title, detail, symbol = '·') {
  const row = document.createElement('div'); row.className = 'log-node';
  const icon = document.createElement('div'); icon.className = 'log-node-indicator'; icon.textContent = symbol; icon.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div'); body.className = 'log-node-body';
  const strong = document.createElement('strong'); strong.textContent = title;
  const p = document.createElement('p'); p.textContent = detail;
  body.append(strong, p); row.append(icon, body); $('activityFeed').prepend(row);
  while ($('activityFeed').children.length > 8) $('activityFeed').lastChild.remove();
}
function status(message, kind = 'processing') {
  $('conversionStatus').hidden = false;
  $('conversionStatus').dataset.state = kind;
  $('statusText').textContent = message;
  $('progress').hidden = kind !== 'processing';
  $('stateBadge').textContent = ({processing:'Processing', success:'Complete', error:'Error', ready:'Ready'})[kind];
}
function busy(value) {
  state.busy = value;
  $('convertBtn').disabled = value || !state.file;
  $('convertBtn').textContent = value ? 'Processing…' : '3. Convert File';
  $('fileInput').disabled = value;
  $('uploadZone').setAttribute('aria-disabled', String(value));
  formats.forEach(b => { b.disabled = value; });
  $('cancelBtn').hidden = !value;
  $('convertBtn').setAttribute('aria-busy', String(value));
}
formats.forEach(b => b.onclick = () => {
  if (state.busy) return;
  state.format = b.dataset.format;
  formats.forEach(c => { c.classList.toggle('selected', c === b); c.setAttribute('aria-pressed', String(c === b)); });
  $('formatNote').textContent = state.format === 'xml'
    ? 'XML contains file details and decoded audio properties. It is metadata, not playable audio.'
    : 'WAV is uncompressed audio. Output may be much larger than the MP3.';
});
function selectFile(file) {
  if (!file || state.busy) return;
  state.file = null; $('fileSummary').hidden = true; $('result').hidden = true;
  $('uploadZone').classList.remove('is-ready'); $('uploadTitle').textContent = '1. Drop your MP3 here';
  $('convertBtn').textContent = '3. Convert File'; $('convertBtn').disabled = true;
  if (!/\.mp3$/i.test(file.name) || !file.size || file.size > 50 * 1024 * 1024) {
    status('Choose a non-empty MP3 file no larger than 50 MB.', 'error');
    log('File rejected', 'Use an MP3 file between 1 byte and 50 MB.', '!'); return;
  }
  state.file = file; $('fileNameLabel').textContent = file.name; $('fileSizeLabel').textContent = sizeLabel(file.size);
  $('fileSummary').hidden = false; $('uploadZone').classList.add('is-ready');
  $('uploadTitle').textContent = 'MP3 selected · choose another if needed'; $('convertBtn').disabled = false;
  status('File selected. Choose an output, then convert.', 'ready'); log('File selected', `${file.name} · ${sizeLabel(file.size)}`);
}
$('fileInput').onchange = e => { selectFile(e.target.files[0]); e.target.value = ''; };
let dragDepth = 0;
['dragenter', 'dragover'].forEach(name => $('uploadZone').addEventListener(name, e => {
  e.preventDefault(); if (state.busy) return;
  if (name === 'dragenter') dragDepth++;
  $('uploadZone').classList.add('is-dragging');
}));
$('uploadZone').addEventListener('dragleave', e => {
  e.preventDefault(); if (--dragDepth <= 0) $('uploadZone').classList.remove('is-dragging');
});
$('uploadZone').addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; $('uploadZone').classList.remove('is-dragging');
  if (e.dataTransfer.files.length !== 1 && !state.busy) {
    state.file = null; $('fileSummary').hidden = true; $('result').hidden = true; $('convertBtn').disabled = true;
    status('Choose one MP3 at a time.', 'error'); return;
  }
  selectFile(e.dataTransfer.files[0]);
});
// Prevent accidental navigation when dropping a file outside the upload control.
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

async function api(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-S4H-Request': 'conversion' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error('Counter unavailable');
    return await response.json();
  } finally { clearTimeout(timer); }
}
let countVersion = 0;
function showCount(total) {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid counter response');
  $('conversionCount').textContent = `${total.toLocaleString()} ${total === 1 ? 'conversion' : 'conversions'}`;
  $('landingConversions').textContent = total.toLocaleString();
}
function showStats(data) {
  if (!Number.isSafeInteger(data.downloads) || data.downloads < 0) throw new Error('Invalid download total');
  showCount(data.total);
  $('landingDownloads').textContent = data.downloads.toLocaleString();
  $('statsStatus').textContent = 'Live · updated just now';
}
async function refreshCount() {
  const version = ++countVersion;
  try { const data = await api('/api/stats'); if (version === countVersion) showStats(data); }
  catch {
    if (version !== countVersion) return;
    $('conversionCount').textContent = 'Unavailable';
    $('landingConversions').textContent = '—'; $('landingDownloads').textContent = '—';
    $('statsStatus').textContent = 'Stats temporarily unavailable';
  }
}
function refreshVisibleStats() {
  if (!document.hidden && (location.pathname === '/' || location.pathname.startsWith('/app'))) refreshCount();
}
setInterval(refreshVisibleStats, 15000);
document.addEventListener('visibilitychange', refreshVisibleStats);
window.addEventListener('online', refreshVisibleStats);
async function recordDownload(item) {
  // Both download links share the same output record and completion token.
  // Wait for completion acknowledgement if the user clicks as the output appears.
  if (!await item.completion || !item.token) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await api('/api/download', { token: item.token });
      ++countVersion; showStats(data); return;
    } catch { /* A retry uses the same token, never a second increment. */ }
  }
}
async function recordCompletion(token) {
  if (!token) {
    $('counterNote').textContent = 'Export ready. Counter unavailable; this completion was not recorded.'; return false;
  }
  // Retry the SAME token once: the server acknowledges duplicates without incrementing.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await api('/api/complete', { token });
      ++countVersion; showCount(data.total);
      $('counterNote').textContent = 'Completion recorded. Counts successful WAV and XML exports across users.';
      return true;
    } catch { /* Retry without minting another token. */ }
  }
  $('counterNote').textContent = 'Export ready. Counter confirmation unavailable; your download is unaffected.';
  return false;
}
function xml(file, decoded) {
  const escape = value => String(value).replace(/[<>&"']/g, c => ({'<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;'})[c]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<audio-manifest>\n  <source>\n    <fileName>${escape(file.name)}</fileName>\n    <sizeBytes>${file.size}</sizeBytes>\n  </source>\n  <decodedAudio>\n    <durationSeconds>${decoded.duration}</durationSeconds>\n    <sampleRateHz>${decoded.sampleRate}</sampleRateHz>\n    <channels>${decoded.numberOfChannels}</channels>\n    <samplesPerChannel>${decoded.length}</samplesPerChannel>\n  </decodedAudio>\n  <exportType>metadata-only</exportType>\n</audio-manifest>\n`;
}
function wav(decoded, job) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/encoder-worker.js'); job.worker = worker;
    job.rejectWorker = reject;
    worker.onmessage = ({ data }) => { worker.terminate(); job.worker = null; data.error ? reject(new Error(data.error)) : resolve(data.blob); };
    worker.onerror = () => { worker.terminate(); job.worker = null; reject(new Error('WAV encoding failed. Try again or use a smaller file.')); };
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i).slice());
    worker.postMessage({ channels, sampleRate: decoded.sampleRate, length: decoded.length }, channels.map(c => c.buffer));
  });
}
function downloadRow(item) {
  const row = document.createElement('div'); row.className = 'download-item';
  const details = document.createElement('div'); details.className = 'download-meta';
  const name = document.createElement('strong'); name.textContent = item.name;
  const meta = document.createElement('span'); meta.textContent = `${item.format.toUpperCase()} · ${sizeLabel(item.size)} · ${item.time}`;
  const link = document.createElement('a'); link.className = 'download-link'; link.href = item.url; link.download = item.name;
  link.textContent = 'Download'; link.setAttribute('aria-label', `Download ${item.name}`);
  link.onclick = () => {
    log('Download requested', item.name, '↓');
    if (!item.downloadRequested) { item.downloadRequested = true; void recordDownload(item); }
  };
  details.append(name, meta); row.append(details, link); return row;
}
function renderDownloads() {
  $('downloadsList').replaceChildren();
  if (!state.downloads.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    empty.innerHTML = '<strong>No converted files yet.</strong><p>Complete your first conversion and it will appear here.</p>';
    $('downloadsList').append(empty);
  } else state.downloads.forEach(item => $('downloadsList').append(downloadRow(item)));
}
$('cancelBtn').onclick = () => {
  const job = state.job;
  if (!job || job.cancelled) return;
  job.cancelled = true;
  job.worker?.terminate(); job.rejectWorker?.(new Error('Cancelled'));
  // The browser decoder cannot be aborted. Keep controls locked until its promise settles.
  status('Cancelling… waiting for the browser to release the audio.', 'ready');
  $('cancelBtn').disabled = true;
};
async function convert() {
  if (state.busy || !state.file) return;
  const file = state.file, format = state.format;
  const job = { cancelled: false, worker: null }; state.job = job;
  let context;
  busy(true); $('cancelBtn').disabled = false; $('result').hidden = true;
  status('Reading MP3 locally…'); log('Conversion started', `Preparing ${format.toUpperCase()} output.`, '↻');
  const check = () => { if (job.cancelled) throw new Error('Cancelled'); };
  // Reserve only a random token; failed/cancelled jobs never submit it.
  const tokenPromise = api('/api/ticket', {}).then(data => data.token).catch(() => null);
  try {
    const bytes = await file.arrayBuffer(); check();
    const head = new Uint8Array(bytes);
    const id3 = head[0] === 73 && head[1] === 68 && head[2] === 51;
    const frame = head[0] === 255 && (head[1] & 0xe6) === 0xe2;
    if (!id3 && !frame) throw new Error('This file does not contain an MP3 header. Choose a genuine MP3 file.');
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) throw new Error('This browser cannot decode audio. Try a current version of Chrome, Safari or Firefox.');
    context = new Audio();
    status('Decoding MP3 in your browser…');
    let decoded;
    try { decoded = await context.decodeAudioData(bytes); }
    catch { throw new Error('The MP3 could not be decoded. It may be damaged or unsupported. Retry or choose another file.'); }
    check();
    if (!decoded.length || decoded.duration > 1200 || decoded.length * decoded.numberOfChannels * 4 > 256 * 1024 * 1024) {
      throw new Error('Decoded audio exceeds the 20-minute / 256 MB workspace limit. Choose a shorter MP3.');
    }
    log('MP3 loaded locally', `${decoded.duration.toFixed(2)} seconds · ${decoded.numberOfChannels} channel(s) · ${decoded.sampleRate} Hz`);
    status(format === 'wav' ? 'Encoding 16-bit WAV…' : 'Generating XML metadata…');
    log(format === 'wav' ? 'Converting to WAV' : 'Generating XML', 'Creating the output in browser memory.', '↻');
    const blob = format === 'wav' ? await wav(decoded, job) : new Blob([xml(file, decoded)], { type: 'application/xml' });
    check(); if (!blob.size) throw new Error('No output was generated. Please retry.');
    const item = { name: file.name.replace(/\.mp3$/i, '') + '.' + format, format, size: blob.size,
      url: URL.createObjectURL(blob), time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) };
    let resolveCompletion;
    item.completion = new Promise(resolve => { resolveCompletion = resolve; });
    state.downloads.unshift(item);
    // Bound retained browser memory. Existing saved downloads are unaffected.
    while (state.downloads.length > 1 && (state.downloads.length > 10 || state.downloads.reduce((sum, output) => sum + output.size, 0) > 128 * 1024 * 1024)) {
      URL.revokeObjectURL(state.downloads.pop().url);
    }
    renderDownloads(); $('result').replaceChildren(downloadRow(item)); $('result').hidden = false;
    status('Success — your file is ready to download.', 'success');
    log('Conversion complete', `${item.name} generated successfully.`, '✓'); log('Download ready', 'Save your output before closing or refreshing this tab.', '↓');
    // Completion is irrevocable after the output exists; cancellation is no longer offered.
    $('cancelBtn').hidden = true;
    item.token = await tokenPromise;
    resolveCompletion(await recordCompletion(item.token));
  } catch (error) {
    if (job.cancelled) { status('Conversion cancelled. No output or completion was recorded.', 'ready'); log('Conversion cancelled', 'No output generated.'); }
    else { status(error.message || 'Conversion failed. Retry or choose another MP3.', 'error'); log('Conversion failed', error.message || 'Unable to generate output.', '!'); }
  } finally {
    job.worker?.terminate();
    if (context && context.state !== 'closed') await context.close().catch(() => {});
    busy(false); state.job = null;
    if ($('conversionStatus').dataset.state === 'error') $('convertBtn').textContent = 'Retry conversion';
  }
}
$('convertBtn').onclick = convert;
window.addEventListener('beforeunload', e => {
  if (state.busy) { e.preventDefault(); e.returnValue = ''; }
});
renderDownloads(); log('Ready for file', 'Choose an MP3 to begin. Audio is processed on this device.'); route();
