import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import LoadingSpinner from '../components/LoadingSpinner.jsx';

function fmtDate(yyyymmdd) {
  if (!yyyymmdd) return '';
  return new Date(yyyymmdd + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export default function SermonDetail() {
  const { id } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sermon, setSermon] = useState(null);
  // Bulletins this sermon has been preached at (via liturgy_items.sermon_id)
  const [preachedAt, setPreachedAt] = useState([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({
    title: '',
    scripture_reference: '',
    theme: '',
    lectionary_year: '',
    strength: '',
    timeless: '',
    is_eulogy: false,
    major_stories: '',
    notes: '',
    preached_at: '',
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [sermonRes, preachingsRes] = await Promise.all([
          withTimeout(
            supabase.from('sermons').select('*').eq('id', id).maybeSingle()
          ),
          withTimeout(
            supabase
              .from('preachings')
              .select(
                '*, bulletin:bulletins(id, service_date, sunday_designation, status)'
              )
              .eq('sermon_id', id)
              .order('preached_at', { ascending: false, nullsFirst: false })
          ),
        ]);
        if (sermonRes.error) throw sermonRes.error;
        if (preachingsRes.error) throw preachingsRes.error;
        if (cancelled) return;
        setSermon(sermonRes.data);
        setPreachedAt(preachingsRes.data ?? []);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const startEdit = () => {
    if (!sermon) return;
    setDraft({
      title: sermon.title ?? '',
      scripture_reference: sermon.scripture_reference ?? '',
      theme: sermon.theme ?? '',
      lectionary_year: sermon.lectionary_year ?? '',
      strength: sermon.strength != null ? String(sermon.strength) : '',
      timeless: sermon.timeless ?? '',
      is_eulogy: !!sermon.is_eulogy,
      major_stories: sermon.major_stories ?? '',
      notes: sermon.notes ?? '',
      preached_at: sermon.preached_at ?? '',
    });
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
  };

  const saveEdit = async () => {
    setSaving(true);
    setError(null);
    try {
      const strengthNum = draft.strength.trim()
        ? Number(draft.strength)
        : null;
      const { data, error: err } = await withTimeout(
        supabase
          .from('sermons')
          .update({
            title: draft.title.trim() || null,
            scripture_reference: draft.scripture_reference.trim() || null,
            theme: draft.theme.trim() || null,
            lectionary_year: draft.lectionary_year.trim() || null,
            strength:
              strengthNum && !Number.isNaN(strengthNum) && strengthNum >= 1 && strengthNum <= 10
                ? Math.round(strengthNum)
                : null,
            timeless: draft.timeless.trim() || null,
            is_eulogy: !!draft.is_eulogy,
            major_stories: draft.major_stories.trim() || null,
            notes: draft.notes.trim() || null,
            preached_at: draft.preached_at || null,
          })
          .eq('id', id)
          .select()
          .single()
      );
      if (err) throw err;
      setSermon(data);
      setEditing(false);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingSpinner label="Loading sermon…" />;
  if (error) {
    return (
      <div className="card text-center space-y-3">
        <p className="text-sm text-red-700">Couldn't load sermon.</p>
        <p className="text-xs text-gray-500">{error}</p>
        <Link to="/" className="btn-secondary inline-block">
          ← Back to archive
        </Link>
      </div>
    );
  }
  if (!sermon) {
    return (
      <div className="card text-center space-y-3">
        <h1 className="font-serif text-xl text-umc-900">Sermon not found</h1>
        <Link to="/" className="btn-secondary inline-block">
          ← Back to archive
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        to="/"
        className="inline-block text-sm text-gray-500 hover:text-gray-700"
      >
        ← All sermons
      </Link>

      {/* Header / metadata */}
      <div className="card space-y-4">
        {editing ? (
          <div className="space-y-3">
            <div>
              <label className="label">Title</label>
              <input
                type="text"
                className="input"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder='e.g., "Walking with Jesus"'
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="label">Scripture reference</label>
                <input
                  type="text"
                  className="input"
                  value={draft.scripture_reference}
                  onChange={(e) =>
                    setDraft({ ...draft, scripture_reference: e.target.value })
                  }
                  placeholder="e.g., John 3:16-21"
                />
              </div>
              <div>
                <label className="label">Theme</label>
                <input
                  type="text"
                  className="input"
                  value={draft.theme}
                  onChange={(e) => setDraft({ ...draft, theme: e.target.value })}
                  placeholder="e.g., Easter, Lent, Stewardship"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="label">Lectionary year</label>
                <input
                  type="text"
                  className="input"
                  value={draft.lectionary_year}
                  onChange={(e) =>
                    setDraft({ ...draft, lectionary_year: e.target.value })
                  }
                  placeholder="e.g., 25C, Ep1C"
                />
              </div>
              <div>
                <label className="label">Strength (1-10)</label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  className="input"
                  value={draft.strength}
                  onChange={(e) =>
                    setDraft({ ...draft, strength: e.target.value })
                  }
                />
              </div>
              <div>
                <label className="label">Date first preached</label>
                <input
                  type="date"
                  className="input"
                  value={draft.preached_at}
                  onChange={(e) =>
                    setDraft({ ...draft, preached_at: e.target.value })
                  }
                />
              </div>
            </div>
            <div>
              <label className="label">Timeless?</label>
              <input
                type="text"
                className="input"
                value={draft.timeless}
                onChange={(e) =>
                  setDraft({ ...draft, timeless: e.target.value })
                }
                placeholder='e.g., "Yes", "No", "Yes, with modification"'
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.is_eulogy}
                onChange={(e) =>
                  setDraft({ ...draft, is_eulogy: e.target.checked })
                }
                className="h-4 w-4 rounded border-gray-300 text-umc-700"
              />
              <span className="text-sm text-gray-700">This is a eulogy</span>
            </label>
            <div>
              <label className="label">Major stories / illustrations used</label>
              <textarea
                className="input min-h-[80px]"
                value={draft.major_stories}
                onChange={(e) =>
                  setDraft({ ...draft, major_stories: e.target.value })
                }
                placeholder="Comma-separated list of stories, jokes, or illustrations used in this sermon."
              />
            </div>
            <div>
              <label className="label">Private notes</label>
              <textarea
                className="input min-h-[100px]"
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                placeholder="Personal notes — not shown in any bulletin. e.g., what worked, what to revise, audience response."
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={saveEdit}
                disabled={saving}
                className="btn-primary disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                className="btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  {sermon.original_sermon_number && (
                    <span className="text-sm text-gray-400 font-mono">
                      #{sermon.original_sermon_number}
                    </span>
                  )}
                  <h1 className="font-serif text-2xl text-umc-900">
                    {sermon.title || (
                      <span className="italic text-gray-400">Untitled sermon</span>
                    )}
                  </h1>
                  {sermon.is_eulogy && (
                    <span className="px-2 py-0.5 text-[10px] uppercase tracking-wide rounded bg-gray-200 text-gray-700">
                      Eulogy
                    </span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600">
                  {sermon.scripture_reference && (
                    <span>{sermon.scripture_reference}</span>
                  )}
                  {sermon.theme && (
                    <span className="italic">{sermon.theme}</span>
                  )}
                  {sermon.lectionary_year && (
                    <span className="text-gray-500">
                      Year: {sermon.lectionary_year}
                    </span>
                  )}
                  {sermon.preached_at && (
                    <span>First preached {fmtDate(sermon.preached_at)}</span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                  {sermon.strength != null && (
                    <span>
                      Strength:{' '}
                      <span className="font-medium text-umc-900">
                        {sermon.strength}/10
                      </span>
                    </span>
                  )}
                  {sermon.timeless && (
                    <span>
                      Timeless?{' '}
                      <span className="font-medium text-gray-700">
                        {sermon.timeless}
                      </span>
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={startEdit}
                className="btn-secondary text-sm whitespace-nowrap"
              >
                Edit metadata
              </button>
            </div>
            {sermon.major_stories && (
              <div className="mt-4 pt-4 border-t border-gray-100">
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                  Major stories / illustrations
                </p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">
                  {sermon.major_stories}
                </p>
              </div>
            )}
            {sermon.notes && (
              <div className="mt-4 pt-4 border-t border-gray-100">
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                  Private notes
                </p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">
                  {sermon.notes}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Preachings */}
      {preachedAt.length > 0 && (
        <div className="card">
          <h2 className="font-serif text-lg text-umc-900">
            Preached
            <span className="ml-2 text-sm font-normal text-gray-500">
              ({preachedAt.length} time{preachedAt.length === 1 ? '' : 's'})
            </span>
          </h2>
          <ul className="mt-2 divide-y divide-gray-100 text-sm">
            {preachedAt.map((p) => (
              <li
                key={p.id}
                className="py-2 flex items-start justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-gray-700">
                    {p.preached_at ? (
                      fmtDate(p.preached_at)
                    ) : (
                      <span className="italic text-gray-400">
                        Date unknown
                      </span>
                    )}
                    {p.location && (
                      <span className="text-gray-500 ml-2">— {p.location}</span>
                    )}
                  </div>
                  {p.title_used && p.title_used !== sermon.title && (
                    <div className="text-xs text-gray-500 italic mt-0.5">
                      Titled: "{p.title_used}"
                    </div>
                  )}
                  {p.series && (
                    <div className="text-xs text-gray-500 mt-0.5">
                      Series: {p.series}
                    </div>
                  )}
                  {p.bulletin && (
                    <div className="text-xs text-gray-400 mt-0.5">
                      In bulletin: {p.bulletin.sunday_designation || ''}
                      {p.bulletin.status !== 'published' && (
                        <span className="ml-1 px-1 py-0.5 text-[10px] uppercase tracking-wide rounded bg-gray-100 text-gray-500">
                          {p.bulletin.status}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Manuscript */}
      <ManuscriptCard sermon={sermon} setSermon={setSermon} />
    </div>
  );
}

// Inline manuscript editor — read view with "Edit" toggle, edit view
// with textarea + DOCX upload, save persists to sermons.manuscript_text.
function ManuscriptCard({ sermon, setSermon }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sermon.manuscript_text ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [uploadNote, setUploadNote] = useState(null);
  const docInputRef = useRef(null);

  const startEdit = () => {
    setDraft(sermon.manuscript_text ?? '');
    setEditing(true);
    setSaveError(null);
    setUploadError(null);
    setUploadNote(null);
  };

  const cancelEdit = () => {
    setEditing(false);
    setUploadError(null);
    setUploadNote(null);
  };

  const handleManuscriptUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isDocx =
      file.name.toLowerCase().endsWith('.docx') ||
      file.type ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (!isDocx) {
      setUploadError(
        'Please upload a .docx file (Microsoft Word). PDF support is coming later.'
      );
      return;
    }
    setUploading(true);
    setUploadError(null);
    setUploadNote(null);
    try {
      const mammoth =
        (await import('mammoth')).default ?? (await import('mammoth'));
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      const text = (result?.value ?? '').trim();
      if (!text) {
        setUploadError(
          "Couldn't extract any text from that document. It might be empty or image-only."
        );
        return;
      }
      setDraft(text);
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      setUploadNote(
        `Loaded ${wordCount.toLocaleString()} words from ${file.name}. Click "Save" to attach it.`
      );
    } catch (err) {
      setUploadError(err?.message || 'Failed to parse document.');
    } finally {
      setUploading(false);
      if (docInputRef.current) docInputRef.current.value = '';
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const { data, error: err } = await withTimeout(
        supabase
          .from('sermons')
          .update({ manuscript_text: draft.trim() || null })
          .eq('id', sermon.id)
          .select()
          .single()
      );
      if (err) throw err;
      setSermon(data);
      setEditing(false);
    } catch (err) {
      setSaveError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-lg text-umc-900">Manuscript</h2>
        {!editing && (
          <button
            type="button"
            onClick={startEdit}
            className="btn-secondary text-sm"
          >
            {sermon.manuscript_text ? 'Edit manuscript' : '+ Add manuscript'}
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-3 space-y-3">
          <div className="flex justify-end">
            <label
              className={`text-xs cursor-pointer text-umc-700 hover:text-umc-900 underline ${
                uploading ? 'opacity-50 pointer-events-none' : ''
              }`}
            >
              {uploading ? 'Reading…' : '📄 Upload Word doc (.docx)'}
              <input
                ref={docInputRef}
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                className="hidden"
                onChange={handleManuscriptUpload}
                disabled={uploading}
              />
            </label>
          </div>
          <textarea
            className="input min-h-[300px] font-mono text-sm"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste the manuscript text here, or upload a .docx file above."
          />
          {uploadError && (
            <p className="text-xs text-red-600">{uploadError}</p>
          )}
          {uploadNote && !uploadError && (
            <p className="text-xs text-umc-700">{uploadNote}</p>
          )}
          {saveError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {saveError}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="btn-primary disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save manuscript'}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : sermon.manuscript_text ? (
        <p className="mt-3 text-base text-gray-800 whitespace-pre-wrap font-serif leading-relaxed">
          {sermon.manuscript_text}
        </p>
      ) : (
        <p className="mt-3 text-sm text-gray-400 italic">
          No manuscript text saved for this sermon. Click "+ Add manuscript"
          above to upload a Word doc or paste the text.
        </p>
      )}
    </div>
  );
}
