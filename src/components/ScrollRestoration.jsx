import { useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// Per-history-entry scroll restoration for SPA navigation.
//
// Behavior:
//   - On scroll, throttle-save the current scrollY to sessionStorage,
//     keyed by location.key (React Router's stable id for the history
//     entry).
//   - On location change:
//       * POP (back/forward) → restore the saved scroll for the new key
//       * PUSH/REPLACE      → scroll to top (a fresh navigation)
//
// Why sessionStorage: survives reload and the auth re-validation flicker
// without leaking across browser sessions. Cleared automatically when
// the tab closes.
export default function ScrollRestoration() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const lastSaveRef = useRef(0);

  // Save scroll on scroll (throttled). Re-runs whenever location.key
  // changes so we always save under the current key.
  useEffect(() => {
    const key = `scroll:${location.key}`;
    const save = () => {
      const now = Date.now();
      if (now - lastSaveRef.current < 100) return;
      lastSaveRef.current = now;
      try {
        sessionStorage.setItem(key, String(window.scrollY));
      } catch {
        /* sessionStorage full / disabled — non-fatal */
      }
    };
    window.addEventListener('scroll', save, { passive: true });
    return () => {
      window.removeEventListener('scroll', save);
      // Final flush — capture the very last scroll position before the
      // listener detaches.
      try {
        sessionStorage.setItem(key, String(window.scrollY));
      } catch {
        /* noop */
      }
    };
  }, [location.key]);

  // Restore (POP) or reset (PUSH/REPLACE) on location change. Wait one
  // tick so the new page has a chance to render its content (otherwise
  // a tall scroll target may not yet exist and the browser clamps).
  useEffect(() => {
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      if (navigationType === 'POP') {
        const saved = sessionStorage.getItem(`scroll:${location.key}`);
        if (saved !== null) {
          window.scrollTo(0, parseInt(saved, 10) || 0);
          return;
        }
      }
      window.scrollTo(0, 0);
    };
    // requestAnimationFrame gives React time to commit the new DOM.
    const raf = window.requestAnimationFrame(apply);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
    };
  }, [location.key, location.pathname, navigationType]);

  return null;
}
