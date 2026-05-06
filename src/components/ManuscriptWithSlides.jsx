import { useMemo } from 'react';
import { publicSlideImageUrl } from '../lib/sermonSlideImages';

// Render a sermon manuscript with its uploaded slide images interleaved
// inline at each <SLIDE #N – Description> marker.
//
// A marker that matches an uploaded image gets rendered as a centered
// figure (image + small caption). A marker without a matching image
// gets a dashed-border placeholder showing the marker text — so the
// pastor can see at a glance which slides still need to be uploaded.
//
// Markers are treated as block-level breaks: a marker that originally
// appeared inline in a paragraph splits the surrounding text into two
// segments with the figure between them. This is much more readable
// than trying to flow images mid-paragraph.
//
// Props:
//   text         — the manuscript text (with raw <SLIDE> markers)
//   slideImages  — array of sermon_slide_images rows
//   missingMode  — 'placeholder' (default) shows a dashed marker box
//                  when no image is matched; 'hide' silently drops the
//                  marker; 'text' just leaves the marker as plain text
const SLIDE_MARKER_RE = /<SLIDE\s+#?(\d+)\s*[-–—]\s*([^>]+)>/g;

export default function ManuscriptWithSlides({
  text,
  slideImages = [],
  missingMode = 'placeholder',
  className = 'text-base text-gray-800 font-serif leading-relaxed',
}) {
  const segments = useMemo(() => parseSegments(text || ''), [text]);

  const imageByMarker = useMemo(() => {
    const map = new Map();
    for (const img of slideImages) {
      if (img.matched_marker_number != null) {
        // First-write-wins; reconciliation enforces one image per
        // marker but we don't crash if it's violated.
        if (!map.has(img.matched_marker_number)) {
          map.set(img.matched_marker_number, img);
        }
      }
    }
    return map;
  }, [slideImages]);

  if (!text || !text.trim()) {
    return (
      <p className="text-sm text-gray-400 italic">
        No manuscript text saved for this sermon.
      </p>
    );
  }

  return (
    <div className={className}>
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          if (!seg.text) return null;
          return (
            <div key={i} className="whitespace-pre-wrap">
              {seg.text}
            </div>
          );
        }
        // 'slide'
        const img = imageByMarker.get(seg.number);
        if (!img) {
          if (missingMode === 'hide') return null;
          if (missingMode === 'text') {
            return (
              <span key={i} className="text-red-700 font-mono text-sm">
                {seg.raw}
              </span>
            );
          }
          return (
            <div key={i} className="my-3 text-center">
              <span className="inline-block rounded border-2 border-dashed border-gray-300 bg-gray-50 px-4 py-2 text-xs text-gray-500 italic">
                ⚠ &lt;SLIDE #{seg.number} – {seg.description}&gt; (no image
                uploaded)
              </span>
            </div>
          );
        }
        return (
          <figure key={i} className="my-4 text-center">
            <img
              src={publicSlideImageUrl(img.image_path)}
              alt={seg.description || `Slide ${seg.number}`}
              loading="lazy"
              className="mx-auto rounded shadow border border-gray-200"
              style={{ maxWidth: '100%', maxHeight: '400px' }}
            />
            <figcaption className="text-xs text-gray-500 mt-1">
              Slide #{seg.number} — {seg.description}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

// Split text into alternating { type: 'text', text } and
// { type: 'slide', number, description, raw } segments. Slide markers
// are pulled out as their own segments; everything else stays as text.
function parseSegments(text) {
  if (!text) return [];
  const segments = [];
  let lastIdx = 0;
  let m;
  SLIDE_MARKER_RE.lastIndex = 0;
  while ((m = SLIDE_MARKER_RE.exec(text)) !== null) {
    if (m.index > lastIdx) {
      segments.push({ type: 'text', text: text.slice(lastIdx, m.index) });
    }
    segments.push({
      type: 'slide',
      number: parseInt(m[1], 10),
      description: m[2].trim(),
      raw: m[0],
    });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIdx) });
  }
  return segments;
}
