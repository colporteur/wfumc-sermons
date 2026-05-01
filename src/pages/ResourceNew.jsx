import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { analyzeResource } from '../lib/claude';
import { listMyLibraries } from '../lib/libraries';
import { addImageToResource } from '../lib/resourceImages';
import { useAuth } from '../contexts/AuthContext.jsx';

const TYPE_CHOICES = [
  { value: 'story', label: 'Story' },
  { value: 'quote', label: 'Quote' },
  { value: 'illustration', label: 'Illustration' },
  { value: 'joke', label: 'Joke' },
  { value: 'note', label: 'Note' },
  { value: 'photo', label: 'Photo' },
];

const EMPTY = {
  resource_type: 'story',
  title: '',
  content: '',
  source: '',
  source_url: '',
  themes: '', // entered as comma-separated, stored as text[]
  scripture_refs: '',
  tone: '',
  notes: '',
  library_id: '', // '' = personal/private; otherwise a library uuid
};

// Remember last library choice so the next "+ New resource" defaults to
// the same place (most users want to file new things into the same pool).
const LAST_LIB_KEY = 'wfumc-resources-last-library';

export default function ResourceNew() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(() => {
    const last =
      typeof window !== 'undefined'
        ? window.localStorage.getItem(LAST_LIB_KEY) || ''
        : '';
    return { ...EMPTY, library_id: last };
  });
  const [libraries, setLibraries] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState(null);
  // Image files held in component state until save; uploaded after the
  // resource row is created so we have a resource_id for path prefix.
  const [imageFiles, setImageFiles] = useState([]);
  const [imagePreviews, setImagePreviews] = useState([]);
  const fileInputRef = useRef(null);

  useEffect(() => {
    listMyLibraries()
      .then((libs) => setLibraries(libs))
      .catch(() => setLibraries([]));
  }, []);

  // Generate preview URLs for any picked files.
  useEffect(() => {
    if (imageFiles.length === 0) {
      setImagePreviews([]);
      return;
    }
    const urls = imageFiles.map((f) => URL.createObjectURL(f));
    setImagePreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [imageFiles]);

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  const handleImageChoose = (e) => {
    const fs = Array.from(e.target.files || []).filter((f) =>
      f.type.startsWith('image/')
    );
    if (fs.length === 0) return;
    setError(null);
    setImageFiles((prev) => [...prev, ...fs]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImageAt = (idx) => {
    setImageFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const runAnalyze = async () => {
    if (!draft.content.trim()) {
      setAnalyzeError('Add some content first, then I can suggest tags.');
      return;
    }
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const result = await analyzeResource({
        content: draft.content,
        type: draft.resource_type,
        title: draft.title || undefined,
        source: draft.source || undefined,
      });
      // Merge: never overwrite a field the user has already filled in.
      setDraft((d) => ({
        ...d,
        themes: d.themes.trim()
          ? d.themes
          : (result.themes ?? []).join(', '),
        scripture_refs: d.scripture_refs.trim()
          ? d.scripture_refs
          : result.scripture_refs ?? '',
        tone: d.tone.trim() ? d.tone : result.tone ?? '',
      }));
    } catch (e) {
      setAnalyzeError(e.message || String(e));
    } finally {
      setAnalyzing(false);
    }
  };

  const save = async () => {
    if (!user?.id) return;
    const isPhoto = draft.resource_type === 'photo';
    if (!isPhoto && !draft.content.trim()) {
      setError('Content is required.');
      return;
    }
    if (isPhoto && imageFiles.length === 0) {
      setError('Photo resources need at least one image.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const themes = draft.themes
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      // Step 1: insert the resource row.
      const { data: created, error: err } = await withTimeout(
        supabase
          .from('resources')
          .insert({
            owner_user_id: user.id,
            library_id: draft.library_id || null,
            resource_type: draft.resource_type,
            title: draft.title.trim() || null,
            content: draft.content.trim() || (isPhoto ? '' : draft.content),
            source: draft.source.trim() || null,
            source_url: draft.source_url.trim() || null,
            themes,
            scripture_refs: draft.scripture_refs.trim() || null,
            tone: draft.tone.trim() || null,
            notes: draft.notes.trim() || null,
          })
          .select()
          .single()
      );
      if (err) throw err;

      // Step 2: upload any picked images and create resource_images rows.
      for (let i = 0; i < imageFiles.length; i++) {
        await addImageToResource({
          file: imageFiles[i],
          ownerUserId: user.id,
          resourceId: created.id,
          sortOrder: i,
        });
      }

      // Remember library choice for next time.
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(LAST_LIB_KEY, draft.library_id || '');
      }
      navigate(`/resources/${created.id}`);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Link
        to="/resources"
        className="inline-block text-sm text-gray-500 hover:text-gray-700"
      >
        ← All resources
      </Link>

      <div className="card space-y-4">
        <h1 className="font-serif text-2xl text-umc-900">New resource</h1>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="label">Type</label>
            <select
              className="input"
              value={draft.resource_type}
              onChange={(e) => set('resource_type', e.target.value)}
            >
              {TYPE_CHOICES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Library</label>
            <select
              className="input"
              value={draft.library_id}
              onChange={(e) => set('library_id', e.target.value)}
            >
              <option value="">Just me (private)</option>
              {libraries.map((lib) => (
                <option key={lib.id} value={lib.id}>
                  {lib.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Title (optional)</label>
            <input
              type="text"
              className="input"
              value={draft.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder='e.g., "Lost sheep retold"'
            />
          </div>
        </div>

        {/* Image attachments (any type can have them) */}
        <div className="border border-dashed border-gray-300 rounded p-3 bg-gray-50 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <label className="label mb-0">
              Images{' '}
              {draft.resource_type === 'photo' && (
                <span className="text-red-600">*</span>
              )}
            </label>
            <label className="btn-secondary text-sm cursor-pointer">
              + Add image(s)
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleImageChoose}
              />
            </label>
          </div>
          {imageFiles.length === 0 ? (
            <p className="text-xs text-gray-500">
              {draft.resource_type === 'photo'
                ? 'A photo resource needs at least one image.'
                : 'Optional. Attach scanned pages, diagrams, or supporting photos.'}
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {imagePreviews.map((url, i) => (
                <div
                  key={i}
                  className="relative border border-gray-200 rounded overflow-hidden bg-white"
                >
                  <img
                    src={url}
                    alt={`preview ${i + 1}`}
                    className="w-full aspect-square object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeImageAt(i)}
                    className="absolute top-1 right-1 px-2 py-0.5 text-xs bg-white/90 hover:bg-white text-red-600 hover:text-red-800 rounded shadow"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="label">
            {draft.resource_type === 'photo'
              ? 'Caption (optional)'
              : 'Content *'}
          </label>
          <textarea
            className="input min-h-[200px]"
            value={draft.content}
            onChange={(e) => set('content', e.target.value)}
            placeholder={
              draft.resource_type === 'photo'
                ? 'Optional caption or context for the photo.'
                : 'The story, quote, illustration, or note itself.'
            }
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Source</label>
            <input
              type="text"
              className="input"
              value={draft.source}
              onChange={(e) => set('source', e.target.value)}
              placeholder='e.g., "C.S. Lewis, Mere Christianity, p. 42"'
            />
          </div>
          <div>
            <label className="label">Source URL</label>
            <input
              type="url"
              className="input"
              value={draft.source_url}
              onChange={(e) => set('source_url', e.target.value)}
              placeholder="https://…"
            />
          </div>
        </div>

        {/* Claude assist */}
        <div className="border border-dashed border-gray-300 rounded p-3 bg-gray-50">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-gray-600">
              Ask Claude to suggest themes, scripture connections, and tone
              based on the content. Existing values won't be overwritten.
            </p>
            <button
              type="button"
              onClick={runAnalyze}
              disabled={analyzing || !draft.content.trim()}
              className="btn-secondary text-sm whitespace-nowrap disabled:opacity-50"
            >
              {analyzing ? 'Analyzing…' : '✨ Analyze with Claude'}
            </button>
          </div>
          {analyzeError && (
            <p className="text-xs text-red-600 mt-2">{analyzeError}</p>
          )}
        </div>

        <div>
          <label className="label">Themes (comma-separated)</label>
          <input
            type="text"
            className="input"
            value={draft.themes}
            onChange={(e) => set('themes', e.target.value)}
            placeholder="e.g., grace, forgiveness, lent"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Scripture connections</label>
            <input
              type="text"
              className="input"
              value={draft.scripture_refs}
              onChange={(e) => set('scripture_refs', e.target.value)}
              placeholder="e.g., Luke 15:11-32; Romans 8:1"
            />
          </div>
          <div>
            <label className="label">Tone</label>
            <input
              type="text"
              className="input"
              value={draft.tone}
              onChange={(e) => set('tone', e.target.value)}
              placeholder="e.g., humorous, convicting, tender"
            />
          </div>
        </div>

        <div>
          <label className="label">Private notes</label>
          <textarea
            className="input min-h-[80px]"
            value={draft.notes}
            onChange={(e) => set('notes', e.target.value)}
            placeholder="Where this landed well, where it bombed, when to use it…"
          />
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="btn-primary disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save resource'}
          </button>
          <Link to="/resources" className="btn-secondary">
            Cancel
          </Link>
        </div>
      </div>
    </div>
  );
}
