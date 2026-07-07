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
  CREATIVE_MODEL_OPTIONS,
  loadCreativeModelKey,
  saveCreativeModelKey,
  creativeModelIdForKey,
  creativeModelShortLabel,
} from '../lib/creativeModel';
import {
  listCreativeSessions,
  createCreativeSession,
  updateCreativeSession,
  deleteCreativeSession,
  appendSessionMessages,
  runCreativeTurn,
  modeLabel,
} from '../lib/creativeStudio';
import { createStashedBlock } from '../lib/sermonStashedBlocks';
import {
  listBackgroundDocs,
  uploadBackgroundDoc,
  deleteBackgroundDoc,
  buildBackgroundDocsContext,
} from '../lib/backgroundDocs';

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
export default function CreativeStudio({
  open,
  onClose,
  sermon,
  manuscript,
  voicePrompt,
  onInsertDraft,
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

  // Background documents (Phase 2). Rows carry a per-session _on toggle
  // (default on) and an in-memory _visionCache the context builder
  // fills so repeated turns don't re-download/re-render.
  const [bgDocs, setBgDocs] = useState([]);
  const [bgUploading, setBgUploading] = useState(false);
  const fileInputRef = useRef(null);

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

  async function send(kind) {
    const text = instruction.trim();
    const defaultAsk =
      kind === 'brainstorm'
        ? 'Open this text up for me. Where are the live wires?'
        : 'Draft a passage for where the sermon is headed.';
    const ask = text || defaultAsk;

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

      const modelId = creativeModelIdForKey(modelKey);
      const onResources = resources.filter((r) => r._on);

      // Background docs: text for extracted PDFs, vision blocks for
      // images/scans. Downloads + page renders are cached on the doc
      // objects, so only the first turn with a given doc pays the cost.
      const { textBlock, imageBlocks } = await buildBackgroundDocsContext(
        bgDocs.filter((d) => d._on)
      );

      const reply = await runCreativeTurn({
        kind,
        mode: session.mode,
        sermon,
        manuscript: includeManuscript ? manuscript : '',
        resources: onResources,
        techniques: selectedTechniques,
        voicePrompt: kind === 'draft' ? voicePrompt : '',
        extraContext: textBlock,
        imageBlocks,
        history: session.messages || [],
        instruction: ask,
        model: modelId,
      });

      const now = new Date().toISOString();
      const newMessages = [
        { role: 'user', kind, content: ask, mode: session.mode, at: now },
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
              value={modelKey}
              onChange={(e) => pickModel(e.target.value)}
              title="Which Claude model handles Studio turns. Applies per call."
            >
              {CREATIVE_MODEL_OPTIONS.map((opt) => (
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
                          {r.title || '(untitled)'}
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

                  {/* Background documents (Phase 2) */}
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                      multiple
                      className="hidden"
                      onChange={(e) => handleUploadFiles(e.target.files)}
                    />
                    <button
                      className="btn-secondary text-sm"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={bgUploading}
                      title="Load scholarly articles, commentary snapshots, or reference images (.pdf, .jpg, .png) into this sermon's Studio. Text PDFs are read directly; scans and images go to Claude vision."
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
                      {m.kind === 'draft' ? '📄 Draft' : '✨ Brainstorm'} ·{' '}
                      {modeLabel(m.mode)}
                      {m.model
                        ? ` · ${
                            CREATIVE_MODEL_OPTIONS.find((o) => o.id === m.model)
                              ?.short || m.model
                          }`
                        : ' · Sonnet 4.6'}
                    </p>
                  )}
                  <div className="whitespace-pre-wrap text-sm">{m.content}</div>
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
                </div>
              ))}
              {sending && (
                <p className="text-sm text-gray-500 animate-pulse">
                  {creativeModelShortLabel(modelKey)} is thinking…
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
                <span className="text-xs text-gray-400 ml-auto">
                  Ctrl/⌘+Enter = Brainstorm
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
