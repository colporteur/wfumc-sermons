import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import {
  DEFAULT_PRINT_PREFS,
  SERMON_MANUSCRIPT_PRESET,
  COMMON_PRINT_FONTS,
  PAGE_NUMBER_POSITIONS,
  SCRIPTURE_FORMATS,
  MANUSCRIPT_MARKERS,
  fetchPrintPrefs,
  savePrintPrefs,
  renderTokens,
} from '../lib/printPreferences';

// /settings/print — global formatting defaults the docx + pptx
// exporters will use. Two-column layout: form on the left, live
// preview of a sample manuscript page on the right (so the pastor
// can dial in font/size/spacing visually without exporting first).
//
// Per-sermon overrides happen later in a small modal at export time;
// this page just sets the default.
export default function PrintPreferences() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState(DEFAULT_PRINT_PREFS);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const row = await fetchPrintPrefs(user.id);
        if (!cancelled && row) {
          setForm({ ...DEFAULT_PRINT_PREFS, ...row });
        }
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!user?.id) return;
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const saved = await savePrintPrefs(user.id, form);
      setForm({ ...DEFAULT_PRINT_PREFS, ...saved });
      setSavedAt(new Date());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefaults = () => {
    if (
      !window.confirm(
        'Reset all print preferences to the basic defaults? This will not save until you click "Save".'
      )
    ) {
      return;
    }
    // Preserve church name across reset — that's a personal value, not
    // a formatting choice.
    setForm({
      ...DEFAULT_PRINT_PREFS,
      default_church_name: form.default_church_name,
    });
  };

  const handleApplyPreset = () => {
    if (
      form.font_family !== DEFAULT_PRINT_PREFS.font_family &&
      !window.confirm(
        'Apply the sermon manuscript preset (Bookman Old Style 18pt double-spaced, italic centered header/footer, no title in body)? This overwrites your current settings (you can still tweak before saving).'
      )
    ) {
      return;
    }
    setForm({
      ...form,
      ...SERMON_MANUSCRIPT_PRESET,
      // Don't overwrite the church name with the preset (which is empty).
      default_church_name: form.default_church_name,
    });
  };

  if (loading) return <LoadingSpinner label="Loading print preferences…" />;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <Link to="/settings" className="text-sm text-gray-500 hover:text-gray-700">
          ← Settings
        </Link>
        <h1 className="font-serif text-2xl text-umc-900 mt-2">
          Print preferences
        </h1>
        <p className="text-sm text-gray-600 mt-1">
          Defaults the Word and PowerPoint exporters will use when you
          generate a manuscript or deck. You can override any of these
          per sermon at export time. The preview on the right updates as
          you type.
        </p>
      </div>

      {/* Preset / shortcut bar */}
      <div className="rounded-md border border-umc-200 bg-umc-50/40 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-umc-900 font-medium">
            Sermon manuscript preset
          </p>
          <p className="text-xs text-gray-600 mt-0.5">
            Bookman Old Style 18pt, double-spaced, US Letter with 1″
            margins, italic centered title in the header, italic centered
            "{`{date} – {church} – {scripture}`}" in the footer, no title
            block in the body.
          </p>
        </div>
        <button
          type="button"
          onClick={handleApplyPreset}
          className="btn-secondary text-sm whitespace-nowrap"
        >
          Apply preset
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Form */}
        <div className="card space-y-5">
          <FormSection title="Typography">
            <Field label="Font">
              <input
                list="common-fonts"
                type="text"
                value={form.font_family}
                onChange={(e) => update('font_family', e.target.value)}
                className="input w-full"
              />
              <datalist id="common-fonts">
                {COMMON_PRINT_FONTS.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              <p className="text-xs text-gray-500 mt-1">
                Type any font installed on your machine. Common picks
                pre-filled.
              </p>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Font size (pt)">
                <input
                  type="number"
                  min="8"
                  max="36"
                  value={form.font_size_pt}
                  onChange={(e) =>
                    update('font_size_pt', Math.round(Number(e.target.value)))
                  }
                  className="input w-full"
                />
              </Field>
              <Field label="Line spacing">
                <select
                  value={String(form.line_spacing)}
                  onChange={(e) => update('line_spacing', Number(e.target.value))}
                  className="input w-full"
                >
                  <option value="1">Single (1.0)</option>
                  <option value="1.15">Tight (1.15)</option>
                  <option value="1.5">One-and-a-half (1.5)</option>
                  <option value="2">Double (2.0)</option>
                  <option value="2.5">Wide (2.5)</option>
                </select>
              </Field>
            </div>
          </FormSection>

          <FormSection title="Margins (inches)">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                ['margin_top_in', 'Top'],
                ['margin_bottom_in', 'Bottom'],
                ['margin_left_in', 'Left'],
                ['margin_right_in', 'Right'],
              ].map(([key, label]) => (
                <Field key={key} label={label}>
                  <input
                    type="number"
                    step="0.05"
                    min="0.25"
                    max="3"
                    value={form[key]}
                    onChange={(e) => update(key, Number(e.target.value))}
                    className="input w-full"
                  />
                </Field>
              ))}
            </div>
          </FormSection>

          <FormSection title="Word header (top of every page)">
            <Field label="Header text">
              <input
                type="text"
                value={form.header_content}
                onChange={(e) => update('header_content', e.target.value)}
                placeholder="e.g. {title}"
                className="input w-full"
              />
              <TokenHelp />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Alignment">
                <select
                  value={form.header_alignment}
                  onChange={(e) => update('header_alignment', e.target.value)}
                  className="input w-full"
                >
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </Field>
              <Field label="Size (pt)">
                <input
                  type="number"
                  min="6"
                  max="24"
                  value={form.header_size_pt}
                  onChange={(e) =>
                    update('header_size_pt', Math.round(Number(e.target.value)))
                  }
                  className="input w-full"
                />
              </Field>
              <Field label="Italic?">
                <label className="inline-flex items-center gap-2 text-sm pt-2">
                  <input
                    type="checkbox"
                    checked={form.header_italic}
                    onChange={(e) => update('header_italic', e.target.checked)}
                  />
                  Italic
                </label>
              </Field>
            </div>
          </FormSection>

          <FormSection title="Word footer (bottom of every page)">
            <Field label="Footer text">
              <textarea
                value={form.footer_content}
                onChange={(e) => update('footer_content', e.target.value)}
                rows={2}
                placeholder="e.g. {date} – {church} – {scripture}"
                className="input w-full"
              />
              <TokenHelp />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Alignment">
                <select
                  value={form.footer_alignment}
                  onChange={(e) => update('footer_alignment', e.target.value)}
                  className="input w-full"
                >
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </Field>
              <Field label="Size (pt)">
                <input
                  type="number"
                  min="6"
                  max="24"
                  value={form.footer_size_pt}
                  onChange={(e) =>
                    update('footer_size_pt', Math.round(Number(e.target.value)))
                  }
                  className="input w-full"
                />
              </Field>
              <Field label="Italic?">
                <label className="inline-flex items-center gap-2 text-sm pt-2">
                  <input
                    type="checkbox"
                    checked={form.footer_italic}
                    onChange={(e) => update('footer_italic', e.target.checked)}
                  />
                  Italic
                </label>
              </Field>
            </div>
            <Field label="Page number position">
              <select
                value={form.page_number_position}
                onChange={(e) => update('page_number_position', e.target.value)}
                className="input w-full"
              >
                {PAGE_NUMBER_POSITIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">
                Word renders the page number in its own paragraph in the
                header or footer area, separate from the text above.
              </p>
            </Field>
          </FormSection>

          <FormSection title="Body content">
            <Field label="Default church name (for the {church} token)">
              <input
                type="text"
                value={form.default_church_name || ''}
                onChange={(e) => update('default_church_name', e.target.value)}
                placeholder="e.g. Wedowee First UMC"
                className="input w-full"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.title_in_body}
                onChange={(e) => update('title_in_body', e.target.checked)}
              />
              Render the title at the top of the body
              <span className="text-xs text-gray-500">
                (turn off when the title lives in the header)
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.show_scripture_reference}
                onChange={(e) =>
                  update('show_scripture_reference', e.target.checked)
                }
                disabled={!form.title_in_body}
              />
              Show scripture reference under the title
              {!form.title_in_body && (
                <span className="text-xs text-gray-400">
                  (only available with title in body)
                </span>
              )}
            </label>
            <Field label="Scripture passage formatting (in body)">
              <select
                value={form.scripture_format}
                onChange={(e) => update('scripture_format', e.target.value)}
                className="input w-full"
              >
                {SCRIPTURE_FORMATS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.page_break_between_sections}
                onChange={(e) =>
                  update('page_break_between_sections', e.target.checked)
                }
              />
              Insert a page break before each major section
            </label>
          </FormSection>

          <div className="flex items-center justify-between pt-2 border-t border-gray-100">
            <button
              type="button"
              onClick={handleResetDefaults}
              className="text-xs text-gray-600 hover:text-gray-900 underline"
            >
              Reset to basic defaults
            </button>
            <div className="flex items-center gap-3">
              {savedAt && (
                <span className="text-xs text-green-700">
                  Saved {savedAt.toLocaleTimeString()}
                </span>
              )}
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="btn-primary text-sm disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>

        {/* Live preview */}
        <PrintPreview prefs={form} />
      </div>

      {/* Manuscript markers reference */}
      <MarkersReference />
    </div>
  );
}

function FormSection({ title, children }) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm uppercase tracking-wide text-gray-500 font-medium">
        {title}
      </h2>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

function TokenHelp() {
  return (
    <p className="text-xs text-gray-500 mt-1">
      Tokens: <code>{'{title}'}</code>, <code>{'{scripture}'}</code>,{' '}
      <code>{'{date}'}</code>, <code>{'{church}'}</code>,{' '}
      <code>{'{page}'}</code>. Leave blank for nothing.
    </p>
  );
}

// Live preview of a single 8.5×11 page rendered with the chosen
// settings. Header is positioned in the top margin area, footer in the
// bottom margin area, body inside the body margins. Scaled to fit the
// column. HTML approximation, not exact docx output.
function PrintPreview({ prefs }) {
  const scale = 0.55;
  const pageWidthIn = 8.5;
  const pageHeightIn = 11.0;
  const pxPerIn = 72;
  const w = pageWidthIn * pxPerIn;
  const h = pageHeightIn * pxPerIn;

  const ctx = {
    title: 'How Many of These 15 Marks of the True Church Do You Have?',
    scripture: 'Acts 2:42–47',
    date: 'April 29, 2026',
    church: prefs.default_church_name || 'Your Church',
  };
  const headerText = renderTokens(prefs.header_content, ctx);
  const footerText = renderTokens(prefs.footer_content, ctx);

  const bodyStyle = {
    fontFamily: `"${prefs.font_family}", serif`,
    fontSize: `${prefs.font_size_pt * scale}pt`,
    lineHeight: prefs.line_spacing,
  };

  const headerStyle = {
    textAlign: prefs.header_alignment,
    fontStyle: prefs.header_italic ? 'italic' : 'normal',
    fontFamily: `"${prefs.font_family}", serif`,
    fontSize: `${prefs.header_size_pt * scale}pt`,
    color: '#666',
  };
  const footerStyle = {
    textAlign: prefs.footer_alignment,
    fontStyle: prefs.footer_italic ? 'italic' : 'normal',
    fontFamily: `"${prefs.font_family}", serif`,
    fontSize: `${prefs.footer_size_pt * scale}pt`,
    color: '#666',
  };

  const pageNumberStyle = pageNumberPositionStyle(prefs.page_number_position);

  // Scripture sample paragraph styling (body scripture, not title block).
  const scriptureStyle =
    prefs.scripture_format === 'block_indent'
      ? {
          marginLeft: `${0.4 * pxPerIn * scale}px`,
          marginRight: `${0.4 * pxPerIn * scale}px`,
          marginTop: '0.2em',
          marginBottom: '0.2em',
        }
      : prefs.scripture_format === 'italic'
      ? { fontStyle: 'italic' }
      : {};

  return (
    <div className="card overflow-hidden">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <h2 className="font-serif text-lg text-umc-900">Live preview</h2>
        <span className="text-xs text-gray-400">
          8.5 × 11", scaled {Math.round(scale * 100)}%
        </span>
      </div>
      <div
        className="bg-gray-100 rounded p-3 overflow-auto"
        style={{ height: h * scale + 24 }}
      >
        <div
          className="bg-white shadow-md mx-auto relative"
          style={{ width: w * scale, height: h * scale }}
        >
          {/* Header band — sits in the top margin area, above the body */}
          {headerText && (
            <div
              className="absolute"
              style={{
                top: 0.4 * pxPerIn * scale,
                left: prefs.margin_left_in * pxPerIn * scale,
                right: prefs.margin_right_in * pxPerIn * scale,
                ...headerStyle,
              }}
            >
              {headerText}
            </div>
          )}
          {/* Footer band — sits in the bottom margin area, below the body */}
          {footerText && (
            <div
              className="absolute whitespace-pre-line"
              style={{
                bottom: 0.4 * pxPerIn * scale,
                left: prefs.margin_left_in * pxPerIn * scale,
                right: prefs.margin_right_in * pxPerIn * scale,
                ...footerStyle,
              }}
            >
              {footerText}
            </div>
          )}
          {/* Page number — separate paragraph in header or footer */}
          {prefs.page_number_position !== 'none' && (
            <div
              className="absolute"
              style={{
                ...pageNumberStyle,
                fontFamily: `"${prefs.font_family}", serif`,
                fontSize: `${(prefs.footer_size_pt || 12) * scale}pt`,
                fontStyle: prefs.footer_italic ? 'italic' : 'normal',
                color: '#666',
              }}
            >
              1
            </div>
          )}
          {/* Body inside margins */}
          <div
            className="absolute overflow-hidden"
            style={{
              top: prefs.margin_top_in * pxPerIn * scale,
              bottom: prefs.margin_bottom_in * pxPerIn * scale,
              left: prefs.margin_left_in * pxPerIn * scale,
              right: prefs.margin_right_in * pxPerIn * scale,
              ...bodyStyle,
            }}
          >
            {prefs.title_in_body && (
              <>
                <div
                  style={{
                    fontWeight: 'bold',
                    fontSize: `${prefs.font_size_pt * 1.4 * scale}pt`,
                    marginBottom: '0.4em',
                  }}
                >
                  {ctx.title}
                </div>
                {prefs.show_scripture_reference && (
                  <div
                    style={{
                      fontStyle: 'italic',
                      color: '#555',
                      marginBottom: '1em',
                      fontSize: `${prefs.font_size_pt * 0.9 * scale}pt`,
                    }}
                  >
                    {ctx.scripture}
                  </div>
                )}
              </>
            )}
            {/* Sample body — shows the special markers Todd uses, with
                the same colors/highlights the docx exporter will apply */}
            <p
              style={{
                textAlign: 'center',
                fontWeight: 'bold',
                color: '#EE0000',
                background: '#00FF00',
                marginBottom: '0.4em',
                padding: '0 0.3em',
                display: 'inline-block',
                width: '100%',
                boxSizing: 'border-box',
              }}
            >
              Don't Read Scripture First
            </p>
            <p
              style={{
                fontWeight: 'bold',
                color: '#EE0000',
                background: '#00FF00',
                marginBottom: '0.6em',
                padding: '0 0.3em',
                display: 'inline-block',
              }}
            >
              Read Acts 2:42–47
            </p>
            <p style={{ marginBottom: '0.6em' }}>
              Today we look at fifteen marks of the true church and ask
              honestly which ones we have. {' '}
              <span
                style={{
                  fontWeight: 'bold',
                  color: '#FF0000',
                  background: '#FFFF00',
                  padding: '0 0.2em',
                }}
              >
                &lt;SLIDE #1 – 15 Marks of the True Church&gt;
              </span>{' '}
              The early church in Acts wasn't perfect, but it was
              recognizable, and Luke gives us a portrait worth holding up
              to a mirror.
            </p>
            <p style={scriptureStyle}>
              "And they devoted themselves to the apostles' teaching and
              fellowship, to the breaking of bread and the prayers."
            </p>
          </div>
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-2">
        Approximate preview. Final output goes through Word, which may
        render fonts and spacing slightly differently. The colored marker
        lines and slide tags above show the formatting the manuscript
        exporter will apply automatically when it sees those patterns.
      </p>
    </div>
  );
}

function pageNumberPositionStyle(pos) {
  const edge = '0.5in';
  const horiz = '0.6in';
  switch (pos) {
    case 'top_left':
      return { top: edge, left: horiz };
    case 'top_center':
      return { top: edge, left: '50%', transform: 'translateX(-50%)' };
    case 'top_right':
      return { top: edge, right: horiz };
    case 'bottom_left':
      return { bottom: edge, left: horiz };
    case 'bottom_center':
      return { bottom: edge, left: '50%', transform: 'translateX(-50%)' };
    case 'bottom_right':
      return { bottom: edge, right: horiz };
    default:
      return {};
  }
}

// Standing reference panel below the form. Documents the special
// inline markers the docx exporter recognizes and the formatting it
// applies to each. The Sermon Workspace will also feed this list to
// Claude so generated drafts use the conventions correctly.
function MarkersReference() {
  return (
    <div className="card space-y-3">
      <div>
        <h2 className="font-serif text-lg text-umc-900">
          Sermon manuscript markers
        </h2>
        <p className="text-sm text-gray-600 mt-1">
          The Word exporter recognizes the patterns below in your
          manuscript text and applies the formatting shown. You don't
          have to format anything by hand — just type the marker.
        </p>
      </div>
      <ul className="divide-y divide-gray-100">
        {MANUSCRIPT_MARKERS.map((m) => (
          <li key={m.id} className="py-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <p className="text-sm font-medium text-umc-900">{m.label}</p>
              <p className="text-xs text-gray-500 mt-0.5">{m.pattern}</p>
            </div>
            <div className="sm:col-span-2 text-xs text-gray-700">
              {m.formatting}
            </div>
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-500 italic">
        These conventions are baked into the exporter. Future versions of
        the Sermon Workspace will also tell Claude about them so that
        generated drafts use the same markers in the same way.
      </p>
    </div>
  );
}
