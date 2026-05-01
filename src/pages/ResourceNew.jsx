import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { analyzeResource } from '../lib/claude';
import { useAuth } from '../contexts/AuthContext.jsx';

const TYPE_CHOICES = [
  { value: 'story', label: 'Story' },
  { value: 'quote', label: 'Quote' },
  { value: 'illustration', label: 'Illustration' },
  { value: 'joke', label: 'Joke' },
  { value: 'note', label: 'Note' },
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
};

export default function ResourceNew() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState(null);

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

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
    if (!draft.content.trim()) {
      setError('Content is required.');
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
          .insert({
            owner_user_id: user.id,
            resource_type: draft.resource_type,
            title: draft.title.trim() || null,
            content: draft.content.trim(),
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
      navigate(`/resources/${data.id}`);
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
          <div className="sm:col-span-2">
            <label className="label">Title (optional)</label>
            <input
              type="text"
              className="input"
              value={draft.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder='e.g., "The lost sheep parable retold"'
            />
          </div>
        </div>

        <div>
          <label className="label">Content *</label>
          <textarea
            className="input min-h-[200px]"
            value={draft.content}
            onChange={(e) => set('content', e.target.value)}
            placeholder="The story, quote, illustration, or note itself."
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
