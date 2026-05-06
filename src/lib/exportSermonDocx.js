// Generate a styled .docx file from a sermon manuscript using the
// pastor's print preferences. Recognizes the inline manuscript markers
// described in MANUSCRIPT_MARKERS (lib/printPreferences.js) and applies
// the documented colors / highlights / alignment automatically:
//
//   - "Don't Read Scripture First"  → centered, bold red on green
//   - "Read [Reference]"            → left-aligned, bold red on green
//   - <SLIDE #N – Description>      → bold red on yellow (inline OK)
//   - Body text                     → regular weight
//
// Headers and footers come from the user's print_preferences row with
// {title} / {scripture} / {date} / {church} / {page} token substitution.

import {
  Document,
  Paragraph,
  TextRun,
  Header,
  Footer,
  PageNumber,
  AlignmentType,
  LineRuleType,
  convertInchesToTwip,
  Packer,
} from 'docx';
import { loadPrintPrefs, renderTokens, DEFAULT_PRINT_PREFS } from './printPreferences';

// --- Marker detection ------------------------------------------------

// "Don't Read Scripture First" marker (smart-quote tolerant).
function isDontReadScriptureFirst(line) {
  const cleaned = line.trim().replace(/[‘’]/g, "'");
  return /^don'?t\s+read\s+scripture\s+first\.?$/i.test(cleaned);
}

// "Read [Scripture Reference]" marker — must be the whole line and the
// remainder must look like a scripture reference (must contain a digit
// so we don't catch "Read carefully" or similar prose).
function readReferenceMatch(line) {
  const trimmed = line.trim();
  const m = trimmed.match(/^Read\s+(.+?)\.?$/i);
  if (!m) return null;
  const ref = m[1].trim();
  if (!/\d/.test(ref)) return null;
  if (ref.length > 100) return null;
  return ref;
}

// Slide marker: <SLIDE #N – Description>. Allows hyphen, en-dash, em-dash.
const SLIDE_RE = /<SLIDE\s+#?\d+\s*[-–—]\s*[^>]+>/g;

function splitInlineSlideMarkers(text) {
  const segments = [];
  let lastIdx = 0;
  let m;
  SLIDE_RE.lastIndex = 0;
  while ((m = SLIDE_RE.exec(text)) !== null) {
    if (m.index > lastIdx) {
      segments.push({ kind: 'text', text: text.slice(lastIdx, m.index) });
    }
    segments.push({ kind: 'slide_marker', text: m[0] });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    segments.push({ kind: 'text', text: text.slice(lastIdx) });
  }
  return segments;
}

// --- Builders --------------------------------------------------------

// Convert print_pref alignment string to docx AlignmentType.
function toAlignment(s) {
  switch (s) {
    case 'center':
      return AlignmentType.CENTER;
    case 'right':
      return AlignmentType.RIGHT;
    default:
      return AlignmentType.LEFT;
  }
}

// docx line-spacing value: in 240ths of a unit, AUTO rule means "lines"
// so 1.5 = 360, 2.0 = 480, etc. We also add a fixed AFTER-paragraph
// gap of 240 twentieths (= 12pt = ~one extra single-spaced line), so
// paragraphs visibly separate instead of running into each other —
// pulpit-friendly when the manuscript is otherwise dense.
const AFTER_PARAGRAPH_TWIPS = 240;

function spacingFromPrefs(prefs) {
  return {
    line: Math.round((prefs.line_spacing || 1.5) * 240),
    lineRule: LineRuleType.AUTO,
    after: AFTER_PARAGRAPH_TWIPS,
  };
}

// Build the one-line title block at the top of the body when
// print_prefs.title_in_body = true. The pastor turns this off when the
// title lives in the Word header instead.
function buildTitleBlock(sermon, prefs) {
  const out = [];
  if (!prefs.title_in_body) return out;
  if (sermon?.title) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [
          new TextRun({
            text: sermon.title,
            bold: true,
            font: prefs.font_family,
            size: Math.round(prefs.font_size_pt * 1.4 * 2),
          }),
        ],
      })
    );
  }
  if (prefs.show_scripture_reference && sermon?.scripture_reference) {
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [
          new TextRun({
            text: sermon.scripture_reference,
            italics: true,
            color: '555555',
            font: prefs.font_family,
            size: Math.round(prefs.font_size_pt * 0.95 * 2),
          }),
        ],
      })
    );
  }
  return out;
}

function buildBodyParagraphs(manuscript, prefs) {
  const fontSize = prefs.font_size_pt * 2; // half-points
  const fontFamily = prefs.font_family;
  const spacing = spacingFromPrefs(prefs);

  const out = [];
  const blocks = (manuscript || '')
    .split(/\n[ \t]*\n+/)
    .map((b) => b.replace(/\s+$/g, ''))
    .filter((b) => b.trim());

  for (const block of blocks) {
    // Special markers that own a whole paragraph
    if (isDontReadScriptureFirst(block)) {
      out.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing,
          children: [
            new TextRun({
              text: block.trim(),
              bold: true,
              color: 'EE0000',
              highlight: 'green',
              font: fontFamily,
              size: fontSize,
            }),
          ],
        })
      );
      continue;
    }

    const readRef = readReferenceMatch(block);
    if (readRef !== null) {
      out.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing,
          children: [
            new TextRun({
              text: block.trim(),
              bold: true,
              color: 'EE0000',
              highlight: 'green',
              font: fontFamily,
              size: fontSize,
            }),
          ],
        })
      );
      continue;
    }

    // Body paragraph — split by inline slide markers so each marker gets
    // its own colored/highlighted run while surrounding prose stays plain.
    const segments = splitInlineSlideMarkers(block);
    const runs = segments.map((seg) =>
      seg.kind === 'slide_marker'
        ? new TextRun({
            text: seg.text,
            bold: true,
            color: 'FF0000',
            highlight: 'yellow',
            font: fontFamily,
            size: fontSize,
          })
        : new TextRun({
            text: seg.text,
            font: fontFamily,
            size: fontSize,
          })
    );
    out.push(
      new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing,
        children: runs,
      })
    );
  }

  return out;
}

function buildHeader(prefs, ctx) {
  const text = renderTokens(prefs.header_content, ctx);
  if (!text) {
    return new Header({ children: [new Paragraph({ children: [] })] });
  }
  return new Header({
    children: [
      new Paragraph({
        alignment: toAlignment(prefs.header_alignment),
        children: [
          new TextRun({
            text,
            italics: !!prefs.header_italic,
            font: prefs.font_family,
            size: (prefs.header_size_pt || 12) * 2,
          }),
        ],
      }),
    ],
  });
}

function buildFooter(prefs, ctx) {
  const paragraphs = [];

  const text = renderTokens(prefs.footer_content, ctx);
  if (text) {
    paragraphs.push(
      new Paragraph({
        alignment: toAlignment(prefs.footer_alignment),
        children: [
          new TextRun({
            text,
            italics: !!prefs.footer_italic,
            font: prefs.font_family,
            size: (prefs.footer_size_pt || 12) * 2,
          }),
        ],
      })
    );
  }

  // Page number paragraph, if requested AND the position is in the bottom
  // half. Top-half positions get rendered into the header instead — but
  // the standard pulpit-manuscript style is bottom_center, so this is
  // the common path. (Top positions are a follow-up.)
  const pos = prefs.page_number_position;
  if (pos && pos !== 'none' && pos.startsWith('bottom_')) {
    const alignment = pos.endsWith('left')
      ? AlignmentType.LEFT
      : pos.endsWith('right')
      ? AlignmentType.RIGHT
      : AlignmentType.CENTER;
    paragraphs.push(
      new Paragraph({
        alignment,
        children: [
          new TextRun({
            font: prefs.font_family,
            size: (prefs.footer_size_pt || 12) * 2,
            italics: !!prefs.footer_italic,
            children: [PageNumber.CURRENT],
          }),
        ],
      })
    );
  }

  if (paragraphs.length === 0) {
    paragraphs.push(new Paragraph({ children: [] }));
  }
  return new Footer({ children: paragraphs });
}

// --- Public entry ----------------------------------------------------

// Generate the .docx blob for a sermon. Doesn't trigger a download —
// the caller does that so it can also handle errors / loading states.
//
// Options:
//   userId           - required, used to load print prefs
//   sermon           - required, the sermon row (title, scripture_reference, manuscript_text)
//   manuscriptText   - optional override; defaults to sermon.manuscript_text
//   dateOverride     - optional ISO date string for the {date} token
//   churchOverride   - optional string for the {church} token
//   prefsOverride    - optional partial print_prefs object to layer on top
export async function buildSermonDocx({
  userId,
  sermon,
  manuscriptText,
  dateOverride,
  churchOverride,
  prefsOverride,
}) {
  if (!sermon) throw new Error('No sermon to export.');
  const text = manuscriptText ?? sermon.manuscript_text ?? '';
  if (!text.trim()) {
    throw new Error('This sermon has no manuscript text to export.');
  }

  const basePrefs = await loadPrintPrefs(userId);
  const prefs = { ...DEFAULT_PRINT_PREFS, ...basePrefs, ...(prefsOverride || {}) };

  // Tokens for header / footer substitution.
  const ctx = {
    title: sermon.title || '',
    scripture: sermon.scripture_reference || '',
    date:
      dateOverride ||
      formatDateForFooter(prefs.default_date_format, new Date()),
    church: churchOverride || prefs.default_church_name || '',
  };

  const header = buildHeader(prefs, ctx);
  const footer = buildFooter(prefs, ctx);
  const titleBlock = buildTitleBlock(sermon, prefs);
  const body = buildBodyParagraphs(text, prefs);

  const doc = new Document({
    creator: 'WFUMC Sermon Workspace',
    title: sermon.title || 'Sermon',
    styles: {
      default: {
        document: {
          run: {
            font: prefs.font_family,
            size: prefs.font_size_pt * 2,
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: convertInchesToTwip(8.5),
              height: convertInchesToTwip(11),
            },
            margin: {
              top: convertInchesToTwip(prefs.margin_top_in),
              bottom: convertInchesToTwip(prefs.margin_bottom_in),
              left: convertInchesToTwip(prefs.margin_left_in),
              right: convertInchesToTwip(prefs.margin_right_in),
            },
          },
        },
        headers: { default: header },
        footers: { default: footer },
        children: [...titleBlock, ...body],
      },
    ],
  });

  return Packer.toBlob(doc);
}

// Produce a sane-looking date string for the footer token. Doesn't try
// to be locale-aware — manuscripts get printed for the pastor, not
// internationalized.
function formatDateForFooter(_unused, dateObj) {
  return dateObj.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// Sanitize a sermon title into a safe filename component.
export function safeFilename(title) {
  if (!title) return 'sermon';
  return title
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'sermon';
}

// Format a date-ish input as "Month Day Year" (e.g. "April 29 2026")
// without commas, suitable for the filename. Accepts ISO strings, the
// already-formatted "April 29, 2026" we get from the modal, or Date
// objects; anything unparseable falls back to today.
function dateForFilename(input) {
  let d;
  if (input instanceof Date) {
    d = input;
  } else if (typeof input === 'string' && input.trim()) {
    // Try ISO first; fall back to Date.parse on the formatted string.
    const isoLike = input.match(/^\d{4}-\d{2}-\d{2}/);
    d = isoLike
      ? new Date(input + (input.length === 10 ? 'T00:00:00' : ''))
      : new Date(input);
  } else {
    d = new Date();
  }
  if (isNaN(d.getTime())) d = new Date();
  return d
    .toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    .replace(/,/g, '');
}

// One-shot helper: build the docx + trigger a browser download. Called
// from the export modal.
//
// Filename format:
//   {Sermon Title} - {Scripture} - {Month Day Year} - {Location}.docx
// Components are sanitized; empty ones are dropped from the filename.
export async function downloadSermonDocx(opts) {
  const blob = await buildSermonDocx(opts);

  const titlePart = safeFilename(opts.sermon?.title);
  const scripturePart = safeFilename(opts.sermon?.scripture_reference || '');
  const datePart = safeFilename(dateForFilename(opts.dateOverride));
  const locationPart = safeFilename(opts.churchOverride || '');
  const parts = [titlePart, scripturePart, datePart, locationPart].filter(
    Boolean
  );
  const fname = parts.join(' - ') + '.docx';

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return fname;
}
