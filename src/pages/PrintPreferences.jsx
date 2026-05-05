import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import {
  DEFAULT_PRINT_PREFS,
  COMMON_PRINT_FONTS,
  PAGE_NUMBER_POSITIONS,
  SCRIPTURE_FORMATS,
  fetchPrintPrefs,
  savePrintPrefs,
  renderHeaderTokens,
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

  // Form state. Initialized to DEFAULT_PRINT_PREFS so the preview
  // works immediately even before the user has saved anything.
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
          // Merge so any fields the row doesn't have keep the defaults.
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
        'Reset all print preferences to the defaults? This will not save until you click "Save".'
      )
    ) {
      return;
    }
    setForm(DEFAULT_PRINT_PREFS);
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
              <Field label="Top">
                <input
                  type="number"
                  step="0.05"
                  min="0.25"
                  max="3"
                  value={form.margin_top_in}
                  onChange={(e) => update('margin_top_in', Number(e.target.value))}
                  className="input w-full"
                />
              </Field>
              <Field label="Bottom">
                <input
                  type="number"
                  step="0.05"
                  min="0.25"
                  max="3"
                  value={form.margin_bottom_in}
                  onChange={(e) => update('margin_bottom_in', Number(e.target.value))}
                  className="input w-full"
                />
              </Field>
              <Field label="Left">
                <input
                  type="number"
                  step="0.05"
                  min="0.25"
                  max="3"
                  value={form.margin_left_in}
                  onChange={(e) => update('margin_left_in', Number(e.target.value))}
                  className="input w-full"
                />
              </Field>
              <Field label="Right">
                <input
                  type="number"
                  step="0.05"
                  min="0.25"
                  max="3"
                  value={form.margin_right_in}
                  onChange={(e) => update('margin_right_in', Number(e.target.value))}
                  className="input w-full"
                />
              </Field>
            </div>
          </FormSection>

          <FormSection title="Header & page numbers">
            <Field label="Page numbers">
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
            </Field>
            <Field label="Header text">
              <input
                type="text"
                value={form.header_content}
                onChange={(e) => update('header_content', e.target.value)}
                placeholder="e.g. {title} — {scripture}"
                className="input w-full"
              />
              <p className="text-xs text-gray-500 mt-1">
                Tokens: <code>{'{title}'}</code>, <code>{'{scripture}'}</code>,{' '}
                <code>{'{date}'}</code>, <code>{'{page}'}</code>. Leave blank
                for no header.
              </p>
            </Field>
          </FormSection>

          <FormSection title="Body content">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.show_scripture_reference}
                onChange={(e) =>
                  update('show_scripture_reference', e.target.checked)
                }
              />
              Show scripture reference under the title
            </label>
            <Field label="Scripture passage formatting">
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
              <p className="text-xs text-gray-500 mt-1">
                Applies to scripture quoted in the body. Doesn't affect the
                title-block reference above.
              </p>
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
              Reset to defaults
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

// Live preview of a single 8.5×11 page rendered with the chosen
// settings. Scaled to fit the column. This is an HTML approximation,
// not exact docx output, but it's close enough that the pastor can
// pick a font and size that read well at the pulpit.
function PrintPreview({ prefs }) {
  // 8.5 × 11 inch page at 72 dpi = 612 × 792 px. We scale down to fit
  // the column (target ~480px wide) and let CSS handle the rest.
  const scale = 0.55;
  const pageWidthIn = 8.5;
  const pageHeightIn = 11.0;
  const pxPerIn = 72;
  const w = pageWidthIn * pxPerIn;
  const h = pageHeightIn * pxPerIn;

  const ctx = {
    title: 'The Word Made Flesh',
    scripture: 'John 1:1–14',
    date: 'December 24, 2026',
  };
  const headerText = renderHeaderTokens(prefs.header_content, ctx);

  // Position the header banner along the top edge if any *_top_* page
  // numbers are chosen — and the page-number element along whichever
  // edge the pastor selected.
  const pageNumberStyle = pageNumberPositionStyle(prefs.page_number_position);

  // Body styles applied to the manuscript area.
  const bodyStyle = {
    fontFamily: `"${prefs.font_family}", serif`,
    fontSize: `${prefs.font_size_pt}pt`,
    lineHeight: prefs.line_spacing,
  };

  // Scripture sample paragraph styling.
  const scriptureStyle =
    prefs.scripture_format === 'block_indent'
      ? { marginLeft: '0.5in', marginRight: '0.5in', marginTop: '0.2em', marginBottom: '0.2em' }
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
          style={{
            width: w * scale,
            height: h * scale,
            transform: `scale(${1})`,
          }}
        >
          {/* Header band */}
          {headerText && (
            <div
              className="absolute left-0 right-0 text-gray-500 text-center"
              style={{
                top: 0.4 * pxPerIn * scale,
                fontFamily: bodyStyle.fontFamily,
                fontSize: `${prefs.font_size_pt * 0.7 * scale}pt`,
              }}
            >
              {headerText}
            </div>
          )}
          {/* Page number */}
          {prefs.page_number_position !== 'none' && (
            <div
              className="absolute text-gray-500"
              style={{
                ...pageNumberStyle,
                fontFamily: bodyStyle.fontFamily,
                fontSize: `${prefs.font_size_pt * 0.7 * scale}pt`,
              }}
            >
              1
            </div>
          )}
          {/* Body inside margins */}
          <div
            className="absolute"
            style={{
              top: prefs.margin_top_in * pxPerIn * scale,
              bottom: prefs.margin_bottom_in * pxPerIn * scale,
              left: prefs.margin_left_in * pxPerIn * scale,
              right: prefs.margin_right_in * pxPerIn * scale,
              ...bodyStyle,
              fontSize: `${prefs.font_size_pt * scale}pt`,
              overflow: 'hidden',
            }}
          >
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
            <p style={{ marginBottom: '0.6em' }}>
              In the beginning was the Word, and the gospel of John opens
              not with a manger but with a cosmos. Before there was a
              shepherd or a star, there was the Word — eternal, particular,
              with God and being God.
            </p>
            <p style={scriptureStyle}>
              "And the Word became flesh and dwelt among us, and we have
              seen his glory, glory as of the only Son from the Father,
              full of grace and truth."
            </p>
            <p style={{ marginTop: '0.6em' }}>
              That is the verse on which Christmas balances. Not the
              softer verses about wonder or peace, lovely as they are,
              but this hard claim that the Word — the speech of God,
              the wisdom by which the world was made — moved into a
              human address.
            </p>
          </div>
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-2">
        Approximate preview. Final output goes through Word, which may
        render fonts and spacing slightly differently.
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
