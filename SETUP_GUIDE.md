# Mash Uploads — Setup Guide

Mash Uploads is a private, single-user tool: you pick one video, write a caption once, and push it to YouTube, TikTok, and Instagram in one go. It is **not** meant to be linked from the public BiteSterxBeast site — keep the deployed URL to yourself.

Because none of these three platforms will let a stranger's app post video on your behalf without you personally proving ownership of a "developer app," you have to register one small app per platform before the tool can talk to them. This is a one-time setup. Budget about 45–60 minutes total, plus a few days of waiting on the YouTube audit (see below).

Nothing here costs money. Everything stays scoped to your own accounts — you are not requesting access to post as anyone else.

---

## 1. YouTube (Google Cloud)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project (e.g. "Mash Uploads").
2. In **APIs & Services → Library**, enable the **YouTube Data API v3**.
3. In **APIs & Services → OAuth consent screen**:
   - User type: **External**.
   - Fill in the app name, your email as support contact, your email as developer contact.
   - Scopes: add `https://www.googleapis.com/auth/youtube.upload`.
   - Test users: add your own Google account (the one that owns your YouTube channel).
   - Leave **Publishing status** as **Testing** for now — you don't need to publish this app publicly.
4. In **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Desktop app**.
   - This client type doesn't require a client secret to stay confidential, so the tool can do the whole OAuth flow from your browser — no backend needed for YouTube specifically.
   - Copy the **Client ID** — you'll paste it into the tool's settings panel.
5. **About the "Testing" limitation:** while your project is in Testing, Google issues refresh tokens that expire after 7 days, so you'd have to reconnect YouTube in the tool about once a week. That's mildly annoying but otherwise harmless.
6. **The part that actually matters — the audit:** regardless of Testing vs. Production, any video uploaded through the API from a project that hasn't passed Google's audit gets forced into **private** visibility. To get public/unlisted uploads working, go to **APIs & Services → OAuth consent screen → Compliance Audit** and submit a request. For a personal-use tool like this, explain in the form that it's a single individual uploading to their own channel(s), and be ready to record a short screen capture showing the OAuth consent + upload flow when they ask. Turnaround is typically a few days to a couple weeks.
   - Until that's approved, you can still use the tool for YouTube — uploads will just land as private/unlisted until you flip them yourself, or until the audit clears.

## 2. TikTok (Developer Portal)

1. Go to [developers.tiktok.com](https://developers.tiktok.com) and create an account, then **Manage apps → Create an app**.
2. Add the **Content Posting API** product to the app.
3. Under **Login Kit**, set a Redirect URI to your deployed tool's callback path (e.g. `https://<your-worker>.workers.dev/auth/tiktok/callback`).
4. Copy the **Client Key** and **Client Secret** — the secret goes into the backend (Worker) config, never into the front-end page.
5. Add your own TikTok account under the app's **Sandbox / Target users** so you're allowed to authorize against it before any audit.
6. **Unaudited limits (fine for solo use to start):** up to 5 accounts can post per 24 hours, and posts land as `SELF_ONLY` (private) — you'll need to open TikTok and manually set each one public after it lands. If that manual step bugs you, apply for the **Content Posting API audit** from the same dashboard to unlock direct public posting (subject to a shared cap of roughly 15 posts/day per account either way).

## 3. Instagram (Meta for Developers)

1. Go to [developers.facebook.com](https://developers.facebook.com) and create an app of type **Business**.
2. Add the **Instagram Graph API** product.
3. Your Instagram account needs to be a **Business or Creator account**, linked to a **Facebook Page** you admin (Instagram settings → Account type, and Linked accounts).
4. In the app's **Roles → Roles** panel, add your own Facebook/Instagram account as an **Admin, Developer, or Tester**. This is the key step that lets the tool work for just you without ever going through Meta's public App Review.
5. In **App Settings → Basic**, copy the **App ID** and **App Secret** (secret goes into the Worker config, same as TikTok).
6. Complete **Page Publishing Authorization** for your linked Page if prompted (a short identity-confirmation step Meta requires before any posting API works).
7. Note the unavoidable part: Instagram's API doesn't accept a direct file upload — it fetches your video from a public URL you give it. The tool handles this by briefly staging your video in a private storage bucket and handing Instagram a short-lived link (see README for the storage setup). Rate limit is 100 published posts per rolling 24 hours, far above anything you'll hit solo.

---

## Where credentials go

- **YouTube Client ID** → pasted directly into the tool's Settings panel in your browser (stored only in that browser's local storage, never sent anywhere but Google).
- **TikTok Client Key/Secret, Instagram App ID/Secret** → set as environment variables on the backend Worker (`wrangler secret put ...`), never exposed to the browser. See README.md for exact commands.

Once all three are set up, open the tool, hit **Connect** under each platform once, and you're ready to post.
