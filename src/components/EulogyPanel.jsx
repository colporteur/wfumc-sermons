import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';
import {
  listBackgroundDocs,
  uploadBackgroundDoc,
  deleteBackgroundDoc,
  addTextBackgroundDoc,
  addUrlBackgroundDoc,
  refreshUrlBackgroundDoc,
} from '../lib/backgroundDocs';
import {
  updateEulogyFields,
  buildPastoralRecordSource,
  assembleLifeOutline,
  suggestEulogyScriptures,
  writeLifeNarrative,
  writeScriptureNarrative,
} from '../lib/eulogy';
import { searchPeople, personDisplayName } from '../lib/congregation';

// Eulogy Mode panel — appears in the Sermon Workspace when
// sermon.is_eulogy is true. Phase 1: subject fields, source material
// (uploads / pasted text / obituary URL / Pastoral Records bridge),
// and the editable life outline. Phase 2: scripture suggestions (only
// while no scripture is chosen) and the two narrative writers, both of
// which preview here and insert into the working manuscript.
//
// Props:
//   sermon            - the eulogy sermon row
//   onSermonChange    - (updatedRow) => void — parent replaces its state
//   model             - model id from the Workspace's manuscript picker
//                       (null = proxy default); all AI actions use it
//   voicePrompt       - the pastor's voice guide (parent loads it)
//   isLocked          - manuscript lock state (blocks insertion)
//   onInsertNarrative - (text) => void — parent appends to manuscript
export default function EulogyPanel({
  sermon,
  onSermonChange,
  model,
  voicePrompt,
  isLocked,
  onInsertNarrative,
}) {
  const { user } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  // Subject fields — local drafts, saved on blur (mirrors how the
  // panel is used: type, tab away, it's saved).
  const [nameDraft, setNameDraft] = useState(sermon.deceased_name || '');
  const [scriptureDraft, setScriptureDraft] = useState(
    sermon.scripture_reference || ''
  );
  const [savingFields, setSavingFields] = useState(false);

  // Sources.
  const [docs, setDocs] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [urlDraft, setUrlDraft] = useState('');
  const [fetchingUrl, setFetchingUrl] = useState(false);
  // Which url-source doc is currently being rechecked (id or null).
  const [refreshingId, setRefreshingId] = useState(null);
  const [personQ, setPersonQ] = useState('');
  const [personResults, setPersonResults] = useState([]);
  const [searchingPerson, setSearchingPerson] = useState(false);

  // Outline.
  const [outlineDraft, setOutlineDraft] = useState(sermon.eulogy_outline || '');
  const [outlineDirty, setOutlineDirty] = useState(false);
  const [assembling, setAssembling] = useState(false);
  const [savingOutline, setSavingOutline] = useState(false);

  // Scripture suggestions (Phase 2).
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState(null); // null = not run
  const [suggestionsRaw, setSuggestionsRaw] = useState('');

  // Narratives (Phase 2). One preview slot — writing a new narrative
  // replaces the preview, never the manuscript (insertion is explicit).
  const [writing, setWriting] = useState(null); // null | 'life' | 'scripture'
  const [narrative, setNarrative] = useState(null); // { kind, text }

  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!sermon?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listBackgroundDocs(sermon.id);
        if (!cancelled) setDocs(rows.map((r) => ({ ...r, _on: true })));
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sermon?.id]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  // ---- field saves ----------------------------------------------------

  async function saveFields(patch) {
    setSavingFields(true);
    setError(null);
    try {
      const updated = await updateEulogyFields(sermon, patch);
      onSermonChange(updated);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingFields(false);
    }
  }

  // ---- sources --------------------------------------------------------

  async function handleUpload(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of files) {
        const row = await uploadBackgroundDoc({
          sermonId: sermon.id,
          ownerUserId: user.id,
          file,
        });
        setDocs((cur) => [{ ...row, _on: true }, ...cur]);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handlePaste(e) {
    e?.preventDefault?.();
    setError(null);
    try {
      const row = await addTextBackgroundDoc({
        sermonId: sermon.id,
        ownerUserId: user.id,
        title: pasteTitle || 'Conversation notes',
        text: pasteText,
      });
      setDocs((cur) => [{ ...row, _on: true }, ...cur]);
      setPasteTitle('');
      setPasteText('');
      setPasteOpen(false);
      setNotice('Notes saved as a source.');
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleFetchUrl(e) {
    e?.preventDefault?.();
    if (!urlDraft.trim()) return;
    setFetchingUrl(true);
    setError(null);
    try {
      const row = await addUrlBackgroundDoc({
        sermonId: sermon.id,
        ownerUserId: user.id,
        url: urlDraft.trim(),
      });
      setDocs((cur) => [{ ...row, _on: true }, ...cur]);
      setUrlDraft('');
      setNotice(`Fetched "${row.title}".`);
    } catch (err) {
      setError(err.message);
    } finally {
      setFetchingUrl(false);
    }
  }

  async function handlePersonSearch(e) {
    e?.preventDefault?.();
    if (!personQ.trim()) return;
    setSearchingPerson(true);
    setError(null);
    try {
      const rows = await searchPeople(personQ);
      setPersonResults(rows);
      if (!rows.length) setNotice('No one in Pastoral Records matches that.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSearchingPerson(false);
    }
  }

  async function pullPersonRecord(personRow) {
    setError(null);
    try {
      const row = await buildPastoralRecordSource({
        sermonId: sermon.id,
        ownerUserId: user.id,
        personId: personRow.id,
      });
      setDocs((cur) => [{ ...row, _on: true }, ...cur]);
      setPersonResults([]);
      setPersonQ('');
      setNotice(`Pulled ${personDisplayName(personRow)}'s record in as a source.`);
      // Convenience: if the name field is still empty, fill it.
      if (!(sermon.deceased_name || '').trim()) {
        const display = personDisplayName(personRow);
        setNameDraft(display);
        saveFields({ deceased_name: display });
      }
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleDoc(id) {
    setDocs((cur) => cur.map((d) => (d.id === id ? { ...d, _on: !d._on } : d)));
  }

  // Recheck a URL source — tribute walls gather new comments over
  // days, so the pastor can re-pull the page without re-adding it.
  async function recheckUrlDoc(doc) {
    setRefreshingId(doc.id);
    setError(null);
    try {
      const { row, changed, newLineCount } = await refreshUrlBackgroundDoc(doc);
      setDocs((cur) =>
        cur.map((d) => (d.id === row.id ? { ...row, _on: d._on } : d))
      );
      if (!changed) {
        setNotice('No changes since the last fetch.');
      } else if (newLineCount > 0) {
        setNotice(
          `Updated — ${newLineCount} new line${newLineCount === 1 ? '' : 's'} since last fetch (new tributes, most likely). ` +
            'Run "Update outline from sources" to fold them in.'
        );
      } else {
        setNotice('Page content changed since the last fetch — stored text updated.');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshingId(null);
    }
  }

  async function removeDoc(doc) {
    if (!window.confirm(`Remove source "${doc.title}"?`)) return;
    try {
      await deleteBackgroundDoc(doc);
      setDocs((cur) => cur.filter((d) => d.id !== doc.id));
    } catch (e) {
      setError(e.message);
    }
  }

  function docKindLabel(d) {
    if (d.kind === 'text') return 'pasted';
    if (d.kind === 'url') return 'web';
    if (d.kind === 'image') return 'image';
    if (d.kind === 'pdf_scanned') return 'scan';
    return 'pdf';
  }

  // ---- outline --------------------------------------------------------

  async function handleAssemble() {
    setAssembling(true);
    setError(null);
    try {
      const outline = await assembleLifeOutline({
        sermon,
        docs: docs.filter((d) => d._on),
        existingOutline: outlineDraft,
        model,
      });
      setOutlineDraft(outline);
      setOutlineDirty(true);
      setNotice(
        outlineDraft.trim()
          ? 'Outline updated — your edits were kept as the base. Review and save.'
          : 'Outline assembled. Edit freely, then save.'
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setAssembling(false);
    }
  }

  async function saveOutline() {
    setSavingOutline(true);
    setError(null);
    try {
      const updated = await updateEulogyFields(sermon, {
        eulogy_outline: outlineDraft,
      });
      onSermonChange(updated);
      setOutlineDirty(false);
      setNotice('Outline saved.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingOutline(false);
    }
  }

  // ---- scripture suggestions (Phase 2) --------------------------------

  async function handleSuggestScriptures() {
    setSuggesting(true);
    setError(null);
    try {
      const { suggestions: parsed, raw } = await suggestEulogyScriptures({
        sermon,
        docs: docs.filter((d) => d._on),
        outline: outlineDraft,
        model,
      });
      setSuggestions(parsed);
      setSuggestionsRaw(raw);
      if (!parsed.length) {
        setNotice('Suggestions came back unstructured — showing them as text.');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSuggesting(false);
    }
  }

  function useSuggestion(reference) {
    setScriptureDraft(reference);
    saveFields({ scripture_reference: reference });
    setSuggestions(null);
    setSuggestionsRaw('');
    setNotice(`Scripture set: ${reference}`);
  }

  // ---- narratives (Phase 2) --------------------------------------------

  async function handleWriteNarrative(kind) {
    setWriting(kind);
    setError(null);
    try {
      const args = {
        sermon,
        outline: outlineDraft,
        docs: docs.filter((d) => d._on),
        voicePrompt,
        model,
      };
      const text =
        kind === 'life'
          ? await writeLifeNarrative(args)
          : await writeScriptureNarrative(args);
      setNarrative({ kind, text });
    } catch (e) {
      setError(e.message);
    } finally {
      setWriting(null);
    }
  }

  function insertNarrative() {
    if (!narrative) return;
    if (isLocked) {
      window.alert('The manuscript is finalized. Unlock it to insert.');
      return;
    }
    onInsertNarrative?.(narrative.text);
    setNarrative(null);
    setNotice('Inserted at the end of the manuscript.');
  }

  // ---- render ---------------------------------------------------------

  return (
    <div className="card space-y-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="font-serif text-lg text-umc-900">
          Eulogy
          {sermon.deceased_name && (
            <span className="ml-2 text-base font-normal text-gray-500">
              {sermon.deceased_name}
            </span>
          )}
        </h2>
        <button
          type="button"
          className="text-xs text-gray-500 hover:text-gray-800 underline"
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Subject fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="text-xs text-gray-600">
              Deceased's name
              <input
                className="input text-sm mt-0.5"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => {
                  if (nameDraft !== (sermon.deceased_name || '')) {
                    saveFields({ deceased_name: nameDraft.trim() || null });
                  }
                }}
                placeholder="Full name"
              />
            </label>
            <label className="text-xs text-gray-600">
              Scripture (optional — leave blank and use Suggest Scripture below)
              <input
                className="input text-sm mt-0.5"
                value={scriptureDraft}
                onChange={(e) => setScriptureDraft(e.target.value)}
                onBlur={() => {
                  if (scriptureDraft !== (sermon.scripture_reference || '')) {
                    saveFields({
                      scripture_reference: scriptureDraft.trim() || null,
                    });
                  }
                }}
                placeholder="e.g., Psalm 23; John 14:1-6"
              />
            </label>
          </div>

          {/* Scripture suggestions — only while no scripture is chosen */}
          {!(sermon.scripture_reference || '').trim() && (
            <div className="space-y-1">
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={handleSuggestScriptures}
                disabled={suggesting}
                title="Suggest passages whose themes resonate with this particular life — drawn from the outline and sources."
              >
                {suggesting ? 'Discerning…' : '✨ Suggest Scripture'}
              </button>
              {suggestions && suggestions.length > 0 && (
                <ul className="space-y-1">
                  {suggestions.map((s, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 text-sm bg-amber-50/60 rounded px-2 py-1.5"
                    >
                      <button
                        type="button"
                        className="btn-secondary text-xs shrink-0"
                        onClick={() => useSuggestion(s.reference)}
                        title="Set this as the eulogy's scripture"
                      >
                        Use
                      </button>
                      <span>
                        <span className="font-medium">{s.reference}</span>
                        {' — '}
                        <span className="text-gray-700">{s.rationale}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {suggestions && suggestions.length === 0 && suggestionsRaw && (
                <div className="text-sm whitespace-pre-wrap bg-amber-50/60 rounded px-2 py-1.5">
                  {suggestionsRaw}
                </div>
              )}
            </div>
          )}

          {/* Sources */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-gray-700">Sources:</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.txt,.md,application/pdf,image/jpeg,image/png,text/plain,text/markdown"
                multiple
                className="hidden"
                onChange={(e) => handleUpload(e.target.files)}
              />
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                title="Upload transcripts, letters, photos, scanned clippings (.pdf/.jpg/.png/.txt/.md). Text files are read directly; scans and images go to Claude vision."
              >
                {uploading ? 'Uploading…' : '+ Upload files'}
              </button>
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => setPasteOpen((v) => !v)}
              >
                {pasteOpen ? 'Cancel paste' : '+ Paste notes'}
              </button>
              <form onSubmit={handleFetchUrl} className="flex gap-1">
                <input
                  className="input text-xs py-1"
                  placeholder="Obituary URL…"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                />
                <button
                  className="btn-secondary text-xs"
                  disabled={fetchingUrl || !urlDraft.trim()}
                >
                  {fetchingUrl ? 'Fetching…' : 'Fetch'}
                </button>
              </form>
              <form onSubmit={handlePersonSearch} className="flex gap-1">
                <input
                  className="input text-xs py-1"
                  placeholder="Pull from Pastoral Records…"
                  value={personQ}
                  onChange={(e) => setPersonQ(e.target.value)}
                />
                <button
                  className="btn-secondary text-xs"
                  disabled={searchingPerson || !personQ.trim()}
                >
                  {searchingPerson ? 'Searching…' : 'Find'}
                </button>
              </form>
            </div>

            {personResults.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {personResults.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="rounded-full border px-2 py-0.5 text-xs hover:bg-gray-50"
                    onClick={() => pullPersonRecord(r)}
                    title="Pull this person's directory profile + eulogy notes in as a source"
                  >
                    + {personDisplayName(r)}
                  </button>
                ))}
              </div>
            )}

            {pasteOpen && (
              <form onSubmit={handlePaste} className="space-y-1">
                <input
                  className="input text-sm"
                  placeholder="Source title (e.g., 'Conversation with Martha, July 3')"
                  value={pasteTitle}
                  onChange={(e) => setPasteTitle(e.target.value)}
                />
                <textarea
                  className="input text-sm"
                  rows={5}
                  placeholder="Paste conversation notes, memories, or transcript text…"
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                />
                <button
                  className="btn-primary text-xs"
                  disabled={!pasteText.trim()}
                >
                  Save as source
                </button>
              </form>
            )}

            {docs.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {docs.map((d) => (
                  <span
                    key={d.id}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                      d._on
                        ? 'bg-sky-100 text-sky-900'
                        : 'bg-gray-100 text-gray-500 line-through'
                    }`}
                    title={
                      (d._on
                        ? 'ON — feeds outline assembly, scripture suggestions, and the narratives. '
                        : 'OFF — held aside. ') + `Kind: ${docKindLabel(d)}.`
                    }
                  >
                    <button type="button" onClick={() => toggleDoc(d.id)}>
                      {d._on ? '●' : '○'}
                    </button>
                    📄 {d.title}
                    <span className="text-[10px] uppercase">{docKindLabel(d)}</span>
                    {d.kind === 'url' && (
                      <button
                        type="button"
                        className="hover:text-sky-700 disabled:opacity-50"
                        disabled={refreshingId === d.id}
                        onClick={() => recheckUrlDoc(d)}
                        title="Recheck this page — tribute walls collect new comments over time. Re-fetches and reports what's new."
                      >
                        {refreshingId === d.id ? '…' : '↻'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="hover:text-red-700"
                      onClick={() => removeDoc(d)}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Outline */}
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-gray-700">
                Life outline
              </span>
              <button
                type="button"
                className="btn-primary text-xs"
                onClick={handleAssemble}
                disabled={assembling}
                title={
                  outlineDraft.trim()
                    ? 'Re-run with the sources — your edited outline is kept as the base, never clobbered.'
                    : 'Assemble a detailed chronological account of the life from the switched-on sources.'
                }
              >
                {assembling
                  ? 'Assembling…'
                  : outlineDraft.trim()
                  ? '✨ Update outline from sources'
                  : '✨ Assemble life outline'}
              </button>
              {outlineDirty && (
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  onClick={saveOutline}
                  disabled={savingOutline}
                >
                  {savingOutline ? 'Saving…' : 'Save outline'}
                </button>
              )}
              {outlineDirty && (
                <span className="text-xs text-amber-700">Unsaved changes</span>
              )}
              {savingFields && (
                <span className="text-xs text-gray-400">Saving…</span>
              )}
            </div>
            <textarea
              className="input text-sm font-serif leading-relaxed"
              rows={outlineDraft ? 14 : 3}
              placeholder="The detailed order of the life will appear here — or start typing it yourself. Add, edit, reorder freely; this is the base the narrative will be written from."
              value={outlineDraft}
              onChange={(e) => {
                setOutlineDraft(e.target.value);
                setOutlineDirty(true);
              }}
            />
          </div>

          {/* Narratives (Phase 2) */}
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-gray-700">
                Narratives
              </span>
              <button
                type="button"
                className="btn-primary text-xs"
                onClick={() => handleWriteNarrative('life')}
                disabled={writing !== null || !outlineDraft.trim()}
                title={
                  !outlineDraft.trim()
                    ? 'Assemble or write the life outline first.'
                    : 'Write the story of the life from your (edited) outline. Previews below — nothing touches the manuscript until you insert.'
                }
              >
                {writing === 'life' ? 'Writing…' : '📄 Write life narrative'}
              </button>
              <button
                type="button"
                className="btn-primary text-xs"
                onClick={() => handleWriteNarrative('scripture')}
                disabled={
                  writing !== null ||
                  !outlineDraft.trim() ||
                  !(sermon.scripture_reference || '').trim()
                }
                title={
                  !(sermon.scripture_reference || '').trim()
                    ? 'Choose a scripture first (enter one or use a suggestion).'
                    : !outlineDraft.trim()
                    ? 'Assemble or write the life outline first.'
                    : "Write the movement that connects this life to the chosen text's themes. Previews below."
                }
              >
                {writing === 'scripture'
                  ? 'Writing…'
                  : '📄 Write Scripture connection'}
              </button>
            </div>
            {narrative && (
              <div className="border rounded-md p-2 space-y-2 bg-gray-50">
                <p className="text-xs text-gray-500">
                  {narrative.kind === 'life'
                    ? 'Life narrative'
                    : `Scripture connection — ${sermon.scripture_reference}`}{' '}
                  (preview — not in the manuscript yet)
                </p>
                <div className="text-sm font-serif whitespace-pre-wrap max-h-80 overflow-y-auto">
                  {narrative.text}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-primary text-xs"
                    onClick={insertNarrative}
                  >
                    Insert into manuscript
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => handleWriteNarrative(narrative.kind)}
                    disabled={writing !== null}
                  >
                    Rewrite
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => setNarrative(null)}
                  >
                    Discard
                  </button>
                </div>
              </div>
            )}
          </div>

          {(error || notice) && (
            <div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              {notice && <p className="text-sm text-emerald-700">{notice}</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
