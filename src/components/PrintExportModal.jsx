import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { downloadSermonDocx } from '../lib/exportSermonDocx';
import { loadPrintPrefs } from '../lib/printPreferences';

// Small "Print options" modal that gathers the per-export tweakables
// (date and church name) before generating the .docx. Everything else
// — font, size, margins, header/footer text, page numbers — comes from
// the user's print_preferences row in /settings/print.
//
// Defaults:
//   - date:   most-recent preaching date for this sermon, or today
//   - church: most-recent preaching's location, or
//             prefs.default_church_name
export default function PrintExportModal({
  open,
  onClose,
  sermon,
  manuscriptText,
  preachings = [],
}) {
  const { user } = useAuth();
  const [loadingPrefs, setLoadingPrefs] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [date, setDate] = useState('');
  const [church, setChurch] = useState('');

  // Reset / hydrate when the modal opens. Depending only on `open`
  // (with eslint-disable for the missing deps) avoids a re-render loop
  // when the parent passes an inline `preachings={[]}` default — that
  // array literal is a new reference on every parent render, which
  // would otherwise re-fire this effect indefinitely and keep
  // loadingPrefs pinned at true.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setExporting(false);

    const best =
      preachings.find((p) => p.preached_at) || preachings[0] || null;
    const todayIso = new Date().toISOString().slice(0, 10);
    setDate(best?.preached_at || todayIso);

    let cancelled = false;
    setLoadingPrefs(true);
    (async () => {
      try {
        const prefs = user?.id ? await loadPrintPrefs(user.id) : null;
        if (cancelled) return;
        // Fallback chain: most recent preaching's location → user's
        // default_church_name from print prefs → 'Wedowee First UMC'.
        // The hardcoded fallback exists so the field is never blank
        // for the primary user; other pastors should set their
        // default_church_name in /settings/print.
        setChurch(
          best?.location ||
            prefs?.default_church_name ||
            'Wedowee First UMC'
        );
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoadingPrefs(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const handleExport = async () => {
    if (!sermon) {
      setError('No sermon to export.');
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const dateText = date
        ? new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })
        : '';
      await downloadSermonDocx({
        userId: user?.id,
        sermon,
        manuscriptText,
        dateOverride: dateText || undefined,
        churchOverride: church || undefined,
      });
      onClose();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-md rounded-t-lg sm:rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 space-y-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-serif text-xl text-umc-900">
              Print to Word
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-700 text-sm"
            >
              Close
            </button>
          </div>

          <p className="text-xs text-gray-600">
            Generates a .docx file using your{' '}
            <a
              href="/settings/print"
              className="underline hover:text-umc-700"
              target="_blank"
              rel="noreferrer"
            >
              print preferences
            </a>{' '}
            (font, size, margins, header / footer). The two fields below
            override the {`{date}`} and {`{church}`} tokens for this
            export only.
          </p>

          {error && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
              {error}
            </p>
          )}

          <label className="block text-sm">
            <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
              Preaching date (footer {`{date}`})
            </span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="input w-full"
            />
          </label>

          <label className="block text-sm">
            <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
              Church (footer {`{church}`})
            </span>
            <input
              type="text"
              value={church}
              onChange={(e) => setChurch(e.target.value)}
              placeholder="e.g. Wedowee First UMC"
              className="input w-full"
            />
          </label>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={exporting}
              className="btn-secondary text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {exporting ? 'Building…' : 'Export to Word'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
