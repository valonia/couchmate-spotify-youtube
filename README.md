# Spotify → YouTube – a Couchmate plugin

Public Spotify playlists, played from YouTube, in sync for everyone. No Spotify login and no Spotify app – just a
username.

It extends the YouTube plugin: write `spotify-youtube` as a topic in the YouTube plugin's settings and the playlists
show at the top of its front page. They open, play, have a queue, go straight from song to song and can be added
to favourites, like any YouTube playlist.

Nothing is created on YouTube or Spotify. The plugin reads the playlists from Spotify's public web pages, matches
every song to a YouTube video in the background and keeps it all on your Couchmate server. Songs that were not
found (or are still being looked up) are shown greyed out and skipped.

**Requires:** the YouTube plugin, switched on (the admin panel offers to install it).

## Set up

1. In the Couchmate admin panel, open **Plugins** and install **Spotify → YouTube** under **Get plugins**.
2. In its **Settings**, write your Spotify username or paste your profile link under **Spotify profiles**
   (in Spotify: your profile → ··· → Share → Copy link to profile). Several, separated by commas, work too.
3. Optionally, paste links to single public playlists under **More playlists**.
4. In the YouTube plugin's settings, add `spotify-youtube` to **Topics on the front page**.

The playlists are read straight away and every 30 minutes after that; **Status** on the plugin's card shows what was
read. Looking up the songs on YouTube takes a while the first time (a few seconds per song) – the first songs of
every playlist are looked up first.

## What is included – and what is not

- Every **public playlist shown on the profile**. In Spotify a playlist is shown there when it is public and
  **Add to profile** is on (it is for new public playlists).
- **Single playlist links** – any public playlist, also ones made by others.
- **Up to 100 songs per playlist** – Spotify's public pages show no more.
- Not included: liked songs and private playlists – Spotify does not show them publicly.

This reads Spotify's public web pages, not an official API, so it may need fixing if Spotify changes them.

## Updates

The server checks this repository for new releases every 6 hours. Under **Plugins** you can update with one
click, or switch on **Update automatically** to have new versions installed as soon as they are released.

## Making your own

Plugins are plain JavaScript modules – `index.mjs` here is a working example of a plugin that extends another one
(`api.use('youtube', 'findVideo', …)` and `api.expose('youtubeRows' / 'youtubeList', …)`).
