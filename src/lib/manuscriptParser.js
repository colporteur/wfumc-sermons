// Manuscript parser for the batch importer. Accepts a browser File
// object and dispatches by extension:
//
//   .docx  → mammoth.convertToText
//   .enex  → reuse parseEnex (one ENEX export can hold many notes)
//   .txt / .md → read as plain text
//
// Returns one or more parsed manuscripts, each with text, content
// hash, source filename, file modified date, and any usable footer
// date extracted from the content.

// Note: mammoth is dynamically imported inside the .docx branch so it
// shares the same lazy chunk as SermonDetail/SermonNew (otherwise vite
// can't move it into a split chunk and the main bundle balloons).
import { parseEnex } from './enex';

// SHA-256 hash of normalized text. Whitespace is collapsed before
// hashing so cosmetic edits don't break dedupe.
async function contentHash(text) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const buf = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Look at the LAST ~800 chars of the manuscript text for a date that
// reads like a preached-on date. Many of Pastor Todd's sermons end
// with a footer like "Wedowee First UMC — March 12, 2023".
function extractFooterDate(text) {
  if (!text) return null;
  const tail = text.slice(-1500);
  // Try in order: ISO, M/D/YYYY, "Month D, YYYY"
  const patterns = [
    /\b(\d{4})-(\d{2})-(\d{2})\b/,
    /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(tail);
    if (m) {
      const d = new Date(m[0]);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

// Read a File as a UTF-8 string (for .enex, .txt, .md).
function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsText(file);
  });
}

// Read a File as ArrayBuffer (for .docx via mammoth).
function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsArrayBuffer(file);
  });
}

// Parse a single File. Returns an array — usually length 1, except
// for ENEX which can hold many notes per file.
//
// Each parsed entry shape:
//   {
//     filename,         // original filename (or "<source>: <note title>" for ENEX)
//     fileModifiedAt,   // ISO date from the File's lastModified
//     text,             // plain-text manuscript content
//     hash,             // SHA-256 of normalized content
//     footerDate,       // ISO date guess from end-of-document, or null
//     parseError,       // optional — set if extraction failed
//   }
export async function parseManuscriptFile(file) {
  const filename = file.name || '(unnamed)';
  const fileModifiedAt = file.lastModified
    ? new Date(file.lastModified).toISOString().slice(0, 10)
    : null;
  const lower = filename.toLowerCase();

  try {
    if (lower.endsWith('.docx')) {
      const arrayBuffer = await readAsArrayBuffer(file);
      const mammoth = (await import('mammoth')).default;
      const result = await mammoth.extractRawText({ arrayBuffer });
      const text = (result.value || '').trim();
      return [
        {
          filename,
          fileModifiedAt,
          text,
          hash: await contentHash(text),
          footerDate: extractFooterDate(text),
        },
      ];
    }
    if (lower.endsWith('.enex')) {
      const xmlText = await readAsText(file);
      const notes = await parseEnex(xmlText);
      const out = [];
      for (const note of notes) {
        const text = (note.content || '').trim();
        out.push({
          filename: `${filename}: ${note.title || '(untitled note)'}`,
          fileModifiedAt: note.createdAt
            ? new Date(note.createdAt).toISOString().slice(0, 10)
            : fileModifiedAt,
          text,
          hash: await contentHash(text),
          footerDate: extractFooterDate(text),
          // Surface the ENEX note title so the heuristics can use it
          // when the filename itself is just the bundle name.
          enexTitle: note.title || null,
        });
      }
      return out;
    }
    if (lower.endsWith('.txt') || lower.endsWith('.md')) {
      const text = (await readAsText(file)).trim();
      return [
        {
          filename,
          fileModifiedAt,
          text,
          hash: await contentHash(text),
          footerDate: extractFooterDate(text),
        },
      ];
    }
    // Unsupported extension — return a parse-error stub so the UI can
    // surface it instead of silently dropping the file.
    return [
      {
        filename,
        fileModifiedAt,
        text: '',
        hash: null,
        footerDate: null,
        parseError: `Unsupported file type. Use .docx, .enex, .txt, or .md.`,
      },
    ];
  } catch (e) {
    return [
      {
        filename,
        fileModifiedAt,
        text: '',
        hash: null,
        footerDate: null,
        parseError: e?.message || String(e),
      },
    ];
  }
}

// Convenience: parse many files in parallel.
export async function parseManuscriptFiles(files) {
  const results = await Promise.all(
    Array.from(files).map((f) => parseManuscriptFile(f))
  );
  return results.flat();
}
