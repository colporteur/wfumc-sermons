import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';
import {
  searchResources,
  suggestResourcesByScripture,
} from '../lib/workspaceResources';
import {
  CREATIVE_TECHNIQUES,
  TECHNIQUE_CATEGORIES,
  techniquesForMode,
  drawTechniqueCards,
  randomEpigraph,
} from '../lib/creativeTechniques';
import {
  loadCreativeModelKey,
  saveCreativeModelKey,
} from '../lib/creativeModel';
import {
  useModelOptions,
  modelIdForOption,
  shortLabelForOption,
  displayKeyForOption,
} from '../lib/aiModels';
import {
  listCreativeSessions,
  createCreativeSession,
  updateCreativeSession,
  deleteCreativeSession,
  appendSessionMessages,
  runCreativeTurn,
  modeLabel,
  CRITIQUE_TOOLS,
  critiqueToolByKey,
} from '../lib/creativeStudio';
import {
  RUNNING_LISTS,
  listLabel,
  fetchListItems,
  addListItem,
  toggleListItemUsed,
  deleteListItem,
  buildListsContext,
  buildWeaveInstruction,
  splitBrainstormItems,
} from '../lib/creativeLists';
import { supabase, withTimeout } from '../lib/supabase';
import { createStashedBlock } from '../lib/sermonStashedBlocks';
import {
  listBackgroundDocs,
  uploadBackgroundDoc,
  deleteBackgroundDoc,
  buildBackgroundDocsContext,
} from '../lib/backgroundDocs';
import {
  searchPeople,
  personDisplayName,
  buildCongregationContext,
} from '../lib/congregation';

// Creative Studio — full-screen brainstorming overlay for the Sermon
// Workspace. Operationalizes the pastor's twelve sermon-tips documents
// (via lib/creativeTechniques.js) as an AI ideation surface.
//
// Three modes (exegesis / illustration / balanced), per-call model
// picker (Haiku 4.5 → Fable 5), toggleable context sources (manuscript,
// library resources, technique cards), and two output actions:
//   Brainstorm — numbered provocations, never prose
//   Draft      — manuscript-ready copy with Insert / Stash actions
//
// Threads persist in sermon_creative_sessions (migration 0068).
//
// Props:
//   open            - boolean
//   onClose         - () => void
//   sermon          - sermon row (id, title, scripture_reference, theme)
//   manuscript      - current working manuscript text
//   voicePrompt     - the pastor's voice guide (parent already loads it)
//   onInsertDraft   - (text) => void — parent appends into manuscript
//   onSendToChat    - (text) => void — parent pre-fills the Workspace
//                     revision-chat composer (used by "Weave" on lists);
//                     the Studio closes so the pastor lands on the chat
export default function CreativeStudio({
  open,
  onClose,
  sermon,
  manuscript,
  voicePrompt,
  onInsertDraft,
  onSendToChat,
}) {
  const { user } = useAuth();

  // ---- threads ------------------------------------------------------
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const active = sessions.find((s) => s.id === activeId) || null;

  // ---- controls -----------------------------------------------------
  // Mode lives on the thread once one exists; before the first send we
  // track it locally so the pastor can set up before committing a row.
  const [localMode, setLocalMode] = useState('balanced');
  const mode = active ? active.mode : localMode;

  const [modelKey, setModelKey] = useState(loadCreativeModelKey);
  // Registry-driven options ('creative' surface); hardcoded fallback
  // renders instantly. Managed in Bulletin App → Settings → AI Models.
  const modelOptions = useModelOptions('creative');

  // ---- context mix --------------------------------------------------
  const [includeManuscript, setIncludeManuscript] = useState(true);
  // [{ ...resourceRow, _on: true }]
  const [resources, setResources] = useState([]);
  const [selectedTechniqueIds, setSelectedTechniqueIds] = useState([]);
  const [contextOpen, setContextOpen] = useState(true);
  const [browseOpen, setBrowseOpen] = useState(false);

  // resource search
  const [resQ, setResQ] = useState('');
  const [resResults, setResResults] = useState([]);
  const [resSearching, setResSearching] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  // Which selected resource is open in the preview card (id or null).
  // Lets the pastor read exactly what each scripture-matched resource
  // says before deciding which ones stay on for the turn.
  const [previewId, setPreviewId] = useState(null);

  // Background documents (Phase 2). Rows carry a per-session _on toggle
  // (default on) and an in-memory _visionCache the context builder
  // fills so repeated turns don't re-download/re-render.
  const [bgDocs, setBgDocs] = useState([]);
  const [bgUploading, setBgUploading] = useState(false);
  const fileInputRef = useRef(null);

  // Specific Pews (Phase 4): real parishioners as lenses. Rows carry a
  // per-session _on toggle and a _ctxCache the congregation lib fills.
  // Selection is session-only by design — who's on the pastor's mind
  // for THIS sitting isn't something to persist.
  const [people, setPeople] = useState([]);
  const [peopleQ, setPeopleQ] = useState('');
  const [peopleResults, setPeopleResults] = useState([]);
  const [peopleSearching, setPeopleSearching] = useState(false);

  // Running Lists (Phase 3).
  const [listItems, setListItems] = useState([]);
  const [listsOpen, setListsOpen] = useState(false);
  const [includeLists, setIncludeLists] = useState(true);
  // Target list for one-click filing from brainstorm items.
  const [fileTargetKey, setFileTargetKey] = useState('golden_phrases');
  const [newItemKey, setNewItemKey] = useState('golden_phrases');
  const [newItemText, setNewItemText] = useState('');

  // Critique tool selection (Phase 3).
  const [critiqueKey, setCritiqueKey] = useState('succes');
  // Message ids already saved to the resource library this session
  // (index-keyed; prevents accidental double-saves).
  const [savedToLibrary, setSavedToLibrary] = useState(new Set());

  // ---- composer -----------------------------------------------------
  const [instruction, setInstruction] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const epigraph = useMemo(() => randomEpigraph(), []);
  const scrollRef = useRef(null);

  const selectedTechniques = useMemo(
    () =>
      selectedTechniqueIds
        .map((id) => CREATIVE_TECHNIQUES.find((t) => t.id === id))
        .filter(Boolean),
    [selectedTechniqueIds]
  );

  // ---- load threads on open ------------------------------------------
  useEffect(() => {
    if (!open || !sermon?.id) return;
    let cancelled = false;
    (async () => {
      setLoadingSessions(true);
      try {
        const rows = await listCreativeSessions(sermon.id);
        if (cancelled) return;
        setSessions(rows);
        if (rows.length > 0) setActiveId((cur) => cur || rows[0].id);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoadingSessions(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sermon?.id]);

  // Load running-list items on open.
  useEffect(() => {
    if (!open || !sermon?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchListItems(sermon.id);
        if (!cancelled) setListItems(rows);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sermon?.id]);

  // Load background documents on open.
  useEffect(() => {
    if (!open || !sermon?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listBackgroundDocs(sermon.id);
        if (!cancelled) {
          setBgDocs(rows.map((r) => ({ ...r, _on: true })));
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sermon?.id]);

  // Autoscroll to latest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId, active?.messages?.length, sending]);

  // Clear transient notice after a beat.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  if (!open) return null;

  // ---- handlers -----------------------------------------------------

  async function setMode(next) {
    if (active) {
      try {
        const updated = await updateCreativeSession(active.id, { mode: next });
        setSessions((cur) => cur.map((s) => (s.id === updated.id ? updated : s)));
      } catch (e) {
        setError(e.message);
      }
    } else {
      setLocalMode(next);
    }
  }

  function pickModel(key) {
    setModelKey(key);
    saveCreativeModelKey(key);
  }

  async function runResourceSearch(e) {
    e?.preventDefault?.();
    const q = resQ.trim();
    if (!q) return;
    setResSearching(true);
    setError(null);
    try {
      const rows = await searchResources(q);
      setResResults(rows);
    } catch (err) {
      setError(err.message);
    } finally {
      setResSearching(false);
    }
  }

  async function suggestByScripture() {
    if (!sermon?.scripture_reference) return;
    setSuggesting(true);
    setError(null);
    try {
      const rows = await suggestResourcesByScripture(sermon.scripture_reference);
      const have = new Set(resources.map((r) => r.id));
      const fresh = (rows || []).filter((r) => !have.has(r.id));
      setResources((cur) => [...cur, ...fresh.map((r) => ({ ...r, _on: true }))]);
      if (!fresh.length) setNotice('No new scripture-matched resources found.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSuggesting(false);
    }
  }

  function addResource(row) {
    setResources((cur) =>
      cur.some((r) => r.id === row.id) ? cur : [...cur, { ...row, _on: true }]
    );
    setResResults((cur) => cur.filter((r) => r.id !== row.id));
  }

  function toggleResource(id) {
    setResources((cur) =>
      cur.map((r) => (r.id === id ? { ...r, _on: !r._on } : r))
    );
  }

  function removeResource(id) {
    setResources((cur) => cur.filter((r) => r.id !== id));
    setPreviewId((cur) => (cur === id ? null : cur));
  }

  async function handleUploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setBgUploading(true);
    setError(null);
    try {
      for (const file of files) {
        const row = await uploadBackgroundDoc({
          sermonId: sermon.id,
          ownerUserId: user.id,
          file,
        });
        setBgDocs((cur) => [{ ...row, _on: true }, ...cur]);
        setNotice(
          row.kind === 'pdf_text'
            ? `Added "${row.title}" — text extracted (${row.page_count} page${
                row.page_count === 1 ? '' : 's'
              }).`
            : row.kind === 'pdf_scanned'
            ? `Added "${row.title}" — scanned PDF; pages go to Claude as images.`
            : `Added "${row.title}".`
        );
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBgUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function toggleBgDoc(id) {
    setBgDocs((cur) =>
      cur.map((d) => (d.id === id ? { ...d, _on: !d._on } : d))
    );
  }

  async function removeBgDoc(doc) {
    if (!window.confirm(`Remove "${doc.title}" from this sermon's background documents?`)) {
      return;
    }
    try {
      await deleteBackgroundDoc(doc);
      setBgDocs((cur) => cur.filter((d) => d.id !== doc.id));
    } catch (e) {
      setError(e.message);
    }
  }

  // ---- Specific Pews handlers (Phase 4) ------------------------------

  async function runPeopleSearch(e) {
    e?.preventDefault?.();
    const q = peopleQ.trim();
    if (!q) return;
    setPeopleSearching(true);
    setError(null);
    try {
      const rows = await searchPeople(q);
      const have = new Set(people.map((p) => p.id));
      setPeopleResults(rows.filter((r) => !have.has(r.id)));
      if (!rows.length) setNotice('No one in Pastoral Records matches that.');
    } catch (err) {
      setError(err.message);
    } finally {
      setPeopleSearching(false);
    }
  }

  function addPerson(row) {
    setPeople((cur) =>
      cur.some((p) => p.id === row.id) ? cur : [...cur, { ...row, _on: true }]
    );
    setPeopleResults((cur) => cur.filter((r) => r.id !== row.id));
  }

  function togglePerson(id) {
    setPeople((cur) =>
      cur.map((p) => (p.id === id ? { ...p, _on: !p._on } : p))
    );
  }

  function removePerson(id) {
    setPeople((cur) => cur.filter((p) => p.id !== id));
  }

  // ---- Running Lists handlers (Phase 3) -----------------------------

  async function fileToList(content, listKey) {
    try {
      const row = await addListItem({
        sermonId: sermon.id,
        ownerUserId: user.id,
        listKey,
        content,
        source: 'studio',
      });
      setListItems((cur) => [...cur, row]);
      setNotice(`Filed to ${listLabel(listKey)}.`);
    } catch (e) {
      setError(e.message);
    }
  }

  async function addManualItem(e) {
    e?.preventDefault?.();
    const body = newItemText.trim();
    if (!body) return;
    try {
      const row = await addListItem({
        sermonId: sermon.id,
        ownerUserId: user.id,
        listKey: newItemKey,
        content: body,
        source: 'manual',
      });
      setListItems((cur) => [...cur, row]);
      setNewItemText('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleToggleUsed(item) {
    try {
      const updated = await toggleListItemUsed(item);
      setListItems((cur) => cur.map((i) => (i.id === updated.id ? updated : i)));
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleDeleteItem(id) {
    try {
      await deleteListItem(id);
      setListItems((cur) => cur.filter((i) => i.id !== id));
    } catch (e) {
      setError(e.message);
    }
  }

  function weaveList(listKey) {
    const instruction = buildWeaveInstruction(listKey, listItems);
    if (!instruction) {
      setNotice('Nothing live on that list to weave.');
      return;
    }
    if (onSendToChat) {
      onSendToChat(instruction);
      onClose();
    }
  }

  // ---- Save a Studio output to the resource library ------------------

  async function saveMessageToLibrary(m, idx) {
    try {
      const { error: insErr } = await withTimeout(
        supabase.from('resources').insert({
          owner_user_id: user.id,
          resource_type: 'note',
          title: `Studio ${m.kind === 'draft' ? 'draft' : 'brainstorm'}: ${
            sermon?.title || sermon?.scripture_reference || 'sermon'
          }`,
          content: m.content,
          source: 'Creative Studio',
          scripture_refs: sermon?.scripture_reference || null,
          notes: `Saved from Creative Studio (${modeLabel(m.mode)} mode).`,
        })
      );
      if (insErr) throw insErr;
      setSavedToLibrary((cur) => new Set(cur).add(idx));
      setNotice('Saved to your resource library (as a note — retype/tag it there anytime).');
    } catch (e) {
      setError(e.message);
    }
  }

  // ---- Critique (Phase 3) --------------------------------------------

  function runCritique() {
    const tool = critiqueToolByKey(critiqueKey);
    if (!tool) return;
    if (!manuscript || !manuscript.trim()) {
      setError('Critiques need a working manuscript — write something first.');
      return;
    }
    send('critique', { presetAsk: tool.ask, displayAsk: `Run: ${tool.label}` });
  }

  function toggleTechnique(id) {
    setSelectedTechniqueIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    );
  }

  function drawCard() {
    const pool = techniquesForMode(mode).filter(
      (t) => !selectedTechniqueIds.includes(t.id)
    );
    if (!pool.length) {
      setNotice('Every card for this mode is already in play.');
      return;
    }
    const [card] = drawTechniqueCards(mode, 1).filter(
      (t) => !selectedTechniqueIds.includes(t.id)
    );
    const pick = card || pool[Math.floor(Math.random() * pool.length)];
    setSelectedTechniqueIds((cur) => [...cur, pick.id]);
    setNotice(`Drew: ${pick.name} (${pick.source})`);
  }

  async function newThread() {
    try {
      const row = await createCreativeSession({
        sermonId: sermon.id,
        ownerUserId: user.id,
        mode,
      });
      setSessions((cur) => [row, ...cur]);
      setActiveId(row.id);
    } catch (e) {
      setError(e.message);
    }
  }

  async function removeThread(id) {
    if (!window.confirm('Delete this thread and its ideas?')) return;
    try {
      await deleteCreativeSession(id);
      setSessions((cur) => cur.filter((s) => s.id !== id));
      if (activeId === id) setActiveId(null);
    } catch (e) {
      setError(e.message);
    }
  }

  async function send(kind, { presetAsk = null, displayAsk = null } = {}) {
    const text = instruction.trim();
    const defaultAsk =
      kind === 'brainstorm'
        ? 'Open this text up for me. Where are the live wires?'
        : 'Draft a passage for where the sermon is headed.';
    const ask = presetAsk || text || defaultAsk;
    // What lands in the visible thread — critiques store their short
    // label rather than the full canned instruction.
    const shownAsk = displayAsk || ask;

    setSending(true);
    setError(null);
    try {
      // Ensure a thread exists.
      let session = active;
      if (!session) {
        session = await createCreativeSession({
          sermonId: sermon.id,
          ownerUserId: user.id,
          mode,
        });
        setSessions((cur) => [session, ...cur]);
        setActiveId(session.id);
      }

      const modelId = modelIdForOption(modelOptions, modelKey);
      const onResources = resources.filter((r) => r._on);

      // Background docs: text for extracted PDFs, vision blocks for
      // images/scans. Downloads + page renders are cached on the doc
      // objects, so only the first turn with a given doc pays the cost.
      const { textBlock, imageBlocks } = await buildBackgroundDocsContext(
        bgDocs.filter((d) => d._on)
      );

      // Running lists ride along (unless toggled off) so Claude builds
      // on what's already been collected instead of re-inventing it.
      const listsBlock = includeLists ? buildListsContext(listItems) : '';
      const extraContext = [listsBlock, textBlock]
        .filter(Boolean)
        .join('\n\n---\n\n');

      // Specific Pews: toggled-on parishioners (profile + interaction
      // summaries, cached per person). Presence of this block also
      // activates the first-names-only / lens-not-material rules in
      // the system prompt.
      const congregationContext = await buildCongregationContext(
        people.filter((p) => p._on)
      );

      const reply = await runCreativeTurn({
        kind,
        mode: session.mode,
        sermon,
        // Critiques are meaningless without the manuscript — force it
        // on regardless of the context-mix toggle.
        manuscript:
          kind === 'critique' || includeManuscript ? manuscript : '',
        resources: onResources,
        techniques: selectedTechniques,
        voicePrompt: kind === 'draft' ? voicePrompt : '',
        extraContext,
        congregationContext,
        imageBlocks,
        history: session.messages || [],
        instruction: ask,
        model: modelId,
      });

      const now = new Date().toISOString();
      const newMessages = [
        { role: 'user', kind, content: shownAsk, mode: session.mode, at: now },
        {
          role: 'assistant',
          kind,
          content: reply,
          mode: session.mode,
          model: modelId,
          techniques: selectedTechniques.map((t) => t.id),
          at: now,
        },
      ];
      const updated = await appendSessionMessages(session.id, newMessages);
      setSessions((cur) => cur.map((s) => (s.id === updated.id ? updated : s)));
      setInstruction('');
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  function insertDraft(text) {
    onInsertDraft?.(text);
    setNotice('Inserted at the end of the manuscript.');
  }

  async function stashDraft(text) {
    try {
      await createStashedBlock({
        sermonId: sermon.id,
        ownerUserId: user.id,
        title: `Creative Studio ${modeLabel(mode).toLowerCase()} draft`,
        body: text,
        source: 'Creative Studio',
        sourceScripture: sermon?.scripture_reference || null,
      });
      setNotice('Stashed — it will be waiting in Stashed Blocks.');
    } catch (e) {
      setError(e.message);
    }
  }

  // ---- render helpers -----------------------------------------------

  const modeButtons = [
    { key: 'exegesis', label: 'Exegesis focus' },
    { key: 'illustration', label: 'Illustration focus' },
    { key: 'balanced', label: 'Balanced' },
  ];

  const categoriesInMode = Object.entries(TECHNIQUE_CATEGORIES).filter(
    ([key]) => techniquesForMode(mode).some((t) => t.category === key)
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-stretch justify-center">
      <div className="bg-white w-full h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 border-b px-4 py-2">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold leading-tight">
              Creative Studio ✨
            </h2>
            <p className="text-xs italic text-gray-500 truncate" title={epigraph}>
              {epigraph}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <select
              className="input text-sm py-1"
              value={displayKeyForOption(modelOptions, modelKey)}
              onChange={(e) => pickModel(e.target.value)}
              title="Which model handles Studio turns. Applies per call. Manage the list in Bulletin App → Settings → AI Models."
            >
              {modelOptions.map((opt) => (
                <option key={opt.key} value={opt.key} title={opt.hint}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button className="btn-secondary text-sm" onClick={onClose}>
              Back to manuscript
            </button>
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Threads sidebar */}
          <div className="w-56 shrink-0 border-r flex flex-col">
            <div className="p-2 border-b">
              <button className="btn-secondary w-full text-sm" onClick={newThread}>
                + New thread
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loadingSessions && (
                <p className="p-3 text-sm text-gray-500">Loading…</p>
              )}
              {!loadingSessions && sessions.length === 0 && (
                <p className="p-3 text-xs text-gray-500">
                  No threads yet. Set your mode and context, then Brainstorm —
                  a thread starts automatically.
                </p>
              )}
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className={`group flex items-start justify-between gap-1 px-3 py-2 cursor-pointer border-b text-sm ${
                    s.id === activeId ? 'bg-indigo-50' : 'hover:bg-gray-50'
                  }`}
                  onClick={() => setActiveId(s.id)}
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{s.title || 'Untitled'}</p>
                    <p className="text-xs text-gray-500">
                      {modeLabel(s.mode)} · {(s.messages || []).length} turns
                    </p>
                  </div>
                  <button
                    className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 text-xs"
                    title="Delete thread"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeThread(s.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Main column */}
          <div className="flex-1 min-w-0 flex flex-col">
            {/* Mode + context bar */}
            <div className="border-b px-4 py-2 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-md border overflow-hidden">
                  {modeButtons.map((m) => (
                    <button
                      key={m.key}
                      className={`px-3 py-1 text-sm ${
                        mode === m.key
                          ? 'bg-indigo-600 text-white'
                          : 'bg-white hover:bg-gray-50'
                      }`}
                      onClick={() => setMode(m.key)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <button
                  className="btn-secondary text-sm"
                  onClick={drawCard}
                  title="Draw a random technique card from your own method (mode-filtered)"
                >
                  Draw a card
                </button>
                <button
                  className="text-sm text-indigo-700 underline"
                  onClick={() => setContextOpen((v) => !v)}
                >
                  {contextOpen ? 'Hide context mix' : 'Show context mix'}
                </button>
                <button
                  className="text-sm text-indigo-700 underline"
                  onClick={() => setListsOpen((v) => !v)}
                  title="Per-sermon running lists from your Exegete-a-Con-Text method: golden phrases, sticky stories, humor log, titles…"
                >
                  {listsOpen ? 'Close Running Lists' : 'Running Lists'}
                  {listItems.filter((i) => !i.used_at).length > 0 &&
                    ` (${listItems.filter((i) => !i.used_at).length})`}
                </button>
              </div>

              {contextOpen && (
                <div className="space-y-2">
                  {/* Toggles summary row */}
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <label className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={includeManuscript}
                        onChange={(e) => setIncludeManuscript(e.target.checked)}
                      />
                      Working manuscript
                    </label>
                    <span className="text-gray-400">·</span>
                    <span className="text-gray-600">
                      {resources.filter((r) => r._on).length}/{resources.length}{' '}
                      resources on
                    </span>
                    <span className="text-gray-400">·</span>
                    <span className="text-gray-600">
                      {selectedTechniques.length} technique
                      {selectedTechniques.length === 1 ? '' : 's'} in play
                    </span>
                    <span className="text-gray-400">·</span>
                    <span className="text-gray-600">
                      {bgDocs.filter((d) => d._on).length}/{bgDocs.length}{' '}
                      background docs on
                    </span>
                    <span className="text-gray-400">·</span>
                    <span className="text-gray-600">
                      {people.filter((p) => p._on).length}/{people.length}{' '}
                      pews on
                    </span>
                    <button
                      className="text-indigo-700 underline"
                      onClick={() => setBrowseOpen((v) => !v)}
                    >
                      {browseOpen ? 'Close technique browser' : 'Browse techniques'}
                    </button>
                  </div>

                  {/* Technique chips */}
                  {selectedTechniques.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {selectedTechniques.map((t) => (
                        <span
                          key={t.id}
                          className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-900 px-2 py-0.5 text-xs"
                          title={`${t.source}\n\n${t.recipe}`}
                        >
                          {t.name}
                          <button
                            className="hover:text-red-700"
                            onClick={() => toggleTechnique(t.id)}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Technique browser */}
                  {browseOpen && (
                    <div className="border rounded-md p-2 max-h-48 overflow-y-auto space-y-2">
                      {categoriesInMode.map(([key, label]) => (
                        <details key={key}>
                          <summary className="text-sm font-medium cursor-pointer">
                            {label}
                          </summary>
                          <div className="pl-4 pt-1 space-y-1">
                            {techniquesForMode(mode)
                              .filter((t) => t.category === key)
                              .map((t) => (
                                <label
                                  key={t.id}
                                  className="flex items-start gap-2 text-sm cursor-pointer"
                                  title={t.recipe}
                                >
                                  <input
                                    type="checkbox"
                                    className="mt-0.5"
                                    checked={selectedTechniqueIds.includes(t.id)}
                                    onChange={() => toggleTechnique(t.id)}
                                  />
                                  <span>
                                    {t.name}{' '}
                                    <span className="text-xs text-gray-500">
                                      ({t.source})
                                    </span>
                                  </span>
                                </label>
                              ))}
                          </div>
                        </details>
                      ))}
                    </div>
                  )}

                  {/* Resources */}
                  <div className="flex flex-wrap items-center gap-2">
                    <form onSubmit={runResourceSearch} className="flex gap-1">
                      <input
                        className="input text-sm py-1"
                        placeholder="Search resource library…"
                        value={resQ}
                        onChange={(e) => setResQ(e.target.value)}
                      />
                      <button
                        className="btn-secondary text-sm"
                        disabled={resSearching}
                      >
                        {resSearching ? 'Searching…' : 'Search'}
                      </button>
                    </form>
                    {sermon?.scripture_reference && (
                      <button
                        className="btn-secondary text-sm"
                        onClick={suggestByScripture}
                        disabled={suggesting}
                        title="Pull resources whose scripture overlaps this sermon's"
                      >
                        {suggesting ? 'Matching…' : 'Suggest by scripture'}
                      </button>
                    )}
                  </div>
                  {resResults.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {resResults.map((r) => (
                        <button
                          key={r.id}
                          className="rounded-full border px-2 py-0.5 text-xs hover:bg-gray-50"
                          onClick={() => addResource(r)}
                          title={`${r.resource_type || 'resource'} — click to add`}
                        >
                          + {r.title || '(untitled)'}
                        </button>
                      ))}
                    </div>
                  )}
                  {resources.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {resources.map((r) => (
                        <span
                          key={r.id}
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                            r._on
                              ? 'bg-emerald-100 text-emerald-900'
                              : 'bg-gray-100 text-gray-500 line-through'
                          }`}
                          title={
                            r._on
                              ? 'ON — feeds the next turn. Click the dot to switch off.'
                              : 'OFF — held aside. Click the dot to switch on.'
                          }
                        >
                          <button onClick={() => toggleResource(r.id)}>
                            {r._on ? '●' : '○'}
                          </button>
                          <button
                            className={`hover:underline ${
                              previewId === r.id ? 'font-semibold' : ''
                            }`}
                            title="Click to read this resource's full text below"
                            onClick={() =>
                              setPreviewId((cur) => (cur === r.id ? null : r.id))
                            }
                          >
                            {r.title || '(untitled)'}
                          </button>
                          <button
                            className="hover:text-red-700"
                            onClick={() => removeResource(r.id)}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Resource preview — read before you decide */}
                  {previewId &&
                    (() => {
                      const r = resources.find((x) => x.id === previewId);
                      if (!r) return null;
                      return (
                        <div className="border rounded-md p-2 space-y-1 bg-emerald-50/40">
                          <div className="flex flex-wrap items-baseline gap-2 text-xs text-gray-600">
                            <span className="text-sm font-medium text-gray-800">
                              {r.title || '(untitled)'}
                            </span>
                            {r.resource_type && <span>{r.resource_type}</span>}
                            {r.tone && <span>tone: {r.tone}</span>}
                            {r.scripture_refs && <span>{r.scripture_refs}</span>}
                            {Array.isArray(r.themes) && r.themes.length > 0 && (
                              <span>themes: {r.themes.join(', ')}</span>
                            )}
                            {r.source && <span>— {r.source}</span>}
                          </div>
                          <div className="text-sm whitespace-pre-wrap max-h-48 overflow-y-auto font-serif">
                            {(r.content || '').trim() || '(no text content)'}
                          </div>
                          <div className="flex gap-2 pt-1">
                            <button
                              className="btn-secondary text-xs"
                              onClick={() => toggleResource(r.id)}
                            >
                              {r._on ? 'Switch off for next turn' : 'Switch on'}
                            </button>
                            <button
                              className="btn-secondary text-xs"
                              onClick={() => removeResource(r.id)}
                            >
                              Remove from mix
                            </button>
                            <button
                              className="btn-secondary text-xs"
                              onClick={() => setPreviewId(null)}
                            >
                              Close
                            </button>
                          </div>
                        </div>
                      );
                    })()}

                  {/* Background documents (Phase 2) */}
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png,.txt,.md,application/pdf,image/jpeg,image/png,text/plain,text/markdown"
                      multiple
                      className="hidden"
                      onChange={(e) => handleUploadFiles(e.target.files)}
                    />
                    <button
                      className="btn-secondary text-sm"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={bgUploading}
                      title="Load scholarly articles, commentary snapshots, or reference images (.pdf, .jpg, .png, .txt, .md) into this sermon's Studio. Text files and text PDFs are read directly; scans and images go to Claude vision."
                    >
                      {bgUploading ? 'Uploading…' : '+ Background document'}
                    </button>
                    {bgDocs.length === 0 && !bgUploading && (
                      <span className="text-xs text-gray-500">
                        Articles, commentary snapshots, reference images —
                        each toggleable per turn.
                      </span>
                    )}
                  </div>
                  {bgDocs.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {bgDocs.map((d) => (
                        <span
                          key={d.id}
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                            d._on
                              ? 'bg-sky-100 text-sky-900'
                              : 'bg-gray-100 text-gray-500 line-through'
                          }`}
                          title={
                            (d.kind === 'pdf_text'
                              ? `Text PDF — ${d.page_count ?? '?'} pages, text goes into the prompt.`
                              : d.kind === 'pdf_scanned'
                              ? 'Scanned PDF — first pages sent to Claude as images.'
                              : 'Image — sent to Claude vision.') +
                            (d._on
                              ? ' ON — feeds the next turn.'
                              : ' OFF — held aside.')
                          }
                        >
                          <button onClick={() => toggleBgDoc(d.id)}>
                            {d._on ? '●' : '○'}
                          </button>
                          📄 {d.title}
                          {d.kind !== 'pdf_text' && (
                            <span className="text-[10px] uppercase">vision</span>
                          )}
                          <button
                            className="hover:text-red-700"
                            onClick={() => removeBgDoc(d)}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Specific Pews (Phase 4) */}
                  <div className="flex flex-wrap items-center gap-2">
                    <form onSubmit={runPeopleSearch} className="flex gap-1">
                      <input
                        className="input text-sm py-1"
                        placeholder="Specific pews: search Pastoral Records…"
                        value={peopleQ}
                        onChange={(e) => setPeopleQ(e.target.value)}
                      />
                      <button
                        className="btn-secondary text-sm"
                        disabled={peopleSearching}
                      >
                        {peopleSearching ? 'Searching…' : 'Find person'}
                      </button>
                    </form>
                    {people.length === 0 && (
                      <span className="text-xs text-gray-500">
                        Hear the sermon through specific parishioners' ears
                        (profile + interaction summaries; first names only in
                        replies).
                      </span>
                    )}
                  </div>
                  {peopleResults.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {peopleResults.map((r) => (
                        <button
                          key={r.id}
                          className="rounded-full border px-2 py-0.5 text-xs hover:bg-gray-50"
                          onClick={() => addPerson(r)}
                          title="Click to add as a lens"
                        >
                          + {personDisplayName(r)}
                        </button>
                      ))}
                    </div>
                  )}
                  {people.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {people.map((p) => (
                        <span
                          key={p.id}
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                            p._on
                              ? 'bg-violet-100 text-violet-900'
                              : 'bg-gray-100 text-gray-500 line-through'
                          }`}
                          title={
                            (p._on
                              ? 'ON — this person\'s profile + recent interaction summaries feed the next turn. '
                              : 'OFF — held aside. ') +
                            'Claude refers to them by first name only and never proposes identifiable sermon material.'
                          }
                        >
                          <button onClick={() => togglePerson(p.id)}>
                            {p._on ? '●' : '○'}
                          </button>
                          {personDisplayName(p)}
                          <button
                            className="hover:text-red-700"
                            onClick={() => removePerson(p.id)}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {!active && (
                <div className="max-w-lg mx-auto text-center text-sm text-gray-500 pt-10 space-y-2">
                  <p className="text-base text-gray-700 font-medium">
                    {sermon?.scripture_reference || sermon?.title || 'This sermon'}
                  </p>
                  <p>
                    Pick a mode, draw a card or two, switch on the resources you
                    want in the mix — then ask for a Brainstorm (provocations to
                    think with) or a Draft (copy you can insert).
                  </p>
                </div>
              )}
              {(active?.messages || []).map((m, i) => (
                <div
                  key={i}
                  className={
                    m.role === 'user'
                      ? 'ml-auto max-w-2xl rounded-lg bg-indigo-50 px-3 py-2'
                      : 'mr-auto max-w-3xl rounded-lg border px-3 py-2'
                  }
                >
                  {m.role === 'assistant' && (
                    <p className="text-xs text-gray-500 mb-1">
                      {m.kind === 'draft'
                        ? '📄 Draft'
                        : m.kind === 'critique'
                        ? '✓ Critique'
                        : '✨ Brainstorm'}{' '}
                      ·{' '}
                      {modeLabel(m.mode)}
                      {m.model
                        ? ` · ${
                            modelOptions.find((o) => o.id === m.model)
                              ?.short || m.model
                          }`
                        : ' · Sonnet 4.6'}
                    </p>
                  )}
                  {m.role === 'assistant' && m.kind === 'brainstorm' ? (
                    // Brainstorms render item-by-item so each line can be
                    // filed to a Running List with one click.
                    <ol className="text-sm space-y-1.5 list-decimal pl-5">
                      {splitBrainstormItems(m.content).map((item, j) => (
                        <li key={j} className="group/item">
                          <span className="whitespace-pre-wrap">{item}</span>{' '}
                          <button
                            className="opacity-0 group-hover/item:opacity-100 text-[10px] text-indigo-700 underline align-baseline"
                            title={`File this line to ${listLabel(fileTargetKey)} (change the target list in the Running Lists panel)`}
                            onClick={() => fileToList(item, fileTargetKey)}
                          >
                            + {listLabel(fileTargetKey)}
                          </button>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="whitespace-pre-wrap text-sm">{m.content}</div>
                  )}
                  {m.role === 'assistant' && m.kind === 'draft' && (
                    <div className="mt-2 flex gap-2">
                      <button
                        className="btn-primary text-xs"
                        onClick={() => insertDraft(m.content)}
                      >
                        Insert into manuscript
                      </button>
                      <button
                        className="btn-secondary text-xs"
                        onClick={() => stashDraft(m.content)}
                      >
                        Stash for later
                      </button>
                    </div>
                  )}
                  {m.role === 'assistant' && m.kind !== 'critique' && (
                    <div className="mt-1">
                      <button
                        className="text-[10px] text-gray-500 hover:text-indigo-700 underline"
                        disabled={savedToLibrary.has(i)}
                        onClick={() => saveMessageToLibrary(m, i)}
                      >
                        {savedToLibrary.has(i)
                          ? '✓ Saved to library'
                          : 'Save to resource library'}
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {sending && (
                <p className="text-sm text-gray-500 animate-pulse">
                  {shortLabelForOption(modelOptions, modelKey)} is thinking…
                </p>
              )}
            </div>

            {/* Notices */}
            {(error || notice) && (
              <div className="px-4 pb-1">
                {error && <p className="text-sm text-red-600">{error}</p>}
                {notice && <p className="text-sm text-emerald-700">{notice}</p>}
              </div>
            )}

            {/* Composer */}
            <div className="border-t px-4 py-3">
              <textarea
                className="input w-full text-sm"
                rows={2}
                placeholder={
                  mode === 'exegesis'
                    ? 'e.g., "What is this text\'s claim on a congregation that just buried two members?"'
                    : mode === 'illustration'
                    ? 'e.g., "I need a story about unearned forgiveness that isn\'t saccharine."'
                    : 'Ask anything — or leave blank and let the techniques lead.'
                }
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    send('brainstorm');
                  }
                }}
                disabled={sending}
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  className="btn-primary text-sm"
                  onClick={() => send('brainstorm')}
                  disabled={sending}
                >
                  ✨ Brainstorm
                </button>
                <button
                  className="btn-secondary text-sm"
                  onClick={() => send('draft')}
                  disabled={sending}
                  title="Write manuscript-ready copy you can insert or stash"
                >
                  📄 Draft copy
                </button>
                <span className="mx-1 text-gray-300">|</span>
                <select
                  className="input text-xs py-1 w-auto"
                  value={critiqueKey}
                  onChange={(e) => setCritiqueKey(e.target.value)}
                  title="Your own post-writing checks, run against the working manuscript."
                >
                  {CRITIQUE_TOOLS.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button
                  className="btn-secondary text-sm"
                  onClick={runCritique}
                  disabled={sending || !manuscript || !manuscript.trim()}
                  title={
                    !manuscript || !manuscript.trim()
                      ? 'Critiques need a working manuscript.'
                      : 'Run this check against the current manuscript.'
                  }
                >
                  ✓ Critique
                </button>
                <span className="text-xs text-gray-400 ml-auto">
                  Ctrl/⌘+Enter = Brainstorm
                </span>
              </div>
            </div>
          </div>

          {/* Running Lists panel (Phase 3) */}
          {listsOpen && (
            <div className="w-80 shrink-0 border-l flex flex-col">
              <div className="border-b px-3 py-2 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Running Lists</h3>
                  <label
                    className="inline-flex items-center gap-1 text-xs"
                    title="When on, live list items ride along on every turn so Claude builds on them instead of re-inventing them."
                  >
                    <input
                      type="checkbox"
                      checked={includeLists}
                      onChange={(e) => setIncludeLists(e.target.checked)}
                    />
                    feed turns
                  </label>
                </div>
                <label className="block text-xs text-gray-600">
                  “+” on brainstorm lines files to:
                  <select
                    className="input text-xs py-1 mt-0.5"
                    value={fileTargetKey}
                    onChange={(e) => setFileTargetKey(e.target.value)}
                  >
                    {RUNNING_LISTS.map((l) => (
                      <option key={l.key} value={l.key}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>
                <form onSubmit={addManualItem} className="flex gap-1">
                  <select
                    className="input text-xs py-1 w-28 shrink-0"
                    value={newItemKey}
                    onChange={(e) => setNewItemKey(e.target.value)}
                  >
                    {RUNNING_LISTS.map((l) => (
                      <option key={l.key} value={l.key}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input text-xs py-1"
                    placeholder="Add an item…"
                    value={newItemText}
                    onChange={(e) => setNewItemText(e.target.value)}
                  />
                  <button className="btn-secondary text-xs shrink-0">Add</button>
                </form>
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
                {RUNNING_LISTS.map((l) => {
                  const items = listItems.filter((i) => i.list_key === l.key);
                  if (items.length === 0) return null;
                  const liveCount = items.filter((i) => !i.used_at).length;
                  return (
                    <div key={l.key}>
                      <div className="flex items-baseline justify-between gap-2">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600" title={l.hint}>
                          {l.label}
                        </h4>
                        {liveCount > 0 && onSendToChat && (
                          <button
                            className="text-[10px] text-indigo-700 underline shrink-0"
                            onClick={() => weaveList(l.key)}
                            title="Hand the live items on this list to the Workspace revision chat as a 'weave these in' instruction."
                          >
                            ▶ Weave into manuscript
                          </button>
                        )}
                      </div>
                      <ul className="mt-1 space-y-1">
                        {items.map((item) => (
                          <li
                            key={item.id}
                            className={`group/li flex items-start gap-1.5 text-xs rounded px-1.5 py-1 ${
                              item.used_at
                                ? 'text-gray-400 line-through bg-gray-50'
                                : 'bg-amber-50/60'
                            }`}
                          >
                            <button
                              className="shrink-0 mt-px"
                              title={item.used_at ? 'Mark as unused' : 'Mark as used in the manuscript'}
                              onClick={() => handleToggleUsed(item)}
                            >
                              {item.used_at ? '✓' : '○'}
                            </button>
                            <span className="flex-1 whitespace-pre-wrap">
                              {item.content}
                            </span>
                            <button
                              className="opacity-0 group-hover/li:opacity-100 text-gray-400 hover:text-red-600 shrink-0"
                              title="Delete item"
                              onClick={() => handleDeleteItem(item.id)}
                            >
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
                {listItems.length === 0 && (
                  <p className="text-xs text-gray-500">
                    Nothing filed yet. Hover a brainstorm line and click the
                    “+” to file it, or add items by hand above. Lists feed
                    future turns and can be woven into the manuscript.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
