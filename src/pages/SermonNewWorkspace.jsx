import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { buildResourcesContext } from '../lib/workspaceResources';
import { useAuth } from '../contexts/AuthContext.jsx';
import SermonResourcePicker from '../components/SermonResourcePicker.jsx';

// /sermons/new/workspace — start a brand-new sermon directly in the
// chat-revise Workspace. The lightweight intro form here only collects
// what the Workspace actually needs:
//
//   - Title (required) — gives the sermon something to be called.
//   - Scripture reference (strongly recommended) — anchors the
//     resource auto-suggest matcher and lets Claude know the text.
//   - Optional starter content — paste any stub, outline, or notes
//     to seed the manuscript. Leave blank for a true from-scratch draft;
//     Claude's first turn will draft the manuscript on the scripture.
//
// Once we've created the sermon row, navigate straight into the
// Workspace at /sermons/:id/workspace where the full chat + manuscript
// + resources flow takes over.
//
// Everything else (theme, lectionary year, strength, eulogy flag,
// preaching dates, etc.) can be filled in later from the sermon's
// detail page once the manuscript exists.
export default function SermonNewWorkspace() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [scripture, setScripture] = useState('');
  const [starter, setStarter] = useState('');
  // Resources picked from the inline picker. Empty by default. On
  // submit these get pre-attached via sermon_resources AND woven into
  // the manuscript so Claude's first turn incorporates them.
  const [pickedResources, setPickedResources] = useState([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!user?.id) {
      setError('Not signed in.');
      return;
    }
    if (
      !title.trim() &&
      !scripture.trim() &&
      !starter.trim() &&
      pickedResources.length === 0
    ) {
      setError(
        'Please give the sermon at least a title, a scripture reference, some starter content, or a resource to start from.'
      );
      return;
    }
    setCreating(true);
    setError(null);
    try {
      // Build the initial manuscript_text. When resources are picked,
      // prepend a clearly-labeled block so Claude's first chat turn
      // sees them as starting materials to weave in (the bracketed
      // instruction tells Claude not to echo the metadata in the
      // output draft).
      const starterTrimmed = starter.trim();
      let manuscript = starterTrimmed || null;
      if (pickedResources.length > 0) {
        const ctx = buildResourcesContext(pickedResources);
        const header =
          '[Starting materials provided by the pastor. Weave these into ' +
          'the sermon draft as appropriate — do not echo this header or ' +
          'the "Resource N" labels in your output.]';
        manuscript =
          header +
          '\n\n' +
          ctx +
          (starterTrimmed ? '\n\n---\n\n' + starterTrimmed : '');
      }

      const { data: created, error: err } = await withTimeout(
        supabase
          .from('sermons')
          .insert({
            owner_user_id: user.id,
            title: title.trim() || 'New sermon',
            scripture_reference: scripture.trim() || null,
            manuscript_text: manuscript,
          })
          .select('id')
          .single()
      );
      if (err) throw err;
      const sermonId = created.id;

      // Pre-attach picked resources via the sermon_resources junction
      // so they appear in the workspace's resource panel and on the
      // sermon's "Resources used" card. UPSERT-with-ignore-duplicates
      // matches what the workspace's auto-link does.
      if (pickedResources.length > 0) {
        const rows = pickedResources.map((r) => ({
          sermon_id: sermonId,
          resource_id: r.id,
          owner_user_id: user.id,
          used_notes: 'Selected at sermon creation in Draft in Workspace',
        }));
        const { error: linkErr } = await withTimeout(
          supabase
            .from('sermon_resources')
            .upsert(rows, {
              onConflict: 'sermon_id,resource_id',
              ignoreDuplicates: true,
            })
        );
        // Don't block on link failure — the manuscript already has
        // the resource content, so the pastor can re-link manually
        // later. Just surface the error.
        if (linkErr) {
          // eslint-disable-next-line no-console
          console.warn('Failed to pre-attach resources:', linkErr);
        }
      }

      navigate(`/sermons/${sermonId}/workspace`);
    } catch (e2) {
      setError(e2.message || String(e2));
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link to="/" className="text-sm text-gray-500 hover:text-gray-700">
          ← Sermons
        </Link>
        <h1 className="font-serif text-2xl text-umc-900 mt-2">
          Draft in Workspace
        </h1>
        <p className="text-sm text-gray-600 mt-1">
          Start a brand-new sermon directly in the chat-revise Workspace.
          Give it a title and scripture; Claude will help you draft and
          revise from there. You can paste a stub or outline if you've
          already started; otherwise the first chat turn drafts a
          manuscript from the scripture.
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      <form onSubmit={handleCreate} className="card space-y-4">
        <div>
          <label className="label">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder='e.g. "The Word Made Flesh"'
            className="input"
            autoFocus
          />
          <p className="text-xs text-gray-500 mt-1">
            You can change the title any time — the workspace just needs
            something to call this sermon.
          </p>
        </div>

        <div>
          <label className="label">Scripture reference</label>
          <input
            type="text"
            value={scripture}
            onChange={(e) => setScripture(e.target.value)}
            placeholder="e.g. John 1:1-14"
            className="input"
          />
          <p className="text-xs text-gray-500 mt-1">
            Strongly recommended. Drives the resource auto-suggest
            matcher and gives Claude the text to preach on.
          </p>
        </div>

        <div>
          <label className="label">
            Start from resources{' '}
            <span className="text-gray-500 font-normal">(optional)</span>
          </label>
          <SermonResourcePicker
            scriptureRef={scripture}
            selected={pickedResources}
            onChange={setPickedResources}
            disabled={creating}
          />
          <p className="text-xs text-gray-500 mt-2">
            Picked resources are pre-attached to the sermon AND seeded
            into the manuscript so Claude's first turn naturally weaves
            them in. You can add more or detach any of them later from
            inside the Workspace.
          </p>
        </div>

        <div>
          <label className="label">
            Starter content{' '}
            <span className="text-gray-500 font-normal">(optional)</span>
          </label>
          <textarea
            value={starter}
            onChange={(e) => setStarter(e.target.value)}
            rows={10}
            className="input font-serif text-sm leading-relaxed"
            placeholder={
              "Paste any starting material here — a stub paragraph, an outline, a few illustrations you want to land, an exegesis note, anything. Leave this blank to have Claude draft from scratch on the scripture."
            }
          />
          <p className="text-xs text-gray-500 mt-1">
            Whatever you put here becomes v0 of the manuscript. Claude
            will revise it on the next turn just like an existing draft.
          </p>
        </div>

        <div className="border-t border-gray-100 pt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-gray-500">
            Want all the metadata fields (theme, lectionary year, etc.)
            instead?{' '}
            <Link to="/sermons/new" className="underline hover:text-umc-700">
              Use the full New Sermon form.
            </Link>
          </p>
          <div className="flex items-center gap-2">
            <Link to="/" className="btn-secondary text-sm">
              Cancel
            </Link>
            <button
              type="submit"
              disabled={creating}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'Open Workspace ↗'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
