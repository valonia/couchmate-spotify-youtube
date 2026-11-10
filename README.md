# Spotify → YouTube – a Couchmate plugin

Spotify playlists, liked songs and the playlists you follow – from one or more Spotify accounts – played from YouTube,
in sync for everyone.

It extends the YouTube plugin: write `spotify-youtube` as a topic in the YouTube plugin's settings and your
playlists show at the top of its front page. They open, play, have a queue, go straight from song to song and
can be added to favourites, like any YouTube playlist.

Nothing is created on YouTube or Spotify. The plugin reads your playlists, matches every song to a YouTube video
in the background and keeps it all on your Couchmate server. Songs that were not found (or are still being looked
up) are shown greyed out and skipped.

**Requires:** the YouTube plugin, switched on (the admin panel offers to install it).

## Set up

Only the admin logs in, once, in the admin panel. Spotify only lets apps read your playlists through an app
registered with Spotify; you make it once – it takes about two minutes. Its owner needs Spotify Premium.

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), log in and press **Create app**.
2. Fill in a name (e.g. *Couchmate*) and a description. Under **Redirect URIs** add:

   `http://127.0.0.1:8787/plugins/spotify-youtube/callback`

   Use the port your Couchmate server has on its computer – 8787 unless you changed it (for example `8788`).
3. Tick **Web API**, accept the terms and save.
4. Open the app's **Settings** and copy the **Client ID**.
5. Under **User Management**, add every Spotify account whose playlists should be read (at most 5).
6. In the Couchmate admin panel: **Plugins → Spotify → YouTube → Settings**. Paste the Client ID. If you used
   another port in step 2, change **Redirect URI** to match exactly.
7. On the plugin's card, open **Status and Spotify login** and press **Log in with Spotify**.
   - On the computer that runs Couchmate, you come straight back and you are done.
   - On another device, the last page will not load. Copy its whole address from the address bar, paste it on the
     Status page and press **Finish logging in**.
   - More accounts: press **Add another account** and choose **Not you?** on Spotify's page (or use a private
     browser window). Each account gets a row of its own on YouTube's front page; log one out on the Status page.
8. In the YouTube plugin's settings, add `spotify-youtube` to **Topics on the front page**.

The playlists are read straight away and every 30 minutes after that. Looking up the songs on YouTube takes a while
the first time (a few seconds per song) – the first songs of every playlist are looked up first.

## Invites

Let someone connect their own Spotify account from their phone – without the admin panel:

1. Give the plugin a **public address**: an https address that reaches this server's `/plugins/spotify-youtube`
   pages from the internet. Only these pages need to be public – the apps, the admin panel and the streams can stay
   private. Some ways:
   - **Tailscale Funnel** (free, no domain): on the computer running Couchmate, with HTTPS and Funnel switched on in
     Tailscale's admin console:

     `tailscale funnel --bg --set-path /plugins/spotify-youtube http://127.0.0.1:8787/plugins/spotify-youtube`

     (use your server's port). The address is `https://<computer>.<tailnet>.ts.net`.
   - **Cloudflare Tunnel** with a domain of your own, to `http://localhost:8787` (a path rule can limit it to
     `/plugins/spotify-youtube`).
   - A reverse proxy (Caddy, Nginx) with a domain and HTTPS.
2. In the plugin's settings, fill in **Public address** (e.g. `https://bob.tail1234.ts.net`).
3. In your Spotify app, add `<public address>/plugins/spotify-youtube/callback` under **Redirect URIs**, and add
   the person's Spotify account under **User Management**.
4. On the Status page, press **Create invite** and send them the link. It works once and for 7 days, and only lets
   them connect a Spotify account. They open it, press **Connect my Spotify**, log in – and their playlists show
   up as a row of their own.

With a public address you can also log in yourself from any device.

## What is included

- **Your playlists** – the ones you made or collaborate on, private ones too, with every song.
- **Liked songs** – as a playlist of its own (can be switched off in the settings).
- **Playlists you follow** – made by others. Spotify does not give apps their songs, so they are read from
  Spotify's public page: only public ones, and only the first 100 songs (the Status page and the apps say
  "100 of 1610 songs"). To get all of them, copy the playlist to one of your own in Spotify. Can be switched off.

## Install

In the Couchmate admin panel, open **Plugins**: it is listed under **Get plugins** – press **Install**, then switch
it on and fill in its settings.

## Updates

The server checks this repository for new releases every 6 hours. Under **Plugins** you can update with one
click, or switch on **Update automatically** to have new versions installed as soon as they are released.

## Making your own

Plugins are plain JavaScript modules – `index.mjs` here is a working example of a plugin that extends another one
(`api.use('youtube', 'findVideo', …)` and `api.expose('youtubeRows' / 'youtubeList', …)`).
