// Parser for Evernote .enex export files.
//
// ENEX is XML wrapping a list of <note> elements. Each note's body lives
// in a CDATA-wrapped ENML document inside <content>. ENML is essentially
// restricted XHTML wrapped in <en-note>.
//
// We extract:
//   - title
//   - plain-text content (HTML stripped, line breaks preserved)
//   - tag list
//   - source URL
//   - created timestamp
//   - notebook (rare — usually only present if exported per-notebook)
//   - a stable hash for deduplication (since ENEX doesn't carry the
//     original Evernote note GUID by default)
//
// Images and other attachments are intentionally skipped per the
// product decision (text-only first pass).

/**
 * Parse a .enex file's text contents into an array of NoteRecord:
 *   {
 *     title: string,
 *     content: string,          // plain text
 *     tags: string[],
 *     sourceUrl: string | null,
 *     createdAt: string | null, // ISO 8601
 *     hash: string,             // stable dedupe key
 *     hasImages: boolean,       // true if any image resources found
 *     images: Array<{
 *       mime: string,
 *       fileName: string | null,
 *       blob: Blob,             // ready to upload to storage
 *       contentHash: string,    // SHA-256 of bytes for dedupe
 *     }>,
 *   }
 */
export async function parseEnex(xmlText) {
  if (!xmlText || typeof xmlText !== 'string') {
    throw new Error('No file contents to parse');
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');

  // DOMParser puts <parsererror> in the doc on bad XML.
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) {
    throw new Error(
      "That doesn't look like a valid Evernote .enex file. " +
        'Make sure you exported as ENEX (not HTML).'
    );
  }

  const noteEls = Array.from(doc.getElementsByTagName('note'));
  if (noteEls.length === 0) {
    throw new Error('No <note> elements found in this .enex file.');
  }

  const out = [];
  for (const el of noteEls) {
    const title = textContent(el, 'title');
    const created = parseEvernoteDate(textContent(el, 'created'));
    const tags = Array.from(el.getElementsByTagName('tag'))
      .map((t) => t.textContent?.trim().toLowerCase())
      .filter(Boolean);
    // <note-attributes><source-url>… (children, not nested deep)
    const attrs = el.getElementsByTagName('note-attributes')[0];
    const sourceUrl = attrs ? textContent(attrs, 'source-url') : null;

    const rawContent = el.getElementsByTagName('content')[0]?.textContent ?? '';
    const { text, hasImages: contentMentionsImages } = enmlToPlainText(rawContent);

    // Pull embedded image resources. ENEX puts them as <resource> children
    // of <note> with base64 data + mime type.
    const images = await extractImageResources(el);
    const hasImages = images.length > 0 || contentMentionsImages;

    const hash = await stableHash(`${title}\n${created || ''}\n${text.slice(0, 200)}`);

    out.push({
      title: title || '(untitled)',
      content: text,
      tags,
      sourceUrl: sourceUrl || null,
      createdAt: created,
      hash,
      hasImages,
      images,
    });
  }
  return out;
}

// Extract image attachments from a <note> element's <resource> children.
// Each <resource> looks like:
//   <resource>
//     <data encoding="base64">....</data>
//     <mime>image/jpeg</mime>
//     <resource-attributes>
//       <file-name>foo.jpg</file-name>
//     </resource-attributes>
//   </resource>
// We skip non-image MIME types (PDFs, audio) — text-image-only first pass.
async function extractImageResources(noteEl) {
  const out = [];
  const resourceEls = Array.from(noteEl.getElementsByTagName('resource'));
  for (const r of resourceEls) {
    const mime = textContent(r, 'mime') || '';
    if (!mime.toLowerCase().startsWith('image/')) continue;
    const dataEl = r.getElementsByTagName('data')[0];
    if (!dataEl) continue;
    // Strip whitespace/newlines from base64 (ENEX often line-wraps it).
    const b64 = (dataEl.textContent || '').replace(/\s+/g, '');
    if (!b64) continue;
    let bytes;
    try {
      bytes = base64ToBytes(b64);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Skipping image with bad base64:', e);
      continue;
    }
    const attrs = r.getElementsByTagName('resource-attributes')[0];
    const fileName = attrs ? textContent(attrs, 'file-name') : null;
    const blob = new Blob([bytes], { type: mime });
    const contentHash = await sha256Hex(bytes);
    out.push({
      mime,
      fileName: fileName || null,
      blob,
      contentHash,
    });
  }
  return out;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function textContent(parent, tagName) {
  const el = parent.getElementsByTagName(tagName)[0];
  return el?.textContent?.trim() || '';
}

// Evernote uses YYYYMMDDTHHMMSSZ (ISO 8601 basic). Convert to extended.
function parseEvernoteDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

// Convert ENML (restricted XHTML) to plain text. We use a DOMParser to
// walk the tree and emit text + line breaks.
function enmlToPlainText(rawEnml) {
  if (!rawEnml) return { text: '', hasImages: false };
  // ENEX content is XML inside CDATA. Wrap in a fake root in case of
  // multiple top-level nodes.
  let body = rawEnml;
  // Strip the XML declaration + DOCTYPE so DOMParser doesn't refuse.
  body = body.replace(/<\?xml[^?]*\?>/g, '');
  body = body.replace(/<!DOCTYPE[^>]*>/g, '');

  const parser = new DOMParser();
  // Parse as HTML so unknown tags don't error.
  const doc = parser.parseFromString(`<root>${body}</root>`, 'text/html');
  const root = doc.body.querySelector('root') || doc.body;

  // Detect images for the preview "had N images" badge.
  const hasImages =
    root.querySelector('en-media[type^="image"]') !== null ||
    root.querySelector('img') !== null;

  // Walk and emit. Block-level tags get a newline before; <br> emits one.
  const BLOCK = new Set([
    'p', 'div', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5',
    'h6', 'blockquote', 'pre', 'tr', 'table',
  ]);
  let buf = '';
  function walk(node) {
    if (node.nodeType === 3) {
      // Text node
      buf += node.nodeValue;
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    // Skip media elements (we're text-only)
    if (tag === 'en-media' || tag === 'img') return;
    if (BLOCK.has(tag) && buf.length > 0 && !buf.endsWith('\n')) {
      buf += '\n';
    }
    if (tag === 'li') buf += '- ';
    for (const child of node.childNodes) walk(child);
    if (BLOCK.has(tag) && !buf.endsWith('\n')) buf += '\n';
  }
  walk(root);

  // Collapse 3+ blank lines to 2; trim trailing whitespace per line.
  const text = buf
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, hasImages };
}

// SHA-256 → hex, used as a stable id for dedupe.
async function stableHash(input) {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
