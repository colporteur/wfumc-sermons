import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import { ELEMENT_GROUPS } from '../lib/worshipElements';
import {
  loadAllInstructions,
  saveInstructionsForElement,
} from '../lib/liturgyInstructions';

// Dedicated settings page where the pastor authors persistent
// per-element-type drafting instructions. These get prepended to every
// Claude draft/brainstorm call for that element type.
//
// Inline "Save as my default" buttons on LiturgyElementDraftModal save
// the SAME table — this page just gives a top-down view to author
// everything at once.
export default function LiturgyInstructions() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Map of { [element_type]: { value: current_textarea, saved: db_value, busy } }
  const [state, setState] = useState({});
  const [savedFlash, setSavedFlash] = useState(null); // element_type just saved

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const map = await loadAllInstructions(user.id);
        if (cancelled) return;
        const initial = {};
        for (const group of ELEMENT_GROUPS) {
          for (const el of group.elements) {
            const saved = map[el.key] || '';
            initial[el.key] = { value: saved, saved, busy: false };
          }
        }
        setState(initial);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const handleChange = (key, value) => {
    setState((prev) => ({
      ...prev,
      [key]: { ...prev[key], value },
    }));
  };

  const handleSave = async (key) => {
    setState((prev) => ({
      ...prev,
      [key]: { ...prev[key], busy: true },
    }));
    setError(null);
    try {
      await saveInstructionsForElement(user.id, key, state[key].value);
      setState((prev) => ({
        ...prev,
        [key]: { value: prev[key].value, saved: prev[key].value, busy: false },
      }));
      setSavedFlash(key);
      setTimeout(() => setSavedFlash((curr) => (curr === key ? null : curr)), 1600);
    } catch (e) {
      setError(e.message || String(e));
      setState((prev) => ({
        ...prev,
        [key]: { ...prev[key], busy: false },
      }));
    }
  };

  const handleRevert = (key) => {
    setState((prev) => ({
      ...prev,
      [key]: { ...prev[key], value: prev[key].saved },
    }));
  };

  if (loading) return <LoadingSpinner label="Loading instructions…" />;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link
          to="/settings"
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← Settings
        </Link>
        <h1 className="text-2xl font-serif text-umc-900 mt-1">
          Liturgy drafting instructions
        </h1>
        <p className="text-sm text-gray-600 mt-1">
          When you click "✨ Draft" or "💡 Brainstorm" on a liturgy
          element, Claude follows your standing instructions for that
          element type along with the scripture and (optionally) the
          spoiler-safe sermon theme. Anything you save here persists
          across sessions.
        </p>
        <p className="text-xs text-gray-500 mt-2 italic">
          Leave any element blank for "no standing guidance" — Claude
          will use only the scripture, sermon theme, and its own UMC
          worship sensibility.
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      {ELEMENT_GROUPS.map((group) => (
        <div key={group.label} className="space-y-3">
          <h2 className="font-serif text-lg text-umc-900">{group.label}</h2>
          {group.elements.map((el) => {
            const s = state[el.key] || { value: '', saved: '', busy: false };
            const dirty = s.value !== s.saved;
            const justSaved = savedFlash === el.key;
            return (
              <div key={el.key} className="card space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-medium text-umc-900">{el.label}</h3>
                  <div className="flex items-center gap-2 text-xs">
                    {justSaved && (
                      <span className="text-green-700">✓ Saved</span>
                    )}
                    {dirty && (
                      <button
                        type="button"
                        onClick={() => handleRevert(el.key)}
                        className="text-gray-500 hover:text-gray-800 underline"
                      >
                        Revert
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleSave(el.key)}
                      disabled={!dirty || s.busy}
                      className="btn-secondary text-xs disabled:opacity-50"
                    >
                      {s.busy ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
                <textarea
                  className="input w-full text-sm min-h-[80px]"
                  value={s.value}
                  onChange={(e) => handleChange(el.key, e.target.value)}
                  placeholder={`Standing guidance for every ${el.label}. (e.g. "Always include responsive Leader/People structure.")`}
                  disabled={s.busy}
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
