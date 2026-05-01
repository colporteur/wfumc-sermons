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
 *     hasImages: boolean,       // for the preview UI
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
    const { text, hasImages } = enmlToPlainText(rawContent);

    const hash = await stableHash(`${title}\n${created || ''}\n${text.slice(0, 200)}`);

    out.push({
      title: title || '(untitled)',
      content: text,
      tags,
      sourceUrl: sourceUrl || null,
      createdAt: created,
      hash,
      hasImages,
    });
  }
  return out;
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
