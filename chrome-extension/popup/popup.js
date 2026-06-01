// Popup form: read pendingCapture, render the form, let the user
// edit + Analyze + save.
//
// Flow:
//   1. On open: fetch pendingCapture, fetch libraries (best-effort),
//      pre-fill the form.
//   2. "Analyze with Claude" button: send current content + URL to
//      Claude, fill in title/themes/scripture/tone/notes/source.
//   3. Save: insert resource; if image kind, upload + insert
//      resource_image; clear pendingCapture and close.

import {
  getPendingCapture,
  clearPendingCapture,
  getSettings,
  setSettings,
} from '../lib/storage.js';
import {
  ensureSession,
  listLibraries,
  insertResource,
  insertResourceImage,
  uploadResourceImage,
} from '../lib/supabase.js';
import { analyzeResource } from '../lib/claude.js';

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'),
  error: $('error'),
  imagePreview: $('image-preview'),
  imagePreviewImg: $('image-preview-img'),
  imageMeta: $('image-meta'),
  resource_type: $('resource_type'),
  library_id: $('library_id'),
  title: $('title'),
  content: $('content'),
  source: $('source'),
  source_url: $('source_url'),
  themes: $('themes'),
  scripture_refs: $('scripture_refs'),
  tone: $('tone'),
  notes: $('notes'),
  analyzeBtn: $('analyze-btn'),
  cancelBtn: $('cancel-btn'),
  saveBtn: $('save-btn'),
  form: $('resource-form'),
  openSettings: $('open-settings'),
};

let capture = null;

init();

async function init() {
  els.openSettings.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  els.cancelBtn.addEventListener('click', cancel);
  els.analyzeBtn.addEventListener('click', analyze);
  els.form.addEventListener('submit', save);

  capture = await getPendingCapture();

  if (capture?.kind === 'error') {
    showError(`Capture failed: ${capture.error}`);
    // Still let user open settings / cancel.
    setStatus('Nothing to save.', true);
    els.saveBtn.disabled = true;
    els.analyzeBtn.disabled = true;
    return;
  }

  if (!capture) {
    setStatus(
      'No pending capture. Right-click some text, an image, or a page to start.',
      true
    );
    els.saveBtn.disabled = true;
    els.analyzeBtn.disabled = true;
    return;
  }

  // Pre-fill form from capture
  els.resource_type.value = capture.suggestedType || 'note';
  els.content.value = capture.content || '';
  els.source_url.value = capture.sourceUrl || '';

  // Image preview
  if (capture.kind === 'image' && capture.imageDataUrl) {
    els.imagePreview.hidden = false;
    els.imagePreviewImg.src = capture.imageDataUrl;
    els.imageMeta.textContent =
      `${capture.imageMediaType || 'image'} · ${formatBytes(capture.imageByteLength)}`;
  }

  // Status line
  const kindLabel = {
    text: 'Captured selected text',
    image: 'Captured image',
    page_summary: 'Summarized page with Claude',
  }[capture.kind] || 'Capture ready';
  setStatus(`${kindLabel} — review and save.`);

  // Try to load libraries (requires sign-in)
  try {
    const session = await ensureSession();
    if (!session) {
      setStatus('Not signed in. Open settings to sign in.', true);
    } else {
      const libs = await listLibraries();
      const settings = await getSettings();
      for (const lib of libs) {
        const opt = document.createElement('option');
        opt.value = lib.id;
        opt.textContent = lib.name;
        els.library_id.appendChild(opt);
      }
      if (settings.defaultLibraryId) {
        els.library_id.value = settings.defaultLibraryId;
      }
    }
  } catch (e) {
    showError(`Couldn't load libraries: ${e.message}`);
  }
}

async function analyze() {
  hideError();
  const content = els.content.value.trim();
  if (!content && !capture?.imageDataUrl) {
    showError('Add some content first, or capture some text/image.');
    return;
  }
  els.analyzeBtn.disabled = true;
  els.analyzeBtn.textContent = 'Analyzing…';
  try {
    // For images, we send a brief description + the page context as
    // the "content". Claude vision could analyze the image directly,
    // but that would require sending the image bytes, which is more
    // complex. Caption-and-context is good enough for tagging.
    const analysisInput = content || `[Image from ${capture?.sourceUrl || 'unknown URL'}]`;
    const proposed = await analyzeResource({
      content: analysisInput,
      sourceUrl: els.source_url.value || capture?.sourceUrl,
      pageTitle: capture?.pageTitle,
      currentType: els.resource_type.value,
    });
    // Apply only fields that came back non-empty AND that are blank
    // in the form (don't clobber user edits).
    if (proposed.title && !els.title.value.trim()) {
      els.title.value = proposed.title;
    }
    if (proposed.resource_type) {
      els.resource_type.value = proposed.resource_type;
    }
    if (proposed.source && !els.source.value.trim()) {
      els.source.value = proposed.source;
    }
    if (proposed.themes?.length && !els.themes.value.trim()) {
      els.themes.value = proposed.themes.join(', ');
    }
    if (proposed.scripture_refs && !els.scripture_refs.value.trim()) {
      els.scripture_refs.value = proposed.scripture_refs;
    }
    if (proposed.tone && !els.tone.value.trim()) {
      els.tone.value = proposed.tone;
    }
    if (proposed.notes && !els.notes.value.trim()) {
      els.notes.value = proposed.notes;
    }
    setStatus('Claude analysis applied. Review and save.');
  } catch (e) {
    showError(`Analyze failed: ${e.message}`);
  } finally {
    els.analyzeBtn.disabled = false;
    els.analyzeBtn.textContent = '✨ Analyze with Claude';
  }
}

async function save(e) {
  e.preventDefault();
  hideError();
  els.saveBtn.disabled = true;
  els.saveBtn.textContent = 'Saving…';
  try {
    const session = await ensureSession();
    if (!session) {
      throw new Error('Not signed in. Open settings first.');
    }

    const themes = els.themes.value
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    const payload = {
      resource_type: els.resource_type.value,
      title: els.title.value.trim() || null,
      content: els.content.value || '',
      source: els.source.value.trim() || null,
      source_url: els.source_url.value.trim() || null,
      themes,
      scripture_refs: els.scripture_refs.value.trim() || null,
      tone: els.tone.value.trim() || null,
      notes: els.notes.value.trim() || null,
      library_id: els.library_id.value || null,
    };

    // For photo type with no content, allow empty content (DB requires
    // not-null on content; default to a placeholder). Anyone surfing
    // resources sees the image; content can be filled later.
    if (!payload.content) {
      payload.content =
        capture?.kind === 'image'
          ? `[Image] ${capture.sourceUrl || ''}`.trim()
          : '';
    }
    if (!payload.content) {
      throw new Error('Content is required.');
    }

    const resource = await insertResource(payload);

    // Image upload (if applicable)
    if (capture?.kind === 'image' && capture.imageDataUrl) {
      const blob = await dataUrlToBlob(capture.imageDataUrl);
      const ext = (capture.imageMediaType || 'image/jpeg').split('/')[1] || 'jpg';
      const filename = `capture-${Date.now()}.${ext}`;
      const path = await uploadResourceImage({
        resourceId: resource.id,
        filename,
        blob,
        contentType: capture.imageMediaType || 'image/jpeg',
      });
      await insertResourceImage({
        resourceId: resource.id,
        imagePath: path,
        contentHash: capture.imageContentHash,
      });
    }

    // Remember the library choice for next time.
    if (els.library_id.value) {
      await setSettings({ defaultLibraryId: els.library_id.value });
    }

    await clearPendingCapture();
    setStatus('Saved! Closing…');
    setTimeout(() => window.close(), 600);
  } catch (e) {
    showError(`Save failed: ${e.message}`);
    els.saveBtn.disabled = false;
    els.saveBtn.textContent = 'Save resource';
  }
}

async function cancel() {
  await clearPendingCapture();
  window.close();
}

// ----- helpers -----

function setStatus(text, warn = false) {
  els.status.textContent = text;
  els.status.classList.toggle('warn', warn);
}

function showError(msg) {
  els.error.textContent = msg;
  els.error.hidden = false;
}

function hideError() {
  els.error.hidden = true;
  els.error.textContent = '';
}

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}
