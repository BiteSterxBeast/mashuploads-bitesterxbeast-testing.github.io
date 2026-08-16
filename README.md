# Mash Uploads

A private, single-user tool: pick one video, write a caption once, hit one button, and it goes out to YouTube, TikTok, and Instagram. Built to get you off Buffer for this specific job.

This is a working scaffold, not a polished product — I couldn't test it against live TikTok/Instagram/YouTube apps in this session (that requires your real developer credentials), so treat the first few posts as a shakedown run and expect to tweak field names/versions if a platform's API has shifted slightly since this was written.

## What's in here

- `index.html` — the tool itself. Open it in a browser, or host it anywhere (even a private, unlisted GitHub Pages path). Nothing about it requires a real server.
- `worker.js` + `wrangler.toml` — a small [Cloudflare Worker](https://developers.cloudflare.com/workers/) that does the three things a static page can't: exchange OAuth codes for tokens (TikTok + Instagram need a client secret kept off the browser), temporarily host your video at a public URL (TikTok/Instagram pull from a URL, they don't accept a raw file POST), and relay the actual post calls (their APIs don't allow direct browser calls).
- `SETUP_GUIDE.md` — how to register the three developer apps and get your credentials.

## Deploying the backend

1. Install Wrangler: `npm install -g wrangler`
2. `wrangler login`
3. Create the R2 bucket used to stage videos: `wrangler r2 bucket create mash-uploads-media`
4. Set your secrets (from SETUP_GUIDE.md):
   ```
   wrangler secret put TIKTOK_CLIENT_KEY
   wrangler secret put TIKTOK_CLIENT_SECRET
   wrangler secret put META_APP_ID
   wrangler secret put META_APP_SECRET
   ```
5. Deploy: `wrangler deploy`
6. Note the `*.workers.dev` URL it gives you — you'll register that as the redirect URI in your TikTok and Meta developer apps (`/auth/tiktok/callback` and `/auth/instagram/callback`), and paste the base URL into the tool's Settings panel.

## Deploying the front end

Just needs static hosting anywhere — it's one HTML file. Options, roughly in order of effort:
- Open `index.html` locally as a file (works, but OAuth redirects need a stable URL to return to, so this is fine for testing but a real hosted URL is better long-term).
- A private, unlisted path on GitHub Pages (e.g. a folder not linked from any nav — `robots.txt`/`noindex` won't stop someone who has the direct link, so keep it truly unlinked, or password it via Cloudflare Access in front of the Worker + page).
- Any static host (Cloudflare Pages, Netlify) with a random/unguessable path.

Once deployed, open it, go to Settings, paste your Worker URL and YouTube Client ID, then hit Connect under each platform once.

## How posting works

1. You pick a video and write a title/caption.
2. If TikTok or Instagram is connected, the browser uploads the file once to the Worker, which stores it in R2 and hands back a temporary public URL.
3. YouTube uploads happen straight from your browser to Google (no Worker involved) using the access token from Google's own client-side library.
4. TikTok and Instagram are told to pull the video from that staged URL, via the Worker (since their APIs won't accept direct browser calls).

## Known limitations (read before relying on this)

- **TikTok posts land private until your app is audited.** Unaudited apps are locked to `SELF_ONLY` visibility — you'll need to open the TikTok app and manually make each post public, or apply for the Content Posting API audit to skip that step.
- **YouTube uploads land private until your project passes Google's compliance audit**, same story — see SETUP_GUIDE.md.
- **YouTube's connect button uses a short-lived session token (~1 hour)**, so you'll reconnect it each time you sit down to post. That's intentional — it avoids needing a backend for YouTube at all.
- **The YouTube upload in `index.html` is a single-request multipart upload**, which is fine for short clips but not ideal for large files or flaky connections. If you're regularly posting long-form video, swap it for YouTube's resumable upload protocol (chunked, resumable on failure) — the API doc for `videos.insert` covers it.
- **Staged video files in R2 aren't automatically deleted.** Set up an R2 lifecycle rule to expire objects after a day or two, or they'll quietly accumulate storage cost (small, but non-zero).
- **Rate limits, if you ever post a lot in one day:** YouTube's upload quota bucket caps at 100/day; TikTok is roughly 15/day per creator account even once audited; Instagram allows up to 100 published posts per rolling 24 hours. None of these should matter at your actual usage, just flagging them.
- **This page is unlisted, not access-controlled.** Anyone with the exact URL (and your Worker URL) could load it. For real protection, put Cloudflare Access (or similar) in front of both, gated to your own email/login.
