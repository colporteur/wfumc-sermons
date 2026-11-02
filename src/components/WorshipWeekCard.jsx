import { useEffect, useState } from 'react';
import { supabase, withTimeout } from '../lib/supabase';

// "Upcoming worship" panel on the sermon detail page.
//
// Lets the pastor attach this archive sermon to an upcoming week in the
// Worship Planning app (shared Supabase project). Writes the same field
// the Worship app's "Use this" button writes:
//   worship_plans.selected_sermon_id = sermon.id
//   worship_plans.sermon_from_scratch = false
// upserted by service_date (unique).
//
// Upcoming weeks = the next N Sundays plus any 'planning'-workflow
// special services (Christmas Eve, Ash Wednesday, …) in that window.
// Weeks that already have a different sermon picked are hidden from
// the picker; weeks marked "write from scratch" are shown with a note.
//
// The Worship app only displays the "Upcoming sermon" pin once a week
// has its Scripture text selected, so when the chosen week has no text
// yet we offer to set it to this sermon's Scripture at the same time.

const WEEKS_AHEAD = 12;

function localIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function upcomingSundayDates(count) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); // today if Sunday
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(localIso(d));
    d.setDate(d.getDate() + 7);
  }
  return out;
}

function fmtDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function WorshipWeekCard({ sermon }) {
  const [weeks, setWeeks] = useState([]); // [{ service_date, label, plan }]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [picking, setPicking] = useState(false);
  const [chosenDate, setChosenDate] = useState('');
  const [setText, setSetText] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = async () => {
    if (!sermon?.id) return;
    setLoading(true);
    setError(null);
    try {
      const today = localIso(new Date());
      const sundays = upcomingSundayDates(WEEKS_AHEAD);
      const horizon = sundays[sundays.length - 1];

      const [specialsRes, plansRes, linkedRes] = await Promise.all([
        withTimeout(
          supabase
            .from('special_services')
            .select('service_date, title, workflow_kind')
            .eq('workflow_kind', 'planning')
            .gte('service_date', today)
            .lte('service_date', horizon)
        ),
        withTimeout(
          supabase
            .from('worship_plans')
            .select('*')
            .gte('service_date', today)
            .lte('service_date', horizon)
        ),
        // Any upcoming week (even beyond the horizon) already using this sermon.
        withTimeout(
          supabase
            .from('worship_plans')
            .select('*')
            .eq('selected_sermon_id', sermon.id)
            .gte('service_date', today)
        ),
      ]);
      // special_services may not be readable for everyone — non-fatal.
      if (specialsRes.error) {
        // eslint-disable-next-line no-console
        console.warn('special_services:', specialsRes.error.message);
      }
      if (plansRes.error) throw plansRes.error;
      if (linkedRes.error) throw linkedRes.error;

      const labels = {};
      for (const d of sundays) labels[d] = 'Sunday';
      for (const s of specialsRes.data ?? []) {
        labels[s.service_date] = s.title || 'Special service';
      }
      const plansByDate = {};
      for (const p of [...(plansRes.data ?? []), ...(linkedRes.data ?? [])]) {
        plansByDate[p.service_date] = p;
        if (!labels[p.service_date]) labels[p.service_date] = 'Service';
      }
      const rows = Object.keys(labels)
        .sort()
        .map((service_date) => ({
          service_date,
          label: labels[service_date],
          plan: plansByDate[service_date] || null,
        }));
      setWeeks(rows);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sermon?.id]);

  const linkedWeeks = weeks.filter(
    (w) => w.plan?.selected_sermon_id === sermon?.id
  );
  const openWeeks = weeks.filter((w) => !w.plan?.selected_sermon_id);
  const chosen = openWeeks.find((w) => w.service_date === chosenDate) || null;
  const chosenHasText = Boolean(
    chosen?.plan?.selected_text_option_id || chosen?.plan?.scripture_reference
  );
  const canSetText = Boolean(chosen && !chosenHasText && sermon?.scripture_reference);

  const startPick = () => {
    setPicking(true);
    setChosenDate(openWeeks[0]?.service_date || '');
    setSetText(true);
    setNotice(null);
    setError(null);
  };

  const assign = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        service_date: chosen.service_date,
        selected_sermon_id: sermon.id,
        sermon_from_scratch: false,
      };
      if (canSetText && setText) {
        payload.scripture_reference = sermon.scripture_reference;
      }
      const { error: err } = await withTimeout(
        supabase
          .from('worship_plans')
          .upsert(payload, { onConflict: 'service_date' })
      );
      if (err) throw err;
      setPicking(false);
      setNotice(
        `Assigned to ${fmtDate(chosen.service_date)}.` +
          (!chosenHasText && !(canSetText && setText)
            ? ' Note: the Worship app shows the upcoming sermon once that week has a Scripture text selected.'
            : '')
      );
      await load();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const unassign = async (w) => {
    if (
      !window.confirm(
        `Remove this sermon from ${fmtDate(w.service_date)}?\n\n` +
          `The week goes back to "no sermon decided" in the Worship app. ` +
          `Its Scripture text and theme are left alone.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await withTimeout(
        supabase
          .from('worship_plans')
          .update({ selected_sermon_id: null, sermon_from_scratch: false })
          .eq('service_date', w.service_date)
      );
      if (err) throw err;
      setNotice(null);
      await load();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-lg text-umc-900">Upcoming worship</h2>
        {!picking && !loading && openWeeks.length > 0 && (
          <button
            type="button"
            onClick={startPick}
            className="text-xs text-umc-700 hover:text-umc-900 underline"
          >
            + Assign to an upcoming week
          </button>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          {error}
        </p>
      )}
      {notice && (
        <p className="mt-2 text-xs text-green-800 bg-green-50 border border-green-200 rounded px-2 py-1">
          {notice}
        </p>
      )}

      {loading ? (
        <p className="mt-3 text-sm text-gray-500">Loading upcoming weeks…</p>
      ) : (
        <>
          {linkedWeeks.length === 0 ? (
            !picking && (
              <p className="mt-3 text-sm text-gray-500 italic">
                Not planned for any upcoming week.
                {openWeeks.length === 0 &&
                  ` All of the next ${WEEKS_AHEAD} weeks already have a sermon.`}
              </p>
            )
          ) : (
            <ul className="mt-2 divide-y divide-gray-100 text-sm">
              {linkedWeeks.map((w) => (
                <li
                  key={w.service_date}
                  className="py-2 flex items-start justify-between gap-3"
                >
                  <div>
                    <p className="text-gray-900">
                      {fmtDate(w.service_date)}
                      <span className="ml-2 text-xs text-gray-500">{w.label}</span>
                    </p>
                    {(w.plan?.scripture_reference || w.plan?.theme) && (
                      <p className="text-xs text-gray-600">
                        {[w.plan.scripture_reference, w.plan.theme]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => unassign(w)}
                    disabled={busy}
                    className="text-xs text-red-700 hover:text-red-900 underline disabled:opacity-50 whitespace-nowrap"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {picking && (
            <div className="mt-3 rounded border border-umc-200 bg-umc-50/40 p-3 space-y-2">
              <p className="text-[10px] uppercase tracking-wide text-umc-700">
                Weeks without a sermon (next {WEEKS_AHEAD} weeks)
              </p>
              <ul className="space-y-1 text-sm">
                {openWeeks.map((w) => {
                  const hasText = Boolean(
                    w.plan?.selected_text_option_id || w.plan?.scripture_reference
                  );
                  return (
                    <li key={w.service_date}>
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="worship-week"
                          className="mt-1"
                          checked={chosenDate === w.service_date}
                          onChange={() => setChosenDate(w.service_date)}
                        />
                        <span>
                          <span className="text-gray-900">
                            {fmtDate(w.service_date)}
                          </span>
                          <span className="ml-2 text-xs text-gray-500">{w.label}</span>
                          <span className="block text-xs text-gray-600">
                            {w.plan?.scripture_reference
                              ? w.plan.scripture_reference
                              : hasText
                              ? 'Text selected'
                              : 'No text selected yet'}
                            {w.plan?.theme ? ` · ${w.plan.theme}` : ''}
                            {w.plan?.sermon_from_scratch && (
                              <span className="text-amber-700">
                                {' '}· marked “write from scratch” (this replaces it)
                              </span>
                            )}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>

              {canSetText && (
                <label className="flex items-start gap-2 text-xs text-gray-700 pt-1">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={setText}
                    onChange={(e) => setSetText(e.target.checked)}
                  />
                  <span>
                    Also set this week’s Scripture to{' '}
                    <strong>{sermon.scripture_reference}</strong>. (The Worship
                    app only shows the upcoming sermon once a week has its
                    text chosen.)
                  </span>
                </label>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setPicking(false)}
                  disabled={busy}
                  className="btn-secondary text-xs"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={assign}
                  disabled={busy || !chosen}
                  className="btn-primary text-xs disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Assign'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
