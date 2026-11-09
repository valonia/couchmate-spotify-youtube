// Spotify → YouTube for Couchmate – an extension of the YouTube plugin.
//
// - Write Spotify usernames (or profile links) in the settings: the public playlists on those profiles are read
//   from Spotify's public web pages – no login, no Spotify app. Single playlist links can be added too. They are
//   read again every 30 minutes.
// - Every song is matched to a YouTube video in the background (with the YouTube plugin's findVideo) and the match
//   is remembered. Nothing is created on YouTube or Spotify; everything is kept on this server.
// - Write "spotify-youtube" as a topic in the YouTube plugin's settings: a row with the playlists shows at the top
//   of its front page. They open, play, queue and can be added to favourites like YouTube playlists.

import fs from 'node:fs';
import path from 'node:path';

const YOUTUBE = 'youtube';
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const USER_ID = /^[A-Za-z0-9._-]{1,64}$/;
const HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Couchmate', 'accept-language': 'en' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default function setup(api) {
  const s = () => api.settings;
  const base = `/plugins/${api.id}`;
  const file = (name) => path.join(api.dataDir, name);
  const load = (name, fallback) => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; } };
  const save = (name, value) => { fs.writeFileSync(`${file(name)}.tmp`, JSON.stringify(value)); fs.renameSync(`${file(name)}.tmp`, file(name)); };

  // playlists: [{ id, name, image, owner, tracks: [{ key, title, artists, duration }] }]
  let library = load('library.json', { playlists: [], users: [], syncedAt: null });
  if (!Array.isArray(library.users)) library.users = [];
  const matches = load('matches.json', {}); // Spotify track id → { v: YouTube video id } or { none: time }
  const status = { syncing: false, errors: [], left: 0 };
  let stopped = false;
  const timers = [];

  // ------------------------------------------------------------------ reading Spotify's public pages

  /** "valonialol", "https://open.spotify.com/user/valonialol?si=…" or "spotify:user:valonialol" → "valonialol". */
  const userOf = (v) => {
    const t = String(v || '').trim();
    const m = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?user\/|spotify:user:)([^/?#\s]+)/i.exec(t);
    const id = m ? decodeURIComponent(m[1]) : t;
    return USER_ID.test(id) ? id : null;
  };
  /** A playlist link, "spotify:playlist:…" or a bare id → the id. */
  const playlistOf = (v) => {
    const t = String(v || '').trim();
    const m = /playlist[/:]([A-Za-z0-9]{22})/.exec(t);
    return m ? m[1] : SPOTIFY_ID.test(t) ? t : null;
  };
  const list = (v) => String(v || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

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

  const imageOfEntity = (images) => {
    const src = images?.items?.[0]?.sources || [];
    return [...src].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null;
  };

  /** A profile's name and public playlists (the ones shown on the profile). */
  async function profile(user) {
    const read = async (url) => initialState(await page(url)).entities?.items?.[`spotify:user:${user}`];
    let u = await read(`https://open.spotify.com/user/${encodeURIComponent(user)}`);
    if (!u) throw new Error('not found on Spotify');
    // The profile page shows the first ones; the profile's playlist page may show more.
    if ((u.publicPlaylistsV2?.totalCount || 0) > (u.publicPlaylistsV2?.items?.length || 0)) {
      const more = await read(`https://open.spotify.com/user/${encodeURIComponent(user)}/playlists`).catch(() => null);
      if ((more?.publicPlaylistsV2?.items?.length || 0) > u.publicPlaylistsV2.items.length) u = { ...u, publicPlaylistsV2: more.publicPlaylistsV2 };
    }
    const playlists = (u.publicPlaylistsV2?.items || []).map((it) => {
      const id = String(it?._uri || it?.data?.uri || '').split(':')[2];
      return SPOTIFY_ID.test(id || '') ? { id, name: it.data?.name || id, image: imageOfEntity(it.data?.images) } : null;
    }).filter(Boolean);
    return { name: u.name || user, playlists, total: u.publicPlaylistsV2?.totalCount || playlists.length };
  }

  /** A public playlist's name, cover and songs (Spotify's embed page shows up to 100 of them). */
  async function playlist(id) {
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
    const cover = [...(e.coverArt?.sources || [])].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || null;
    return { name: e.name || e.title || id, owner: e.subtitle || '', image: cover, tracks };
  }

  /** Reads every profile and playlist from the settings again. */
  async function sync() {
    if (status.syncing || stopped) return;
    status.syncing = true;
    const errors = [];
    try {
      const users = [...new Set(list(s().users).map(userOf).filter(Boolean))];
      const wanted = new Map(); // playlist id → { owner, image, name }
      const profiles = [];
      for (const user of users) {
        try {
          const p = await profile(user);
          profiles.push({ id: user, name: p.name, count: p.playlists.length, total: p.total });
          for (const pl of p.playlists) if (!wanted.has(pl.id)) wanted.set(pl.id, { owner: p.name, image: pl.image, name: pl.name });
        } catch (e) {
          errors.push(`${user}: ${e.message}`);
          profiles.push({ id: user, name: user, count: 0, error: e.message });
        }
      }
      for (const v of list(s().playlists)) {
        const id = playlistOf(v);
        if (id && !wanted.has(id)) wanted.set(id, {});
        else if (!id) errors.push(`${v}: not a Spotify playlist link`);
      }
      const old = new Map(library.playlists.map((p) => [p.id, p]));
      const out = [];
      for (const [id, hint] of wanted) {
        try {
          const pl = await playlist(id);
          out.push({ id, name: pl.name || hint.name || id, owner: hint.owner || pl.owner, image: pl.image || hint.image || null, tracks: pl.tracks });
        } catch (e) {
          errors.push(`${hint.name || id}: ${e.message}`);
          if (old.has(id)) out.push(old.get(id)); // keep what was read last time
        }
      }
      library = { playlists: out, users: profiles, syncedAt: Date.now() };
      save('library.json', library);
      status.errors = errors;
      if (errors.length) api.log(`could not read: ${errors.join('; ')}`);
      api.log(`read ${out.length} playlists with ${out.reduce((n, p) => n + p.tracks.length, 0)} songs`);
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
      if (!api.has(YOUTUBE, 'findVideo')) { status.errors = ['Switch on the YouTube plugin – the songs are found with it']; return; }
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
            if (!api.has(YOUTUBE, 'findVideo')) { status.errors = ['The YouTube plugin was switched off']; i = todo.length; break; }
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

  const coverOf = (p) => {
    if (p.image) return p.image;
    const v = p.tracks.map((t) => matches[t.key]?.v).find(Boolean);
    return v ? `https://i.ytimg.com/vi/${v}/hqdefault.jpg` : null;
  };

  api.expose('youtubeRows', () => ({
    label: api.t('Playlists from Spotify'),
    rows: library.playlists.some((p) => p.tracks.length) ? [{
      id: 'playlists',
      title: api.t('Playlists from Spotify'),
      lists: library.playlists.filter((p) => p.tracks.length).map((p) => ({
        id: p.id,
        title: p.name,
        subtitle: p.owner ? `${p.owner} · ${p.tracks.length}` : api.t('{n} songs', { n: p.tracks.length }),
        image: coverOf(p),
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
    return { title: p.name, channel: p.owner ? `Spotify · ${p.owner}` : 'Spotify', videos, pending };
  });

  // ------------------------------------------------------------------ the status page in the admin panel

  api.route('GET', '/status', (req, res) => {
    const n = library.playlists.reduce((sum, p) => sum + p.tracks.length, 0);
    const found = library.playlists.reduce((sum, p) => sum + p.tracks.filter((t) => matches[t.key]?.v).length, 0);
    const users = library.users.map((u) => `<li><b>${esc(u.name)}</b> <span class="dim">(${esc(u.id)})</span> – ${u.error ? `<span class="err">${esc(u.error)}</span>` : `${u.count} public playlists`}</li>`).join('');
    const lists = library.playlists.map((p) => `<li>${esc(p.name)} <span class="dim">· ${esc(p.owner || 'link')} · ${p.tracks.length} songs, ${p.tracks.filter((t) => matches[t.key]?.v).length} found</span></li>`).join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spotify → YouTube</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;background:#0f1115;color:#e8eaf0}
.card{background:#181b22;border-radius:12px;padding:16px 18px;margin:14px 0}.dim{color:#9aa0ad}.err{color:#ff7a7a}code{background:#0f1115;padding:2px 6px;border-radius:6px}
.btn{background:#2a2f3a;color:#e8eaf0;border:0;border-radius:20px;padding:9px 18px;font-weight:600;cursor:pointer;font-size:15px}li{margin:2px 0}
</style></head><body><h1>Spotify → YouTube</h1>
${!list(s().users).length && !list(s().playlists).length ? '<div class="card">Write a Spotify username or profile link in the plugin\'s settings (e.g. <code>https://open.spotify.com/user/…</code>).</div>' : ''}
<div class="card"><p>${library.playlists.length} playlists, ${n} songs – ${found} found on YouTube${status.left ? `, ${status.left} still being looked up` : ''}.
${library.syncedAt ? `<br><span class="dim">Read ${esc(new Date(library.syncedAt).toLocaleString())}${status.syncing ? ' – reading again now…' : ''}</span>` : status.syncing ? '<br><span class="dim">Reading…</span>' : ''}</p>
${status.errors.map((e) => `<p class="err">${esc(e)}</p>`).join('')}
<form method="post" action="${base}/sync"><button class="btn">Read again now</button></form></div>
${users ? `<div class="card"><b>Profiles</b><ul>${users}</ul></div>` : ''}
${lists ? `<div class="card"><b>Playlists</b><ul>${lists}</ul></div>` : ''}
<div class="card dim">In the YouTube plugin's settings, write <code>spotify-youtube</code> under <b>Topics on the front page</b> – the playlists then show at the top of YouTube in the apps.</div>
</body></html>`);
  }, { auth: 'admin' });
  api.route('POST', '/sync', (req, res) => { sync(); res.writeHead(303, { location: `${base}/status` }); res.end(); }, { auth: 'admin' });
  api.link('Status', `${base}/status`);

  // No api.source: this plugin has no menu entry or screens of its own – it only extends YouTube.

  // Read now (the settings may have changed – the plugin restarts then) and every 30 minutes.
  setTimeout(() => sync(), 3000);
  timers.push(setInterval(() => sync(), 30 * 60 * 1000));
  return () => { stopped = true; timers.forEach(clearInterval); };
}
