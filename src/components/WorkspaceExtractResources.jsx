// Modal version of /resources/extract, mounted inside the Sermon
// Workspace. Same input modes (paste / URL / PDF with optional page
// range), same Claude extraction prompt, same review-then-commit
// flow — with one addition: each proposed row carries an
// "Attach to this sermon" toggle (default on) so the pastor can split
// a batch between "for this sermon" and "archive only" in one pass.
//
// On commit, every checked proposal becomes a `resources` row. Rows
// with the attach toggle ALSO get a `sermon_resources` link inserted
// so they show in the workspace's Resources Used panel and in
// `buildResourcesContext` calls for upcoming Claude turns.

import { useRef, useState } from 'react';
import { supabase, withTimeout } from '../lib/supabase';
import { fetchUrlText } from '../lib/urlFetch';
import { extractPdfText } from '../lib/pdfText';
import { extractResourcesFromSource } from '../lib/claude';
import { parsePageRangeSpec, formatPageRange } from '../lib/pageRange';

const MODE_TABS = [
  { value: 'paste', label: 'Paste text' },
  { value: 'url', label: 'Fetch URL' },
  { value: 'pdf', label: 'Upload .pdf' },
];

const TYPE_OPTIONS = ['story', 'quote', 'illustration', 'joke', 'exegesis'];

export default function WorkspaceExtractResources({
  sermon,
  ownerUserId,
  manuscript = '',
  onClose,
  onCommitted, // (counts) => void   counts = { created, attached }
}) {
  // "Filter by manuscript" — when on, the sermon's metadata (scripture,
  // title, body) is passed to Claude as relevance context so only items
  // pertinent to the active sermon come back. Off by default (broad
  // sweep).
  //
  // The filter is useful as long as at least ONE of scripture / title /
  // body has real content. A brand-new sermon called "New sermon" with
  // no scripture and no body would give Claude nothing to filter on, so
  // the checkbox is disabled in that case to avoid the trap of "filter
  // returned [] because there was nothing to filter against".
  const trimmedManuscript = (manuscript || '').trim();
  const trimmedScripture = (sermon?.scripture_reference || '').trim();
  const trimmedTitle = (sermon?.title || '').trim();
  // Reject default placeholder titles as not-useful-signal.
  const isPlaceholderTitle =
    !trimmedTitle ||
    /^(new sermon|untitled|new)$/i.test(trimmedTitle);
  const hasFilterSignal =
    !!trimmedManuscript ||
    !!trimmedScripture ||
    !isPlaceholderTitle;
  const [filterByManuscript, setFilterByManuscript] = useState(false);

  // Build the manuscript context block sent to Claude. Combines whatever
  // signal we have so even an empty-body sermon can filter on its
  // scripture reference.
  const buildManuscriptContext = () => {
    const parts = [];
    if (!isPlaceholderTitle) parts.push(`Sermon title: ${trimmedTitle}`);
    if (trimmedScripture) parts.push(`Scripture: ${trimmedScripture}`);
    if (trimmedManuscript) {
      parts.push(`Manuscript (so far):\n${trimmedManuscript}`);
    }
    return parts.join('\n\n');
  };
  const [stage, setStage] = useState('input'); // 'input' | 'review' | 'done'
  const [mode, setMode] = useState('paste');
  const [pasted, setPasted] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [fetchingUrl, setFetchingUrl] = useState(false);
  const [fetchedUrl, setFetchedUrl] = useState('');
  const [pageRangeSpec, setPageRangeSpec] = useState('');
  const [parsedText, setParsedText] = useState('');
  // For PDFs: per-page texts so the pastor can preview which pages
  // actually got included. Empty for paste / URL modes.
  const [pagePreviews, setPagePreviews] = useState([]);
  const [parseStatus, setParseStatus] = useState(null);
  const [sourceLabel, setSourceLabel] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState(null);
  // Tracks whether the last empty result happened with the relevance
  // filter on, so the error can offer a one-click "Retry without filter"
  // button (faster + clearer than asking the pastor to manually untick).
  const [lastEmptyWithFilter, setLastEmptyWithFilter] = useState(false);
  const [proposals, setProposals] = useState([]);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState({ created: 0, attached: 0 });
  const fileRef = useRef(null);

  // --- input loaders -------------------------------------------------

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setParseStatus(null);
    setParsedText('');
    setPagePreviews([]);
    setSourceLabel(file.name);
    try {
      setParseStatus('Reading the PDF…');
      let pageFilter = null;
      try {
        pageFilter = parsePageRangeSpec(pageRangeSpec);
      } catch (parseErr) {
        throw new Error(`Page range: ${parseErr.message}`);
      }
      const { text, pageCount, pagesExtracted, pageTexts } = await extractPdfText(
        file,
        pageFilter ? { pages: pageFilter } : undefined
      );
      setPagePreviews(pageTexts || []);
      if (!text.trim()) {
        throw new Error(
          pageFilter
            ? "Couldn't pull any text out of the selected pages. Check the page range."
            : "Couldn't pull any text out of that PDF. It might be image-only (scanned)."
        );
      }
      setParsedText(text);
      const sliceLabel =
        pageFilter && pagesExtracted.length < pageCount
          ? ` (pages ${formatPageRange(new Set(pagesExtracted))} of ${pageCount})`
          : ` (${pageCount}-page PDF)`;
      setParseStatus(
        `Loaded ${text.length.toLocaleString()} characters from ${file.name}${sliceLabel}.`
      );
    } catch (err) {
      setError(err.message || String(err));
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleFetchUrl = async () => {
    setError(null);
    setParseStatus(null);
    setParsedText('');
    setFetchedUrl('');
    if (!urlInput.trim()) {
      setError('Paste a URL first.');
      return;
    }
    setFetchingUrl(true);
    setParseStatus('Fetching the page…');
    try {
      const { text, title, finalUrl } = await fetchUrlText(urlInput);
      setParsedText(text);
      setSourceLabel(title || finalUrl || urlInput);
      setFetchedUrl(finalUrl || urlInput.trim());
      setParseStatus(
        `Loaded ${text.length.toLocaleString()} characters from ${title || finalUrl || urlInput}.`
      );
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setFetchingUrl(false);
    }
  };

  // --- extract -------------------------------------------------------

  // forceWithoutFilter=true is used by the "Retry without filter"
  // button on the empty-result error — runs the same extraction with
  // the manuscript context blanked, so the pastor can tell whether
  // the filter or the page selection is to blame.
  const handleExtract = async ({ forceWithoutFilter = false } = {}) => {
    setError(null);
    setLastEmptyWithFilter(false);
    let text = '';
    let label = sourceLabel.trim();
    if (mode === 'paste') {
      text = pasted.trim();
      if (!text) {
        setError('Paste some text first.');
        return;
      }
      if (!label) label = 'Pasted text';
    } else if (mode === 'url') {
      text = parsedText;
      if (!text) {
        setError('Click "Fetch page" first.');
        return;
      }
      if (!label) label = urlInput.trim();
    } else {
      text = parsedText;
      if (!text) {
        setError('Upload a file first.');
        return;
      }
    }
    setExtracting(true);
    try {
      const useFilter =
        !forceWithoutFilter && filterByManuscript && hasFilterSignal;
      const items = await extractResourcesFromSource({
        sourceText: text,
        sourceLabel: label,
        manuscriptContext: useFilter ? buildManuscriptContext() : '',
      });
      if (items.length === 0) {
        if (useFilter) {
          setError(
            "Claude didn't find anything in this source relevant to your sermon. Could be the filter was too strict, or the page range doesn't cover the right material."
          );
          setLastEmptyWithFilter(true);
        } else {
          setError(
            "Claude didn't find anything worth extracting from this source. Try a different chunk?"
          );
        }
        setExtracting(false);
        return;
      }
      // Every row defaults to checked AND attached. Pastor toggles
      // off either as needed before committing.
      setProposals(
        items.map((it) => ({
          checked: true,
          attach: true,
          imported: false,
          title: it.proposed_title || '',
          content: it.content || '',
          resource_type: it.type || 'story',
          themes: (it.themes || []).join(', '),
          scripture_refs: it.scripture_refs || '',
          tone: it.tone || '',
        }))
      );
      setSourceLabel(label);
      setStage('review');
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setExtracting(false);
    }
  };

  // --- commit --------------------------------------------------------

  const updateProposal = (i, patch) =>
    setProposals((prev) =>
      prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p))
    );

  const handleCommit = async () => {
    setError(null);
    const toImport = proposals.filter((p) => p.checked && !p.imported);
    if (toImport.length === 0) {
      setError('Nothing checked to import.');
      return;
    }
    setCommitting(true);
    try {
      // Insert all resources in one shot — returns ids so we can build
      // the sermon_resources rows for the attach-toggled ones.
      const rows = toImport.map((p) => ({
        owner_user_id: ownerUserId,
        resource_type: p.resource_type,
        title: p.title.trim() || null,
        content: p.content,
        source: sourceLabel.trim() || null,
        source_url: fetchedUrl || null,
        themes: p.themes
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
        scripture_refs: p.scripture_refs.trim() || null,
        tone: p.tone.trim() || null,
        notes: null,
        auto_generated: true,
        auto_source_label: sourceLabel || null,
      }));
      const { data: inserted, error: insErr } = await withTimeout(
        supabase.from('resources').insert(rows).select('id')
      );
      if (insErr) throw insErr;
      const insertedIds = (inserted || []).map((r) => r.id);
      const created = insertedIds.length;

      // For attach=on rows: pair them with the matching inserted id
      // and write sermon_resources links. The two arrays are aligned
      // by position so this lookup is safe.
      const attachLinks = [];
      for (let i = 0; i < toImport.length; i++) {
        if (toImport[i].attach && insertedIds[i]) {
          attachLinks.push({
            sermon_id: sermon.id,
            resource_id: insertedIds[i],
            owner_user_id: ownerUserId,
            used_notes: 'Auto-attached from Workspace extract',
          });
        }
      }
      let attached = 0;
      if (attachLinks.length > 0) {
        const { data: linked, error: linkErr } = await withTimeout(
          supabase
            .from('sermon_resources')
            .upsert(attachLinks, {
              onConflict: 'sermon_id,resource_id',
              ignoreDuplicates: true,
            })
            .select('resource_id')
        );
        if (linkErr) throw linkErr;
        attached = (linked || []).length;
      }
      setCommitted({ created, attached });
      setStage('done');
      onCommitted?.({ created, attached });
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setCommitting(false);
    }
  };

  // --- render --------------------------------------------------------

  const hasInput =
    (mode === 'paste' && pasted.trim().length > 0) ||
    (mode === 'pdf' && parsedText.length > 0) ||
    (mode === 'url' && parsedText.length > 0);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4"
      onClick={onClose}
    >
      <div
        className="card max-w-4xl w-full my-8 max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div>
            <h2 className="font-serif text-lg text-umc-900">
              ✨ Extract resources from a source
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              For this sermon:{' '}
              <span className="text-umc-900">
                {sermon?.title || '(untitled)'}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-xl"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 mb-2">
            <p>{error}</p>
            {lastEmptyWithFilter && (
              <button
                type="button"
                onClick={() =>
                  handleExtract({ forceWithoutFilter: true })
                }
                disabled={extracting}
                className="mt-2 px-3 py-1 rounded bg-white border border-red-300 text-red-700 hover:bg-red-100 text-xs font-medium disabled:opacity-50"
              >
                {extracting ? 'Retrying…' : 'Retry without filter'}
              </button>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto pr-1 space-y-3">
          {stage === 'input' && (
            <>
              {/* Mode tabs */}
              <div className="flex flex-wrap gap-1">
                {MODE_TABS.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => {
                      setMode(t.value);
                      setError(null);
                      setParseStatus(null);
                    }}
                    className={
                      'px-3 py-1 rounded text-xs ' +
                      (mode === t.value
                        ? 'bg-umc-900 text-white'
                        : 'bg-white text-umc-900 border border-umc-200 hover:bg-umc-100')
                    }
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {mode === 'paste' && (
                <div>
                  <label className="label">Paste source text</label>
                  <textarea
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    rows={10}
                    placeholder="Paste an article, book chapter excerpt, blog post, transcript…"
                    className="input text-sm font-serif"
                  />
                  <div className="mt-2">
                    <label className="label">
                      Source label{' '}
                      <span className="text-gray-500 font-normal">(optional)</span>
                    </label>
                    <input
                      type="text"
                      value={sourceLabel}
                      onChange={(e) => setSourceLabel(e.target.value)}
                      placeholder='e.g. "Tim Keller, Prayer, ch. 4"'
                      className="input text-sm"
                    />
                  </div>
                </div>
              )}

              {mode === 'url' && (
                <div className="space-y-2">
                  <div>
                    <label className="label">URL to fetch</label>
                    <div className="flex gap-2">
                      <input
                        type="url"
                        value={urlInput}
                        onChange={(e) => setUrlInput(e.target.value)}
                        placeholder="https://…"
                        className="input flex-1 text-sm"
                      />
                      <button
                        type="button"
                        onClick={handleFetchUrl}
                        disabled={fetchingUrl || !urlInput.trim()}
                        className="btn-secondary text-sm"
                      >
                        {fetchingUrl ? 'Fetching…' : 'Fetch page'}
                      </button>
                    </div>
                  </div>
                  {parseStatus && (
                    <p className="text-xs text-umc-700">{parseStatus}</p>
                  )}
                </div>
              )}

              {mode === 'pdf' && (
                <div className="space-y-2">
                  <div>
                    <label className="label">
                      Pages{' '}
                      <span className="text-gray-500 font-normal">
                        (optional — leave blank for all pages)
                      </span>
                    </label>
                    <input
                      type="text"
                      value={pageRangeSpec}
                      onChange={(e) => setPageRangeSpec(e.target.value)}
                      placeholder='e.g. "4-17" or "4-17, 22, 30-35"'
                      className="input text-sm"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Limits Claude to specific pages of the PDF.
                    </p>
                  </div>
                  <div>
                    <label className="label">Upload .pdf file</label>
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".pdf,application/pdf"
                      onChange={handleFile}
                      className="block text-sm"
                    />
                    {parseStatus && (
                      <p className="text-xs text-umc-700 mt-2">{parseStatus}</p>
                    )}
                  </div>
                  {pagePreviews.length > 0 && (
                    <details className="text-xs border border-gray-200 rounded">
                      <summary className="cursor-pointer px-2 py-1 bg-gray-50 hover:bg-gray-100 text-gray-700">
                        Preview included text ({pagePreviews.length} page
                        {pagePreviews.length === 1 ? '' : 's'}) — verify the
                        right pages were read before extracting
                      </summary>
                      <div className="max-h-72 overflow-y-auto p-2 space-y-2 bg-white">
                        {pagePreviews.map((pt) => (
                          <div key={pt.page}>
                            <p className="text-[10px] uppercase tracking-wide text-umc-700">
                              PDF page {pt.page}
                            </p>
                            <pre className="text-[11px] whitespace-pre-wrap font-mono text-gray-700 bg-gray-50 border border-gray-100 rounded p-2">
                              {pt.text
                                ? pt.text.slice(0, 1500) +
                                  (pt.text.length > 1500 ? '\n…[truncated for preview]' : '')
                                : '[no extractable text on this page]'}
                            </pre>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  {pagePreviews.length > 0 && (
                    <p className="text-[11px] text-gray-500 italic">
                      Tip: if the text you see isn't what you expected,
                      remember PDF pages start at the cover — printed
                      page 1 of a commentary is often PDF page 10+ after
                      the front matter.
                    </p>
                  )}
                </div>
              )}

              <div className="pt-2 border-t flex items-center justify-between flex-wrap gap-2">
                <label
                  className={`inline-flex items-center gap-2 text-xs ${
                    hasFilterSignal ? 'text-gray-700' : 'text-gray-400'
                  }`}
                  title={
                    hasFilterSignal
                      ? `Filter on:${trimmedScripture ? `\nScripture: ${trimmedScripture}` : ''}${!isPlaceholderTitle ? `\nTitle: ${trimmedTitle}` : ''}${trimmedManuscript ? '\n+ manuscript body' : ''}`
                      : "Set a scripture reference, a real title, or add manuscript text in the workspace to enable this."
                  }
                >
                  <input
                    type="checkbox"
                    checked={filterByManuscript}
                    onChange={(e) =>
                      setFilterByManuscript(e.target.checked)
                    }
                    disabled={!hasFilterSignal || extracting}
                  />
                  Only items relevant to this sermon
                  {hasFilterSignal && trimmedScripture && (
                    <span className="text-[10px] text-gray-500 ml-1">
                      ({trimmedScripture}
                      {trimmedManuscript ? ' + body' : ''})
                    </span>
                  )}
                </label>
                <button
                  type="button"
                  onClick={handleExtract}
                  disabled={extracting || !hasInput}
                  className="btn-primary text-sm disabled:opacity-50"
                >
                  {extracting ? 'Asking Claude…' : '✨ Extract'}
                </button>
              </div>
            </>
          )}

          {stage === 'review' && (
            <>
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <p className="text-sm text-gray-700">
                  Claude found{' '}
                  <strong>{proposals.length}</strong>{' '}
                  candidate{proposals.length === 1 ? '' : 's'}. Toggle the{' '}
                  <span className="text-umc-900 font-medium">attach</span>{' '}
                  switch on each row to control whether it also goes into
                  this sermon's resource list.
                </p>
                <div className="flex gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() =>
                      setProposals((prev) =>
                        prev.map((p) =>
                          p.imported ? p : { ...p, attach: true }
                        )
                      )
                    }
                    className="text-umc-700 hover:underline"
                  >
                    Attach all
                  </button>
                  <span className="text-gray-400">·</span>
                  <button
                    type="button"
                    onClick={() =>
                      setProposals((prev) =>
                        prev.map((p) =>
                          p.imported ? p : { ...p, attach: false }
                        )
                      )
                    }
                    className="text-umc-700 hover:underline"
                  >
                    Attach none
                  </button>
                </div>
              </div>

              <ul className="space-y-2">
                {proposals.map((p, i) => (
                  <li
                    key={i}
                    className={`border rounded p-3 ${
                      p.checked
                        ? 'border-gray-200'
                        : 'border-gray-100 bg-gray-50 opacity-60'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={p.checked}
                        onChange={(e) =>
                          updateProposal(i, { checked: e.target.checked })
                        }
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <input
                            type="text"
                            value={p.title}
                            onChange={(e) =>
                              updateProposal(i, { title: e.target.value })
                            }
                            className="input text-sm flex-1 min-w-[200px]"
                          />
                          <select
                            value={p.resource_type}
                            onChange={(e) =>
                              updateProposal(i, {
                                resource_type: e.target.value,
                              })
                            }
                            className="input w-auto text-xs"
                          >
                            {TYPE_OPTIONS.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </div>
                        <textarea
                          value={p.content}
                          onChange={(e) =>
                            updateProposal(i, { content: e.target.value })
                          }
                          rows={3}
                          className="input text-xs font-serif"
                        />
                        <div className="flex flex-wrap gap-2 text-xs">
                          <input
                            type="text"
                            value={p.scripture_refs}
                            onChange={(e) =>
                              updateProposal(i, {
                                scripture_refs: e.target.value,
                              })
                            }
                            placeholder="Scripture refs"
                            className="input flex-1 min-w-[140px] text-xs"
                          />
                          <input
                            type="text"
                            value={p.themes}
                            onChange={(e) =>
                              updateProposal(i, { themes: e.target.value })
                            }
                            placeholder="Themes (comma-separated)"
                            className="input flex-1 min-w-[140px] text-xs"
                          />
                          <input
                            type="text"
                            value={p.tone}
                            onChange={(e) =>
                              updateProposal(i, { tone: e.target.value })
                            }
                            placeholder="Tone"
                            className="input w-32 text-xs"
                          />
                        </div>
                        <label
                          className={`inline-flex items-center gap-2 text-xs ${
                            p.attach ? 'text-umc-900' : 'text-gray-500'
                          }`}
                          title={
                            p.attach
                              ? 'After save, this resource links to this sermon and shows in the workspace resource panel.'
                              : 'After save, this resource lives only in your general archive.'
                          }
                        >
                          <input
                            type="checkbox"
                            checked={p.attach}
                            onChange={(e) =>
                              updateProposal(i, { attach: e.target.checked })
                            }
                          />
                          {p.attach
                            ? '→ attach to this sermon'
                            : 'archive only'}
                        </label>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="flex justify-between items-center pt-2 border-t">
                <button
                  type="button"
                  onClick={() => setStage('input')}
                  className="text-xs text-gray-500 hover:text-gray-800 underline"
                >
                  ← Back to source
                </button>
                <button
                  type="button"
                  onClick={handleCommit}
                  disabled={committing}
                  className="btn-primary text-sm disabled:opacity-50"
                >
                  {committing
                    ? 'Saving…'
                    : `Save ${proposals.filter((p) => p.checked).length} resource${proposals.filter((p) => p.checked).length === 1 ? '' : 's'}`}
                </button>
              </div>
            </>
          )}

          {stage === 'done' && (
            <div className="text-center py-6 space-y-3">
              <p className="text-sm text-gray-700">
                Created <strong>{committed.created}</strong> resource
                {committed.created === 1 ? '' : 's'}
                {committed.attached > 0 && (
                  <>
                    {' '}
                    · attached <strong>{committed.attached}</strong> to this
                    sermon
                  </>
                )}
                .
              </p>
              <div className="flex justify-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setStage('input');
                    setPasted('');
                    setParsedText('');
                    setSourceLabel('');
                    setProposals([]);
                    setPageRangeSpec('');
                    setCommitted({ created: 0, attached: 0 });
                  }}
                  className="btn-secondary text-sm"
                >
                  Extract more
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="btn-primary text-sm"
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
