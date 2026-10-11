# YouTube Audio Importer (Foundry VTT v13/v14)

Import audio from YouTube directly into your Foundry assets and playlists.

- **Playlists tab → "Import from YouTube"**: paste a link, pick the folder, format and playlist, watch the progress bars.
- **Right-click a playlist → "Paste from YouTube"**: takes the link from your clipboard and adds the track straight to that playlist.
- The original link is saved in the sound's description.
- Understands every common YouTube link shape (`watch`, `youtu.be`, `shorts`, `live`, `embed`, `music.`, `m.`, `youtube-nocookie`, tracking/time parameters, bare video IDs).
- **Import sound** or **Import playlist**: the dialog detects from the link which applies (a video inside a playlist lets you choose). Playlists go into a Foundry playlist named after them, with a subfolder per playlist.
- Formats: opus (default, best quality/size), ogg (Vorbis, plays everywhere), mp3, m4a.

## Install

1. In Foundry: **Add-on Modules → Install Module**, paste the manifest URL:
   `https://github.com/Hexnen/yt-audio-importer/releases/latest/download/module.json`
2. Enable the module in your world.
3. Download **foundry-yt-helper-v1.1.2.exe** (also committed in this repo as [`helper/foundry-yt-helper-v1.1.2.exe`](helper/foundry-yt-helper-v1.1.2.exe)) from the [latest release](https://github.com/Hexnen/yt-audio-importer/releases/latest) (the module also has a button for it) and run it. Keep its window open while you import; close it to stop. The first run downloads `yt-dlp` and `ffmpeg` automatically into `%LOCALAPPDATA%\yt-audio-helper`.

Foundry modules run only in the browser and cannot run `yt-dlp`, so a tiny local program (the helper) does the download; it listens on `127.0.0.1:30077` only and accepts YouTube links only. It must run on the same computer as the browser you use as GM.

The module checks the helper version and tells you when it is outdated. Windows may show a SmartScreen warning for the unsigned helper exe; the source is in `helper/`.

## Releasing

Build the helper with `cd helper && npm ci && node build.mjs` (Node 22, produces `helper/dist/foundry-yt-helper-v<version>.exe` as a Node SEA; the version comes from `helper/package.json`). Zip `module.json`, `scripts/`, `lang/`, `README.md` and `LICENSE` as `module.zip`, bump `version`/`download` in `module.json`, then publish a GitHub release `vX.Y.Z` with `module.json`, `module.zip` and `foundry-yt-helper-v<version>.exe` attached; keep `HELPER_REQUIRED` in `scripts/module.mjs` in sync with the helper version.

Respect YouTube's terms of service and copyright; use this for content you may legally use.
