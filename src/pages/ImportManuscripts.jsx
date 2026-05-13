import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext.jsx';
import { parseManuscriptFiles } from '../lib/manuscriptParser';
import { extractSignals } from '../lib/manuscriptHeuristics';
import { rankCandidates } from '../lib/manuscriptMatcher';
import { matchManuscriptToSermon } from '../lib/claude';
import LoadingSpinner from '../components/LoadingSpinner.jsx';

// Batch importer for historical sermon manuscripts.
//
// Phases:
//   1. UPLOAD — file picker (multi) or directory drop
//   2. PARSE  — extract text, hash, signals from each file
//   3. MATCH  — heuristic score against all sermons; bucket per file
//   4. REVIEW — verification portal (confidence buckets, bulk actions,
//                Send to Claude for low/none, per-card confirm/skip)
//   5. COMMIT — multi-version archiving, hash dedupe, redirect to
//                preachings review queue

const BUCKET_ORDER = ['high', 'medium', 'low', 'none', 'duplicate', 'parse_error'];
const BUCKET_LABELS = {
  high: { label: 'High confidence', emoji: '🟢' },
  medium: { label: 'Medium confidence', emoji: '🟡' },
  low: { label: 'Low confidence', emoji: '🔴' },
  none: { label: 'No match found', emoji: '⚪' },
  duplicate: { label: 'Duplicates (already imported)', emoji: '🚫' },
  parse_error: { label: 'Could not parse', emoji: '⚠️' },
};

export default function ImportManuscripts() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  const [phase, setPhase] = useState('upload'); // upload | parsing | review | committing
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, label: '' });

  // After parse+match, items[] is the working set. Each item:
  //   {
  //     uid, filename, fileModifiedAt, text, hash, footerDate,
  //     signals: {title, scripture, preached_at, preached_at_source},
  //     candidates: [{sermon_id, sermon, score, breakdown}],
  //     bucket: 'high'|'medium'|'low'|'none'|'duplicate'|'parse_error',
  //     selectedCandidateId,    // sermon_id chosen for confirm/match
  //     status: 'pending'|'confirm'|'skip'|'new_sermon',
  //     parseError,
  //     dupeOfRevisionId,
  //   }
  const [items, setItems] = useState([]);
  const [allSermons, setAllSermons] = useState([]);
  const [selectedUids, setSelectedUids] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // ---- 1. Upload kickoff ------------------------------------------

  const handleFiles = async (files) => {
    if (!files || files.length === 0) return;
    setError(null);
    setPhase('parsing');
    setProgress({ done: 0, total: files.length, label: 'Reading files…' });
    try {
      // Parse all files (DOCX/ENEX/TXT). ENEX bundles can yield many
      // entries from one file.
      const parsed = await parseManuscriptFiles(files);
      setProgress({ done: 0, total: parsed.length, label: 'Loading sermon catalog…' });

      // Pull all sermons + their existing manuscript text + content hashes
      // of any prior import revisions so we can dedupe cleanly.
      const { data: sermons, error: smErr } = await withTimeout(
        supabase
          .from('sermons')
          .select('id, title, scripture_reference, preached_at, manuscript_text')
          .order('preached_at', { ascending: false, nullsFirst: false }),
        30000
      );
      if (smErr) throw smErr;
      setAllSermons(sermons || []);

      const { data: existingHashes, error: hashErr } = await withTimeout(
        supabase
          .from('sermon_revisions')
          .select('id, sermon_id, source_content_hash')
          .not('source_content_hash', 'is', null),
        30000
      );
      if (hashErr) throw hashErr;
      const hashIndex = new Map();
      for (const r of existingHashes || []) {
        hashIndex.set(r.source_content_hash, { sermonId: r.sermon_id, revisionId: r.id });
      }

      // Build items[] with signals + candidates + bucket per file.
      setProgress({ done: 0, total: parsed.length, label: 'Matching against sermons…' });
      const out = [];
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i];
        const uid = `u${i}-${(p.filename || '').slice(0, 30)}`;
        if (p.parseError) {
          out.push({ uid, ...p, signals: null, candidates: [], bucket: 'parse_error', status: 'pending' });
          continue;
        }
        // Dedupe — content hash already on a revision?
        if (p.hash && hashIndex.has(p.hash)) {
          const dupe = hashIndex.get(p.hash);
          const sermonForDupe = (sermons || []).find((s) => s.id === dupe.sermonId);
          out.push({
            uid, ...p,
            signals: extractSignals(p),
            candidates: sermonForDupe
              ? [{ sermon_id: sermonForDupe.id, sermon: sermonForDupe, score: 100, breakdown: { title: 100, scripture: 100, date: 100 } }]
              : [],
            bucket: 'duplicate',
            status: 'skip',
            dupeOfRevisionId: dupe.revisionId,
          });
          continue;
        }
        const signals = extractSignals(p);
        const { topCandidates, bucket } = rankCandidates(signals, sermons || []);
        out.push({
          uid, ...p,
          signals,
          candidates: topCandidates,
          bucket,
          // Auto-select the top candidate for high/medium; pre-mark high as confirmed.
          selectedCandidateId: topCandidates[0]?.sermon_id || null,
          status: bucket === 'high' ? 'confirm' : 'pending',
        });
        setProgress({ done: i + 1, total: parsed.length, label: 'Matching against sermons…' });
      }
      setItems(out);
      // Pre-select all high-confidence items so "Confirm selected" is one click.
      setSelectedUids(new Set(out.filter((it) => it.bucket === 'high').map((it) => it.uid)));
      setPhase('review');
    } catch (e) {
      setError(e.message || String(e));
      setPhase('upload');
    }
  };

  // ---- 2. Bucket grouping for the portal --------------------------

  const grouped = useMemo(() => {
    const groups = {};
    for (const k of BUCKET_ORDER) groups[k] = [];
    for (const it of items) groups[it.bucket]?.push(it);
    return groups;
  }, [items]);

  // ---- 3. Bulk actions --------------------------------------------

  const toggleSelected = (uid) => {
    setSelectedUids((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  };
  const selectAllInBucket = (bucket) => {
    setSelectedUids((prev) => {
      const next = new Set(prev);
      for (const it of grouped[bucket] || []) next.add(it.uid);
      return next;
    });
  };
  const deselectAllInBucket = (bucket) => {
    setSelectedUids((prev) => {
      const next = new Set(prev);
      for (const it of grouped[bucket] || []) next.delete(it.uid);
      return next;
    });
  };

  const setItemStatus = (uid, status) => {
    setItems((prev) => prev.map((it) => (it.uid === uid ? { ...it, status } : it)));
  };
  const setItemCandidate = (uid, sermonId) => {
    setItems((prev) =>
      prev.map((it) =>
        it.uid === uid ? { ...it, selectedCandidateId: sermonId, status: 'confirm' } : it
      )
    );
  };

  const handleConfirmSelected = () => {
    setItems((prev) =>
      prev.map((it) =>
        selectedUids.has(it.uid) && it.selectedCandidateId
          ? { ...it, status: 'confirm' }
          : it
      )
    );
  };
  const handleSkipSelected = () => {
    setItems((prev) =>
      prev.map((it) => (selectedUids.has(it.uid) ? { ...it, status: 'skip' } : it))
    );
  };
  const handleNewSermonSelected = () => {
    setItems((prev) =>
      prev.map((it) =>
        selectedUids.has(it.uid)
          ? { ...it, status: 'new_sermon', selectedCandidateId: null }
          : it
      )
    );
  };

  // Send selected (medium/low/none) items to Claude for a fresh match.
  const handleSendToClaude = async () => {
    const targets = items.filter(
      (it) => selectedUids.has(it.uid) && !it.parseError && it.bucket !== 'duplicate'
    );
    if (targets.length === 0) return;
    setBulkBusy(true);
    setError(null);
    // Limit candidates per call to top ~50 sermons (API token sanity)
    // OR all sermons if there are fewer.
    const candidatesForClaude = (allSermons || []).slice(0, 80);
    try {
      // Run sequentially to keep API usage gentle.
      for (let i = 0; i < targets.length; i++) {
        const it = targets[i];
        try {
          const result = await matchManuscriptToSermon({
            filename: it.filename,
            snippet: it.text,
            candidates: candidatesForClaude,
          });
          if (result.sermonId) {
            const sermon = allSermons.find((s) => s.id === result.sermonId);
            if (sermon) {
              setItems((prev) =>
                prev.map((x) =>
                  x.uid === it.uid
                    ? {
                        ...x,
                        candidates: [
                          { sermon_id: sermon.id, sermon, score: confidenceToScore(result.confidence), breakdown: { claude: result.reasoning } },
                          ...x.candidates.filter((c) => c.sermon_id !== sermon.id),
                        ].slice(0, 3),
                        selectedCandidateId: sermon.id,
                        bucket: result.confidence === 'high' ? 'high' : result.confidence === 'medium' ? 'medium' : 'low',
                        status: result.confidence === 'high' ? 'confirm' : 'pending',
                        claudeReasoning: result.reasoning,
                      }
                    : x
                )
              );
            }
          } else {
            setItems((prev) =>
              prev.map((x) =>
                x.uid === it.uid
                  ? { ...x, claudeReasoning: result.reasoning, bucket: 'none' }
                  : x
              )
            );
          }
        } catch (e) {
          // Per-item Claude failure — don't blow up the bulk run.
          // eslint-disable-next-line no-console
          console.warn('Claude match failed for', it.filename, e);
        }
      }
    } finally {
      setBulkBusy(false);
    }
  };

  // ---- 4. Commit --------------------------------------------------

  const confirmedCount = items.filter((it) => it.status === 'confirm' && it.selectedCandidateId).length;
  const newSermonCount = items.filter((it) => it.status === 'new_sermon').length;

  const handleCommit = async () => {
    if (!user?.id) return;
    if (confirmedCount + newSermonCount === 0) {
      setError('Nothing selected to import.');
      return;
    }
    setPhase('committing');
    setError(null);
    setProgress({ done: 0, total: confirmedCount + newSermonCount, label: 'Committing…' });

    const results = { added_canonical: 0, added_revision: 0, created_sermons: 0, failed: 0, errors: [] };

    // Group confirmed items by target sermon so multi-version logic
    // can decide canonical vs. revision per-sermon in one pass.
    const bySermon = new Map();
    for (const it of items) {
      if (it.status === 'confirm' && it.selectedCandidateId) {
        if (!bySermon.has(it.selectedCandidateId)) bySermon.set(it.selectedCandidateId, []);
        bySermon.get(it.selectedCandidateId).push(it);
      }
    }
    // Items destined for new sermons — handled separately so we can
    // create the sermon first, then attach a revision row.
    const newSermonItems = items.filter((it) => it.status === 'new_sermon');

    const preachingsQueue = [];
    let done = 0;

    for (const [sermonId, group] of bySermon.entries()) {
      // Sort by extracted preached_at desc; fall back to fileModifiedAt.
      group.sort((a, b) => {
        const da = a.signals?.preached_at || a.fileModifiedAt || '';
        const db = b.signals?.preached_at || b.fileModifiedAt || '';
        return db.localeCompare(da);
      });
      const sermon = allSermons.find((s) => s.id === sermonId);
      const sermonHasManuscript = !!(sermon?.manuscript_text || '').trim();

      // Per pastor's rule: existing manuscript_text always wins as
      // canonical. Imports become revisions, with the newest at the
      // top of the revisions list.
      // If sermon has no existing manuscript, the newest imported
      // becomes the canonical and the rest are revisions.
      let canonicalIdx = -1;
      if (!sermonHasManuscript) canonicalIdx = 0;

      for (let i = 0; i < group.length; i++) {
        const it = group[i];
        try {
          if (i === canonicalIdx) {
            // Set sermon.manuscript_text + create revision-of-record
            // for the import (so dedupe works on re-runs).
            await withTimeout(
              supabase
                .from('sermons')
                .update({ manuscript_text: it.text })
                .eq('id', sermonId)
            );
            await withTimeout(
              supabase.from('sermon_revisions').insert({
                sermon_id: sermonId,
                owner_user_id: user.id,
                snapshot_title: sermon.title || null,
                snapshot_manuscript_text: it.text,
                snapshot_scripture_reference: sermon.scripture_reference || null,
                label:
                  `Imported (${it.signals?.preached_at || 'no date'}) from ${it.filename}`,
                source_filename: it.filename,
                source_content_hash: it.hash,
                source_preached_at: it.signals?.preached_at || null,
              })
            );
            results.added_canonical++;
          } else {
            await withTimeout(
              supabase.from('sermon_revisions').insert({
                sermon_id: sermonId,
                owner_user_id: user.id,
                snapshot_title: sermon?.title || null,
                snapshot_manuscript_text: it.text,
                snapshot_scripture_reference: sermon?.scripture_reference || null,
                label:
                  `Imported (${it.signals?.preached_at || 'no date'}) from ${it.filename}`,
                source_filename: it.filename,
                source_content_hash: it.hash,
                source_preached_at: it.signals?.preached_at || null,
              })
            );
            results.added_revision++;
          }
          if (it.signals?.preached_at) {
            preachingsQueue.push({
              sermonId,
              sermonTitle: sermon?.title || '(untitled)',
              date: it.signals.preached_at,
              filename: it.filename,
            });
          }
        } catch (e) {
          results.failed++;
          results.errors.push({ filename: it.filename, error: e.message || String(e) });
        }
        done++;
        setProgress((p) => ({ ...p, done }));
      }
    }

    // Create new sermons + attach the manuscript as canonical + a revision row.
    for (const it of newSermonItems) {
      try {
        const { data: created, error: createErr } = await withTimeout(
          supabase
            .from('sermons')
            .insert({
              title: it.signals?.title || it.filename,
              scripture_reference: it.signals?.scripture || null,
              preached_at: it.signals?.preached_at || null,
              manuscript_text: it.text,
              owner_user_id: user.id,
            })
            .select('id, title')
            .single()
        );
        if (createErr) throw createErr;
        await withTimeout(
          supabase.from('sermon_revisions').insert({
            sermon_id: created.id,
            owner_user_id: user.id,
            snapshot_title: created.title,
            snapshot_manuscript_text: it.text,
            snapshot_scripture_reference: it.signals?.scripture || null,
            label:
              `Imported (${it.signals?.preached_at || 'no date'}) from ${it.filename}`,
            source_filename: it.filename,
            source_content_hash: it.hash,
            source_preached_at: it.signals?.preached_at || null,
          })
        );
        results.created_sermons++;
        if (it.signals?.preached_at) {
          preachingsQueue.push({
            sermonId: created.id,
            sermonTitle: created.title,
            date: it.signals.preached_at,
            filename: it.filename,
          });
        }
      } catch (e) {
        results.failed++;
        results.errors.push({ filename: it.filename, error: e.message || String(e) });
      }
      done++;
      setProgress((p) => ({ ...p, done }));
    }

    // Stash the preachings queue in sessionStorage and redirect to the
    // review page (next phase of the import flow).
    try {
      sessionStorage.setItem(
        'wfumc-import-preachings-queue',
        JSON.stringify({ stamp: Date.now(), items: preachingsQueue, results })
      );
    } catch {
      /* sessionStorage full / disabled — non-fatal */
    }
    navigate('/sermons/import-manuscripts/review-preachings');
  };

  // ---- 5. Render ---------------------------------------------------

  return (
    <div className="space-y-4 max-w-6xl">
      <div>
        <Link to="/" className="text-sm text-gray-500 hover:text-gray-700">
          ← Sermons
        </Link>
        <h1 className="font-serif text-2xl text-umc-900 mt-1">
          Batch import manuscripts
        </h1>
        <p className="text-sm text-gray-600 mt-1">
          Pick a folder or several files at once. Supported formats:{' '}
          <code className="bg-gray-100 px-1 rounded">.docx</code>,{' '}
          <code className="bg-gray-100 px-1 rounded">.enex</code>,{' '}
          <code className="bg-gray-100 px-1 rounded">.txt</code>. Each file
          gets matched against your existing sermon catalog. You confirm
          matches in a verification portal before any database writes.
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      {phase === 'upload' && (
        <div className="card text-center space-y-3">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".docx,.enex,.txt,.md"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <input
            ref={folderInputRef}
            type="file"
            webkitdirectory=""
            directory=""
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="btn-primary"
            >
              📄 Pick files
            </button>
            <span className="text-sm text-gray-500">or</span>
            <button
              type="button"
              onClick={() => folderInputRef.current?.click()}
              className="btn-secondary"
            >
              📁 Pick a folder
            </button>
          </div>
          <p className="text-xs text-gray-500">
            "Pick a folder" recurses into subfolders — handy for "import
            all of 2018" or for a season's worth at a time.
          </p>
        </div>
      )}

      {phase === 'parsing' && (
        <div className="card text-center space-y-2">
          <LoadingSpinner label={progress.label} />
          {progress.total > 0 && (
            <>
              <div className="text-sm text-gray-600">
                {progress.done} / {progress.total}
              </div>
              <div className="w-full bg-gray-200 rounded h-2 mt-1">
                <div
                  className="bg-umc-700 h-2 rounded"
                  style={{
                    width:
                      progress.total > 0
                        ? `${Math.round((progress.done / progress.total) * 100)}%`
                        : '0%',
                  }}
                />
              </div>
            </>
          )}
        </div>
      )}

      {phase === 'committing' && (
        <div className="card text-center space-y-2">
          <LoadingSpinner label={progress.label} />
          {progress.total > 0 && (
            <>
              <div className="text-sm text-gray-600">
                {progress.done} / {progress.total}
              </div>
              <div className="w-full bg-gray-200 rounded h-2 mt-1">
                <div
                  className="bg-umc-700 h-2 rounded"
                  style={{
                    width:
                      progress.total > 0
                        ? `${Math.round((progress.done / progress.total) * 100)}%`
                        : '0%',
                  }}
                />
              </div>
            </>
          )}
        </div>
      )}

      {phase === 'review' && (
        <ReviewPortal
          items={items}
          grouped={grouped}
          allSermons={allSermons}
          selectedUids={selectedUids}
          onToggleSelected={toggleSelected}
          onSelectAllBucket={selectAllInBucket}
          onDeselectAllBucket={deselectAllInBucket}
          onConfirmSelected={handleConfirmSelected}
          onSkipSelected={handleSkipSelected}
          onNewSermonSelected={handleNewSermonSelected}
          onSendToClaude={handleSendToClaude}
          onSetItemStatus={setItemStatus}
          onSetItemCandidate={setItemCandidate}
          bulkBusy={bulkBusy}
          confirmedCount={confirmedCount}
          newSermonCount={newSermonCount}
          onCommit={handleCommit}
        />
      )}
    </div>
  );
}

// =====================================================================
// Sub-components
// =====================================================================

function confidenceToScore(c) {
  return c === 'high' ? 92 : c === 'medium' ? 70 : c === 'low' ? 40 : 10;
}

function ReviewPortal({
  items, grouped, allSermons,
  selectedUids, onToggleSelected, onSelectAllBucket, onDeselectAllBucket,
  onConfirmSelected, onSkipSelected, onNewSermonSelected, onSendToClaude,
  onSetItemStatus, onSetItemCandidate,
  bulkBusy, confirmedCount, newSermonCount, onCommit,
}) {
  const totals = useMemo(() => {
    const out = { confirmed: 0, skipped: 0, pending: 0, new_sermon: 0 };
    for (const it of items) {
      if (it.status === 'confirm') out.confirmed++;
      else if (it.status === 'skip') out.skipped++;
      else if (it.status === 'new_sermon') out.new_sermon++;
      else out.pending++;
    }
    return out;
  }, [items]);

  return (
    <>
      {/* Sticky-ish action bar at the top */}
      <div className="card sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-gray-700">
          <strong>{items.length}</strong> files · {totals.confirmed}{' '}
          confirmed · {totals.pending} pending · {totals.skipped} skipped ·{' '}
          {totals.new_sermon} new sermon · {selectedUids.size} selected
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onConfirmSelected}
            disabled={selectedUids.size === 0 || bulkBusy}
            className="btn-secondary text-xs disabled:opacity-50"
          >
            ✓ Confirm selected
          </button>
          <button
            type="button"
            onClick={onSkipSelected}
            disabled={selectedUids.size === 0 || bulkBusy}
            className="btn-secondary text-xs disabled:opacity-50"
          >
            ✗ Skip selected
          </button>
          <button
            type="button"
            onClick={onNewSermonSelected}
            disabled={selectedUids.size === 0 || bulkBusy}
            className="btn-secondary text-xs disabled:opacity-50"
          >
            + Create new sermon for selected
          </button>
          <button
            type="button"
            onClick={onSendToClaude}
            disabled={selectedUids.size === 0 || bulkBusy}
            className="btn-secondary text-xs disabled:opacity-50"
          >
            {bulkBusy ? '✨ Asking Claude…' : '✨ Send selected to Claude'}
          </button>
          <button
            type="button"
            onClick={onCommit}
            disabled={confirmedCount + newSermonCount === 0 || bulkBusy}
            className="btn-primary text-xs disabled:opacity-50"
          >
            Commit ({confirmedCount + newSermonCount})
          </button>
        </div>
      </div>

      {BUCKET_ORDER.map((bucket) => {
        const list = grouped[bucket] || [];
        if (list.length === 0) return null;
        const meta = BUCKET_LABELS[bucket];
        return (
          <section key={bucket} className="card space-y-2">
            <div className="flex items-baseline justify-between flex-wrap gap-2">
              <h2 className="font-serif text-lg text-umc-900">
                {meta.emoji} {meta.label}{' '}
                <span className="text-sm font-normal text-gray-500">
                  ({list.length})
                </span>
              </h2>
              <div className="flex gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => onSelectAllBucket(bucket)}
                  className="text-umc-700 hover:text-umc-900 underline"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => onDeselectAllBucket(bucket)}
                  className="text-gray-500 hover:text-gray-800 underline"
                >
                  Deselect all
                </button>
              </div>
            </div>
            <ul className="divide-y divide-gray-200">
              {list.map((it) => (
                <li key={it.uid} className="py-3">
                  <ItemCard
                    item={it}
                    selected={selectedUids.has(it.uid)}
                    onToggleSelected={() => onToggleSelected(it.uid)}
                    onSetStatus={(s) => onSetItemStatus(it.uid, s)}
                    onSetCandidate={(id) => onSetItemCandidate(it.uid, id)}
                    allSermons={allSermons}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

function ItemCard({ item, selected, onToggleSelected, onSetStatus, onSetCandidate, allSermons }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const searchResults = useMemo(() => {
    if (!searchTerm.trim()) return [];
    const q = searchTerm.toLowerCase();
    return allSermons
      .filter(
        (s) =>
          (s.title || '').toLowerCase().includes(q) ||
          (s.scripture_reference || '').toLowerCase().includes(q)
      )
      .slice(0, 10);
  }, [searchTerm, allSermons]);

  const top = item.candidates[0];
  const status = item.status;

  return (
    <div className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelected}
        disabled={item.bucket === 'duplicate' || item.bucket === 'parse_error'}
        className="mt-1 rounded border-gray-300 disabled:opacity-30"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <div className="font-medium text-sm text-gray-900 truncate" title={item.filename}>
            {item.filename}
          </div>
          <StatusBadge status={status} />
        </div>
        {item.parseError ? (
          <p className="text-xs text-red-700 mt-1">{item.parseError}</p>
        ) : (
          <>
            <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-3">
              {item.signals?.title && <span title="Extracted title">📝 {item.signals.title}</span>}
              {item.signals?.scripture && <span title="Extracted scripture">📖 {item.signals.scripture}</span>}
              {item.signals?.preached_at && (
                <span title={`Date source: ${item.signals.preached_at_source}`}>
                  📅 {item.signals.preached_at}
                </span>
              )}
            </div>
            {item.bucket === 'duplicate' && (
              <p className="text-xs text-gray-700 mt-1 italic">
                Already imported — same content hash matches an existing revision.
              </p>
            )}
            {top && item.bucket !== 'duplicate' && (
              <div className="text-xs text-gray-700 mt-2 bg-gray-50 border border-gray-200 rounded p-2">
                <div className="flex items-baseline justify-between gap-2 flex-wrap">
                  <div>
                    <strong>Match:</strong> {top.sermon.title || '(untitled)'}
                    {top.sermon.scripture_reference && (
                      <> — {top.sermon.scripture_reference}</>
                    )}
                    {top.sermon.preached_at && <> — {top.sermon.preached_at}</>}
                  </div>
                  <div className="text-[10px] text-gray-500">
                    score {top.score}
                  </div>
                </div>
                {item.candidates.slice(1).length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] text-gray-500">
                      {item.candidates.slice(1).length} alternate match(es)
                    </summary>
                    <ul className="text-[11px] text-gray-700 mt-1 space-y-0.5">
                      {item.candidates.slice(1).map((c) => (
                        <li key={c.sermon_id} className="flex items-baseline justify-between gap-2">
                          <span className="truncate">
                            {c.sermon.title} {c.sermon.scripture_reference && `— ${c.sermon.scripture_reference}`}
                          </span>
                          <button
                            type="button"
                            onClick={() => onSetCandidate(c.sermon_id)}
                            className="text-[10px] text-umc-700 hover:text-umc-900 underline whitespace-nowrap"
                          >
                            Use this
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {item.claudeReasoning && (
                  <p className="text-[10px] text-gray-500 italic mt-1">
                    Claude: {item.claudeReasoning}
                  </p>
                )}
              </div>
            )}
            <div className="flex gap-3 text-xs mt-2 flex-wrap">
              {top && (
                <button
                  type="button"
                  onClick={() => onSetStatus('confirm')}
                  className={
                    'underline ' +
                    (status === 'confirm'
                      ? 'text-green-700 font-semibold'
                      : 'text-umc-700 hover:text-umc-900')
                  }
                >
                  ✓ Confirm
                </button>
              )}
              <button
                type="button"
                onClick={() => setSearchOpen((s) => !s)}
                className="text-gray-600 hover:text-gray-900 underline"
              >
                🔍 Reassign…
              </button>
              <button
                type="button"
                onClick={() => onSetStatus('new_sermon')}
                className={
                  'underline ' +
                  (status === 'new_sermon'
                    ? 'text-blue-700 font-semibold'
                    : 'text-gray-600 hover:text-gray-900')
                }
              >
                + New sermon
              </button>
              <button
                type="button"
                onClick={() => onSetStatus('skip')}
                className={
                  'underline ' +
                  (status === 'skip'
                    ? 'text-red-700 font-semibold'
                    : 'text-gray-600 hover:text-red-800')
                }
              >
                ✗ Skip
              </button>
              <details>
                <summary className="cursor-pointer text-[10px] text-gray-500">Preview text</summary>
                <pre className="text-[10px] text-gray-700 whitespace-pre-wrap font-mono mt-1 bg-gray-50 border border-gray-200 rounded p-1 max-h-32 overflow-y-auto max-w-md">
                  {(item.text || '').slice(0, 500)}
                </pre>
              </details>
            </div>
            {searchOpen && (
              <div className="mt-2 border border-gray-200 rounded p-2 bg-white">
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search sermons by title or scripture…"
                  className="input text-xs"
                />
                {searchResults.length > 0 && (
                  <ul className="mt-1 max-h-40 overflow-y-auto divide-y divide-gray-100">
                    {searchResults.map((s) => (
                      <li key={s.id} className="py-1 flex items-baseline justify-between gap-2">
                        <span className="text-xs truncate">
                          {s.title || '(untitled)'}
                          {s.scripture_reference && (
                            <span className="text-gray-500"> — {s.scripture_reference}</span>
                          )}
                          {s.preached_at && (
                            <span className="text-gray-400 text-[10px]"> · {s.preached_at}</span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            onSetCandidate(s.id);
                            setSearchOpen(false);
                            setSearchTerm('');
                          }}
                          className="text-[10px] text-umc-700 hover:text-umc-900 underline whitespace-nowrap"
                        >
                          Use
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    confirm: { label: 'Confirmed', cls: 'bg-green-100 text-green-800 border-green-200' },
    skip: { label: 'Skipped', cls: 'bg-red-100 text-red-800 border-red-200' },
    new_sermon: { label: 'New sermon', cls: 'bg-blue-100 text-blue-800 border-blue-200' },
    pending: { label: 'Pending', cls: 'bg-gray-100 text-gray-700 border-gray-200' },
  };
  const m = map[status] || map.pending;
  return (
    <span
      className={'text-[10px] px-1.5 py-0.5 rounded border ' + m.cls}
    >
      {m.label}
    </span>
  );
}
