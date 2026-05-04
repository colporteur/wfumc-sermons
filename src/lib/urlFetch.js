// Fetch a URL through the url-fetch Supabase Edge Function and return
// its plain-text body + title.
//
// Browsers can't fetch arbitrary external URLs because of CORS. The
// Edge Function does the fetch server-side, strips HTML to text, and
// returns the result. Auth: same JWT-based pattern as claude-proxy.

import { supabase, withTimeout } from './supabase';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;

/**
 * @param {string} url   http(s) URL to fetch.
 * @returns {Promise<{ text: string, title: string, finalUrl: string }>}
 */
export async function fetchUrlText(url) {
  if (!url || !/^https?:\/\//i.test(url.trim())) {
    throw new Error('Enter a valid http(s) URL.');
  }
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in.');

  const res = await withTimeout(
    fetch(`${supabaseUrl}/functions/v1/url-fetch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ url: url.trim() }),
    }),
    45000
  );

  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new Error(
      body?.error || `url-fetch failed (${res.status})`
    );
  }
  if (!body?.text || !body.text.trim()) {
    throw new Error("Couldn't extract any readable text from that page.");
  }
  return {
    text: body.text,
    title: body.title || '',
    finalUrl: body.finalUrl || url,
  };
}
