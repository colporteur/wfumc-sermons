// Tiny Supabase REST + Auth + Storage client.
//
// We avoid the supabase-js SDK to keep the extension small and to keep
// service-worker import semantics simple. Only the endpoints we need
// are wrapped.

import { getSettings, getSession, setSession } from './storage.js';

class SupabaseError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function withConfig() {
  const settings = await getSettings();
  if (!settings.supabaseUrl || !settings.supabaseAnonKey) {
    throw new SupabaseError(
      'Supabase URL and anon key not set. Open the extension Settings page.'
    );
  }
  const url = settings.supabaseUrl.replace(/\/$/, '');
  return { url, anonKey: settings.supabaseAnonKey };
}

// ---------- Auth ----------

export async function signIn(email, password) {
  const { url, anonKey } = await withConfig();
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
    },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new SupabaseError(
      body.error_description || body.msg || 'Sign-in failed',
      res.status,
      body
    );
  }
  const session = {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (body.expires_in || 3600),
    user: body.user,
  };
  await setSession(session);
  return session;
}

export async function signOut() {
  const session = await getSession();
  if (session?.access_token) {
    try {
      const { url, anonKey } = await withConfig();
      await fetch(`${url}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${session.access_token}`,
        },
      });
    } catch {
      // Ignore — even if remote logout fails, clear local state.
    }
  }
  await setSession(null);
}

// Refresh the access token if it's expired (or close to expiring).
// Returns the (possibly-refreshed) session, or null if no session
// exists / refresh failed.
export async function ensureSession() {
  let session = await getSession();
  if (!session) return null;
  const now = Math.floor(Date.now() / 1000);
  // Refresh 60 seconds before expiry to avoid races.
  if (session.expires_at && session.expires_at - now > 60) {
    return session;
  }
  // Time to refresh.
  if (!session.refresh_token) return null;
  try {
    const { url, anonKey } = await withConfig();
    const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
      },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    const body = await res.json();
    if (!res.ok) {
      // Refresh failed — clear session, force re-login.
      await setSession(null);
      return null;
    }
    session = {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (body.expires_in || 3600),
      user: body.user || session.user,
    };
    await setSession(session);
    return session;
  } catch {
    return null;
  }
}

// Returns the user object from the current session, or null.
export async function getUser() {
  const session = await ensureSession();
  return session?.user || null;
}

// ---------- REST helper ----------

async function authedFetch(path, init = {}) {
  const { url, anonKey } = await withConfig();
  const session = await ensureSession();
  if (!session) {
    throw new SupabaseError('Not signed in. Open Settings to sign in.');
  }
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    throw new SupabaseError(
      typeof body === 'string'
        ? body
        : body.message || body.error_description || `HTTP ${res.status}`,
      res.status,
      body
    );
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- Resources ----------

// List the libraries the current user is a member of (or created).
export async function listLibraries() {
  const session = await ensureSession();
  if (!session) return [];
  // We rely on RLS — user only sees libraries they're a member of.
  return authedFetch('/rest/v1/resource_libraries?select=id,name,description&order=name.asc');
}

export async function insertResource(payload) {
  // Force owner_user_id to the signed-in user. Don't trust whatever the
  // form thought was set.
  const session = await ensureSession();
  payload.owner_user_id = session.user.id;
  const rows = await authedFetch('/rest/v1/resources', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function insertResourceImage({
  resourceId,
  imagePath,
  caption,
  contentHash,
}) {
  const session = await ensureSession();
  const rows = await authedFetch('/rest/v1/resource_images', {
    method: 'POST',
    body: JSON.stringify({
      resource_id: resourceId,
      owner_user_id: session.user.id,
      image_path: imagePath,
      sort_order: 0,
      caption: caption || null,
      content_hash: contentHash || null,
    }),
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

// Upload a Blob/File to Supabase Storage. Path convention:
//   <owner_user_id>/<resource_id>/<filename>
// Returns the storage path on success.
export async function uploadResourceImage({
  bucket = 'resource-images',
  resourceId,
  filename,
  blob,
  contentType = 'image/jpeg',
}) {
  const { url, anonKey } = await withConfig();
  const session = await ensureSession();
  if (!session) throw new SupabaseError('Not signed in.');
  const path = `${session.user.id}/${resourceId}/${filename}`;
  const res = await fetch(
    `${url}/storage/v1/object/${bucket}/${encodeURIComponent(path)}`,
    {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': contentType,
        'x-upsert': 'true',
      },
      body: blob,
    }
  );
  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    throw new SupabaseError(
      typeof body === 'string' ? body : body.message || `Upload failed (${res.status})`,
      res.status,
      body
    );
  }
  return path;
}
