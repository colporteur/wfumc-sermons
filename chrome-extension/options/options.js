import {
  getSettings,
  setSettings,
  getSession,
  setSession,
} from '../lib/storage.js';
import { signIn, signOut, ensureSession } from '../lib/supabase.js';

const $ = (id) => document.getElementById(id);
const els = {
  supabaseUrl: $('supabaseUrl'),
  supabaseAnonKey: $('supabaseAnonKey'),
  anthropicApiKey: $('anthropicApiKey'),
  email: $('email'),
  password: $('password'),
  sessionStatus: $('session-status'),
  signInBtn: $('sign-in-btn'),
  signOutBtn: $('sign-out-btn'),
  saveBtn: $('save-btn'),
  error: $('error'),
  saved: $('saved'),
};

init();

async function init() {
  const settings = await getSettings();
  els.supabaseUrl.value = settings.supabaseUrl;
  els.supabaseAnonKey.value = settings.supabaseAnonKey;
  els.anthropicApiKey.value = settings.anthropicApiKey;

  await refreshSessionStatus();

  els.saveBtn.addEventListener('click', saveSettings);
  els.signInBtn.addEventListener('click', doSignIn);
  els.signOutBtn.addEventListener('click', doSignOut);
}

async function saveSettings() {
  hideError();
  await setSettings({
    supabaseUrl: els.supabaseUrl.value.trim(),
    supabaseAnonKey: els.supabaseAnonKey.value.trim(),
    anthropicApiKey: els.anthropicApiKey.value.trim(),
  });
  showSaved();
}

async function doSignIn() {
  hideError();
  const email = els.email.value.trim();
  const password = els.password.value;
  if (!email || !password) {
    showError('Email and password required.');
    return;
  }
  // Persist URL + key first so signIn can find them.
  await setSettings({
    supabaseUrl: els.supabaseUrl.value.trim(),
    supabaseAnonKey: els.supabaseAnonKey.value.trim(),
  });
  els.signInBtn.disabled = true;
  els.signInBtn.textContent = 'Signing in…';
  try {
    await signIn(email, password);
    els.password.value = '';
    await refreshSessionStatus();
    showSaved('Signed in.');
  } catch (e) {
    showError(`Sign-in failed: ${e.message}`);
  } finally {
    els.signInBtn.disabled = false;
    els.signInBtn.textContent = 'Sign in';
  }
}

async function doSignOut() {
  hideError();
  await signOut();
  await refreshSessionStatus();
}

async function refreshSessionStatus() {
  const session = await ensureSession();
  if (session?.user) {
    els.sessionStatus.textContent = `Signed in as ${session.user.email}`;
    els.sessionStatus.classList.remove('signed-out');
    els.sessionStatus.classList.add('signed-in');
    els.signInBtn.hidden = true;
    els.signOutBtn.hidden = false;
    els.email.value = session.user.email || '';
    els.email.disabled = true;
    els.password.disabled = true;
  } else {
    els.sessionStatus.textContent = 'Not signed in.';
    els.sessionStatus.classList.remove('signed-in');
    els.sessionStatus.classList.add('signed-out');
    els.signInBtn.hidden = false;
    els.signOutBtn.hidden = true;
    els.email.disabled = false;
    els.password.disabled = false;
  }
}

function showError(msg) {
  els.error.textContent = msg;
  els.error.hidden = false;
  els.saved.hidden = true;
}

function hideError() {
  els.error.hidden = true;
  els.error.textContent = '';
}

function showSaved(msg = 'Settings saved.') {
  els.saved.textContent = msg;
  els.saved.hidden = false;
  els.error.hidden = true;
  setTimeout(() => {
    els.saved.hidden = true;
  }, 2500);
}
