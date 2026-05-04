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

  const handleCommit = async () => {
    if (!bulletinId) {
      setError('Pick a bulletin first.');
      return;
    }
    if (!body.trim()) {
      setError('Body is empty — nothing to send.');
      return;
    }
    setCommitting(true);
    setError(null);
    try {
      // Compute next position in the chosen bulletin.
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
        existing && existing.length > 0 ? (existing[0].position ?? 0) + 1 : 1;

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
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setCommitting(false);
    }
  };

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
                  Will be appended to the end of the chosen bulletin's order
                  of worship. You can reorder and refine in the bulletin
                  editor afterward.
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
                  disabled={committing || !bulletinId}
                  className="btn-primary text-sm disabled:opacity-50"
                >
                  {committing ? 'Sending…' : 'Send to bulletin'}
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
