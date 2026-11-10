// Spotify → YouTube for Couchmate – an extension of the YouTube plugin.
//
// - The admin logs in with Spotify once (the plugin's Status page in the admin panel; it needs a Spotify app made once
//   on developer.spotify.com). Every song of the playlists you made or collaborate on (private ones too), your liked
//   songs and the playlists you follow are read and kept on this server, and read again every 30 minutes.
//   Spotify gives apps the songs of your own playlists only: the ones you follow come from Spotify's public page –
//   the first 100 songs.
// - Every song is matched to a YouTube video in the background (with the YouTube plugin's findVideo) and the match
//   is remembered. Nothing is created on YouTube or Spotify.
// - Write "spotify-youtube" as a topic in the YouTube plugin's settings: the playlists show at the top of its front
//   page. They open, play, queue and can be added to favourites like YouTube playlists.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const YOUTUBE = 'youtube';
const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';
const SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read';
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const EMBED_MAX = 100; // what Spotify's public embed page shows of a playlist
const HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Couchmate', 'accept-language': 'en' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default function setup(api) {
  const s = () => api.settings;
  const base = `/plugins/${api.id}`;
  const file = (name) => path.join(api.dataDir, name);
  const load = (name, fallback) => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; } };
  const save = (name, value) => { fs.writeFileSync(`${file(name)}.tmp`, JSON.stringify(value)); fs.renameSync(`${file(name)}.tmp`, file(name)); };

  // playlists: [{ id, name, image, owner, liked?, full, total, snapshot?, tracks: [{ key, title, artists, duration }] }]
  // full = every song (official API); otherwise the first EMBED_MAX of total (a playlist you follow).
  let library = load('library.json', { playlists: [], syncedAt: null });
  let token = load('token.json', null); // { access, refresh, expiresAt, user: { id, name } }
  const matches = load('matches.json', {}); // Spotify track id → { v: YouTube video id } or { none: time }
  const logins = new Map(); // state → { verifier, at } while the admin is logging in
  const status = { syncing: false, errors: [], left: 0 };
  let stopped = false;
  const timers = [];

  // ------------------------------------------------------------------ Spotify's public pages (playlists you follow)

  async function page(url) {
    const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (r.status === 404) throw new Error('not found on Spotify');
    if (!r.ok) throw new Error(`Spotify answered ${r.status}`);
    return r.text();
  }

  /** The data a public open.spotify.com page carries (what the page shows before any script runs). */
  function initialState(html) {
    const m = /<script id="initialState" type="text\/plain">([^<]*)<\/script>/.exec(html);
    if (!m) throw new Error('Spotify\'s page has changed');
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  }

  /** How many songs a public playlist has (its page says so even when the embed page shows fewer). */
  async function publicTotal(id) {
    const st = initialState(await page(`https://open.spotify.com/playlist/${id}`));
    return Number(st.entities?.items?.[`spotify:playlist:${id}`]?.content?.totalCount) || null;
  }

  /** A public playlist's name, cover and songs – Spotify's embed page shows the first 100. */
  async function publicPlaylist(id) {
    const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(await page(`https://open.spotify.com/embed/playlist/${id}`));
    if (!m) throw new Error('Spotify\'s page has changed');
    const e = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
    if (!e) throw new Error('not found on Spotify (is it private?)');
    const tracks = (e.trackList || []).map((t) => {
      const key = String(t.uri || '').split(':')[2];
      return SPOTIFY_ID.test(key || '') && t.entityType !== 'episode'
        ? { key, title: t.title || '', artists: t.subtitle || '', duration: Math.round((Number(t.duration) || 0) / 1000) }
        : null;
    }).filter(Boolean);
    const total = tracks.length >= EMBED_MAX ? await publicTotal(id).catch(() => null) : tracks.length;
    const cover = [...(e.coverArt?.sources || [])].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null;
    return { name: e.name || e.title || id, owner: e.subtitle || '', image: cover, tracks, full: false, total: total || tracks.length };
  }

  // ------------------------------------------------------------------ logging in (OAuth with PKCE – no secret needed)

  const loginReady = () => Boolean(String(s().clientId || '').trim());
  const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  function authorizeUrl() {
    if (!loginReady()) throw new Error('Fill in the Spotify Client ID in the plugin\'s settings first');
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

  /** The end of a login: the code Spotify sent back (to /callback, or pasted on the Status page). */
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

  const trackOf = (t) => (t && typeof t === 'object' && t.id && t.type !== 'episode'
    ? { key: t.id, title: t.name || '', artists: (t.artists || []).map((a) => a.name).filter(Boolean).join(', '), duration: Math.round((Number(t.duration_ms) || 0) / 1000) }
    : null);
  // Since February 2026 a playlist entry holds the song in "item" (it used to be "track").
  const entryTrack = (e) => trackOf(e && typeof e.item === 'object' ? e.item : e?.track);

  /** Logged in: liked songs, and every playlist in the library – all songs of your own, the public page for others'. */
  async function accountPlaylists(old) {
    const me = token.user?.id;
    const out = [];
    if (s().liked !== false) try {
      const tracks = (await pages('/me/tracks?limit=50')).map((e) => trackOf(e.track ?? e.item)).filter(Boolean);
      out.push({ id: 'liked', name: null, liked: true, image: null, owner: token.user?.name || '', full: true, total: tracks.length, tracks });
    } catch (e) {
      status.errors.push(`Liked songs: ${e.message}`);
      if (old.get('liked')) out.push(old.get('liked'));
    }
    for (const pl of await pages('/me/playlists?limit=50')) {
      if (!SPOTIFY_ID.test(pl?.id || '')) continue;
      const own = pl.owner?.id === me || pl.collaborative === true;
      if (!own && s().followed === false) continue;
      const prev = old.get(pl.id);
      if (prev && prev.snapshot === pl.snapshot_id && prev.full === own) { out.push(prev); continue; } // unchanged
      try {
        if (own) {
          const tracks = (await pages(`/playlists/${pl.id}/items?limit=50`)).map(entryTrack).filter(Boolean);
          out.push({ id: pl.id, name: pl.name || pl.id, image: pl.images?.[0]?.url || null, owner: pl.owner?.display_name || '', full: true, total: tracks.length, snapshot: pl.snapshot_id, tracks });
        } else {
          // Spotify gives apps the songs of your own playlists only – others' come from the public page.
          const p = await publicPlaylist(pl.id);
          out.push({ id: pl.id, ...p, name: pl.name || p.name, owner: pl.owner?.display_name || p.owner, image: pl.images?.[0]?.url || p.image, snapshot: pl.snapshot_id });
        }
      } catch (e) {
        status.errors.push(`${pl.name}: ${e.message}`);
        if (prev) out.push(prev);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ reading everything

  async function sync() {
    if (status.syncing || stopped || !token?.refresh || !loginReady()) return;
    status.syncing = true;
    status.errors = [];
    try {
      const old = new Map(library.playlists.map((p) => [p.id, p]));
      const out = await accountPlaylists(old);
      library = { playlists: out, syncedAt: Date.now() };
      save('library.json', library);
      if (status.errors.length) api.log(`could not read: ${status.errors.join('; ')}`);
      api.log(`read ${out.length} playlists with ${out.reduce((n, p) => n + p.tracks.length, 0)} songs`);
      matchAll();
    } catch (e) {
      status.errors.push(e.message);
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
      if (!api.has(YOUTUBE, 'findVideo')) { status.errors.push('Switch on the YouTube plugin – the songs are found with it'); return; }
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
            if (!api.has(YOUTUBE, 'findVideo')) { status.errors.push('The YouTube plugin was switched off'); i = todo.length; break; }
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

  const nameOf = (p) => (p.liked ? api.t('Liked songs') : p.name);
  const coverOf = (p) => {
    if (p.image) return p.image;
    const v = p.tracks.map((t) => matches[t.key]?.v).find(Boolean);
    return v ? `https://i.ytimg.com/vi/${v}/hqdefault.jpg` : null;
  };
  /** "41 songs" – or "100 of 1610 songs" when Spotify only showed the first ones. */
  const countOf = (p) => (p.total > p.tracks.length
    ? api.t('{n} of {total} songs', { n: p.tracks.length, total: p.total })
    : api.t('{n} songs', { n: p.tracks.length }));

  api.expose('youtubeRows', () => ({
    label: api.t('Playlists from Spotify'),
    rows: library.playlists.some((p) => p.tracks.length) ? [{
      id: 'playlists',
      title: api.t('Playlists from Spotify'),
      lists: library.playlists.filter((p) => p.tracks.length).map((p) => ({
        id: p.id, title: nameOf(p), subtitle: p.owner ? `${p.owner} · ${p.tracks.length}` : countOf(p), image: coverOf(p),
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
    // "Spotify · Katrin · 100/1610" when Spotify only gave the first songs.
    const channel = [p.liked ? 'Spotify' : `Spotify · ${p.owner}`, p.total > p.tracks.length ? `${p.tracks.length}/${p.total}` : null].filter(Boolean).join(' · ');
    return { title: nameOf(p), channel, videos, pending };
  });

  // ------------------------------------------------------------------ the Status page in the admin panel

  const html = (res, body, code = 200) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spotify → YouTube</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;background:#0f1115;color:#e8eaf0}
a{color:#7aa2ff}.card{background:#181b22;border-radius:12px;padding:16px 18px;margin:14px 0}.dim{color:#9aa0ad}.err{color:#ff7a7a}
code{background:#0f1115;padding:2px 6px;border-radius:6px}li{margin:2px 0}
.btn{display:inline-block;background:#2a2f3a;color:#e8eaf0;border:0;border-radius:20px;padding:9px 18px;font-weight:600;text-decoration:none;cursor:pointer;font-size:15px}
.btn.green{background:#1db954;color:#000}input{width:100%;box-sizing:border-box;padding:9px;border-radius:8px;border:1px solid #333a48;background:#0f1115;color:#e8eaf0}
</style></head><body><h1>Spotify → YouTube</h1>${body}</body></html>`);
  };
  const back = (res, to = `${base}/status`) => { res.writeHead(303, { location: to }); res.end(); };
  const readForm = (req) => new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 20000) req.destroy(); });
    req.on('end', () => resolve(new URLSearchParams(b)));
  });

  api.route('GET', '/status', (req, res, { query }) => {
    const n = library.playlists.reduce((sum, p) => sum + p.tracks.length, 0);
    const found = library.playlists.reduce((sum, p) => sum + p.tracks.filter((t) => matches[t.key]?.v).length, 0);
    const parts = [];
    if (query.get('error')) parts.push(`<p class="err">${esc(query.get('error'))}</p>`);

    // Logging in (optional)
    if (!loginReady()) {
      parts.push(`<div class="card"><b>First:</b> make a Spotify app and fill in its Client ID in the plugin's settings.
        <a href="https://github.com/valonia/couchmate-spotify-youtube#set-up" target="_blank">How (2 minutes) ↗</a></div>`);
    } else if (!token?.refresh) {
      parts.push(`<div class="card"><b>Spotify account</b><p>Not logged in.</p><p><a class="btn green" href="${base}/authorize">Log in with Spotify</a></p>
        <p class="dim">After logging in, Spotify sends you to <code>${esc(s().redirectUri)}</code>. If you are not on the computer that runs
        Couchmate that page will not load – copy its whole address from the address bar and paste it here:</p>
        <form method="post" action="${base}/connect"><input name="url" placeholder="http://127.0.0.1:…/callback?code=…" required>
        <p><button class="btn" type="submit">Finish logging in</button></p></form></div>`);
    } else {
      parts.push(`<div class="card"><b>Spotify account</b><p>Logged in as <b>${esc(token.user?.name || '?')}</b>.</p>
        <form method="post" action="${base}/logout"><button class="btn">Log out</button></form></div>`);
    }

    parts.push(`<div class="card"><p>${library.playlists.length} playlists, ${n} songs – ${found} found on YouTube${status.left ? `, ${status.left} still being looked up` : ''}.
      ${library.syncedAt ? `<br><span class="dim">Read ${esc(new Date(library.syncedAt).toLocaleString())}${status.syncing ? ' – reading again now…' : ''}</span>` : status.syncing ? '<br><span class="dim">Reading…</span>' : ''}</p>
      ${status.errors.map((e) => `<p class="err">${esc(e)}</p>`).join('')}
      <form method="post" action="${base}/sync"><button class="btn">Read again now</button></form></div>`);
    if (library.playlists.length) {
      parts.push(`<div class="card"><b>Playlists</b><ul>${library.playlists.map((p) => {
        const cut = p.total > p.tracks.length ? ` <span class="err">– the first ${p.tracks.length} of ${p.total} songs (made by someone else: copy it to a playlist of your own in Spotify to get them all)</span>` : '';
        return `<li>${esc(p.liked ? 'Liked songs' : p.name)} <span class="dim">· ${esc(p.owner)} · ${p.tracks.length} songs, ${p.tracks.filter((t) => matches[t.key]?.v).length} found</span>${cut}</li>`;
      }).join('')}</ul></div>`);
    }
    parts.push('<div class="card dim">In the YouTube plugin\'s settings, write <code>spotify-youtube</code> under <b>Topics on the front page</b> – the playlists then show at the top of YouTube in the apps.</div>');
    html(res, parts.join(''));
  }, { auth: 'admin' });

  api.route('GET', '/authorize', (req, res) => {
    try { res.writeHead(302, { location: authorizeUrl() }); res.end(); } catch (e) { back(res, `${base}/status?error=${encodeURIComponent(e.message)}`); }
  }, { auth: 'admin' });

  // Spotify sends the browser here after logging in (works when the browser is on the computer running Couchmate).
  // Only finishes a login started from the Status page (the state must match).
  api.route('GET', '/callback', async (req, res, { query }) => {
    if (query.get('error')) return html(res, `<p class="err">Spotify said: ${esc(query.get('error'))}</p>`, 400);
    try {
      await finishLogin(query.get('code'), query.get('state'));
      html(res, `<div class="card"><p>Logged in as <b>${esc(token.user.name)}</b>. Your playlists are being read now.</p><p class="dim">You can close this tab.</p></div>`);
    } catch (e) {
      html(res, `<p class="err">${esc(e.message)}</p>`, 400);
    }
  }, { auth: 'public' });

  // The address Spotify sent the browser to, pasted on the Status page (when the browser is on another device).
  api.route('POST', '/connect', async (req, res) => {
    try {
      const url = new URL(String((await readForm(req)).get('url') || '').trim());
      if (url.searchParams.get('error')) throw new Error(`Spotify said: ${url.searchParams.get('error')}`);
      await finishLogin(url.searchParams.get('code'), url.searchParams.get('state'));
      back(res);
    } catch (e) {
      back(res, `${base}/status?error=${encodeURIComponent(e.message === 'Invalid URL' ? 'That is not the address from the address bar' : e.message)}`);
    }
  }, { auth: 'admin' });

  api.route('POST', '/sync', (req, res) => { sync(); back(res); }, { auth: 'admin' });
  api.route('POST', '/logout', (req, res) => { logout(); back(res); }, { auth: 'admin' });
  api.link('Status and Spotify login', `${base}/status`);

  // No api.source: this plugin has no menu entry or screens of its own – it only extends YouTube.

  // Read now (the settings may have changed – the plugin restarts then) and every 30 minutes.
  setTimeout(() => (token?.refresh ? sync() : matchAll()), 3000);
  timers.push(setInterval(() => sync(), 30 * 60 * 1000));
  return () => { stopped = true; timers.forEach(clearInterval); };
}
