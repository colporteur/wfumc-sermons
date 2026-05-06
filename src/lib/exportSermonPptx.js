// PowerPoint export for the Sermon Workspace.
//
// Generates a 16:9 .pptx deck from the workspace_slides rows, using
// sensible default styling for each slide_type:
//
//   title     — big centered title, smaller subtitle
//   scripture — title at top, body text large + centered, breathing room
//   quote     — italic body in soft cream background, centered
//   image     — title at top, gray placeholder rectangle with the image
//                description text inside (the pastor swaps in real
//                imagery in PowerPoint)
//   content   — title left-aligned at top, body as bullets if multiline
//                or a single block otherwise
//   blank     — empty slide (deliberate visual pause)
//
// Speaker notes go into the .pptx notes pane.
//
// Real template parsing (uploading a designed .pptx and using its
// slide masters) is intentionally not done here — pptxgenjs builds
// from scratch. The workflow we expect is: export this deck, open in
// PowerPoint, apply your standard Theme via Design → Themes. That
// re-skins fonts and colors deck-wide in one click.

import pptxgen from 'pptxgenjs';

// 16:9 wide layout dimensions in inches
const SLIDE_W = 13.333;
const SLIDE_H = 7.5;

// --- Per-type slide builders ----------------------------------------

function addTitleSlide(pres, s) {
  const slide = pres.addSlide();
  slide.background = { color: 'FFFFFF' };
  if (s.title) {
    slide.addText(s.title, {
      x: 0.5,
      y: 2.3,
      w: SLIDE_W - 1,
      h: 1.5,
      fontSize: 48,
      bold: true,
      align: 'center',
      fontFace: 'Calibri',
      color: '1A1A1A',
    });
  }
  if (s.body) {
    slide.addText(s.body, {
      x: 0.5,
      y: 4.2,
      w: SLIDE_W - 1,
      h: 1,
      fontSize: 24,
      align: 'center',
      fontFace: 'Calibri',
      color: '666666',
    });
  }
  if (s.notes) slide.addNotes(s.notes);
}

function addScriptureSlide(pres, s) {
  const slide = pres.addSlide();
  slide.background = { color: 'FFFFFF' };
  if (s.title) {
    slide.addText(s.title, {
      x: 0.5,
      y: 0.5,
      w: SLIDE_W - 1,
      h: 0.8,
      fontSize: 28,
      bold: true,
      align: 'center',
      fontFace: 'Calibri',
      color: '1A1A1A',
    });
  }
  slide.addText(s.body || '', {
    x: 1,
    y: 1.6,
    w: SLIDE_W - 2,
    h: SLIDE_H - 2.5,
    fontSize: 28,
    align: 'center',
    valign: 'middle',
    fontFace: 'Cambria',
    color: '1A1A1A',
    fit: 'shrink',
  });
  if (s.notes) slide.addNotes(s.notes);
}

function addQuoteSlide(pres, s) {
  const slide = pres.addSlide();
  slide.background = { color: 'FAF8F1' }; // soft cream
  const quoted = s.body ? `“${s.body}”` : '';
  slide.addText(quoted, {
    x: 1,
    y: 1.4,
    w: SLIDE_W - 2,
    h: SLIDE_H - 3,
    fontSize: 36,
    italic: true,
    align: 'center',
    valign: 'middle',
    fontFace: 'Cambria',
    color: '1A1A1A',
    fit: 'shrink',
  });
  if (s.title) {
    slide.addText(`— ${s.title}`, {
      x: 1,
      y: SLIDE_H - 1.4,
      w: SLIDE_W - 2,
      h: 0.6,
      fontSize: 18,
      align: 'center',
      fontFace: 'Calibri',
      color: '666666',
    });
  }
  if (s.notes) slide.addNotes(s.notes);
}

function addImageSlide(pres, s) {
  const slide = pres.addSlide();
  slide.background = { color: 'FFFFFF' };
  if (s.title) {
    slide.addText(s.title, {
      x: 0.5,
      y: 0.5,
      w: SLIDE_W - 1,
      h: 0.8,
      fontSize: 28,
      bold: true,
      align: 'center',
      fontFace: 'Calibri',
      color: '1A1A1A',
    });
  }
  // Placeholder rectangle so the pastor sees where the image goes.
  slide.addShape(pres.ShapeType.rect, {
    x: 1.5,
    y: 1.6,
    w: SLIDE_W - 3,
    h: SLIDE_H - 2.5,
    fill: { color: 'EEEEEE' },
    line: { color: 'CCCCCC', width: 1, dashType: 'dash' },
  });
  slide.addText(`[Image: ${s.body || 'placeholder'}]`, {
    x: 1.5,
    y: 1.6,
    w: SLIDE_W - 3,
    h: SLIDE_H - 2.5,
    fontSize: 16,
    italic: true,
    align: 'center',
    valign: 'middle',
    fontFace: 'Calibri',
    color: '999999',
  });
  if (s.notes) slide.addNotes(s.notes);
}

function addContentSlide(pres, s) {
  const slide = pres.addSlide();
  slide.background = { color: 'FFFFFF' };
  if (s.title) {
    slide.addText(s.title, {
      x: 0.5,
      y: 0.5,
      w: SLIDE_W - 1,
      h: 0.9,
      fontSize: 32,
      bold: true,
      align: 'left',
      fontFace: 'Calibri',
      color: '1A1A1A',
    });
  }
  if (s.body) {
    const lines = s.body.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) {
      slide.addText(
        lines.map((text) => ({ text, options: { bullet: true } })),
        {
          x: 0.7,
          y: 1.6,
          w: SLIDE_W - 1.4,
          h: SLIDE_H - 2,
          fontSize: 24,
          fontFace: 'Calibri',
          color: '1A1A1A',
          paraSpaceAfter: 8,
        }
      );
    } else {
      slide.addText(s.body, {
        x: 0.7,
        y: 1.6,
        w: SLIDE_W - 1.4,
        h: SLIDE_H - 2,
        fontSize: 24,
        align: 'left',
        valign: 'top',
        fontFace: 'Calibri',
        color: '1A1A1A',
      });
    }
  }
  if (s.notes) slide.addNotes(s.notes);
}

function addBlankSlide(pres, s) {
  const slide = pres.addSlide();
  slide.background = { color: 'FFFFFF' };
  if (s.notes) slide.addNotes(s.notes);
}

const TYPE_DISPATCH = {
  title: addTitleSlide,
  scripture: addScriptureSlide,
  quote: addQuoteSlide,
  image: addImageSlide,
  content: addContentSlide,
  blank: addBlankSlide,
};

// --- Public entry ----------------------------------------------------

// Build a deck and trigger a browser download. Returns the filename.
//
// Options:
//   sermon - the sermon row (used for filename + presentation metadata)
//   slides - array of workspace_slides rows in the order they should
//            appear in the deck
export async function downloadSermonPptx({ sermon, slides }) {
  if (!Array.isArray(slides) || slides.length === 0) {
    throw new Error('No slides to export — add at least one slide first.');
  }

  const pres = new pptxgen();
  pres.layout = 'LAYOUT_WIDE'; // 16:9 widescreen
  pres.author = 'WFUMC Sermon Workspace';
  pres.title = sermon?.title || 'Sermon';

  for (const s of slides) {
    const builder = TYPE_DISPATCH[s.slide_type] || addContentSlide;
    builder(pres, s);
  }

  const fname = buildPptxFilename(sermon);
  await pres.writeFile({ fileName: fname });
  return fname;
}

function buildPptxFilename(sermon) {
  const titlePart = sanitize(sermon?.title || 'Sermon');
  const scripturePart = sanitize(sermon?.scripture_reference || '');
  const dateStr = new Date()
    .toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    .replace(/,/g, '');
  const datePart = sanitize(dateStr);
  const parts = [titlePart, scripturePart, datePart].filter(Boolean);
  return parts.join(' - ') + ' (slides).pptx';
}

function sanitize(s) {
  if (!s) return '';
  return s
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
