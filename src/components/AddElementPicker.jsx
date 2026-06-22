import { useState } from 'react';
import { ELEMENT_GROUPS } from '../lib/worshipElements';

// Inline + dropdown for adding an element to a liturgy. Shows the
// canonical worship-element list grouped by liturgical movement
// (Gathering, Word, Response, Thanksgiving, Sending).
//
// Props:
//   onAdd  - async (elementKey) => void
//   busy   - parent busy flag
export default function AddElementPicker({ onAdd, busy }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  const handlePick = async (key) => {
    setAdding(true);
    try {
      await onAdd(key);
      setOpen(false);
    } catch (e) {
      window.alert(e.message || String(e));
    } finally {
      setAdding(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={busy}
        className="btn-secondary text-sm disabled:opacity-50"
      >
        + Add element
      </button>
    );
  }

  return (
    <div className="border border-umc-200 bg-umc-50 rounded p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-umc-900">
          Pick an element to add
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-gray-500 hover:text-gray-800 underline"
        >
          Cancel
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {ELEMENT_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.elements.map((el) => (
                <li key={el.key}>
                  <button
                    type="button"
                    onClick={() => handlePick(el.key)}
                    disabled={adding}
                    className="text-left text-sm text-umc-700 hover:text-umc-900 hover:underline disabled:opacity-50 w-full"
                  >
                    {el.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
