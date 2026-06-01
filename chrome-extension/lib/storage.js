// chrome.storage.sync helpers for settings, chrome.storage.local for
// transient state (the pending capture that the popup picks up).
//
// All functions return promises (chrome.storage.* APIs already return
// promises in MV3 if no callback is given).

export const SETTINGS_KEYS = [
  'supabaseUrl',
  'supabaseAnonKey',
  'anthropicApiKey',
  'defaultLibraryId',
];

const SESSION_KEY = 'supabaseSession';
const PENDING_KEY = 'pendingCapture';

export async function getSettings() {
  const out = await chrome.storage.sync.get(SETTINGS_KEYS);
  return {
    supabaseUrl: out.supabaseUrl || '',
    supabaseAnonKey: out.supabaseAnonKey || '',
    anthropicApiKey: out.anthropicApiKey || '',
    defaultLibraryId: out.defaultLibraryId || '',
  };
}

export async function setSettings(patch) {
  const valid = {};
  for (const k of SETTINGS_KEYS) {
    if (k in patch) valid[k] = patch[k];
  }
  await chrome.storage.sync.set(valid);
}

// Session — stores Supabase access_token + refresh_token + expiry.
// Lives in chrome.storage.local (not synced; per-device).
export async function getSession() {
  const out = await chrome.storage.local.get([SESSION_KEY]);
  return out[SESSION_KEY] || null;
}

export async function setSession(session) {
  if (session) {
    await chrome.storage.local.set({ [SESSION_KEY]: session });
  } else {
    await chrome.storage.local.remove(SESSION_KEY);
  }
}

// Pending capture — the payload that background.js writes when a
// context menu is clicked, and that popup.js reads on open. Cleared
// after popup commits or cancels so a stale capture doesn't reappear.
export async function getPendingCapture() {
  const out = await chrome.storage.local.get([PENDING_KEY]);
  return out[PENDING_KEY] || null;
}

export async function setPendingCapture(payload) {
  if (payload) {
    await chrome.storage.local.set({ [PENDING_KEY]: payload });
  } else {
    await chrome.storage.local.remove(PENDING_KEY);
  }
}

export async function clearPendingCapture() {
  await chrome.storage.local.remove(PENDING_KEY);
}
