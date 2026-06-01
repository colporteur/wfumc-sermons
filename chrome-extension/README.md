# WFUMC Resource Capture — Chrome Extension

A personal Chrome extension that lets Pastor Todd right-click and save
text, images, or AI-summarized pages into the WFUMC Resource Library
(the same Supabase backend the Sermon / Bulletin / Worship apps use).

## Install (Developer Mode)

This isn't published to the Chrome Web Store; it's loaded as an
unpacked extension on your own browser.

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked**.
4. Select this folder (`chrome-extension`).
5. The "WFUMC Resource Capture" icon appears in your toolbar.

## First-time setup

1. Right-click the extension icon → **Options**, or click the icon to
   open the popup and then click "Open settings."
2. Fill in:
   - **Supabase URL** — same as `VITE_SUPABASE_URL` in your apps.
   - **Supabase anon key** — same as `VITE_SUPABASE_ANON_KEY`.
   - **Email + password** — your Sermons app login. Click **Sign in**.
   - **Anthropic API key** — get one from
     [console.anthropic.com](https://console.anthropic.com). Used for
     "Summarize page" and "Analyze with Claude". Stored only in
     `chrome.storage.sync` on your Chrome profile.
3. Click **Save settings**.

## Use

Right-click anywhere on a webpage. Under **Save to WFUMC Resources**:

- **Save selected text** — when you have text highlighted. Captures
  the selection as the resource content (suggested type: quote).
- **Save this image** — when you right-click on an image. Downloads
  it, uploads to Supabase Storage, creates a `photo` resource.
- **Summarize page with Claude** — Claude reads the visible page text
  and writes a 1-2 paragraph summary as the resource content.

A popup window opens with all the resource fields:
**Type**, **Library**, **Title**, **Content** (pre-filled),
**Source**, **Source URL** (auto-filled from page),
**Themes**, **Scripture connections**, **Tone**, **Private notes**.

Click **✨ Analyze with Claude** to have Claude propose a title,
themes, scripture refs, source, tone, and notes based on the captured
content. Only blank fields get filled — anything you've typed stays
put. Edit anything, then **Save resource** posts to Supabase. The
new resource appears immediately in the Sermon app's `/resources`
view.

## What's stored where

- **Supabase URL + anon key** — `chrome.storage.sync` (synced across
  Chrome profiles signed into your Google account)
- **Anthropic API key** — `chrome.storage.sync`
- **Supabase session token** — `chrome.storage.local` (per-device,
  refreshed automatically)
- **Last captured payload** — `chrome.storage.local`, cleared as soon
  as you save or cancel

The extension never sends data anywhere except Supabase (your project)
and api.anthropic.com (with your key).

## Files

```
chrome-extension/
├── manifest.json         # MV3 manifest, permissions, context menu host
├── background.js         # Service worker — context menu + capture
├── lib/
│   ├── storage.js        # chrome.storage helpers
│   ├── supabase.js       # Tiny REST client + auth + storage
│   └── claude.js         # Anthropic Messages API wrapper
├── popup/
│   ├── popup.html        # Capture-review form
│   ├── popup.css         # Shared styles
│   └── popup.js          # Form behavior + save
├── options/
│   ├── options.html      # Settings page
│   └── options.js
└── icons/                # 16/48/128px PNG
```

## Updating

Edit any source file, then go to `chrome://extensions` and click the
reload (↻) button on the WFUMC Resource Capture card. Changes take
effect immediately. The service worker restarts on reload, so the
context menus re-register.
