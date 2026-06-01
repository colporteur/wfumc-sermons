// Background service worker — registers context menus, handles clicks,
// fetches/processes the captured payload, and opens the popup for review.
//
// Manifest V3 service workers are short-lived; we re-register the menus
// in chrome.runtime.onInstalled and chrome.runtime.onStartup.

import { setPendingCapture } from './lib/storage.js';
import { summarizePage } from './lib/claude.js';

const MENU_TEXT = 'wfumc-capture-text';
const MENU_IMAGE = 'wfumc-capture-image';
const MENU_PAGE = 'wfumc-capture-page';
const PARENT = 'wfumc-capture-parent';

function registerMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: PARENT,
      title: 'Save to WFUMC Resources',
      contexts: ['selection', 'image', 'page', 'link'],
    });
    chrome.contextMenus.create({
      id: MENU_TEXT,
      parentId: PARENT,
      title: 'Save selected text',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU_IMAGE,
      parentId: PARENT,
      title: 'Save this image',
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: MENU_PAGE,
      parentId: PARENT,
      title: 'Summarize page with Claude',
      contexts: ['page', 'link'],
    });
  });
}

chrome.runtime.onInstalled.addListener(registerMenus);
chrome.runtime.onStartup.addListener(registerMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === MENU_TEXT) {
      await captureText(info, tab);
    } else if (info.menuItemId === MENU_IMAGE) {
      await captureImage(info, tab);
    } else if (info.menuItemId === MENU_PAGE) {
      await capturePage(info, tab);
    } else {
      return;
    }
    await openPopup();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[wfumc-capture] context menu error:', e);
    // Stash the error so the popup can show it.
    await setPendingCapture({
      kind: 'error',
      error: e.message || String(e),
      sourceUrl: tab?.url || '',
      pageTitle: tab?.title || '',
    });
    await openPopup();
  }
});

// ----- Capture handlers -----

async function captureText(info, tab) {
  await setPendingCapture({
    kind: 'text',
    content: (info.selectionText || '').trim(),
    sourceUrl: tab?.url || info.pageUrl || '',
    pageTitle: tab?.title || '',
    suggestedType: 'quote',
  });
}

async function captureImage(info, tab) {
  // info.srcUrl is the image URL. Fetch it and stash as base64 so the
  // popup can preview + upload it (the popup is in a different
  // execution context that can't access the page's DOM).
  const srcUrl = info.srcUrl;
  if (!srcUrl) throw new Error('No image URL captured.');
  const { dataUrl, mediaType, byteLength, contentHash } = await downloadAsDataUrl(srcUrl);
  await setPendingCapture({
    kind: 'image',
    content: '',
    imageDataUrl: dataUrl,
    imageMediaType: mediaType,
    imageByteLength: byteLength,
    imageContentHash: contentHash,
    imageSrcUrl: srcUrl,
    sourceUrl: tab?.url || info.pageUrl || '',
    pageTitle: tab?.title || '',
    suggestedType: 'photo',
  });
}

async function capturePage(info, tab) {
  // Pull the page's visible text via a one-shot scripting injection,
  // then ask Claude to summarize.
  const tabId = tab?.id;
  if (!tabId) throw new Error("Couldn't identify the active tab.");
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractReadablePageText,
  });
  const text = result?.text || '';
  const pageTitle = result?.title || tab?.title || '';
  if (!text.trim()) throw new Error('No readable text found on this page.');

  // Stash a placeholder first so the popup can open and show "Summarizing…"
  // — but for simplicity we just block here and write the final payload.
  // (Background workers can keep running while the popup opens.)
  let summary = '';
  try {
    summary = await summarizePage({
      text,
      url: tab?.url || info.pageUrl || '',
      title: pageTitle,
    });
  } catch (e) {
    // Surface the Claude error in the popup but still let the user
    // edit/save with the raw extracted text as a fallback.
    summary = `[Claude summary failed: ${e.message}]\n\n${text.slice(0, 1500)}…`;
  }

  await setPendingCapture({
    kind: 'page_summary',
    content: summary,
    sourceUrl: tab?.url || info.pageUrl || '',
    pageTitle,
    suggestedType: 'note',
  });
}

// ----- Page text extraction (runs in the page context) -----
//
// Crude but effective: clones <body>, strips scripts/styles/nav/aside/
// header/footer/forms, and returns the resulting innerText. Anything
// fancier (Readability.js et al.) costs bundle size we'd rather avoid.
function extractReadablePageText() {
  const doc = document.cloneNode(true);
  const drop = [
    'script', 'style', 'noscript', 'svg', 'iframe', 'video', 'audio',
    'nav', 'aside', 'header', 'footer', 'form', 'button',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  ];
  for (const sel of drop) {
    for (const el of doc.querySelectorAll(sel)) el.remove();
  }
  const body = doc.body;
  if (!body) return { text: '', title: document.title || '' };
  const text = (body.innerText || body.textContent || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, title: document.title || '' };
}

// ----- Image fetch helper -----

async function downloadAsDataUrl(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`Couldn't fetch image (${res.status}).`);
  const blob = await res.blob();
  const mediaType = blob.type || 'image/jpeg';
  const byteLength = blob.size;
  const arrayBuf = await blob.arrayBuffer();
  const contentHash = await sha256Hex(arrayBuf);
  const dataUrl = await blobToDataUrl(blob);
  return { dataUrl, mediaType, byteLength, contentHash };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ----- Open popup as a small standalone window -----
//
// chrome.action.openPopup() doesn't reliably work from a context menu
// click outside the toolbar. Instead, open popup.html in a small
// detached window — a familiar pattern for capture extensions.
async function openPopup() {
  const url = chrome.runtime.getURL('popup/popup.html');
  await chrome.windows.create({
    url,
    type: 'popup',
    width: 540,
    height: 720,
    focused: true,
  });
}
