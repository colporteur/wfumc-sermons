// Background documents for the Creative Studio (Phase 2).
//
// Scholarly articles, commentary snapshots, and reference images the
// pastor loads per-sermon. Three kinds (decided at upload):
//   pdf_text    — text layer extracted via pdfjs, stored on the row
//   pdf_scanned — no usable text layer; pages rendered to JPEG at turn
//                 time and sent to Claude vision
//   image       — .jpg/.png; downsized + sent to Claude vision
//
// Files live in the PRIVATE `background-docs` bucket (migration 0069):
// download goes through the authenticated storage client, never a
// public URL — commentary scans are copyrighted study material.

import { supabase, withTimeout } from './supabase';
import { extractPdfText } from './pdfText';
import { prepareImageForUpload, blobToBase64 } from './imageHelpers';
import { fetchUrlText } from './urlFetch';
import { groupDocsBySets } from './commentarySets';

const BUCKET = 'background-docs';

// A PDF whose average extracted text per page falls below this is
// treated as scanned (the "text" is usually just page numbers or OCR
// dregs) and routed to vision instead.
const SCANNED_CHARS_PER_PAGE = 200;

// Caps, chosen to keep prompt sizes and per-turn latency sane.
const EXTRACTED_TEXT_CAP = 60000; // chars stored per pdf_text doc
const PER_DOC_TEXT_PROMPT_CAP = 16000; // chars of a doc sent per turn
const MAX_VISION_PAGES_PER_DOC = 4; // scanned-PDF pages rendered per doc
// Raised from 6 → 10 for commentary sets (migration 0074): a set of
// consecutive page photos should usually fit in one turn.
const MAX_VISION_BLOCKS_PER_TURN = 10; // total images across all docs

// ---------------------------------------------------------------------
// pdfjs page rendering (scanned PDFs → JPEG blobs)
// ---------------------------------------------------------------------

// Same lazy-load pattern as lib/pdfText.js so the heavy dep only loads
// when actually needed.
let _pdfjsPromise = null;
async function getPdfjs() {
  if (_pdfjsPromise) return _pdfjsPromise;
  _pdfjsPromise = (async () => {
    const pdfjsLib = await import('pdfjs-dist');
    const workerSrc = (
      await import('pdfjs-dist/build/pdf.worker.mjs?url')
    ).default;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
    return pdfjsLib;
  })();
  return _pdfjsPromise;
}

/**
 * Render the first `maxPages` pages of a PDF blob to JPEG blobs.
 * Scale targets ~1600px on the longer side — enough for Claude to read
 * commentary type without ballooning the payload.
 */
async function renderPdfPagesToJpegs(blob, maxPages = MAX_VISION_PAGES_PER_DOC) {
  const pdfjs = await getPdfjs();
  const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() })
    .promise;
  const n = Math.min(doc.numPages, maxPages);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, 1600 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const jpeg = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Page render failed.'))),
        'image/jpeg',
        0.82
      );
    });
    out.push(jpeg);
  }
  return out;
}

// ---------------------------------------------------------------------
// CRUD + upload
// ---------------------------------------------------------------------

export async function listBackgroundDocs(sermonId) {
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_background_docs')
      // commentary_sets(title) rides along so the UI can group page
      // photos into one chip per set (see lib/commentarySets.js).
      .select('*, commentary_sets(title)')
      .eq('sermon_id', sermonId)
      .order('created_at', { ascending: false })
  );
  if (error) throw error;
  return data || [];
}

/**
 * Upload a background document (.pdf / .jpg / .jpeg / .png).
 * Classifies it, extracts text when possible, stores file + row.
 * Returns the inserted row.
 */
export async function uploadBackgroundDoc({ sermonId, ownerUserId, file, commentarySetId = null }) {
  if (!file) throw new Error('No file provided.');
  const name = file.name || 'document';
  const lower = name.toLowerCase();
  const isPdf =
    file.type === 'application/pdf' || lower.endsWith('.pdf');
  const isImage =
    /^image\/(jpeg|jpg|png)$/.test(file.type) ||
    /\.(jpe?g|png)$/.test(lower);
  const isPlainText =
    file.type === 'text/plain' ||
    file.type === 'text/markdown' ||
    /\.(txt|md)$/.test(lower);
  if (!isPdf && !isImage && !isPlainText) {
    throw new Error('Only .pdf, .jpg, .png, .txt, and .md files are supported here.');
  }

  // Plain-text files skip the bucket entirely — they become a 'text'
  // background doc (same as pasted notes), body in extracted_text.
  if (isPlainText) {
    const text = await file.text();
    return addTextBackgroundDoc({
      sermonId,
      ownerUserId,
      title: name,
      text,
    });
  }

  let kind;
  let extractedText = null;
  let pageCount = null;
  let uploadBlob = file;
  let mimeType = file.type || (isPdf ? 'application/pdf' : 'image/jpeg');

  if (isPdf) {
    // Try the text layer first.
    try {
      const res = await extractPdfText(file);
      pageCount = res.pageCount;
      const text = (res.text || '').trim();
      if (text.length >= SCANNED_CHARS_PER_PAGE * Math.max(1, res.pageCount)) {
        kind = 'pdf_text';
        extractedText =
          text.length > EXTRACTED_TEXT_CAP
            ? text.slice(0, EXTRACTED_TEXT_CAP) +
              '\n[… truncated at storage cap …]'
            : text;
      } else {
        kind = 'pdf_scanned';
      }
    } catch {
      // Broken text layer or image-only PDF — treat as scanned.
      kind = 'pdf_scanned';
    }
  } else {
    kind = 'image';
    // Downsize/re-encode images at upload so turn-time is fast and the
    // private bucket doesn't accumulate 12 MB phone photos.
    const prepared = await prepareImageForUpload(file);
    uploadBlob = prepared.blob;
    mimeType = prepared.mediaType;
  }

  const docId = crypto.randomUUID();
  const safeName = name.replace(/[^\w.\- ]+/g, '_');
  const path = `${ownerUserId}/${docId}/${safeName}`;

  const { error: upErr } = await withTimeout(
    supabase.storage.from(BUCKET).upload(path, uploadBlob, {
      contentType: mimeType,
      upsert: false,
    }),
    60000
  );
  if (upErr) throw upErr;

  const { data, error } = await withTimeout(
    supabase
      .from('sermon_background_docs')
      .insert({
        id: docId,
        sermon_id: sermonId,
        owner_user_id: ownerUserId,
        title: name,
        file_path: path,
        mime_type: mimeType,
        file_size_bytes: uploadBlob.size ?? null,
        kind,
        extracted_text: extractedText,
        page_count: pageCount,
        commentary_set_id: commentarySetId,
      })
      .select('*, commentary_sets(title)')
      .single()
  );
  if (error) {
    // Best-effort cleanup so a failed insert doesn't strand bytes.
    try {
      await supabase.storage.from(BUCKET).remove([path]);
    } catch {
      /* noop */
    }
    throw error;
  }
  return data;
}

export async function deleteBackgroundDoc(doc) {
  const { error } = await withTimeout(
    supabase.from('sermon_background_docs').delete().eq('id', doc.id)
  );
  if (error) throw error;
  if (doc.file_path) {
    try {
      await supabase.storage.from(BUCKET).remove([doc.file_path]);
    } catch {
      /* orphaned bytes are harmless; bucket is private + owner-scoped */
    }
  }
}

// ---------------------------------------------------------------------
// Storage-less kinds (Eulogy Mode / migration 0071): pasted text and
// fetched URLs. Body lives in extracted_text; no bucket object.
// ---------------------------------------------------------------------

/**
 * Save pasted material (conversation notes, memories, transcript text)
 * as a background doc of kind 'text'.
 */
export async function addTextBackgroundDoc({ sermonId, ownerUserId, title, text }) {
  const body = (text || '').trim();
  if (!body) throw new Error('Nothing to save — the pasted text is empty.');
  const capped =
    body.length > EXTRACTED_TEXT_CAP
      ? body.slice(0, EXTRACTED_TEXT_CAP) + '\n[… truncated at storage cap …]'
      : body;
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_background_docs')
      .insert({
        sermon_id: sermonId,
        owner_user_id: ownerUserId,
        title: (title || '').trim() || 'Pasted notes',
        file_path: null,
        mime_type: 'text/plain',
        file_size_bytes: capped.length,
        kind: 'text',
        extracted_text: capped,
      })
      .select('*')
      .single()
  );
  if (error) throw error;
  return data;
}

/**
 * Fetch a URL server-side (url-fetch Edge Function) and save the page
 * text as a background doc of kind 'url'. Used for obituaries and
 * tribute pages.
 */
export async function addUrlBackgroundDoc({ sermonId, ownerUserId, url }) {
  const { text, title, finalUrl } = await fetchUrlText(url);
  const body = (text || '').trim();
  if (!body) throw new Error('That page came back empty — try pasting its text instead.');
  const capped =
    body.length > EXTRACTED_TEXT_CAP
      ? body.slice(0, EXTRACTED_TEXT_CAP) + '\n[… truncated at storage cap …]'
      : body;
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_background_docs')
      .insert({
        sermon_id: sermonId,
        owner_user_id: ownerUserId,
        title: (title || '').trim() || finalUrl || url,
        file_path: null,
        mime_type: 'text/plain',
        file_size_bytes: capped.length,
        kind: 'url',
        source_url: finalUrl || url,
        extracted_text: capped,
      })
      .select('*')
      .single()
  );
  if (error) throw error;
  return data;
}

/**
 * Re-fetch a 'url' background doc (obituary / tribute wall) and update
 * the stored text. Tribute comments roll in over days — this lets the
 * pastor recheck without re-adding the source.
 *
 * Returns { row, changed, newLineCount }:
 *   changed      — whether the stored text differs from the fresh fetch
 *   newLineCount — lines present in the fresh fetch that weren't there
 *                  before (rough "new tributes" signal)
 *
 * The stored text is REPLACED with the fresh fetch (the page's current
 * state is the truth); the diff numbers are for the pastor's notice.
 */
export async function refreshUrlBackgroundDoc(doc) {
  if (doc.kind !== 'url' || !doc.source_url) {
    throw new Error('Only URL sources can be rechecked.');
  }
  const { text } = await fetchUrlText(doc.source_url);
  const fresh = (text || '').trim();
  if (!fresh) {
    throw new Error(
      'The page came back empty this time — the site may be blocking automated fetches. The previously fetched text was kept.'
    );
  }
  const capped =
    fresh.length > EXTRACTED_TEXT_CAP
      ? fresh.slice(0, EXTRACTED_TEXT_CAP) + '\n[… truncated at storage cap …]'
      : fresh;

  const old = (doc.extracted_text || '').trim();
  const changed = capped !== old;
  let newLineCount = 0;
  if (changed) {
    const oldLines = new Set(
      old.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    );
    for (const line of capped.split('\n')) {
      const t = line.trim();
      if (t.length > 0 && !oldLines.has(t)) newLineCount += 1;
    }
  }

  const { data, error } = await withTimeout(
    supabase
      .from('sermon_background_docs')
      .update({
        extracted_text: capped,
        file_size_bytes: capped.length,
      })
      .eq('id', doc.id)
      .select('*')
      .single()
  );
  if (error) throw error;
  return { row: data, changed, newLineCount };
}

async function downloadDocBlob(doc) {
  const { data, error } = await withTimeout(
    supabase.storage.from(BUCKET).download(doc.file_path),
    60000
  );
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------
// Turn-time context assembly
// ---------------------------------------------------------------------

/**
 * Build the prompt contribution for the toggled-ON background docs:
 *   - textBlock: a single string block covering pdf_text docs (and doc
 *     notes for the vision docs, so Claude knows what it's looking at)
 *   - imageBlocks: Anthropic image content blocks for image/pdf_scanned
 *     docs, capped per doc and per turn
 *
 * Vision bytes are cached on the doc objects passed in (`_visionCache`)
 * so repeated turns in a session don't re-download/re-render.
 */
export async function buildBackgroundDocsContext(docs) {
  const on = (docs || []).filter(Boolean);
  if (on.length === 0) return { textBlock: '', imageBlocks: [] };

  const textParts = [];
  const imageBlocks = [];

  // Commentary sets (migration 0074): page photos tagged with a set
  // travel as one labeled, ordered sequence; everything else renders
  // as before. Build the processing order: singles first, then each
  // set's pages in upload order under a set banner.
  const { singles, sets } = groupDocsBySets(on);
  const workList = [];
  for (const doc of singles) {
    workList.push({ doc, header: null });
  }
  for (const g of sets) {
    textParts.push(
      `## Commentary set: ${g.title} — ${g.docs.length} page${
        g.docs.length === 1 ? '' : 's'
      }, in reading order`
    );
    g.docs.forEach((doc, i) => {
      workList.push({
        doc,
        header: `### ${g.title} — page ${i + 1} of ${g.docs.length} (${doc.title})`,
      });
    });
  }

  for (const { doc, header: headerOverride } of workList) {
    const header =
      headerOverride ??
      `## Background document: ${doc.title}${
        doc.notes ? `\nPastor's note: ${doc.notes}` : ''
      }`;

    if (doc.kind === 'pdf_text' || doc.kind === 'text' || doc.kind === 'url') {
      let body = (doc.extracted_text || '').trim();
      if (body.length > PER_DOC_TEXT_PROMPT_CAP) {
        body =
          body.slice(0, PER_DOC_TEXT_PROMPT_CAP) +
          '\n[… truncated for prompt length …]';
      }
      const urlLine =
        doc.kind === 'url' && doc.source_url ? `\nSource: ${doc.source_url}` : '';
      textParts.push(header + urlLine + '\n\n' + body);
      continue;
    }

    // Vision kinds — respect the per-turn image budget.
    if (imageBlocks.length >= MAX_VISION_BLOCKS_PER_TURN) {
      textParts.push(
        header +
          '\n\n[Attached as images on earlier turns; skipped this turn — image budget reached. Toggle other docs off to include it.]'
      );
      continue;
    }

    try {
      if (!doc._visionCache) {
        const blob = await downloadDocBlob(doc);
        if (doc.kind === 'image') {
          const prepared = await prepareImageForUpload(blob);
          doc._visionCache = [
            {
              data: await blobToBase64(prepared.blob),
              media_type: prepared.mediaType,
            },
          ];
        } else {
          // pdf_scanned
          const jpegs = await renderPdfPagesToJpegs(blob);
          doc._visionCache = [];
          for (const jpeg of jpegs) {
            doc._visionCache.push({
              data: await blobToBase64(jpeg),
              media_type: 'image/jpeg',
            });
          }
        }
      }
      const room = MAX_VISION_BLOCKS_PER_TURN - imageBlocks.length;
      const used = doc._visionCache.slice(0, room);
      for (const img of used) {
        imageBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.media_type,
            data: img.data,
          },
        });
      }
      const pageNote =
        doc.kind === 'pdf_scanned'
          ? ` (${used.length} of ${doc.page_count ?? '?'} page${
              (doc.page_count ?? 2) === 1 ? '' : 's'
            } attached as images${
              doc.page_count > used.length ? ' — first pages only' : ''
            })`
          : ' (attached as an image)';
      textParts.push(header + pageNote);
    } catch (e) {
      textParts.push(
        header + `\n\n[Couldn't load this document this turn: ${e.message}]`
      );
    }
  }

  const textBlock = textParts.length
    ? '# Background documents the pastor has switched ON for this turn\n\n' +
      textParts.join('\n\n---\n\n')
    : '';
  return { textBlock, imageBlocks };
}
