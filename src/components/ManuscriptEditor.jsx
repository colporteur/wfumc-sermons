import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Manuscript editor with an optional pixel-aligned paragraph-number
// gutter. The numbers live in a separate <div> with `user-select:
// none`, so they're invisible to copy/paste, the Word/PowerPoint
// exporters, and the slide-anchoring logic — those still see exactly
// the plain manuscript text the textarea holds.
//
// How the alignment works:
//   1. A hidden "mirror" <div> is given identical styles to the
//      textarea (font, line-height, padding, width).
//   2. Each blank-line-separated paragraph becomes a <span> in the
//      mirror, with the same wrap behaviour the textarea uses.
//   3. After layout, span.offsetTop is the Y of that paragraph inside
//      the textarea — we render gutter numbers at those same Y values.
//   4. The gutter's inner div is translated by -scrollTop to scroll-
//      sync with the textarea.
//
// Cursor → current paragraph: counted by walking blank-line boundaries
// before the cursor position; the matching gutter number is highlighted.
//
// Props mirror what a plain <textarea> takes plus a className override.
export default function ManuscriptEditor({
  value,
  onChange,
  readOnly = false,
  placeholder,
  textareaClassName = '',
  textareaStyle = {},
  showNumbers,
  onToggleNumbers,
  onCurrentParagraphChange,
}) {
  const taRef = useRef(null);
  const mirrorRef = useRef(null);
  const gutterRef = useRef(null);

  // [{ idx, top }] — top is the Y in textarea-content coordinates.
  const [paragraphPositions, setParagraphPositions] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(-1);
  const [scrollTop, setScrollTop] = useState(0);
  // Vertical offset from the textarea's outer top to where text starts:
  // border-top + padding-top. The gutter doesn't have the same border,
  // so we need to add this when placing numbers.
  const [textTopOffset, setTextTopOffset] = useState(0);

  // Re-measure paragraph positions after every text change OR when the
  // gutter is freshly toggled on. useLayoutEffect so we measure before
  // the browser paints (no flicker).
  useLayoutEffect(() => {
    if (!showNumbers) return;
    const ta = taRef.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror) return;

    // Copy textarea styles onto the mirror so wrapping matches exactly.
    const cs = window.getComputedStyle(ta);
    const props = [
      'fontFamily',
      'fontSize',
      'fontWeight',
      'fontStyle',
      'fontVariant',
      'letterSpacing',
      'lineHeight',
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'borderTopWidth',
      'borderRightWidth',
      'borderBottomWidth',
      'borderLeftWidth',
      'boxSizing',
      'wordSpacing',
      'textIndent',
      'textTransform',
      'whiteSpace',
      'wordWrap',
      'overflowWrap',
      'tabSize',
    ];
    for (const p of props) mirror.style[p] = cs[p];
    // Force textarea-style wrapping.
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflowWrap = 'break-word';
    mirror.style.width = ta.clientWidth + 'px';

    setTextTopOffset(
      (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.borderTopWidth) || 0)
    );

    // Walk the text, splitting on blank-line boundaries the same way
    // splitManuscriptParagraphs does, BUT preserving every character so
    // wrapping matches the textarea byte-for-byte.
    const text = value || '';
    mirror.innerHTML = '';
    const positions = [];
    const blankLineRe = /\n[ \t]*\n+/g;
    let lastEnd = 0;
    let pIdx = 0;
    let m;
    const appendSegment = (segText, isParagraph) => {
      const span = document.createElement('span');
      // Empty paragraphs would have zero height; insert a zero-width
      // joiner so offsetTop still reports a sensible Y.
      span.textContent = segText.length === 0 ? '​' : segText;
      if (isParagraph && segText.trim().length > 0) {
        positions.push({ idx: pIdx, span });
        pIdx++;
      }
      mirror.appendChild(span);
    };
    while ((m = blankLineRe.exec(text)) !== null) {
      appendSegment(text.slice(lastEnd, m.index), true);
      appendSegment(m[0], false);
      lastEnd = m.index + m[0].length;
    }
    if (lastEnd <= text.length) {
      appendSegment(text.slice(lastEnd), true);
    }

    // Measure. offsetTop is from the mirror's content-edge (padding-edge),
    // so it's the same Y the matching text occupies inside the textarea
    // (relative to the textarea's content-edge).
    const measured = positions.map((p) => ({
      idx: p.idx,
      top: p.span.offsetTop,
    }));
    setParagraphPositions(measured);
  }, [value, showNumbers]);

  // Re-measure on textarea resize (panel layout shift, window resize).
  useEffect(() => {
    if (!showNumbers) return undefined;
    const ta = taRef.current;
    if (!ta) return undefined;
    const ro = new ResizeObserver(() => {
      // Trigger the layout effect by nudging the value-keyed re-render.
      // Using a forceUpdate-style state set is overkill; bumping
      // scrollTop to itself is a no-op so we just call the measurement
      // logic directly via a microtask.
      Promise.resolve().then(() => {
        if (!mirrorRef.current || !ta) return;
        mirrorRef.current.style.width = ta.clientWidth + 'px';
        // Re-measure existing spans.
        const spans = mirrorRef.current.querySelectorAll('span');
        const measured = [];
        let pIdx = 0;
        for (const span of spans) {
          if (span.textContent && span.textContent.trim().length > 0) {
            measured.push({ idx: pIdx, top: span.offsetTop });
            pIdx++;
          }
        }
        setParagraphPositions(measured);
      });
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [showNumbers]);

  // Cursor → current paragraph index. Count blank-line breaks before
  // the cursor, matching splitManuscriptParagraphs' boundary logic.
  const recomputeCurrent = () => {
    const ta = taRef.current;
    if (!ta) return;
    const pos = ta.selectionStart || 0;
    const text = value || '';
    // Count *paragraph blocks* that start before `pos`. A paragraph
    // block is a non-empty run of text separated by /\n[ \t]*\n+/.
    // We walk the same regex but only count blocks whose start <= pos.
    let idx = -1;
    const blankLineRe = /\n[ \t]*\n+/g;
    let lastEnd = 0;
    let pIdx = 0;
    let m;
    while ((m = blankLineRe.exec(text)) !== null) {
      const segText = text.slice(lastEnd, m.index);
      if (segText.trim().length > 0) {
        if (lastEnd <= pos && pos <= m.index) {
          idx = pIdx;
          break;
        }
        pIdx++;
      }
      lastEnd = m.index + m[0].length;
    }
    if (idx === -1) {
      const tail = text.slice(lastEnd);
      if (tail.trim().length > 0 && pos >= lastEnd) {
        idx = pIdx;
      }
    }
    setCurrentIdx(idx);
    if (typeof onCurrentParagraphChange === 'function') {
      onCurrentParagraphChange(idx);
    }
  };

  const handleScroll = () => {
    if (taRef.current) setScrollTop(taRef.current.scrollTop);
  };

  return (
    <div
      className="relative flex flex-1 min-h-0"
      style={textareaStyle}
    >
      {showNumbers && (
        <div
          ref={gutterRef}
          aria-hidden="true"
          className="select-none flex-shrink-0 text-right pr-2 border-r border-gray-200 bg-gray-50 overflow-hidden relative"
          style={{ width: '3rem' }}
        >
          {/* Inner div is shifted by scrollTop so the numbers move with the textarea text. */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${-scrollTop}px)`,
              willChange: 'transform',
            }}
          >
            {paragraphPositions.map((p) => {
              const isCurrent = p.idx === currentIdx;
              return (
                <div
                  key={p.idx}
                  style={{
                    position: 'absolute',
                    top: textTopOffset + p.top,
                    right: '0.5rem',
                    fontSize: '10px',
                    lineHeight: 1.2,
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, monospace',
                  }}
                  className={
                    isCurrent
                      ? 'text-umc-800 font-bold'
                      : 'text-gray-400'
                  }
                  title={`Paragraph ${p.idx + 1}`}
                >
                  ¶{p.idx + 1}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => {
          if (typeof onChange === 'function') onChange(e);
        }}
        onScroll={handleScroll}
        onSelect={recomputeCurrent}
        onKeyUp={recomputeCurrent}
        onClick={recomputeCurrent}
        onFocus={recomputeCurrent}
        readOnly={readOnly}
        placeholder={placeholder}
        className={textareaClassName}
        style={{ resize: 'none', flex: 1 }}
      />

      {/* Hidden mirror — used only for measurement. Off-screen so it
          doesn't take layout space. */}
      <div
        ref={mirrorRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          left: -99999,
          visibility: 'hidden',
          pointerEvents: 'none',
          whiteSpace: 'pre-wrap',
          wordWrap: 'break-word',
          overflowWrap: 'break-word',
        }}
      />
    </div>
  );
}

// Convenience: a labeled checkbox the parent can drop into the editor's
// header row. Kept here so the editor and its toggle stay paired.
export function ParagraphNumberToggle({ checked, onChange, currentIdx, total }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-gray-300"
      />
      <span>Show ¶ numbers</span>
      {checked && total > 0 && (
        <span className="text-gray-400">
          {currentIdx >= 0 ? `(at ¶${currentIdx + 1} of ${total})` : `(${total} total)`}
        </span>
      )}
    </label>
  );
}
