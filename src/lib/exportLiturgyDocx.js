// Word doc export for a single liturgy. Parallel to exportSermonDocx
// but simpler: no markers, no print-prefs-driven headers/footers, no
// page-number tokens. Just a clean, readable order of worship.
//
// Layout:
//   Liturgy Title           (centered, large serif)
//   Date · Scripture refs   (centered, small)
//   [blank]
//   ELEMENT LABEL           (small caps, bold, dark)
//   element body            (left-aligned serif body)
//   [blank line]
//   ELEMENT LABEL
//   element body
//   …
//
// One-shot entry point:
//   await exportLiturgyDocx({ liturgy, sections, showAnnouncements })

import {
  Document,
  Paragraph,
  TextRun,
  AlignmentType,
  HeadingLevel,
  Packer,
  convertInchesToTwip,
} from 'docx';
import { getElementLabel } from './worshipElements';

function safeFilename(s) {
  return (s || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function bodyParagraphs(body) {
  const paragraphs = [];
  const text = (body || '').trim();
  if (!text) {
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({ text: '(no text)', italics: true, color: '888888' }),
        ],
      })
    );
    return paragraphs;
  }
  // Split on blank lines, preserve intra-paragraph line breaks.
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split(/\n/);
    const runs = [];
    lines.forEach((line, idx) => {
      runs.push(new TextRun({ text: line }));
      if (idx < lines.length - 1) runs.push(new TextRun({ break: 1 }));
    });
    paragraphs.push(
      new Paragraph({
        children: runs,
        spacing: { after: 120 },
      })
    );
  }
  return paragraphs;
}

function elementHeading(element) {
  const label = getElementLabel(element.section_kind);
  // If the pastor gave the element a custom title that differs from
  // the canonical label, include both.
  const customTitle =
    element.title && element.title !== label ? element.title : '';
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 80 },
    children: [
      new TextRun({
        text: label.toUpperCase(),
        bold: true,
        size: 22, // 11pt
        color: '7E2A2A', // muted UMC red
      }),
      ...(customTitle
        ? [
            new TextRun({
              text: '  — ' + customTitle,
              size: 22,
              color: '555555',
            }),
          ]
        : []),
    ],
  });
}

export async function buildLiturgyDocx({ liturgy, sections, showAnnouncements = false }) {
  const visible = (sections || []).filter(
    (s) => showAnnouncements || !s.is_announcement
  );

  // --- Title block ---
  const titleParagraph = new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 },
    children: [
      new TextRun({
        text: liturgy.title || 'Liturgy',
        bold: true,
        size: 36, // 18pt
        color: '4A1A1A',
      }),
    ],
  });

  const subParts = [];
  if (liturgy.used_at) subParts.push(liturgy.used_at);
  if (liturgy.used_location) subParts.push(liturgy.used_location);
  if (liturgy.scripture_refs) subParts.push(liturgy.scripture_refs);
  const subtitle = subParts.length
    ? new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 360 },
        children: [
          new TextRun({
            text: subParts.join('  ·  '),
            italics: true,
            size: 22,
            color: '555555',
          }),
        ],
      })
    : new Paragraph({ children: [], spacing: { after: 240 } });

  // --- Element list ---
  const elementParagraphs = [];
  for (const el of visible) {
    elementParagraphs.push(elementHeading(el));
    for (const p of bodyParagraphs(el.body)) {
      elementParagraphs.push(p);
    }
  }

  if (elementParagraphs.length === 0) {
    elementParagraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: '(No elements yet.)',
            italics: true,
            color: '888888',
          }),
        ],
      })
    );
  }

  const doc = new Document({
    creator: 'WFUMC Sermon Archive',
    title: liturgy.title || 'Liturgy',
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(0.9),
              bottom: convertInchesToTwip(0.9),
              left: convertInchesToTwip(1.0),
              right: convertInchesToTwip(1.0),
            },
          },
        },
        children: [titleParagraph, subtitle, ...elementParagraphs],
      },
    ],
  });
  return Packer.toBlob(doc);
}

/**
 * One-shot: build + trigger browser download. Filename:
 *   {Liturgy Title} - {Date} - {Scripture}.docx
 */
export async function exportLiturgyDocx(opts) {
  const blob = await buildLiturgyDocx(opts);
  const { liturgy } = opts;
  const parts = [
    safeFilename(liturgy.title || 'Liturgy'),
    safeFilename(liturgy.used_at || ''),
    safeFilename(liturgy.scripture_refs || ''),
  ].filter(Boolean);
  const fname = parts.join(' - ') + '.docx';

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return fname;
}
