# Spotify → YouTube – a Couchmate plugin

Your Spotify playlists, liked songs and the playlists you follow – played from YouTube, in sync for everyone.

It extends the YouTube plugin: write `spotify-youtube` as a topic in the YouTube plugin's settings and your
playlists show at the top of its front page. They open, play, have a queue, go straight from song to song and
can be added to favourites, like any YouTube playlist.

Nothing is created on YouTube or Spotify. The plugin reads your playlists, matches every song to a YouTube video
in the background and keeps it all on your Couchmate server. Songs that were not found (or are still being looked
up) are shown greyed out and skipped.

**Requires:** the YouTube plugin, switched on.

## Set up

Spotify only lets apps read your playlists after you log in, through an app registered with Spotify. You make that
app once – it takes about two minutes. The person who makes it needs Spotify Premium; the people who log in do not.

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), log in and press **Create app**.
2. Fill in a name (e.g. *Couchmate*) and a description. Under **Redirect URIs** add:

   `http://127.0.0.1:8787/plugins/spotify-youtube/callback`

   Use the port your Couchmate server has on its computer – 8787 unless you changed it (for example `8788`).
3. Tick **Web API**, accept the terms and save.
4. Open the app's **Settings** and copy the **Client ID**.
5. Under **User Management**, add the name and e-mail of every Spotify account that should log in (yours too).
6. In the Couchmate admin panel: **Plugins → Spotify → YouTube → Settings**. Paste the Client ID. If you used
   another port in step 2, change **Redirect URI** to match exactly.
7. On the plugin's card, open **Spotify login and status** and press **Log in with Spotify**.
   - On the computer that runs Couchmate, you come straight back and you are done.
   - On another device, the last page will not load. Copy its whole address from the address bar, paste it on the
     status page and press **Finish logging in**.
8. In the YouTube plugin's settings, add `spotify-youtube` to **Topics on the front page**.

The playlists are read straight away and every 30 minutes after that. Looking up the songs on YouTube takes a while
the first time (a few seconds per song) – the first songs of every playlist are looked up first.

## What is included

- **Your playlists** – the ones you made or collaborate on.
- **Liked songs** – as a playlist of its own (can be switched off in the settings).
- **Playlists you follow** – made by others. Spotify does not give their songs to apps any more, so they are read
  from Spotify's public pages: only public playlists, and very long ones may be cut short. Can be switched off.

## Install

In the Couchmate admin panel, open **Plugins**: it is listed under **Get plugins** – press **Install**, then switch
it on and fill in its settings.

## Updates

The server checks this repository for new releases every 6 hours. Under **Plugins** you can update with one
click, or switch on **Update automatically** to have new versions installed as soon as they are released.

## Making your own

Plugins are plain JavaScript modules – `index.mjs` here is a working example of a plugin that extends another one
(`api.use('youtube', 'findVideo', …)` and `api.expose('youtubeRows' / 'youtubeList', …)`).
