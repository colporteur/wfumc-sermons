import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext.jsx';

// Create a brand-new sermon directly in the archive (independent of any
// bulletin). Useful for backfilling old manuscripts from your computer
// or Evernote without waiting until you preach the sermon next.
export default function SermonNew() {
  const { user } = useAuth();
  const navigate = useNavigate();

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
    location: '',
    manuscript_text: '',
  });
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [uploadNote, setUploadNote] = useState(null);
  const docInputRef = useRef(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

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

      const updates = { manuscript_text: text };

      // If the title field is empty, try using the file name (without
      // extension) as a sensible default. Pastor can edit before saving.
      if (!draft.title.trim()) {
        const guessedTitle = file.name
          .replace(/\.docx$/i, '')
          .replace(/[_-]+/g, ' ')
          .trim();
        if (guessedTitle) updates.title = guessedTitle;
      }

      setDraft((d) => ({ ...d, ...updates }));
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      setUploadNote(
        `Loaded ${wordCount.toLocaleString()} words from ${file.name}.`
      );
    } catch (err) {
      setUploadError(err?.message || 'Failed to parse document.');
    } finally {
      setUploading(false);
      if (docInputRef.current) docInputRef.current.value = '';
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!user?.id) {
      setSaveError('Not signed in.');
      return;
    }
    if (!draft.title.trim() && !draft.manuscript_text.trim()) {
      setSaveError(
        'Please give the sermon a title or paste/upload some manuscript text.'
      );
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const strengthNum = draft.strength.trim()
        ? Number(draft.strength)
        : null;

      const { data: sermon, error: serErr } = await withTimeout(
        supabase
          .from('sermons')
          .insert({
            owner_user_id: user.id,
            title: draft.title.trim() || null,
            scripture_reference: draft.scripture_reference.trim() || null,
            theme: draft.theme.trim() || null,
            lectionary_year: draft.lectionary_year.trim() || null,
            strength:
              strengthNum &&
              !Number.isNaN(strengthNum) &&
              strengthNum >= 1 &&
              strengthNum <= 10
                ? Math.round(strengthNum)
                : null,
            timeless: draft.timeless.trim() || null,
            is_eulogy: !!draft.is_eulogy,
            major_stories: draft.major_stories.trim() || null,
            notes: draft.notes.trim() || null,
            preached_at: draft.preached_at || null,
            manuscript_text: draft.manuscript_text.trim() || null,
          })
          .select()
          .single()
      );
      if (serErr) throw serErr;

      // If the user gave us a date+location, also create a first preaching
      // entry so the sermon's preaching history isn't empty.
      if (draft.preached_at && draft.location.trim()) {
        const { error: pErr } = await withTimeout(
          supabase.from('preachings').insert({
            sermon_id: sermon.id,
            owner_user_id: user.id,
            preached_at: draft.preached_at,
            location: draft.location.trim(),
          })
        );
        if (pErr) {
          // Non-fatal; sermon is already saved
          // eslint-disable-next-line no-console
          console.warn('Initial preaching failed:', pErr);
        }
      }

      navigate(`/sermons/${sermon.id}`);
    } catch (err) {
      setSaveError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Link to="/" className="text-sm text-gray-500 hover:text-gray-700">
        ← Back to sermons
      </Link>
      <div>
        <h1 className="font-serif text-2xl text-umc-900">Add new sermon</h1>
        <p className="text-sm text-gray-600 mt-1">
          Create a sermon directly in the archive — useful for uploading
          manuscripts you've written but haven't preached yet, or for
          backfilling old sermons from your Word docs.
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div className="card space-y-4">
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
                onChange={(e) =>
                  setDraft({ ...draft, theme: e.target.value })
                }
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
                placeholder="e.g., 25C"
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
              <label className="label">Timeless?</label>
              <input
                type="text"
                className="input"
                value={draft.timeless}
                onChange={(e) =>
                  setDraft({ ...draft, timeless: e.target.value })
                }
                placeholder="Yes / No / With modification"
              />
            </div>
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
        </div>

        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-serif text-lg text-umc-900">Manuscript</h3>
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
            value={draft.manuscript_text}
            onChange={(e) =>
              setDraft({ ...draft, manuscript_text: e.target.value })
            }
            placeholder="Paste your sermon manuscript here, or upload a .docx file above."
          />
          {uploadError && (
            <p className="text-xs text-red-600">{uploadError}</p>
          )}
          {uploadNote && !uploadError && (
            <p className="text-xs text-umc-700">{uploadNote}</p>
          )}
        </div>

        <div className="card space-y-4">
          <h3 className="font-serif text-lg text-umc-900">
            First preaching{' '}
            <span className="text-sm font-normal text-gray-500">
              (optional)
            </span>
          </h3>
          <p className="text-xs text-gray-500">
            If you've already preached this sermon, fill in when and where.
            More preachings can be added later from the sermon's detail
            page (or auto-recorded when you preach it via the bulletin app).
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label">Date preached</label>
              <input
                type="date"
                className="input"
                value={draft.preached_at}
                onChange={(e) =>
                  setDraft({ ...draft, preached_at: e.target.value })
                }
              />
            </div>
            <div>
              <label className="label">Location</label>
              <input
                type="text"
                className="input"
                value={draft.location}
                onChange={(e) =>
                  setDraft({ ...draft, location: e.target.value })
                }
                placeholder="e.g., Wedowee First UMC"
              />
            </div>
          </div>
        </div>

        <div className="card space-y-4">
          <h3 className="font-serif text-lg text-umc-900">
            Other notes{' '}
            <span className="text-sm font-normal text-gray-500">
              (optional)
            </span>
          </h3>
          <div>
            <label className="label">Major stories / illustrations</label>
            <textarea
              className="input min-h-[80px]"
              value={draft.major_stories}
              onChange={(e) =>
                setDraft({ ...draft, major_stories: e.target.value })
              }
              placeholder="e.g., Carter and the orange tree; basketball game; etc."
            />
          </div>
          <div>
            <label className="label">Private notes</label>
            <textarea
              className="input min-h-[100px]"
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              placeholder="Personal notes — won't be shown publicly."
            />
          </div>
        </div>

        {saveError && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
            {saveError}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saving}
            className="btn-primary disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save sermon'}
          </button>
          <Link to="/" className="btn-secondary">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
