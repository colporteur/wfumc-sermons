import { useEffect, useState } from 'react';
import { supabase, withTimeout } from '../lib/supabase';

// Send a parsed liturgy section into the order of worship of a chosen
// bulletin. The pastor edits the text first; on commit we insert a
// liturgy_items row at the end of the chosen bulletin's order.
//
// Section-kind → item_type mapping is best-effort. Pastor can change
// the type in the dropdown before committing.

const SECTION_TO_ITEM_TYPE = {
  call_to_worship: 'responsive_reading',
  opening_prayer: 'prayer_text',
  pastoral_prayer: 'prayer_text',
  confession: 'prayer_text',
  assurance: 'prayer_text',
  responsive_reading: 'responsive_reading',
  affirmation: 'prayer_text',
  scripture: 'scripture',
  sermon: 'sermon',
  hymn: 'hymn',
  offering_prayer: 'prayer_text',
  communion: 'communion',
  benediction: 'prayer_text',
  announcements: 'generic',
  other: 'generic',
};

const ITEM_TYPE_OPTIONS = [
  { value: 'generic', label: 'Generic' },
  { value: 'hymn', label: 'Hymn' },
  { value: 'music', label: 'Music' },
  { value: 'scripture', label: 'Scripture' },
  { value: 'prayer_text', label: 'Prayer / responsive text' },
  { value: 'responsive_reading', label: 'Responsive reading' },
  { value: 'communion', label: 'Communion' },
  { value: 'sermon', label: 'Sermon' },
  { value: 'giving', label: 'Giving / offering' },
];

export default function SendToBulletinModal({ section, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [bulletins, setBulletins] = useState([]);
  const [bulletinId, setBulletinId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [itemType, setItemType] = useState('generic');
  const [committing, setCommitting] = useState(false);
  const [done, setDone] = useState(null); // { bulletinId, itemId, message }

  // Mode: 'append' (default — insert at the end of the chosen
  // bulletin) or 'replace' (overwrite an existing liturgy item in place).
  const [mode, setMode] = useState('append');
  const [existingItems, setExistingItems] = useState([]);
  const [replaceItemId, setReplaceItemId] = useState('');
  const [loadingItems, setLoadingItems] = useState(false);

  useEffect(() => {
    if (!section) return;
    setTitle(section.title || titleFromKind(section.section_kind) || '');
    setBody(section.body || '');
    setItemType(SECTION_TO_ITEM_TYPE[section.section_kind] || 'generic');
    setError(null);
    setDone(null);
    setLoading(true);
    (async () => {
      try {
        // Load bulletins relevant for sending: any draft + anything
        // dated today or later (regardless of status). Most recent
        // last so the picker defaults to "next upcoming" naturally
        // when sorted ascending below.
        const today = new Date().toISOString().slice(0, 10);
        const { data, error: err } = await withTimeout(
          supabase
            .from('bulletins')
            .select(
              'id, service_date, sunday_designation, status'
            )
            .or(`status.eq.draft,service_date.gte.${today}`)
            .order('service_date', { ascending: true })
        );
        if (err) throw err;
        setBulletins(data ?? []);
        if (data && data.length > 0) {
          // Default to the next upcoming, or the first draft.
          const upcoming = data.find((b) => b.service_date >= today);
          setBulletinId((upcoming || data[0]).id);
        }
      } catch (e) {
        setError(e.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [section]);

  // Whenever the chosen bulletin changes, fetch its existing liturgy
  // items so the Replace-mode dropdown is ready to use the moment the
  // pastor flips the toggle. Best-effort — failure leaves the dropdown
  // empty and falls back to "Append".
  useEffect(() => {
    if (!bulletinId) {
      setExistingItems([]);
      setReplaceItemId('');
      return;
    }
    let cancelled = false;
    setLoadingItems(true);
    (async () => {
      try {
        const { data, error: itemsErr } = await withTimeout(
          supabase
            .from('liturgy_items')
            .select('id, position, item_type, title, inline_body')
            .eq('bulletin_id', bulletinId)
            .order('position', { ascending: true })
        );
        if (itemsErr) throw itemsErr;
        if (cancelled) return;
        setExistingItems(data ?? []);
        // Reset the picked item whenever the bulletin changes so we
        // never carry an id from one bulletin into another.
        setReplaceItemId('');
      } catch (e) {
        if (!cancelled) setExistingItems([]);
        // Don't surface the error in the main banner — Replace mode
        // can simply be unavailable; Append still works.
        // eslint-disable-next-line no-console
        console.warn('SendToBulletinModal: failed to load existing items', e);
      } finally {
        if (!cancelled) setLoadingItems(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bulletinId]);

  const handleCommit = async () => {
    if (!bulletinId) {
      setError('Pick a bulletin first.');
      return;
    }
    if (!body.trim()) {
      setError('Body is empty — nothing to send.');
      return;
    }
    if (mode === 'replace' && !replaceItemId) {
      setError(
        'Pick which existing liturgy item to overwrite, or switch to Append mode.'
      );
      return;
    }
    if (mode === 'replace') {
      const target = existingItems.find((i) => i.id === replaceItemId);
      const targetLabel = target
        ? `#${target.position} · ${
            target.title || itemTypeLabel(target.item_type) || '(untitled)'
          }`
        : 'this item';
      if (
        !window.confirm(
          `Overwrite ${targetLabel} with the new content?\n\n` +
            `The existing title, body, and item type will be replaced. ` +
            `Position in the order of worship stays the same.`
        )
      ) {
        return;
      }
    }
    setCommitting(true);
    setError(null);
    try {
      if (mode === 'replace') {
        // UPDATE the chosen item in place. Position stays as-is so the
        // pastor's existing order of worship layout is preserved.
        const { data: updated, error: updErr } = await withTimeout(
          supabase
            .from('liturgy_items')
            .update({
              item_type: itemType,
              title: title.trim() || titleFromKind(section.section_kind),
              inline_body: body,
            })
            .eq('id', replaceItemId)
            .select('id')
            .single()
        );
        if (updErr) throw updErr;
        setDone({
          bulletinId,
          itemId: updated.id,
          message: 'Existing item overwritten.',
        });
      } else {
        // APPEND: compute next position in the chosen bulletin and insert.
        const { data: existing, error: posErr } = await withTimeout(
          supabase
            .from('liturgy_items')
            .select('position')
            .eq('bulletin_id', bulletinId)
            .order('position', { ascending: false })
            .limit(1)
        );
        if (posErr) throw posErr;
        const nextPos =
          existing && existing.length > 0
            ? (existing[0].position ?? 0) + 1
            : 1;

        const { data: newItem, error: insErr } = await withTimeout(
          supabase
            .from('liturgy_items')
            .insert({
              bulletin_id: bulletinId,
              position: nextPos,
              item_type: itemType,
              title: title.trim() || titleFromKind(section.section_kind),
              inline_body: body,
              is_starred: false,
            })
            .select('id')
            .single()
        );
        if (insErr) throw insErr;
        setDone({
          bulletinId,
          itemId: newItem.id,
          message: 'Sent to bulletin.',
        });
      }
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setCommitting(false);
    }
  };

  const itemTypeLabel = (t) =>
    ITEM_TYPE_OPTIONS.find((o) => o.value === t)?.label || t;

  if (!section) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-2xl rounded-t-lg sm:rounded-lg shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 space-y-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-serif text-xl text-umc-900">
              Send to bulletin
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-700 text-sm"
            >
              Close
            </button>
          </div>

          {error && (
            <p className="rounded bg-red-50 border border-red-200 px-2 py-1 text-sm text-red-700">
              {error}
            </p>
          )}

          {loading ? (
            <p className="text-sm text-gray-500 italic">
              Loading bulletins…
            </p>
          ) : done ? (
            <div className="text-center space-y-3 py-6">
              <p className="text-base text-umc-900">✓ {done.message}</p>
              <p className="text-xs text-gray-600">
                Open the bulletin in the bulletin admin app to refine the
                placement and details.
              </p>
              <button type="button" onClick={onClose} className="btn-primary">
                Close
              </button>
            </div>
          ) : bulletins.length === 0 ? (
            <p className="text-sm text-gray-700">
              No draft or upcoming bulletins to send to. Create a new
              bulletin in the bulletin admin app first.
            </p>
          ) : (
            <>
              <div>
                <label className="label">Send to bulletin</label>
                <select
                  value={bulletinId}
                  onChange={(e) => setBulletinId(e.target.value)}
                  className="input"
                >
                  {bulletins.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.service_date}
                      {b.sunday_designation
                        ? ` · ${b.sunday_designation}`
                        : ''}{' '}
                      ({b.status})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <span className="label">Where to put it</span>
                <div className="flex flex-wrap items-center gap-4 mt-1">
                  <label className="inline-flex items-baseline gap-1.5 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="send-mode"
                      value="append"
                      checked={mode === 'append'}
                      onChange={() => setMode('append')}
                    />
                    <span>Append to end of order of worship</span>
                  </label>
                  <label
                    className={
                      'inline-flex items-baseline gap-1.5 text-sm cursor-pointer ' +
                      (existingItems.length === 0 ? 'opacity-50' : '')
                    }
                    title={
                      existingItems.length === 0
                        ? 'This bulletin has no existing liturgy items to overwrite.'
                        : 'Pick an existing item to overwrite in place.'
                    }
                  >
                    <input
                      type="radio"
                      name="send-mode"
                      value="replace"
                      checked={mode === 'replace'}
                      onChange={() => setMode('replace')}
                      disabled={existingItems.length === 0}
                    />
                    <span>Replace an existing item</span>
                  </label>
                </div>
              </div>

              {mode === 'replace' && (
                <div>
                  <label className="label">Item to overwrite</label>
                  {loadingItems ? (
                    <p className="text-xs text-gray-500 italic">
                      Loading existing items…
                    </p>
                  ) : (
                    <select
                      value={replaceItemId}
                      onChange={(e) => setReplaceItemId(e.target.value)}
                      className="input"
                    >
                      <option value="">— Pick an existing item —</option>
                      {existingItems.map((it) => {
                        const label =
                          it.title ||
                          itemTypeLabel(it.item_type) ||
                          '(untitled)';
                        const preview = it.inline_body
                          ? ' — ' +
                            it.inline_body
                              .replace(/\s+/g, ' ')
                              .trim()
                              .slice(0, 50) +
                            (it.inline_body.length > 50 ? '…' : '')
                          : '';
                        return (
                          <option key={it.id} value={it.id}>
                            #{it.position} · {label} ({it.item_type}){preview}
                          </option>
                        );
                      })}
                    </select>
                  )}
                  <p className="text-[11px] text-gray-500 mt-1">
                    The chosen item's title, body, and type will be
                    overwritten. Its position in the order of worship is
                    preserved.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <label className="label">Item title</label>
                  <input
                    type="text"
                    className="input"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">Type</label>
                  <select
                    className="input"
                    value={itemType}
                    onChange={(e) => setItemType(e.target.value)}
                  >
                    {ITEM_TYPE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="label">Body (edit before sending)</label>
                <textarea
                  className="input min-h-[200px] font-serif text-sm"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
                <p className="text-[11px] text-gray-500 mt-1">
                  {mode === 'replace'
                    ? "Will overwrite the chosen item's body in place. You can refine in the bulletin editor afterward."
                    : "Will be appended to the end of the chosen bulletin's order of worship. You can reorder and refine in the bulletin editor afterward."}
                </p>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="btn-secondary text-sm"
                  disabled={committing}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCommit}
                  disabled={
                    committing ||
                    !bulletinId ||
                    (mode === 'replace' && !replaceItemId)
                  }
                  className="btn-primary text-sm disabled:opacity-50"
                >
                  {committing
                    ? mode === 'replace'
                      ? 'Overwriting…'
                      : 'Sending…'
                    : mode === 'replace'
                    ? 'Overwrite existing item'
                    : 'Send to bulletin'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function titleFromKind(kind) {
  const map = {
    call_to_worship: 'Call to Worship',
    opening_prayer: 'Opening Prayer',
    pastoral_prayer: 'Pastoral Prayer',
    confession: 'Confession',
    assurance: 'Words of Assurance',
    responsive_reading: 'Responsive Reading',
    affirmation: 'Affirmation of Faith',
    scripture: 'Scripture Reading',
    sermon: 'Sermon',
    hymn: 'Hymn',
    offering_prayer: 'Offering Prayer',
    communion: 'Communion',
    benediction: 'Benediction',
    announcements: 'Announcements',
  };
  return map[kind] || '';
}
