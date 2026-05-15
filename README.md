# Spotify Rolling Lyrics Chrome Extension

A Manifest V3 Chrome extension that shows rolling lyrics for the currently playing Spotify Web track, including as a floating window while browsing other websites.

## Features

- Reads the current Spotify Web track title, artist, progress, and duration from an open `open.spotify.com` tab.
- Fetches synced lyrics from LRCLIB (`https://lrclib.net`).
- Highlights and scrolls LRC timestamped lyrics.
- Falls back to plain lyrics when synced lyrics are unavailable.
- Shows a draggable floating lyrics panel on normal web pages.
- Provides a collapsible lyrics panel and `-` / `+` timing offset controls.
- Collapsed mode becomes a small right-edge music button.
- The gear button opens settings for font size, active lyric color, background opacity, and pitch shift.
- Previous, Play/Pause, and Next buttons can control playback in the Spotify Web tab.
- Adds a seekable playback progress bar with elapsed and total time directly below the transport controls.
- Adds a track-list browser button to open the current page's loaded Spotify tracks and jump to a selected song.
- Mirrors the shared Spotify playback state into floating panels on other tabs, including progress, pitch status, and the current page's loaded track list.

## Pitch Shift

The extension now uses a Chrome-extension-managed audio path for Spotify pitch shifting:

`Spotify tab audio -> chrome.tabCapture -> offscreen document -> SoundTouch AudioWorklet -> speakers`

This is more reliable than injecting a pitch engine into Spotify's page because it no longer depends on Spotify's internal `<audio>` element or Web Audio graph.

On first use, if the panel says high quality pitch needs authorization, click the extension icon in Chrome's toolbar once while the Spotify tab is active. After that, the current tab's audio can be captured and processed by the extension.

Chrome still requires that first toolbar click because `chrome.tabCapture` can only start after the user explicitly invokes the extension. The UX around this can be improved, but the gesture itself cannot be removed while staying on the supported `tabCapture` path.

After the Spotify source tab has been authorized, other normal web tabs can use the mirrored floating panel to change pitch and pick tracks from the synced track list. The actual audio processing still runs on the Spotify source tab.

## Install

1. Open `chrome://extensions/` in Chrome.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this project folder after cloning or downloading it locally.
5. Open or refresh `https://open.spotify.com/`, then play a song.
6. Browse another `http://` or `https://` page. The floating lyrics window should appear there too.

## Required Permissions

The extension injects a content script into `http://*/*` and `https://*/*` pages so it can draw the floating lyrics window while you browse. The Spotify tab is the only page used as the playback source.

## Notes

Lyrics come from the public LRCLIB API. Some songs may not have synced lyrics. If Spotify changes its page DOM, the selectors in `src/content.js` may need an update.

See `CHANGELOG.md` for version history.
