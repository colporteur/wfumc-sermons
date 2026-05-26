// PowerPoint export for the Sermon Workspace.
//
// Generates a 16:9 .pptx deck from the workspace_slides rows. Styling
// rules (pastor's standing preferences as of Phase F):
//
//   - Albertus Medium throughout. PowerPoint substitutes if a viewer's
//     machine doesn't have it installed.
//   - Default 54pt body text, autoshrunk to fit (fit: 'shrink') so
//     short text stays at 54pt but long passages scale down rather
//     than overflowing the slide.
//   - Left-justified, single-spaced (paraSpaceAfter: 0).
//   - NO bullets — even multi-line bodies render as continuous prose
//     with line breaks. The pastor wants the visual cleanliness of
//     unornamented text.
//
// One exception to the left-justified rule: attribution lines
// (scripture references on scripture slides, source attributions on
// quote slides) render right-justified, smaller, with an em-dash
// prefix at the bottom of the slide. That visual treatment marks
// them as secondary to the body content.
//
// Per slide type:
//
//   title     — title (54pt bold) + optional subtitle (32pt), both
//                left-aligned. Sermon title page.
//   scripture — scripture text fills the slide (54pt, left, shrink).
//                Reference (from s.title) appears bottom-right with
//                em-dash prefix.
//   quote     — quote body (54pt italic, left, shrink) on a soft
//                cream background. Source (from s.title) appears
//                bottom-right with em-dash prefix.
//   image     — title at top (left-aligned) + gray placeholder
//                rectangle for the image. Pastor swaps in real
//                imagery inside PowerPoint.
//   content   — title (54pt bold, left) + body (54pt, left, shrink,
//                NO bullets, paragraph breaks preserved).
//   blank     — empty slide (deliberate visual pause).
//
// Speaker notes go into the .pptx notes pane.

import pptxgen from 'pptxgenjs';

// 16:9 wide layout dimensions in inches
const SLIDE_W = 13.333;
const SLIDE_H = 7.5;

// Default font face for all slide text. Pastor's chosen face — used
// across his manuscripts and bulletin headers too. PowerPoint
// substitutes if the viewer's machine doesn't have it.
const SLIDE_FONT = 'Albertus Medium';

// Body text default. fit:'shrink' takes care of long-text overflow —
// short text actually renders at this size, longer text gets autoshrunk.
const BODY_FONT_SIZE = 54;

// Attribution lines (scripture refs, quote sources) are intentionally
// smaller so the eye reads them as secondary to the body content.
const ATTRIBUTION_FONT_SIZE = 28;

// Subtitle / supporting text on title slides.
const SUBTITLE_FONT_SIZE = 32;

// Standard left/right margins so all slide types align visually.
const MARGIN_X = 0.7;
// Vertical space reserved at the bottom of scripture/quote slides for
// the attribution line.
const ATTRIBUTION_BAND_H = 1.0;

// Common text-box options shared across most slide bodies. Spread
// these into a slide.addText call and override per-type as needed.
const BODY_BASE = {
  fontSize: BODY_FONT_SIZE,
  fontFace: SLIDE_FONT,
  color: '1A1A1A',
  align: 'left',
  valign: 'top',
  fit: 'shrink',
  paraSpaceAfter: 0,
};

const ATTRIBUTION_BASE = {
  fontSize: ATTRIBUTION_FONT_SIZE,
  fontFace: SLIDE_FONT,
  color: '1A1A1A',
  align: 'right',
  valign: 'bottom',
  paraSpaceAfter: 0,
};

// --- Per-type slide builders ----------------------------------------

function addTitleSlide(pres, s) {
  const slide = pres.addSlide();
  slide.background = { color: 'FFFFFF' };
  if (s.title) {
    slide.addText(s.title, {
      ...BODY_BASE,
      x: MARGIN_X,
      y: 2.3,
      w: SLIDE_W - MARGIN_X * 2,
      h: 2.4,
      bold: true,
    });
  }
  if (s.body) {
    slide.addText(s.body, {
      ...BODY_BASE,
      x: MARGIN_X,
      y: 4.8,
      w: SLIDE_W - MARGIN_X * 2,
      h: 1.5,
      fontSize: SUBTITLE_FONT_SIZE,
      color: '666666',
    });
  }
  if (s.notes) slide.addNotes(s.notes);
}

function addScriptureSlide(pres, s) {
  const slide = pres.addSlide();
  slide.background = { color: 'FFFFFF' };
  // Scripture text fills the body area, left-aligned, autoshrunk.
  slide.addText(s.body || '', {
    ...BODY_BASE,
    x: MARGIN_X,
    y: 0.5,
    w: SLIDE_W - MARGIN_X * 2,
    h: SLIDE_H - 0.5 - ATTRIBUTION_BAND_H - 0.2,
  });
  // Reference (e.g., "Acts 17:22-31") sits bottom-right with em-dash.
  if (s.title) {
    slide.addText(`— ${s.title}`, {
      ...ATTRIBUTION_BASE,
      x: MARGIN_X,
      y: SLIDE_H - ATTRIBUTION_BAND_H,
      w: SLIDE_W - MARGIN_X * 2,
      h: ATTRIBUTION_BAND_H - 0.2,
    });
  }
  if (s.notes) slide.addNotes(s.notes);
}

function addQuoteSlide(pres, s) {
  const slide = pres.addSlide();
  slide.background = { color: 'FAF8F1' }; // soft cream
  // Italic quote body with curly quote marks (preserved from prior
  // design — keeps quote slides visually distinct from plain content).
  const quoted = s.body ? `“${s.body}”` : '';
  slide.addText(quoted, {
    ...BODY_BASE,
    x: MARGIN_X,
    y: 0.5,
    w: SLIDE_W - MARGIN_X * 2,
    h: SLIDE_H - 0.5 - ATTRIBUTION_BAND_H - 0.2,
    italic: true,
  });
  // Source attribution: bottom-right, em-dash prefixed.
  if (s.title) {
    slide.addText(`— ${s.title}`, {
      ...ATTRIBUTION_BASE,
      x: MARGIN_X,
      y: SLIDE_H - ATTRIBUTION_BAND_H,
      w: SLIDE_W - MARGIN_X * 2,
      h: ATTRIBUTION_BAND_H - 0.2,
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
      ...BODY_BASE,
      x: MARGIN_X,
      y: 0.5,
      w: SLIDE_W - MARGIN_X * 2,
      h: 0.9,
      bold: true,
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
    fontFace: SLIDE_FONT,
    color: '999999',
  });
  if (s.notes) slide.addNotes(s.notes);
}

function addContentSlide(pres, s) {
  const slide = pres.addSlide();
  slide.background = { color: 'FFFFFF' };
  const hasTitle = Boolean(s.title);
  // Title sits at the top; body fills the rest. If there's no title,
  // body uses the full slide area so short content can scale up bigger.
  const titleH = 1.1;
  const bodyY = hasTitle ? 1.6 : 0.5;
  const bodyH = SLIDE_H - bodyY - 0.4;
  if (hasTitle) {
    slide.addText(s.title, {
      ...BODY_BASE,
      x: MARGIN_X,
      y: 0.5,
      w: SLIDE_W - MARGIN_X * 2,
      h: titleH,
      bold: true,
    });
  }
  if (s.body) {
    // Single addText call regardless of whether the body has paragraph
    // breaks — pptxgenjs preserves newlines in the text and renders
    // them as paragraph breaks within the box. No bullets, ever.
    slide.addText(s.body, {
      ...BODY_BASE,
      x: MARGIN_X,
      y: bodyY,
      w: SLIDE_W - MARGIN_X * 2,
      h: bodyH,
    });
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
  return parts.join(' - ') + ' - SLIDES.pptx';
}

function sanitize(s) {
  if (!s) return '';
  // Replace filesystem-forbidden chars with a SPACE rather than
  // stripping. That way "Acts 17:22-31" becomes "Acts 17 22-31" — the
  // chapter and verse stay readably separated — instead of being
  // crushed together into "Acts 1722-31".
  return s
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
