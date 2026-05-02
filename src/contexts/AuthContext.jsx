import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { supabase, withTimeout } from '../lib/supabase';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  // Tracks the user.id that's currently "loaded" (profile fetched). Used
  // to decide whether a SIGNED_IN event represents a real user change
  // (we need to reload profile + show spinner) or just a tab-resume
  // re-validation (no UI work needed).
  const loadedUserId = useRef(null);

  const loadProfile = useCallback(async (userId) => {
    if (!userId) {
      setProfile(null);
      return;
    }
    try {
      const { data, error } = await withTimeout(
        supabase
          .from('staff_profiles')
          .select('user_id, full_name, role')
          .eq('user_id', userId)
          .maybeSingle()
      );
      if (error) {
        // On a transient query error, KEEP the existing profile.
        console.error('Error loading staff profile:', error);
        return;
      }
      setProfile(data);
    } catch (e) {
      // Same here: on timeout, keep the last-known-good profile.
      console.error('Timeout loading staff profile:', e);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      if (!mounted) return;
      setSession(s);
      loadedUserId.current = s?.user?.id ?? null;
      await loadProfile(s?.user?.id);
      if (mounted) setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, s) => {
      if (!mounted) return;
      if (event === 'INITIAL_SESSION') return;

      const newUserId = s?.user?.id ?? null;
      const sameUser = newUserId && newUserId === loadedUserId.current;

      // SIGNED_IN fires both on real sign-ins AND every time the tab
      // regains focus while there's a valid session in storage. If it's
      // the same user we already have loaded, treat it as a no-op for
      // the UI: just refresh the session reference (token may have been
      // rotated) and leave loading alone. This prevents the page from
      // unmounting on every tab return.
      if (event === 'SIGNED_IN' && sameUser) {
        setSession(s);
        return;
      }

      if (
        event === 'SIGNED_IN' ||
        event === 'SIGNED_OUT' ||
        event === 'USER_UPDATED'
      ) {
        // Real user transition — show loading while we re-fetch profile.
        setLoading(true);
        setSession(s);
        loadedUserId.current = newUserId;
        await loadProfile(newUserId);
        if (mounted) setLoading(false);
      } else {
        // TOKEN_REFRESHED, PASSWORD_RECOVERY, etc — quiet update.
        setSession(s);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signIn = useCallback(async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
    return data;
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    isStaff: !!profile,
    isPastor: profile?.role === 'pastor',
    loading,
    signIn,
    signOut,
    refreshProfile: () => loadProfile(session?.user?.id),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
