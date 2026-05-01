# Setup — WFUMC Sermon Archive

This is a separate codebase from the bulletin app, but it talks to the
**same Supabase project** and uses the **same staff login** you already
created. No database migrations needed (the `sermons` table already
exists from the bulletin app).

## What you'll need

- Node.js 18+ (you already have this from the bulletin app)
- The same Supabase URL + anon key you used for the bulletin app
- A new GitHub repository for this app

---

## Step 1 — Local install

In PowerShell, navigate to this folder:

```
cd "C:\Users\noren\Google Drive\WFUMC Sermons App"
```

Install dependencies:

```
npm install
```

Copy the env template and fill in your Supabase values (same as the
bulletin app's `.env.local`):

```
cp .env.example .env.local
```

Open `.env.local` in any text editor and paste in:

```
VITE_SUPABASE_URL=https://datkqtnredzlwttlxuie.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiI...
```

Start the dev server:

```
npm run dev
```

Open http://localhost:5174 — you should land on the login page. Sign in
with your existing pastor account; you should see whatever sermons are
already in the database (any sermon items you've filled in via the
bulletin app will show up).

---

## Step 2 — Create the GitHub repo

1. Go to https://github.com/new
2. Repo name: `wfumc-sermons`
3. Set it **Public** (free GitHub Pages requires it)
4. Don't initialize with README (we have one)
5. Create

---

## Step 3 — Push the code

In PowerShell from this folder:

```
git init
git branch -M main
git add .
git commit -m "Initial scaffold"
git remote add origin https://github.com/colporteur/wfumc-sermons.git
git push -u origin main
```

(Git will use your existing GitHub credentials from when you set up the
bulletin app, so no new login flow.)

---

## Step 4 — Configure GitHub Pages and secrets

1. Go to `https://github.com/colporteur/wfumc-sermons/settings/pages`
2. Under **Source**, choose **GitHub Actions**
3. Go to `https://github.com/colporteur/wfumc-sermons/settings/secrets/actions`
4. Add two secrets (same values as the bulletin app):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

The first push will have triggered a deploy that probably failed
(secrets weren't set). Re-run it from the **Actions** tab once secrets
are in place.

---

## Step 5 — Done

Live URL: `https://colporteur.github.io/wfumc-sermons/`

Sign in with your church staff credentials. You should see the sermon
list. Subsequent pushes to `main` auto-deploy.

---

## Troubleshooting

**Login spins forever** — same as the bulletin app: clear localStorage
(DevTools → Application → Local Storage → delete `wfumc-sermons-auth`)
and sign in again.

**"No staff profile" page** — your account isn't in `staff_profiles`. Same
profile that lets you into the bulletin app should work here. Run in
Supabase SQL Editor: `SELECT * FROM staff_profiles;` to verify.

**Empty sermon list** — sermons appear here as soon as you fill in a
sermon item in the bulletin app's Order of Worship tab. If you've used
the bulletin app for a few weeks but see nothing, check that
`liturgy_items.sermon_id` is being set (the bulletin app's SermonFields
lazy-creates the sermon row on first edit).
