import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { analyzeResource, analyzeResourceWithImages } from '../lib/claude';
import { listMyLibraries } from '../lib/libraries';
import {
  publicResourceImageUrl,
  listResourceImages,
  addImageToResource,
  removeResourceImage,
} from '../lib/resourceImages';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';

const TYPE_CHOICES = [
  { value: 'story', label: 'Story' },
  { value: 'quote', label: 'Quote' },
  { value: 'illustration', label: 'Illustration' },
  { value: 'joke', label: 'Joke' },
  { value: 'note', label: 'Note' },
  { value: 'photo', label: 'Photo' },
];

const TYPE_BADGE = {
  story: { label: 'Story', cls: 'bg-blue-100 text-blue-800' },
  quote: { label: 'Quote', cls: 'bg-purple-100 text-purple-800' },
  illustration: { label: 'Illustration', cls: 'bg-amber-100 text-amber-800' },
  joke: { label: 'Joke', cls: 'bg-green-100 text-green-800' },
  note: { label: 'Note', cls: 'bg-gray-200 text-gray-700' },
  photo: { label: 'Photo', cls: 'bg-pink-100 text-pink-800' },
};

export default function ResourceDetail() {
  const { user } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [resource, setResource] = useState(null);
  // sermons that link to this resource (via sermon_resources)
  const [usedIn, setUsedIn] = useState([]);
  const [libraries, setLibraries] = useState([]);
  // Images attached to this resource (resource_images rows)
  const [images, setImages] = useState([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState(null);
  // Image management
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageError, setImageError] = useState(null);
  const [removingImageId, setRemovingImageId] = useState(null);
  const fileInputRef = useRef(null);
  // Vision analyze state
  const [visionRunning, setVisionRunning] = useState(false);
  const [visionError, setVisionError] = useState(null);
  const [visionSuggestions, setVisionSuggestions] = useState(null);
  const [visionOverwrite, setVisionOverwrite] = useState(false);
  const [visionApplying, setVisionApplying] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [resourceRes, linksRes, imagesResult, libsResult] =
          await Promise.all([
            // No owner filter — we want library-shared resources too. RLS
            // enforces visibility (owner OR library member).
            withTimeout(
              supabase.from('resources').select('*').eq('id', id).maybeSingle()
            ),
            withTimeout(
              supabase
                .from('sermon_resources')
                .select(
                  'id, used_notes, created_at, sermon:sermons(id, title, original_sermon_number)'
                )
                .eq('resource_id', id)
                .eq('owner_user_id', user.id)
                .order('created_at', { ascending: false })
            ),
            listResourceImages(id).catch(() => []),
            listMyLibraries().catch(() => []),
          ]);
        if (resourceRes.error) throw resourceRes.error;
        if (linksRes.error) throw linksRes.error;
        if (cancelled) return;
        setResource(resourceRes.data);
        setUsedIn(linksRes.data ?? []);
        setImages(imagesResult);
        setLibraries(libsResult);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, user?.id]);

  const startEdit = () => {
    if (!resource) return;
    setDraft({
      resource_type: resource.resource_type,
      title: resource.title ?? '',
      content: resource.content ?? '',
      source: resource.source ?? '',
      source_url: resource.source_url ?? '',
      themes: (resource.themes ?? []).join(', '),
      scripture_refs: resource.scripture_refs ?? '',
      tone: resource.tone ?? '',
      notes: resource.notes ?? '',
      library_id: resource.library_id ?? '',
    });
    setEditing(true);
    setAnalyzeError(null);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(null);
  };

  // Add one or more images to the current resource (works in any mode).
  const handleImageUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length || !user?.id || !resource) return;
    setUploadingImage(true);
    setImageError(null);
    try {
      // Place new images at the end (sort_order = current max + 1+).
      const baseSort = images.length > 0
        ? Math.max(...images.map((i) => i.sort_order)) + 1
        : 0;
      const added = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f.type.startsWith('image/')) {
          setImageError(`Skipped non-image file: ${f.name}`);
          continue;
        }
        const row = await addImageToResource({
          file: f,
          ownerUserId: user.id,
          resourceId: resource.id,
          sortOrder: baseSort + i,
        });
        added.push(row);
      }
      setImages((prev) => [...prev, ...added]);
    } catch (err) {
      setImageError(err.message || String(err));
    } finally {
      setUploadingImage(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleImageRemove = async (img) => {
    if (!window.confirm('Remove this image? This can\'t be undone.')) return;
    setRemovingImageId(img.id);
    setImageError(null);
    try {
      await removeResourceImage(img);
      setImages((prev) => prev.filter((i) => i.id !== img.id));
    } catch (err) {
      setImageError(err.message || String(err));
    } finally {
      setRemovingImageId(null);
    }
  };

  // Vision analyze: send the resource's images to Claude and propose
  // metadata + a narrative content block. The user reviews suggestions
  // and chooses whether to overwrite existing values or only fill blanks.
  const runVisionAnalyze = async () => {
    if (images.length === 0 || !resource) return;
    setVisionRunning(true);
    setVisionError(null);
    setVisionSuggestions(null);
    try {
      const result = await analyzeResourceWithImages({
        images: images.map((i) => ({
          image_path: i.image_path,
          caption: i.caption,
        })),
        existing: {
          title: resource.title,
          content: resource.content,
          source: resource.source,
          themes: resource.themes,
          scripture_refs: resource.scripture_refs,
          tone: resource.tone,
          resource_type: resource.resource_type,
        },
      });
      setVisionSuggestions(result);
    } catch (e) {
      setVisionError(e.message || String(e));
    } finally {
      setVisionRunning(false);
    }
  };

  // Apply vision suggestions to the resource. If `overwrite` is on, every
  // suggested field replaces whatever's there. If off, suggestions only
  // fill empty fields. Themes always merge (deduped union).
  const applyVisionSuggestions = async () => {
    if (!visionSuggestions || !resource) return;
    setVisionApplying(true);
    setVisionError(null);
    try {
      const sug = visionSuggestions;
      const cur = resource;
      // Merge themes — always union, since themes are additive in spirit.
      const themeUnion = Array.from(
        new Set(
          [...(cur.themes ?? []), ...(sug.themes ?? [])]
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean)
        )
      );
      const pickField = (curVal, sugVal) => {
        if (visionOverwrite) return sugVal || null;
        // Fill-blanks-only mode
        if (curVal && String(curVal).trim()) return curVal;
        return sugVal || null;
      };
      const update = {
        title: pickField(cur.title, sug.title),
        content: pickField(cur.content, sug.content) || '',
        scripture_refs: pickField(cur.scripture_refs, sug.scripture_refs),
        tone: pickField(cur.tone, sug.tone),
        themes: themeUnion,
      };
      const { data, error: err } = await withTimeout(
        supabase
          .from('resources')
          .update(update)
          .eq('id', resource.id)
          .select()
          .single()
      );
      if (err) throw err;
      setResource(data);
      setVisionSuggestions(null);
      setVisionOverwrite(false);
    } catch (e) {
      setVisionError(e.message || String(e));
    } finally {
      setVisionApplying(false);
    }
  };

  const cancelVision = () => {
    setVisionSuggestions(null);
    setVisionError(null);
    setVisionOverwrite(false);
  };

  const runAnalyze = async () => {
    if (!draft || !draft.content.trim()) {
      setAnalyzeError('Add some content first.');
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
    if (!draft) return;
    const isPhoto = draft.resource_type === 'photo';
    // For non-photo: content required. For photo: at least one image required.
    if (!isPhoto && !draft.content.trim()) {
      setError('Content is required.');
      return;
    }
    if (isPhoto && images.length === 0) {
      setError('Photo resources need at least one image. Add one below.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const themes = draft.themes
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      const { data, error: err } = await withTimeout(
        supabase
          .from('resources')
          .update({
            resource_type: draft.resource_type,
            library_id: draft.library_id || null,
            title: draft.title.trim() || null,
            content: draft.content.trim() || (isPhoto ? '' : draft.content),
            source: draft.source.trim() || null,
            source_url: draft.source_url.trim() || null,
            themes,
            scripture_refs: draft.scripture_refs.trim() || null,
            tone: draft.tone.trim() || null,
            notes: draft.notes.trim() || null,
          })
          .eq('id', resource.id)
          .select()
          .single()
      );
      if (err) throw err;
      setResource(data);
      setEditing(false);
      setDraft(null);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!resource) return;
    if (
      !window.confirm(
        `Delete this ${resource.resource_type}? It will be unlinked from any sermons that used it. This can't be undone.`
      )
    ) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      const { error: err } = await withTimeout(
        supabase.from('resources').delete().eq('id', resource.id)
      );
      if (err) throw err;
      // resource_images rows + their storage objects: cascade deletes the
      // table rows; storage objects orphaned but not user-visible.
      navigate('/resources');
    } catch (e) {
      setError(e.message || String(e));
      setDeleting(false);
    }
  };

  if (loading) return <LoadingSpinner label="Loading resource…" />;
  if (error && !resource) {
    return (
      <div className="card text-center space-y-3">
        <p className="text-sm text-red-700">Couldn't load resource.</p>
        <p className="text-xs text-gray-500">{error}</p>
        <Link to="/resources" className="btn-secondary inline-block">
          ← Back to resources
        </Link>
      </div>
    );
  }
  if (!resource) {
    return (
      <div className="card text-center space-y-3">
        <h1 className="font-serif text-xl text-umc-900">Resource not found</h1>
        <Link to="/resources" className="btn-secondary inline-block">
          ← Back to resources
        </Link>
      </div>
    );
  }

  const badge = TYPE_BADGE[resource.resource_type] ?? TYPE_BADGE.note;

  return (
    <div className="space-y-6">
      <Link
        to="/resources"
        className="inline-block text-sm text-gray-500 hover:text-gray-700"
      >
        ← All resources
      </Link>

      <div className="card space-y-4">
        {editing ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="label">Type</label>
                <select
                  className="input"
                  value={draft.resource_type}
                  onChange={(e) =>
                    setDraft({ ...draft, resource_type: e.target.value })
                  }
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
                  onChange={(e) =>
                    setDraft({ ...draft, library_id: e.target.value })
                  }
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
                <label className="label">Title</label>
                <input
                  type="text"
                  className="input"
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
              </div>
            </div>
            <div>
              <label className="label">
                {draft.resource_type === 'photo' ? 'Caption (optional)' : 'Content *'}
              </label>
              <textarea
                className="input min-h-[200px]"
                value={draft.content}
                onChange={(e) =>
                  setDraft({ ...draft, content: e.target.value })
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
                  onChange={(e) =>
                    setDraft({ ...draft, source: e.target.value })
                  }
                />
              </div>
              <div>
                <label className="label">Source URL</label>
                <input
                  type="url"
                  className="input"
                  value={draft.source_url}
                  onChange={(e) =>
                    setDraft({ ...draft, source_url: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="border border-dashed border-gray-300 rounded p-3 bg-gray-50">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-gray-600">
                  Re-run Claude analysis. Existing values won't be overwritten.
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
                onChange={(e) => setDraft({ ...draft, themes: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Scripture connections</label>
                <input
                  type="text"
                  className="input"
                  value={draft.scripture_refs}
                  onChange={(e) =>
                    setDraft({ ...draft, scripture_refs: e.target.value })
                  }
                />
              </div>
              <div>
                <label className="label">Tone</label>
                <input
                  type="text"
                  className="input"
                  value={draft.tone}
                  onChange={(e) => setDraft({ ...draft, tone: e.target.value })}
                />
              </div>
            </div>
            <div>
              <label className="label">Private notes</label>
              <textarea
                className="input min-h-[80px]"
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
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
                  <span
                    className={`px-2 py-0.5 text-[10px] uppercase tracking-wide rounded ${badge.cls}`}
                  >
                    {badge.label}
                  </span>
                  {resource.title && (
                    <h1 className="font-serif text-2xl text-umc-900">
                      {resource.title}
                    </h1>
                  )}
                  {(() => {
                    const lib = libraries.find((l) => l.id === resource.library_id);
                    return lib ? (
                      <span className="text-[10px] uppercase tracking-wide text-gray-500">
                        in {lib.name}
                      </span>
                    ) : (
                      <span className="text-[10px] uppercase tracking-wide text-gray-400">
                        private
                      </span>
                    );
                  })()}
                  {resource.owner_user_id !== user?.id && (
                    <span className="text-[10px] uppercase tracking-wide text-umc-700">
                      added by co-member
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  onClick={startEdit}
                  className="btn-secondary text-sm"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={remove}
                  disabled={deleting}
                  className="text-sm text-red-600 hover:text-red-800 underline disabled:opacity-50"
                >
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
            {resource.content && (
              <p className="mt-4 text-base text-gray-800 whitespace-pre-wrap font-serif leading-relaxed">
                {resource.content}
              </p>
            )}
            {(resource.source || resource.source_url) && (
              <div className="mt-3 text-sm text-gray-600">
                {resource.source && <span>— {resource.source}</span>}
                {resource.source_url && (
                  <>
                    {resource.source && <span className="mx-2">·</span>}
                    <a
                      href={resource.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-umc-700 hover:text-umc-900 underline break-all"
                    >
                      {resource.source_url}
                    </a>
                  </>
                )}
              </div>
            )}
            <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                  Themes
                </p>
                {(resource.themes ?? []).length === 0 ? (
                  <p className="text-xs text-gray-400 italic">None</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {resource.themes.map((t) => (
                      <span
                        key={t}
                        className="px-2 py-0.5 text-[10px] rounded bg-umc-100 text-umc-900"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                  Scripture connections
                </p>
                <p className="text-sm text-gray-700">
                  {resource.scripture_refs || (
                    <span className="text-xs text-gray-400 italic">None</span>
                  )}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                  Tone
                </p>
                <p className="text-sm text-gray-700">
                  {resource.tone || (
                    <span className="text-xs text-gray-400 italic">—</span>
                  )}
                </p>
              </div>
            </div>
            {resource.notes && (
              <div className="mt-4 pt-4 border-t border-gray-100">
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                  Private notes
                </p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">
                  {resource.notes}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Images gallery */}
      <div className="card">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-serif text-lg text-umc-900">
              Images
              {images.length > 0 && (
                <span className="ml-2 text-sm font-normal text-gray-500">
                  ({images.length})
                </span>
              )}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {resource.resource_type === 'photo'
                ? 'The image is the heart of this photo resource.'
                : 'Optional: scanned pages, diagrams, or photos that go with this resource.'}
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            {images.length > 0 && (
              <button
                type="button"
                onClick={runVisionAnalyze}
                disabled={visionRunning || visionApplying}
                className="btn-secondary text-sm whitespace-nowrap disabled:opacity-50"
                title="Use Claude vision to suggest title, content narrative, themes, scripture, and tone based on the image(s)"
              >
                {visionRunning ? 'Analyzing…' : '✨ Analyze with Claude'}
              </button>
            )}
            <label
              className={`btn-secondary text-sm cursor-pointer whitespace-nowrap ${
                uploadingImage ? 'opacity-50 pointer-events-none' : ''
              }`}
            >
              {uploadingImage ? 'Uploading…' : '+ Add image(s)'}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleImageUpload}
                disabled={uploadingImage}
              />
            </label>
          </div>
        </div>
        {imageError && (
          <p className="text-sm text-red-600 mt-2">{imageError}</p>
        )}
        {visionError && (
          <p className="text-sm text-red-600 mt-2">{visionError}</p>
        )}

        {/* Vision suggestions panel — appears once Claude responds. */}
        {visionSuggestions && (
          <div className="mt-4 border border-umc-700 rounded p-3 bg-umc-50/30 space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-medium text-umc-900">
                ✨ Claude's suggestions
              </h3>
              <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={visionOverwrite}
                  onChange={(e) => setVisionOverwrite(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-umc-700"
                />
                <span>
                  Overwrite existing values
                  <span className="block text-[10px] text-gray-500 leading-tight">
                    {visionOverwrite
                      ? 'Replace whatever\'s there'
                      : 'Only fill empty fields (themes always merge)'}
                  </span>
                </span>
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <SuggestionRow
                label="Title"
                current={resource.title}
                suggested={visionSuggestions.title}
                overwrite={visionOverwrite}
              />
              <SuggestionRow
                label="Tone"
                current={resource.tone}
                suggested={visionSuggestions.tone}
                overwrite={visionOverwrite}
              />
              <SuggestionRow
                label="Scripture"
                current={resource.scripture_refs}
                suggested={visionSuggestions.scripture_refs}
                overwrite={visionOverwrite}
              />
              <SuggestionRow
                label="Themes"
                current={(resource.themes ?? []).join(', ')}
                suggested={(visionSuggestions.themes ?? []).join(', ')}
                overwrite={true /* themes always merge */}
                noteOverride="(always merged with existing)"
              />
              <div className="sm:col-span-2">
                <SuggestionRow
                  label="Content (narrative)"
                  current={resource.content}
                  suggested={visionSuggestions.content}
                  overwrite={visionOverwrite}
                  multiline
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={applyVisionSuggestions}
                disabled={visionApplying}
                className="btn-primary text-sm disabled:opacity-50"
              >
                {visionApplying ? 'Applying…' : 'Apply suggestions'}
              </button>
              <button
                type="button"
                onClick={cancelVision}
                disabled={visionApplying}
                className="btn-secondary text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {images.length === 0 ? (
          <p className="mt-3 text-sm text-gray-400 italic">
            No images yet.
          </p>
        ) : (
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3">
            {images.map((img) => (
              <div
                key={img.id}
                className="relative group border border-gray-200 rounded overflow-hidden bg-gray-50"
              >
                <a
                  href={publicResourceImageUrl(img.image_path)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                >
                  <img
                    src={publicResourceImageUrl(img.image_path)}
                    alt={img.caption || resource.title || 'resource image'}
                    loading="lazy"
                    className="w-full aspect-square object-cover hover:opacity-90 transition-opacity"
                  />
                </a>
                <button
                  type="button"
                  onClick={() => handleImageRemove(img)}
                  disabled={removingImageId === img.id}
                  className="absolute top-1 right-1 px-2 py-0.5 text-xs bg-white/90 hover:bg-white text-red-600 hover:text-red-800 rounded shadow disabled:opacity-50"
                  title="Remove this image"
                >
                  {removingImageId === img.id ? '…' : '✕'}
                </button>
                {img.caption && (
                  <p className="px-2 py-1 text-xs text-gray-600 bg-white">
                    {img.caption}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Used in */}
      <div className="card">
        <h2 className="font-serif text-lg text-umc-900">
          Used in
          <span className="ml-2 text-sm font-normal text-gray-500">
            ({usedIn.length})
          </span>
        </h2>
        {usedIn.length === 0 ? (
          <p className="mt-2 text-sm text-gray-400 italic">
            Not yet linked to any sermons. Link this resource from a sermon's
            detail page when you use it.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-100">
            {usedIn.map((link) => (
              <li key={link.id} className="py-2">
                {link.sermon ? (
                  <Link
                    to={`/sermons/${link.sermon.id}`}
                    className="text-sm text-umc-700 hover:text-umc-900"
                  >
                    {link.sermon.original_sermon_number && (
                      <span className="text-xs text-gray-400 font-mono mr-2">
                        #{link.sermon.original_sermon_number}
                      </span>
                    )}
                    {link.sermon.title || (
                      <span className="italic text-gray-500">Untitled</span>
                    )}
                  </Link>
                ) : (
                  <span className="text-sm text-gray-400 italic">
                    Sermon deleted
                  </span>
                )}
                {link.used_notes && (
                  <p className="text-xs text-gray-500 mt-1">{link.used_notes}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// Single row in the vision suggestions panel — shows the field's current
// value (struck through if overwriting), Claude's suggestion, and a hint
// about whether the suggestion will actually be applied.
function SuggestionRow({
  label,
  current,
  suggested,
  overwrite,
  multiline = false,
  noteOverride = null,
}) {
  const hasCurrent = current && String(current).trim().length > 0;
  const hasSuggestion = suggested && String(suggested).trim().length > 0;
  const willApply = overwrite || !hasCurrent;

  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
        {label}
        <span className="ml-2 text-gray-400 normal-case tracking-normal">
          {noteOverride
            ? noteOverride
            : willApply && hasSuggestion
            ? '→ will apply'
            : !hasSuggestion
            ? '(no suggestion)'
            : '(kept as-is)'}
        </span>
      </p>
      {hasCurrent && (
        <p
          className={`text-xs ${
            willApply && hasSuggestion
              ? 'line-through text-gray-400'
              : 'text-gray-700'
          } ${multiline ? 'whitespace-pre-wrap' : ''}`}
        >
          {current}
        </p>
      )}
      {hasSuggestion && (
        <p
          className={`text-xs mt-1 ${
            willApply ? 'text-umc-900 font-medium' : 'text-gray-400'
          } ${multiline ? 'whitespace-pre-wrap' : ''}`}
        >
          {hasCurrent ? '→ ' : ''}
          {suggested}
        </p>
      )}
      {!hasCurrent && !hasSuggestion && (
        <p className="text-xs text-gray-400 italic">—</p>
      )}
    </div>
  );
}
