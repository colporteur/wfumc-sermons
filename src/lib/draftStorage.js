// Tiny helper for persisting in-progress edit drafts to sessionStorage.
//
// Why sessionStorage: drafts shouldn't outlive the browser tab; if you
// close and reopen the browser, you probably don't want a half-edited
// sermon from a week ago to come back. localStorage would also leak
// across users on a shared machine.

import { useCallback, useEffect, useState } from 'react';

const PREFIX = 'wfumc-draft:';

function readDraft(key) {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeDraft(key, value) {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* full / disabled — non-fatal */
  }
}

export function clearDraft(key) {
  try {
    sessionStorage.removeItem(PREFIX + key);
  } catch {
    /* noop */
  }
}

/**
 * useDraftStorage — like useState, but writes through to sessionStorage.
 *
 * @param {string|null} key  Storage key (typically `entity-${id}`). Pass
 *   null to skip persistence (e.g., when entity isn't loaded yet).
 * @returns {[any, (next: any) => void, () => boolean, () => void]}
 *   [value, setValue, hasSavedDraft, discardDraft]
 *   - value: current draft value (or null if none)
 *   - setValue: setter that also persists
 *   - hasSavedDraft(): true if a draft exists in storage right now
 *   - discardDraft(): clears storage AND in-memory state
 */
export function useDraftStorage(key) {
  const [value, setValueState] = useState(() =>
    key ? readDraft(key) : null
  );

  // If the key changes (different sermon loaded), re-hydrate.
  useEffect(() => {
    if (!key) {
      setValueState(null);
      return;
    }
    setValueState(readDraft(key));
  }, [key]);

  const setValue = useCallback(
    (next) => {
      setValueState(next);
      if (key) writeDraft(key, next);
    },
    [key]
  );

  const hasSavedDraft = useCallback(() => {
    if (!key) return false;
    return readDraft(key) !== null;
  }, [key]);

  const discardDraft = useCallback(() => {
    if (key) clearDraft(key);
    setValueState(null);
  }, [key]);

  return [value, setValue, hasSavedDraft, discardDraft];
}
