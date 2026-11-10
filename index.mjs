// Spotify → YouTube for Couchmate – an extension of the YouTube plugin.
//
// - The admin logs in with one or more Spotify accounts (the plugin's Status page in the admin panel; it needs a
//   Spotify app made once on developer.spotify.com, with every account added under User Management). For each
//   account, every song of the playlists it made or collaborates on (private ones too), its liked songs and the
//   playlists it follows are read and kept on this server, and read again every 30 minutes.
//   Spotify gives apps the songs of your own playlists only: the ones you follow come from Spotify's public page –
//   the first 100 songs.
// - Every song is matched to a YouTube video in the background (with the YouTube plugin's findVideo) and the match
//   is remembered. Nothing is created on YouTube or Spotify.
// - Write "spotify-youtube" as a topic in the YouTube plugin's settings: a row per account shows at the top of its
//   front page. The playlists open, play, queue and can be added to favourites like YouTube playlists.

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
/** A list id for an account's liked songs (ids may only hold letters, digits, - and _). */
const likedId = (userId) => `liked-${String(userId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 50)}`;

export default function setup(api) {
  const s = () => api.settings;
  const base = `/plugins/${api.id}`;
  const file = (name) => path.join(api.dataDir, name);
  const load = (name, fallback) => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; } };
  const save = (name, value) => { fs.writeFileSync(`${file(name)}.tmp`, JSON.stringify(value)); fs.renameSync(`${file(name)}.tmp`, file(name)); };

  // The logged-in accounts: [{ access, refresh, expiresAt, user: { id, name } }]. One account from before is moved over.
  let accounts = load('accounts.json', null);
  if (!Array.isArray(accounts)) {
    const old = load('token.json', null);
    accounts = old?.refresh && old.user ? [old] : [];
    save('accounts.json', accounts);
  }
  // playlists: [{ id, name, image, owner, account, liked?, full, total, snapshot?, tracks: [{ key, title, artists, duration }] }]
  // account = the account (user id) whose row it shows in; full = every song (official API); otherwise the first
  // EMBED_MAX of total (a playlist someone follows).
  let library = load('library.json', { playlists: [], syncedAt: null });
  const matches = load('matches.json', {}); // Spotify track id → { v: YouTube video id } or { none: time }
  const logins = new Map(); // state → { verifier, at } while the admin is logging in
  const status = { syncing: false, errors: [], left: 0 };
  let stopped = false;
  const timers = [];

  const saveAccounts = () => save('accounts.json', accounts);

  // ------------------------------------------------------------------ Spotify's public pages (playlists someone follows)

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
      // Always ask – so another account can be added (Spotify's page has "Not you?").
      show_dialog: 'true',
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

  /** The end of a login: the code Spotify sent back (to /callback, or pasted on the Status page). Returns the account. */
  async function finishLogin(code, state) {
    const l = logins.get(String(state || ''));
    if (!l) throw new Error('This login has expired – start it again');
    logins.delete(state);
    const d = await tokenRequest({ grant_type: 'authorization_code', code: String(code || ''), redirect_uri: s().redirectUri.trim(), code_verifier: l.verifier });
    const acct = { access: d.access_token, refresh: d.refresh_token, expiresAt: Date.now() + (Number(d.expires_in) - 60) * 1000, user: null };
    const me = await spotify(acct, '/me');
    acct.user = { id: me.id, name: me.display_name || me.id };
    // The same account again replaces it; another one is added.
    accounts = [...accounts.filter((a) => a.user?.id !== acct.user.id), acct];
    saveAccounts();
    api.log(`logged in as ${acct.user.name}`);
    sync();
    return acct;
  }

  function logout(userId) {
    const acct = accounts.find((a) => a.user?.id === userId);
    if (!acct) return;
    accounts = accounts.filter((a) => a !== acct);
    saveAccounts();
    library = { ...library, playlists: library.playlists.filter((p) => p.account !== userId) };
    save('library.json', library);
    api.log(`logged out ${acct.user.name}`);
    sync(); // a playlist it shared with another account shows under that one again
  }

  async function accessToken(acct) {
    if (!acct?.refresh) throw new Error('Not logged in to Spotify');
    if (acct.access && Date.now() < acct.expiresAt) return acct.access;
    const d = await tokenRequest({ grant_type: 'refresh_token', refresh_token: acct.refresh });
    Object.assign(acct, { access: d.access_token, refresh: d.refresh_token || acct.refresh, expiresAt: Date.now() + (Number(d.expires_in) - 60) * 1000 });
    if (accounts.includes(acct)) saveAccounts();
    return acct.access;
  }

  async function spotify(acct, pathOrUrl) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await fetch(pathOrUrl.startsWith('https://') ? pathOrUrl : `${API}${pathOrUrl}`, {
        headers: { authorization: `Bearer ${await accessToken(acct)}` }, signal: AbortSignal.timeout(20000),
      });
      if (r.status === 429) { await sleep(Math.min(30, Number(r.headers.get('retry-after')) || 2) * 1000); continue; }
      if (r.status === 401 && attempt === 0) { acct.expiresAt = 0; continue; }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error?.message || `Spotify answered ${r.status}`);
      }
      return r.json();
    }
    throw new Error('Spotify is busy – trying again later');
  }

  /** Every page of a list from Spotify's API. */
  async function pages(acct, first, max = 10000) {
    const out = [];
    let url = first;
    while (url && out.length < max) {
      const d = await spotify(acct, url);
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

  /** One account: liked songs, and every playlist in its library – all songs of its own, the public page for others'. */
  async function accountPlaylists(acct, old) {
    const me = acct.user.id;
    const who = acct.user.name;
    const out = [];
    if (s().liked !== false) {
      const id = likedId(me);
      try {
        const tracks = (await pages(acct, '/me/tracks?limit=50')).map((e) => trackOf(e.track ?? e.item)).filter(Boolean);
        out.push({ id, name: null, liked: true, image: null, owner: who, account: me, full: true, total: tracks.length, tracks });
      } catch (e) {
        status.errors.push(`${who} – liked songs: ${e.message}`);
        if (old.get(id)) out.push(old.get(id));
      }
    }
    for (const pl of await pages(acct, '/me/playlists?limit=50')) {
      if (!SPOTIFY_ID.test(pl?.id || '')) continue;
      const own = pl.owner?.id === me || pl.collaborative === true;
      if (!own && s().followed === false) continue;
      const prev = old.get(pl.id);
      if (prev && prev.snapshot === pl.snapshot_id && prev.full === own) { out.push({ ...prev, account: me }); continue; } // unchanged
      try {
        if (own) {
          const tracks = (await pages(acct, `/playlists/${pl.id}/items?limit=50`)).map(entryTrack).filter(Boolean);
          out.push({ id: pl.id, name: pl.name || pl.id, image: pl.images?.[0]?.url || null, owner: pl.owner?.display_name || '', account: me, full: true, total: tracks.length, snapshot: pl.snapshot_id, tracks });
        } else {
          // Spotify gives apps the songs of your own playlists only – others' come from the public page.
          const p = await publicPlaylist(pl.id);
          out.push({ id: pl.id, ...p, name: pl.name || p.name, owner: pl.owner?.display_name || p.owner, image: pl.images?.[0]?.url || p.image, account: me, snapshot: pl.snapshot_id });
        }
      } catch (e) {
        status.errors.push(`${who} – ${pl.name}: ${e.message}`);
        if (prev) out.push({ ...prev, account: me });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ reading everything

  async function sync() {
    if (status.syncing || stopped || !accounts.length || !loginReady()) return;
    status.syncing = true;
    status.errors = [];
    try {
      const old = new Map(library.playlists.map((p) => [p.id, p]));
      // A playlist several accounts have shows once: with every song if one of them owns it, else under the first.
      const byId = new Map();
      for (const acct of [...accounts]) {
        let lists;
        try {
          lists = await accountPlaylists(acct, old);
        } catch (e) {
          status.errors.push(`${acct.user?.name || '?'}: ${e.message}`);
          lists = library.playlists.filter((p) => p.account === acct.user?.id); // keep what was read last time
        }
        for (const p of lists) {
          const had = byId.get(p.id);
          if (!had || (!had.full && p.full)) byId.set(p.id, p);
        }
      }
      const out = [...byId.values()];
      library = { playlists: out, syncedAt: Date.now() };
      save('library.json', library);
      if (status.errors.length) api.log(`could not read: ${status.errors.join('; ')}`);
      api.log(`read ${out.length} playlists with ${out.reduce((n, p) => n + p.tracks.length, 0)} songs from ${accounts.length} account(s)`);
      matchAll();
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

  // A row per account (in the order they were added), titled with the account's name when there are several.
  api.expose('youtubeRows', () => ({
    label: api.t('Playlists from Spotify'),
    rows: accounts.map((a) => ({
      id: `acct-${likedId(a.user.id).slice(6)}`,
      title: accounts.length > 1 ? api.t('From Spotify · {name}', { name: a.user.name }) : api.t('Playlists from Spotify'),
      lists: library.playlists.filter((p) => p.account === a.user.id && p.tracks.length).map((p) => ({
        id: p.id, title: nameOf(p), subtitle: p.liked ? countOf(p) : `${p.owner} · ${p.tracks.length}`, image: coverOf(p),
      })),
    })).filter((r) => r.lists.length),
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
    const channel = [`Spotify · ${p.owner}`, p.total > p.tracks.length ? `${p.tracks.length}/${p.total}` : null].filter(Boolean).join(' · ');
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
.btn.small{padding:5px 12px;font-size:13px}.btn.green{background:#1db954;color:#000}
.acct{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #262b35}.acct:last-child{border-bottom:0}.acct .grow{flex:1}
input{width:100%;box-sizing:border-box;padding:9px;border-radius:8px;border:1px solid #333a48;background:#0f1115;color:#e8eaf0}
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

    if (!loginReady()) {
      parts.push(`<div class="card"><b>First:</b> make a Spotify app and fill in its Client ID in the plugin's settings.
        <a href="https://github.com/valonia/couchmate-spotify-youtube#set-up" target="_blank">How (2 minutes) ↗</a></div>`);
    } else {
      const list = accounts.map((a) => {
        const count = library.playlists.filter((p) => p.account === a.user.id).length;
        return `<div class="acct"><span class="grow"><b>${esc(a.user.name)}</b> <span class="dim">· ${count} playlists</span></span>
          <form method="post" action="${base}/logout"><input type="hidden" name="id" value="${esc(a.user.id)}"><button class="btn small">Log out</button></form></div>`;
      }).join('');
      parts.push(`<div class="card"><b>Spotify accounts</b>
        ${list || '<p class="dim">No account yet.</p>'}
        <p><a class="btn green" href="${base}/authorize">${accounts.length ? 'Add another account' : 'Log in with Spotify'}</a></p>
        <p class="dim">Each account must be added under <b>User Management</b> in your Spotify app (at most 5). To add someone
        else's, choose <b>Not you?</b> on Spotify's page – or log in from a private browser window.</p>
        <p class="dim">After logging in, Spotify sends you to <code>${esc(s().redirectUri)}</code>. If you are not on the computer that runs
        Couchmate that page will not load – copy its whole address from the address bar and paste it here:</p>
        <form method="post" action="${base}/connect"><input name="url" placeholder="http://127.0.0.1:…/callback?code=…" required>
        <p><button class="btn" type="submit">Finish logging in</button></p></form></div>`);
    }

    parts.push(`<div class="card"><p>${library.playlists.length} playlists, ${n} songs – ${found} found on YouTube${status.left ? `, ${status.left} still being looked up` : ''}.
      ${library.syncedAt ? `<br><span class="dim">Read ${esc(new Date(library.syncedAt).toLocaleString())}${status.syncing ? ' – reading again now…' : ''}</span>` : status.syncing ? '<br><span class="dim">Reading…</span>' : ''}</p>
      ${status.errors.map((e) => `<p class="err">${esc(e)}</p>`).join('')}
      <form method="post" action="${base}/sync"><button class="btn">Read again now</button></form></div>`);
    for (const a of accounts) {
      const lists = library.playlists.filter((p) => p.account === a.user.id);
      if (!lists.length) continue;
      parts.push(`<div class="card"><b>${esc(a.user.name)}</b><ul>${lists.map((p) => {
        const cut = p.total > p.tracks.length ? ` <span class="err">– the first ${p.tracks.length} of ${p.total} songs (made by someone else: copy it to a playlist of your own in Spotify to get them all)</span>` : '';
        return `<li>${esc(p.liked ? 'Liked songs' : p.name)} <span class="dim">· ${esc(p.owner)} · ${p.tracks.length} songs, ${p.tracks.filter((t) => matches[t.key]?.v).length} found</span>${cut}</li>`;
      }).join('')}</ul></div>`);
    }
    parts.push('<div class="card dim">In the YouTube plugin\'s settings, write <code>spotify-youtube</code> under <b>Topics on the front page</b> – the playlists then show at the top of YouTube in the apps, a row per account.</div>');
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
      const acct = await finishLogin(query.get('code'), query.get('state'));
      html(res, `<div class="card"><p>Logged in as <b>${esc(acct.user.name)}</b>. The playlists are being read now.</p><p class="dim">You can close this tab.</p></div>`);
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
  api.route('POST', '/logout', async (req, res) => { logout(String((await readForm(req)).get('id') || '')); back(res); }, { auth: 'admin' });
  api.link('Status and Spotify login', `${base}/status`);

  // No api.source: this plugin has no menu entry or screens of its own – it only extends YouTube.

  // Read now (the settings may have changed – the plugin restarts then) and every 30 minutes.
  setTimeout(() => (accounts.length ? sync() : matchAll()), 3000);
  timers.push(setInterval(() => sync(), 30 * 60 * 1000));
  return () => { stopped = true; timers.forEach(clearInterval); };
}
