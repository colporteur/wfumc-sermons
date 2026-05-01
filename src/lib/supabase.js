import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // eslint-disable-next-line no-console
  console.error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
      'Copy .env.example to .env.local and fill in the values.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    // Distinct storage key from the bulletin app so the two apps' sessions
    // don't fight each other if a user has both open.
    storageKey: 'wfumc-sermons-auth',
    // Override the default navigator.locks-based mutex with a no-op —
    // same fix as the bulletin app to avoid intermittent deadlocks.
    lock: (_name, _acquireTimeout, fn) => fn(),
  },
});

// 15-second timeout wrapper used everywhere we hit Supabase, so the UI
// never hangs forever on a stuck call.
export function withTimeout(promise, ms = 15000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Request timed out after ${Math.round(ms / 1000)}s. ` +
            `Check your connection and try again. If this keeps happening, ` +
            `clear localStorage (DevTools → Application → Local Storage) and sign in again.`
        )
      );
    }, ms);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    timeout,
  ]);
}
