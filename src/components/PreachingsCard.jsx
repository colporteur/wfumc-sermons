import { useState } from 'react';
import { supabase, withTimeout } from '../lib/supabase';

// CRUD panel for the "Preached" history of a sermon. Shows each past
// preaching of this sermon (date + location + optional title-as-used,
// series, bulletin link, parsed liturgy text). Lets the pastor:
//   - Add a new preaching entry (date + location + optional fields)
//   - Edit an existing entry inline
//   - Delete an entry
// All writes go straight to the `preachings` table; the parent owns
// the list state and we update it via setPreachings.
//
// Bulletin-linked rows (those that came from a published bulletin)
// can still be edited and deleted here — but deleting one only
// removes the preaching record, not the bulletin itself.

function fmtDate(yyyymmdd) {
  if (!yyyymmdd) return '';
  return new Date(yyyymmdd + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// Empty form template used for both Add and reset-on-cancel.
const emptyForm = {
  preached_at: '',
  location: '',
  title_used: '',
  series: '',
  notes: '',
};

export default function PreachingsCard({
  sermon,
  preachings,
  setPreachings,
  userId,
}) {
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(emptyForm);
  const [busyId, setBusyId] = useState(null); // id of row being saved/deleted, or 'new' for add
  const [error, setError] = useState(null);

  const sortPreachings = (rows) =>
    [...rows].sort((a, b) => {
      // Most recent first; null dates sink to the bottom.
      if (!a.preached_at && !b.preached_at) return 0;
      if (!a.preached_at) return 1;
      if (!b.preached_at) return -1;
      return b.preached_at.localeCompare(a.preached_at);
    });

  const startEdit = (p) => {
    setEditingId(p.id);
    setEditForm({
      preached_at: p.preached_at || '',
      location: p.location || '',
      title_used: p.title_used || '',
      series: p.series || '',
      notes: p.notes || '',
    });
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm(emptyForm);
    setError(null);
  };

  const saveEdit = async (p) => {
    setBusyId(p.id);
    setError(null);
    try {
      const payload = {
        preached_at: editForm.preached_at || null,
        location: editForm.location.trim() || null,
        title_used: editForm.title_used.trim() || null,
        series: editForm.series.trim() || null,
        notes: editForm.notes.trim() || null,
      };
      const { data, error: err } = await withTimeout(
        supabase
          .from('preachings')
          .update(payload)
          .eq('id', p.id)
          .select('*, bulletin:bulletins(id, service_date, sunday_designation, status)')
          .single()
      );
      if (err) throw err;
      setPreachings((prev) =>
        sortPreachings(prev.map((row) => (row.id === p.id ? { ...row, ...data } : row)))
      );
      cancelEdit();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  const deleteRow = async (p) => {
    const label = p.preached_at
      ? fmtDate(p.preached_at)
      : '(undated preaching)';
    if (
      !window.confirm(
        `Delete the preaching record for ${label}${p.location ? ` at ${p.location}` : ''}?\n\n` +
          `This only removes the history entry. If this preaching was tied to a bulletin, ` +
          `the bulletin itself is left alone.`
      )
    ) {
      return;
    }
    setBusyId(p.id);
    setError(null);
    try {
      const { error: err } = await withTimeout(
        supabase.from('preachings').delete().eq('id', p.id)
      );
      if (err) throw err;
      setPreachings((prev) => prev.filter((row) => row.id !== p.id));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  const startAdd = () => {
    setAdding(true);
    setAddForm({
      ...emptyForm,
      // Default location to the most-recent preaching's location, since
      // most adds are at the same church.
      location: preachings[0]?.location || '',
    });
    setError(null);
  };

  const cancelAdd = () => {
    setAdding(false);
    setAddForm(emptyForm);
    setError(null);
  };

  const saveAdd = async () => {
    if (!sermon?.id || !userId) {
      setError('Missing sermon or user context.');
      return;
    }
    if (!addForm.preached_at && !addForm.location.trim()) {
      setError('Add at least a date or a location.');
      return;
    }
    setBusyId('new');
    setError(null);
    try {
      const payload = {
        sermon_id: sermon.id,
        owner_user_id: userId,
        preached_at: addForm.preached_at || null,
        location: addForm.location.trim() || null,
        title_used: addForm.title_used.trim() || null,
        series: addForm.series.trim() || null,
        notes: addForm.notes.trim() || null,
      };
      const { data, error: err } = await withTimeout(
        supabase
          .from('preachings')
          .insert(payload)
          .select('*, bulletin:bulletins(id, service_date, sunday_designation, status)')
          .single()
      );
      if (err) throw err;
      setPreachings((prev) => sortPreachings([...prev, data]));
      cancelAdd();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  const renderForm = (form, setForm, onSave, onCancel, savingKey, saveLabel) => {
    const saving = busyId === savingKey;
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="block text-xs">
            <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
              Date
            </span>
            <input
              type="date"
              value={form.preached_at}
              onChange={(e) =>
                setForm((f) => ({ ...f, preached_at: e.target.value }))
              }
              className="input w-full text-sm"
            />
          </label>
          <label className="block text-xs">
            <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
              Location
            </span>
            <input
              type="text"
              value={form.location}
              onChange={(e) =>
                setForm((f) => ({ ...f, location: e.target.value }))
              }
              placeholder="Wedowee First UMC"
              className="input w-full text-sm"
            />
          </label>
          <label className="block text-xs">
            <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
              Title used (if different)
            </span>
            <input
              type="text"
              value={form.title_used}
              onChange={(e) =>
                setForm((f) => ({ ...f, title_used: e.target.value }))
              }
              placeholder=""
              className="input w-full text-sm"
            />
          </label>
          <label className="block text-xs">
            <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
              Series
            </span>
            <input
              type="text"
              value={form.series}
              onChange={(e) =>
                setForm((f) => ({ ...f, series: e.target.value }))
              }
              placeholder=""
              className="input w-full text-sm"
            />
          </label>
        </div>
        <label className="block text-xs">
          <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
            Notes
          </span>
          <textarea
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            rows={2}
            className="input w-full text-sm"
          />
        </label>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="btn-secondary text-xs"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="btn-primary text-xs disabled:opacity-50"
          >
            {saving ? 'Saving…' : saveLabel}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="card">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-lg text-umc-900">
          Preached
          {preachings.length > 0 && (
            <span className="ml-2 text-sm font-normal text-gray-500">
              ({preachings.length} time{preachings.length === 1 ? '' : 's'})
            </span>
          )}
        </h2>
        {!adding && (
          <button
            type="button"
            onClick={startAdd}
            className="text-xs text-umc-700 hover:text-umc-900 underline"
          >
            + Add preaching
          </button>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          {error}
        </p>
      )}

      {adding && (
        <div className="mt-3 rounded border border-umc-200 bg-umc-50/40 p-3">
          <p className="text-[10px] uppercase tracking-wide text-umc-700 mb-2">
            New preaching entry
          </p>
          {renderForm(addForm, setAddForm, saveAdd, cancelAdd, 'new', 'Add')}
        </div>
      )}

      {preachings.length === 0 && !adding ? (
        <p className="mt-3 text-sm text-gray-500 italic">
          No preaching history yet. Use “Add preaching” to record when you’ve
          preached this sermon.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-gray-100 text-sm">
          {preachings.map((p) => {
            const isEditing = editingId === p.id;
            const rowBusy = busyId === p.id;
            return (
              <li key={p.id} className="py-2">
                {isEditing ? (
                  <div className="rounded border border-gray-200 bg-gray-50 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">
                      Editing preaching entry
                    </p>
                    {renderForm(
                      editForm,
                      setEditForm,
                      () => saveEdit(p),
                      cancelEdit,
                      p.id,
                      'Save'
                    )}
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-gray-700">
                        {p.preached_at ? (
                          fmtDate(p.preached_at)
                        ) : (
                          <span className="italic text-gray-400">
                            Date unknown
                          </span>
                        )}
                        {p.location && (
                          <span className="text-gray-500 ml-2">
                            — {p.location}
                          </span>
                        )}
                      </div>
                      {p.title_used && p.title_used !== sermon?.title && (
                        <div className="text-xs text-gray-500 italic mt-0.5">
                          Titled: "{p.title_used}"
                        </div>
                      )}
                      {p.series && (
                        <div className="text-xs text-gray-500 mt-0.5">
                          Series: {p.series}
                        </div>
                      )}
                      {p.notes && (
                        <div className="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap">
                          {p.notes}
                        </div>
                      )}
                      {p.bulletin && (
                        <div className="text-xs text-gray-400 mt-0.5">
                          In bulletin: {p.bulletin.sunday_designation || ''}
                          {p.bulletin.status !== 'published' && (
                            <span className="ml-1 px-1 py-0.5 text-[10px] uppercase tracking-wide rounded bg-gray-100 text-gray-500">
                              {p.bulletin.status}
                            </span>
                          )}
                        </div>
                      )}
                      {p.liturgy_text && (
                        <details className="mt-2">
                          <summary className="text-xs text-umc-700 hover:text-umc-900 cursor-pointer">
                            📄 Liturgy
                            {p.liturgy_source_filename && (
                              <span className="ml-1 text-gray-400 font-mono text-[10px]">
                                ({p.liturgy_source_filename})
                              </span>
                            )}
                          </summary>
                          <p className="mt-2 text-sm text-gray-800 whitespace-pre-wrap font-serif leading-relaxed bg-gray-50 border border-gray-200 rounded p-3 max-h-96 overflow-y-auto">
                            {p.liturgy_text}
                          </p>
                        </details>
                      )}
                    </div>
                    <div className="flex flex-col sm:flex-row gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => startEdit(p)}
                        disabled={rowBusy || editingId !== null || adding}
                        className="text-xs text-gray-600 hover:text-umc-900 underline disabled:opacity-40"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteRow(p)}
                        disabled={rowBusy || editingId !== null || adding}
                        className="text-xs text-red-600 hover:text-red-800 underline disabled:opacity-40"
                      >
                        {rowBusy ? '…' : 'Delete'}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
