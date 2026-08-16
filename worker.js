/**
 * Mash Uploads — backend Worker.
 *
 * Only handles what genuinely can't be done from the browser alone:
 *   - TikTok + Instagram OAuth token exchange (both require a client secret)
 *   - Temporarily staging the video file at a public URL (Instagram/TikTok
 *     pull-upload requires a URL, not a direct file POST)
 *   - Proxying the actual TikTok/Instagram post calls (their APIs don't send
 *     CORS headers, so the browser can't call them directly)
 *
 * YouTube is NOT handled here — it authenticates and uploads straight from
 * the browser (see index.html), since Google's "Desktop app" OAuth client
 * type doesn't need a secret protected.
 *
 * Deploy with Wrangler. Requires:
 *   - An R2 bucket bound as MEDIA (for staged video files)
 *   - Secrets: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET,
 *              META_APP_ID, META_APP_SECRET
 *   - This Worker's own deployed URL, for building redirect_uris
 *
 * See SETUP_GUIDE.md and README.md for exact commands.
 */

const TIKTOK_API = 'https://open.tiktokapis.com';
const GRAPH_API = 'https://graph.facebook.com/v21.0';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function redirectHome(returnUrl, params) {
  const url = new URL(returnUrl);
  url.hash = new URLSearchParams(params).toString();
  return Response.redirect(url.toString(), 302);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const workerOrigin = url.origin;

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    try {
      // ---------- TikTok OAuth ----------
      if (url.pathname === '/auth/tiktok/start') {
        const state = url.searchParams.get('state');
        const ret = url.searchParams.get('return');
        // Pack the return URL into state so the callback doesn't need storage.
        const packedState = btoa(JSON.stringify({ state, ret }));
        const authUrl = new URL('https://www.tiktok.com/v2/auth/authorize/');
        authUrl.searchParams.set('client_key', env.TIKTOK_CLIENT_KEY);
        authUrl.searchParams.set('scope', 'video.publish');
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('redirect_uri', `${workerOrigin}/auth/tiktok/callback`);
        authUrl.searchParams.set('state', packedState);
        return Response.redirect(authUrl.toString(), 302);
      }

      if (url.pathname === '/auth/tiktok/callback') {
        const code = url.searchParams.get('code');
        const { ret } = JSON.parse(atob(url.searchParams.get('state') || 'e30='));
        if (!code) return redirectHome(ret, { platform: 'tiktok', error: url.searchParams.get('error') || 'no_code' });

        const tokenRes = await fetch(`${TIKTOK_API}/v2/oauth/token/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_key: env.TIKTOK_CLIENT_KEY,
            client_secret: env.TIKTOK_CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
            redirect_uri: `${workerOrigin}/auth/tiktok/callback`
          })
        });
        const data = await tokenRes.json();
        if (!tokenRes.ok || data.error) {
          return redirectHome(ret, { platform: 'tiktok', error: data.error_description || data.error || 'exchange_failed' });
        }
        // NOTE: data.refresh_token is available too — this scaffold only
        // keeps the short-lived access_token client-side for simplicity.
        // Persist refresh_token server-side (e.g. in KV) if you want the
        // tool to survive past the access token's ~24h lifetime without
        // reconnecting.
        return redirectHome(ret, { platform: 'tiktok', access_token: data.access_token, expires_in: data.expires_in });
      }

      // ---------- Instagram / Meta OAuth ----------
      if (url.pathname === '/auth/instagram/start') {
        const state = url.searchParams.get('state');
        const ret = url.searchParams.get('return');
        const packedState = btoa(JSON.stringify({ state, ret }));
        const authUrl = new URL('https://www.facebook.com/v21.0/dialog/oauth');
        authUrl.searchParams.set('client_id', env.META_APP_ID);
        authUrl.searchParams.set('redirect_uri', `${workerOrigin}/auth/instagram/callback`);
        authUrl.searchParams.set('scope', 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement');
        authUrl.searchParams.set('state', packedState);
        return Response.redirect(authUrl.toString(), 302);
      }

      if (url.pathname === '/auth/instagram/callback') {
        const code = url.searchParams.get('code');
        const { ret } = JSON.parse(atob(url.searchParams.get('state') || 'e30='));
        if (!code) return redirectHome(ret, { platform: 'instagram', error: url.searchParams.get('error') || 'no_code' });

        // 1. Exchange code for a short-lived user token
        const shortRes = await fetch(`${GRAPH_API}/oauth/access_token?` + new URLSearchParams({
          client_id: env.META_APP_ID,
          client_secret: env.META_APP_SECRET,
          redirect_uri: `${workerOrigin}/auth/instagram/callback`,
          code
        }));
        const shortData = await shortRes.json();
        if (!shortRes.ok || shortData.error) {
          return redirectHome(ret, { platform: 'instagram', error: shortData.error?.message || 'exchange_failed' });
        }

        // 2. Exchange for a long-lived token (~60 days)
        const longRes = await fetch(`${GRAPH_API}/oauth/access_token?` + new URLSearchParams({
          grant_type: 'fb_exchange_token',
          client_id: env.META_APP_ID,
          client_secret: env.META_APP_SECRET,
          fb_exchange_token: shortData.access_token
        }));
        const longData = await longRes.json();
        const accessToken = longData.access_token || shortData.access_token;
        const expiresIn = longData.expires_in || shortData.expires_in || 3600;

        // 3. Resolve the linked Instagram Business Account ID via the user's Page
        const pagesRes = await fetch(`${GRAPH_API}/me/accounts?access_token=${accessToken}`);
        const pagesData = await pagesRes.json();
        const page = pagesData.data?.[0];
        let igUserId = '';
        if (page) {
          const igRes = await fetch(`${GRAPH_API}/${page.id}?fields=instagram_business_account&access_token=${accessToken}`);
          const igData = await igRes.json();
          igUserId = igData.instagram_business_account?.id || '';
        }
        if (!igUserId) {
          return redirectHome(ret, { platform: 'instagram', error: 'no_linked_ig_business_account' });
        }

        return redirectHome(ret, { platform: 'instagram', access_token: accessToken, expires_in: expiresIn, ig_user_id: igUserId });
      }

      // ---------- Stage a video file at a temporary public URL ----------
      if (url.pathname === '/stage' && request.method === 'POST') {
        const form = await request.formData();
        const file = form.get('file');
        if (!file) return json({ error: 'no_file' }, 400);
        const key = crypto.randomUUID() + '-' + file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        await env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type || 'video/mp4' } });
        // Served back out through /media/:key below. Clean these up periodically
        // (e.g. an R2 lifecycle rule) — this scaffold doesn't auto-delete them.
        return json({ url: `${workerOrigin}/media/${key}` });
      }

      if (url.pathname.startsWith('/media/')) {
        const key = url.pathname.replace('/media/', '');
        const obj = await env.MEDIA.get(key);
        if (!obj) return new Response('Not found', { status: 404 });
        return new Response(obj.body, {
          headers: { 'Content-Type': obj.httpMetadata?.contentType || 'video/mp4', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // ---------- Post proxy (TikTok + Instagram) ----------
      if (url.pathname === '/api/post' && request.method === 'POST') {
        const body = await request.json();
        const { platform, access_token } = body;

        if (platform === 'tiktok') {
          const initRes = await fetch(`${TIKTOK_API}/v2/post/publish/video/init/`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              post_info: {
                title: body.title || '',
                // NOTE: stays SELF_ONLY (private) until your TikTok app is
                // audited for direct public posting — see SETUP_GUIDE.md.
                privacy_level: 'SELF_ONLY'
              },
              source_info: { source: 'PULL_FROM_URL', video_url: body.video_url }
            })
          });
          const data = await initRes.json();
          if (!initRes.ok || data.error?.code !== 'ok') return json({ error: data.error?.message || 'tiktok_post_failed' }, 400);
          return json({ ok: true, publish_id: data.data?.publish_id });
        }

        if (platform === 'instagram') {
          const igUserId = body.ig_user_id;
          if (!igUserId) return json({ error: 'missing_ig_user_id' }, 400);

          const createRes = await fetch(`${GRAPH_API}/${igUserId}/media`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              media_type: 'REELS',
              video_url: body.video_url,
              caption: body.caption || '',
              access_token
            })
          });
          const createData = await createRes.json();
          if (!createRes.ok || createData.error) return json({ error: createData.error?.message || 'instagram_container_failed' }, 400);
          const creationId = createData.id;

          // Poll until Instagram finishes processing the video (can take a bit)
          let status = 'IN_PROGRESS';
          for (let i = 0; i < 20 && status === 'IN_PROGRESS'; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const statusRes = await fetch(`${GRAPH_API}/${creationId}?fields=status_code&access_token=${access_token}`);
            const statusData = await statusRes.json();
            status = statusData.status_code;
          }
          if (status !== 'FINISHED') return json({ error: `instagram_not_ready (${status})` }, 400);

          const publishRes = await fetch(`${GRAPH_API}/${igUserId}/media_publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ creation_id: creationId, access_token })
          });
          const publishData = await publishRes.json();
          if (!publishRes.ok || publishData.error) return json({ error: publishData.error?.message || 'instagram_publish_failed' }, 400);
          return json({ ok: true, media_id: publishData.id });
        }

        return json({ error: 'unknown_platform' }, 400);
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      return json({ error: err.message || 'internal_error' }, 500);
    }
  }
};
