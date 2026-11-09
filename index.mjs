// Spotify → YouTube for Couchmate – an extension of the YouTube plugin.
//
// - Log in with Spotify once (the plugin's page in the admin panel). Your playlists, liked songs and the playlists
//   you follow are read and kept on this server, and checked again every 30 minutes.
// - Every song is matched to a YouTube video in the background (with the YouTube plugin's findVideo) and the match
//   is remembered. Nothing is created on YouTube or Spotify.
// - Write "spotify-youtube" as a topic in the YouTube plugin's settings: a row with your playlists shows at the top
//   of its front page. They open, play, queue and can be added to favourites like YouTube playlists.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';
const SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read';
const YOUTUBE = 'youtube';
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default function setup(api) {
  const s = () => api.settings;
  const base = `/plugins/${api.id}`;
  const file = (name) => path.join(api.dataDir, name);
  const load = (name, fallback) => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; } };
  const save = (name, value) => { fs.writeFileSync(`${file(name)}.tmp`, JSON.stringify(value)); fs.renameSync(`${file(name)}.tmp`, file(name)); };

  let token = load('token.json', null); // { access, refresh, expiresAt, user: { id, name } }
  let library = load('library.json', { playlists: [], syncedAt: null }); // [{ id, name, image, owner, own, snapshot, tracks: [{ key, title, artists, duration }] }]
  const matches = load('matches.json', {}); // Spotify track id → { v: YouTube video id } or { none: time }
  const logins = new Map(); // state → { verifier, at } while someone is logging in
  const status = { syncing: false, error: null, left: 0 };
  let stopped = false;
  const timers = [];

  // ------------------------------------------------------------------ logging in (OAuth with PKCE – no secret needed)

  const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  function authorizeUrl() {
    if (!s().clientId) throw new Error('Fill in the Spotify Client ID in the plugin\'s settings first');
    const verifier = b64url(crypto.randomBytes(48));
    const state = b64url(crypto.randomBytes(16));
    for (const [k, v] of logins) if (Date.now() - v.at > 15 * 60 * 1000) logins.delete(k);
    logins.set(state, { verifier, at: Date.now() });
    const q = new URLSearchParams({
      client_id: s().clientId.trim(), response_type: 'code', redirect_uri: s().redirectUri.trim(), scope: SCOPES, state,
      code_challenge_method: 'S256', code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    });
    return `${ACCOUNTS}/authorize?${q}`;
  }

  async function tokenRequest(body) {
    const r = await fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: s().clientId.trim(), ...body }), signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error_description || d.error || `Spotify answered ${r.status}`);
    return d;
  }

  /** The end of a login: the code Spotify sent back (to /callback, or pasted in the admin page). */
  async function finishLogin(code, state) {
    const l = logins.get(String(state || ''));
    if (!l) throw new Error('This login has expired – start it again');
    logins.delete(state);
    const d = await tokenRequest({ grant_type: 'authorization_code', code: String(code || ''), redirect_uri: s().redirectUri.trim(), code_verifier: l.verifier });
    token = { access: d.access_token, refresh: d.refresh_token, expiresAt: Date.now() + (Number(d.expires_in) - 60) * 1000 };
    const me = await spotify('/me');
    token.user = { id: me.id, name: me.display_name || me.id };
    save('token.json', token);
    api.log(`logged in as ${token.user.name}`);
    sync();
  }

  function logout() {
    token = null;
    try { fs.unlinkSync(file('token.json')); } catch { /* already gone */ }
    library = { playlists: [], syncedAt: null };
    save('library.json', library);
    api.log('logged out');
  }

  async function accessToken() {
    if (!token?.refresh) throw new Error('Not logged in to Spotify');
    if (token.access && Date.now() < token.expiresAt) return token.access;
    const d = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh });
    token = { ...token, access: d.access_token, refresh: d.refresh_token || token.refresh, expiresAt: Date.now() + (Number(d.expires_in) - 60) * 1000 };
    save('token.json', token);
    return token.access;
  }

  async function spotify(pathOrUrl) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await fetch(pathOrUrl.startsWith('https://') ? pathOrUrl : `${API}${pathOrUrl}`, {
        headers: { authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(20000),
      });
      if (r.status === 429) { await sleep(Math.min(30, Number(r.headers.get('retry-after')) || 2) * 1000); continue; }
      if (r.status === 401 && attempt === 0) { token.expiresAt = 0; continue; }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error?.message || `Spotify answered ${r.status}`);
      }
      return r.json();
    }
    throw new Error('Spotify is busy – trying again later');
  }

  /** Every page of a list from Spotify's API. */
  async function pages(first, max = 10000) {
    const out = [];
    let url = first;
    while (url && out.length < max) {
      const d = await spotify(url);
      out.push(...(d.items || []));
      url = d.next;
    }
    return out;
  }

  // ------------------------------------------------------------------ reading the playlists

  const trackOf = (t) => (t && typeof t === 'object' && t.id && t.type !== 'episode'
    ? { key: t.id, title: t.name || '', artists: (t.artists || []).map((a) => a.name).filter(Boolean).join(', '), duration: Math.round((Number(t.duration_ms) || 0) / 1000) }
    : null);
  // Since February 2026 a playlist entry holds the song in "item" (it used to be "track").
  const entryTrack = (e) => trackOf(e && typeof e.item === 'object' ? e.item : e?.track);

  /** The songs of a playlist someone else made: Spotify only shows them on its public page. */
  async function publicTracks(id) {
    const r = await fetch(`https://open.spotify.com/embed/playlist/${id}`, { headers: { 'user-agent': 'Mozilla/5.0 (Couchmate)' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Spotify answered ${r.status} (is the playlist private?)`);
    const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(await r.text());
    if (!m) throw new Error('Spotify\'s public page has changed');
    const entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
    return (entity?.trackList || []).map((t) => {
      const key = String(t.uri || '').split(':')[2];
      return SPOTIFY_ID.test(key || '') && t.entityType !== 'episode'
        ? { key, title: t.title || '', artists: t.subtitle || '', duration: Math.round((Number(t.duration) || 0) / 1000) }
        : null;
    }).filter(Boolean);
  }

  /** Reads the playlists again (only the ones that changed – Spotify's snapshot id says so). */
  async function sync() {
    if (status.syncing || !token?.refresh || stopped) return;
    status.syncing = true;
    status.error = null;
    try {
      const me = token.user?.id;
      const old = new Map(library.playlists.map((p) => [p.id, p]));
      const out = [];
      if (s().liked !== false) {
        try {
          const tracks = (await pages('/me/tracks?limit=50')).map((e) => trackOf(e.track ?? e.item)).filter(Boolean);
          out.push({ id: 'liked', name: null, liked: true, image: null, owner: '', own: true, tracks });
        } catch (e) { api.log(`liked songs: ${e.message}`); if (old.get('liked')) out.push(old.get('liked')); }
      }
      for (const pl of await pages('/me/playlists?limit=50')) {
        if (!SPOTIFY_ID.test(pl?.id || '')) continue;
        const own = pl.owner?.id === me || pl.collaborative === true;
        if (!own && s().followed === false) continue;
        const prev = old.get(pl.id);
        let tracks = prev && prev.snapshot === pl.snapshot_id ? prev.tracks : null;
        if (!tracks) {
          try {
            tracks = own ? (await pages(`/playlists/${pl.id}/items?limit=50`)).map(entryTrack).filter(Boolean) : await publicTracks(pl.id);
          } catch (e) {
            api.log(`${pl.name}: ${e.message}`);
            tracks = prev?.tracks || [];
          }
        }
        out.push({ id: pl.id, name: pl.name || pl.id, image: pl.images?.[0]?.url || null, owner: pl.owner?.display_name || '', own, snapshot: pl.snapshot_id, tracks });
      }
      library = { playlists: out, syncedAt: Date.now() };
      save('library.json', library);
      api.log(`read ${out.length} playlists with ${out.reduce((n, p) => n + p.tracks.length, 0)} songs`);
      matchAll();
    } catch (e) {
      status.error = e.message;
      api.log(`could not read the playlists: ${e.message}`);
    } finally {
      status.syncing = false;
    }
  }

  // ------------------------------------------------------------------ matching songs to YouTube videos

  let matching = false;
  async function matchAll() {
    if (matching || stopped) return;
    matching = true;
    try {
      // The first songs of every playlist first – so each one can be played soon – then the rest.
      const todo = [];
      const seen = new Set();
      const add = (t) => { if (!matches[t.key] && !seen.has(t.key)) { seen.add(t.key); todo.push(t); } };
      for (const p of library.playlists) p.tracks.slice(0, 15).forEach(add);
      for (const p of library.playlists) p.tracks.forEach(add);
      status.left = todo.length;
      if (!todo.length) return;
      if (!api.has(YOUTUBE, 'findVideo')) { status.error = 'Switch on the YouTube plugin – the songs are found with it'; return; }
      api.log(`looking up ${todo.length} songs on YouTube`);
      let i = 0;
      let unsaved = 0;
      const worker = async () => {
        while (i < todo.length && !stopped) {
          const t = todo[i++];
          try {
            const v = await api.use(YOUTUBE, 'findVideo', `${t.artists} - ${t.title}`, { duration: t.duration });
            matches[t.key] = v?.id ? { v: v.id } : { none: Date.now() };
          } catch (e) {
            if (!api.has(YOUTUBE, 'findVideo')) { status.error = 'The YouTube plugin was switched off'; i = todo.length; break; }
            api.log(`${t.artists} - ${t.title}: ${e.message}`);
          }
          status.left = Math.max(0, status.left - 1);
          if (++unsaved >= 10) { save('matches.json', matches); unsaved = 0; }
        }
      };
      await Promise.all([worker(), worker()]);
      save('matches.json', matches);
      api.log('done looking up songs');
    } finally {
      matching = false;
    }
  }

  // ------------------------------------------------------------------ what the YouTube plugin shows

  const titleOf = (p) => (p.liked ? api.t('Liked songs') : p.name);
  const imageOf = (p) => {
    if (p.image) return p.image;
    const v = p.tracks.map((t) => matches[t.key]?.v).find(Boolean);
    return v ? `https://i.ytimg.com/vi/${v}/hqdefault.jpg` : null;
  };

  api.expose('youtubeRows', () => ({
    label: api.t('Playlists from Spotify'),
    rows: library.playlists.length ? [{
      id: 'playlists',
      title: api.t('Your playlists from Spotify'),
      lists: library.playlists.filter((p) => p.tracks.length).map((p) => ({
        id: p.id,
        title: titleOf(p),
        subtitle: p.own ? api.t('{n} songs', { n: p.tracks.length }) : `${p.owner} · ${p.tracks.length}`,
        image: imageOf(p),
      })),
    }] : [],
  }));

  api.expose('youtubeList', (listId) => {
    const p = library.playlists.find((x) => x.id === listId);
    if (!p) return { title: listId, channel: 'Spotify', videos: [], pending: 0 };
    // Every song, in order – the ones without a video show greyed out in the apps and are skipped when playing.
    let pending = 0;
    const videos = p.tracks.map((t) => {
      const m = matches[t.key];
      if (!m) pending++;
      return { id: m?.v || null, title: t.title, channel: t.artists, duration: t.duration, missing: m?.v ? undefined : m ? 'none' : 'pending' };
    });
    return { title: titleOf(p), channel: p.own ? 'Spotify' : `Spotify · ${p.owner}`, videos, pending };
  });

  // ------------------------------------------------------------------ the page in the admin panel

  const page = (res, body, code = 200) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spotify → YouTube</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;background:#0f1115;color:#e8eaf0}
a{color:#7aa2ff}.card{background:#181b22;border-radius:12px;padding:16px 18px;margin:14px 0}.dim{color:#9aa0ad}
.btn{display:inline-block;background:#1db954;color:#000;border:0;border-radius:20px;padding:9px 18px;font-weight:600;text-decoration:none;cursor:pointer;font-size:15px}
.btn.grey{background:#2a2f3a;color:#e8eaf0}input{width:100%;box-sizing:border-box;padding:9px;border-radius:8px;border:1px solid #333a48;background:#0f1115;color:#e8eaf0}
code{background:#0f1115;padding:2px 6px;border-radius:6px}.err{color:#ff7a7a}li{margin:2px 0}
</style></head><body><h1>Spotify → YouTube</h1>${body}</body></html>`);
  };
  const back = (res, to = `${base}/login`) => { res.writeHead(303, { location: to }); res.end(); };
  const readForm = (req) => new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 20000) req.destroy(); });
    req.on('end', () => resolve(new URLSearchParams(b)));
  });

  api.route('GET', '/login', (req, res, { query }) => {
    const n = library.playlists.reduce((sum, p) => sum + p.tracks.length, 0);
    const found = library.playlists.reduce((sum, p) => sum + p.tracks.filter((t) => matches[t.key]?.v).length, 0);
    const parts = [];
    if (query.get('error')) parts.push(`<p class="err">${esc(query.get('error'))}</p>`);
    if (!s().clientId) {
      parts.push(`<div class="card"><b>First:</b> make a Spotify app and fill in its Client ID in the plugin's settings.
        <a href="https://github.com/valonia/couchmate-spotify-youtube#set-up" target="_blank">How (2 minutes) ↗</a></div>`);
    } else if (!token?.refresh) {
      parts.push(`<div class="card"><p>Not logged in.</p><p><a class="btn" href="${base}/authorize">Log in with Spotify</a></p>
        <p class="dim">After logging in, Spotify sends you to <code>${esc(s().redirectUri)}</code>. If you are not on the computer that
        runs Couchmate that page will not load – copy its whole address from the address bar and paste it here:</p>
        <form method="post" action="${base}/connect"><input name="url" placeholder="http://127.0.0.1:…/callback?code=…" required>
        <p><button class="btn grey" type="submit">Finish logging in</button></p></form></div>`);
    } else {
      parts.push(`<div class="card"><p>Logged in as <b>${esc(token.user?.name || '?')}</b>.</p>
        <p>${library.playlists.length} playlists, ${n} songs – ${found} found on YouTube${status.left ? `, ${status.left} still being looked up` : ''}.
        ${library.syncedAt ? `<br><span class="dim">Read ${esc(new Date(library.syncedAt).toLocaleString())}${status.syncing ? ' – reading again now…' : ''}</span>` : status.syncing ? '<br><span class="dim">Reading your playlists…</span>' : ''}</p>
        ${status.error ? `<p class="err">${esc(status.error)}</p>` : ''}
        <form method="post" action="${base}/sync" style="display:inline"><button class="btn grey">Read again now</button></form>
        <form method="post" action="${base}/logout" style="display:inline;margin-left:8px"><button class="btn grey">Log out</button></form></div>
        <div class="card"><p>In the YouTube plugin's settings, write <code>spotify-youtube</code> under <b>Topics on the front page</b> –
        your playlists then show at the top of YouTube in the apps.</p>
        <ul>${library.playlists.map((p) => `<li>${esc(p.liked ? 'Liked songs' : p.name)} <span class="dim">· ${p.tracks.length} songs${p.own ? '' : ` · by ${esc(p.owner)}`}</span></li>`).join('')}</ul></div>`);
    }
    page(res, parts.join(''));
  }, { auth: 'admin' });

  api.route('GET', '/authorize', (req, res) => {
    try { res.writeHead(302, { location: authorizeUrl() }); res.end(); } catch (e) { back(res, `${base}/login?error=${encodeURIComponent(e.message)}`); }
  }, { auth: 'admin' });

  // Spotify sends the browser here after logging in (works when the browser is on the computer running Couchmate).
  api.route('GET', '/callback', async (req, res, { query }) => {
    if (query.get('error')) return page(res, `<p class="err">Spotify said: ${esc(query.get('error'))}</p>`, 400);
    try {
      await finishLogin(query.get('code'), query.get('state'));
      page(res, `<div class="card"><p>Logged in as <b>${esc(token.user.name)}</b>. Your playlists are being read now.</p>
        <p class="dim">You can close this tab.</p></div>`);
    } catch (e) {
      page(res, `<p class="err">${esc(e.message)}</p>`, 400);
    }
  }, { auth: 'public' });

  // The address Spotify sent the browser to, pasted in the admin page (when the browser is on another device).
  api.route('POST', '/connect', async (req, res) => {
    try {
      const url = new URL(String((await readForm(req)).get('url') || '').trim());
      if (url.searchParams.get('error')) throw new Error(`Spotify said: ${url.searchParams.get('error')}`);
      await finishLogin(url.searchParams.get('code'), url.searchParams.get('state'));
      back(res);
    } catch (e) {
      back(res, `${base}/login?error=${encodeURIComponent(e.message === 'Invalid URL' ? 'That is not the address from the address bar' : e.message)}`);
    }
  }, { auth: 'admin' });

  api.route('POST', '/sync', (req, res) => { sync(); back(res); }, { auth: 'admin' });
  api.route('POST', '/logout', (req, res) => { logout(); back(res); }, { auth: 'admin' });
  api.link('Spotify login and status', `${base}/login`);

  // No api.source: this plugin has no menu entry or screens of its own – it only extends YouTube.

  // Read the playlists now and every 30 minutes; look up songs that are still missing.
  if (token?.refresh) setTimeout(() => sync(), 5000);
  else setTimeout(() => matchAll(), 8000); // songs left from before a restart
  timers.push(setInterval(() => sync(), 30 * 60 * 1000));
  return () => { stopped = true; timers.forEach(clearInterval); };
}
