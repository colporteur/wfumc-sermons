import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext.jsx';
import TypeaheadSearch from '../components/TypeaheadSearch.jsx';
import { buildDefaultElements } from '../lib/worshipElements';

// Create a brand-new liturgy from scratch. Seeds the 6 default
// worship elements (empty bodies) and lands the user on the detail
// page ready to edit.
//
// Optional fields:
//   - date (used_at)
//   - scripture_refs (single ref or semicolon-separated multi)
//   - linked sermon (auto-pulls scripture_reference into the
//     scripture_refs field if user hasn't typed their own)
export default function LiturgyNew() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [usedAt, setUsedAt] = useState('');
  const [scriptureRefs, setScriptureRefs] = useState('');
  const [linkedSermon, setLinkedSermon] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handlePickSermon = (sermon) => {
    setLinkedSermon(sermon);
    // Auto-pull the sermon's scripture into the liturgy's scripture
    // field — but only if the pastor hasn't already typed something
    // they want to keep.
    if (!scriptureRefs.trim() && sermon?.scripture_reference) {
      setScriptureRefs(sermon.scripture_reference);
    }
  };

  const handleCreate = async (e) => {
    e?.preventDefault?.();
    setError(null);
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError('Title is required.');
      return;
    }
    if (!user?.id) {
      setError('Not signed in.');
      return;
    }
    setBusy(true);
    try {
      // 1. Insert the liturgy row.
      const { data: created, error: liturgyErr } = await withTimeout(
        supabase
          .from('sermon_liturgies')
          .insert({
            owner_user_id: user.id,
            title: cleanTitle,
            used_at: usedAt || null,
            scripture_refs: scriptureRefs.trim() || null,
            raw_body: null,
          })
          .select('id')
          .single()
      );
      if (liturgyErr) throw liturgyErr;
      const liturgyId = created.id;

      // 2. Seed the 6 default elements.
      const defaults = buildDefaultElements({
        liturgyId,
        ownerUserId: user.id,
      });
      const { error: secErr } = await withTimeout(
        supabase.from('sermon_liturgy_sections').insert(defaults)
      );
      if (secErr) throw secErr;

      // 3. Optionally link to a sermon (auto-approved manual link).
      if (linkedSermon?.id) {
        const { error: linkErr } = await withTimeout(
          supabase.from('sermon_liturgy_links').insert({
            liturgy_id: liturgyId,
            sermon_id: linkedSermon.id,
            owner_user_id: user.id,
            link_kind: 'manual',
            confidence: 'high',
            approved: true,
          })
        );
        if (linkErr) throw linkErr;
      }

      navigate(`/liturgies/${liturgyId}`);
    } catch (err) {
      setError(err.message || String(err));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <Link
        to="/liturgies"
        className="text-sm text-gray-500 hover:text-gray-700"
      >
        ← Back to liturgies
      </Link>
      <h1 className="text-2xl font-serif text-umc-900">New liturgy</h1>
      <p className="text-sm text-gray-600">
        A new liturgy starts with six default elements (Call to Worship,
        Prelude, Announcements, Children's Moment, Congregational Prayer,
        Offering Statement). You can add more elements, edit any of
        them, and use Claude to draft text once it's created.
      </p>

      <form onSubmit={handleCreate} className="space-y-3 card">
        <div>
          <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
            Title <span className="text-red-600">*</span>
          </label>
          <input
            className="input w-full"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g., June 22 — Matthew 9:9-13"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
            Date (optional)
          </label>
          <input
            type="date"
            className="input w-full"
            value={usedAt}
            onChange={(e) => setUsedAt(e.target.value)}
          />
          <p className="text-[11px] text-gray-500 mt-1">
            When this liturgy will be used in worship. Optional.
          </p>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
            Scripture reference(s) (optional)
          </label>
          <input
            className="input w-full"
            value={scriptureRefs}
            onChange={(e) => setScriptureRefs(e.target.value)}
            placeholder="Matthew 9:9-13; Hosea 6:6"
          />
          <p className="text-[11px] text-gray-500 mt-1">
            Separate multiple references with a semicolon. Auto-fills
            from the linked sermon if you pick one below.
          </p>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
            Linked sermon (optional)
          </label>
          {linkedSermon ? (
            <div className="flex items-center justify-between gap-2 p-2 bg-umc-50 border border-umc-200 rounded">
              <div className="min-w-0">
                <div className="font-medium text-sm truncate">
                  {linkedSermon.title || '(untitled)'}
                </div>
                {linkedSermon.scripture_reference && (
                  <div className="text-xs text-gray-600 truncate">
                    {linkedSermon.scripture_reference}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setLinkedSermon(null)}
                className="text-xs text-gray-500 hover:text-gray-700 underline whitespace-nowrap"
              >
                Clear
              </button>
            </div>
          ) : (
            <TypeaheadSearch
              table="sermons"
              selectColumns="id, title, scripture_reference"
              searchColumns="title,scripture_reference"
              labelFor={(r) => r.title || '(untitled)'}
              subLabelFor={(r) => r.scripture_reference || ''}
              onPick={handlePickSermon}
              placeholder="Type a sermon title or scripture…"
            />
          )}
        </div>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-2 pt-2">
          <button
            type="submit"
            disabled={busy || !title.trim()}
            className="btn-primary disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create liturgy'}
          </button>
          <Link to="/liturgies" className="btn-secondary">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
