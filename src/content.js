(function () {
  const PANEL_ID = "spotify-rolling-lyrics-panel";
  const TICK_MS = 350;
  const IS_SPOTIFY = location.hostname === "open.spotify.com";
  const ACTIVE_LINE_POSITION_MIN = 75;
  const ACTIVE_LINE_POSITION_MAX = 100;
  const TEMP_STATUS_ACTION_MS = 3000;
  const ACTIVE_LINE_POSITION_SCALE_VERSION = 3;

  const state = {
    trackKey: "",
    track: null,
    lyrics: [],
    lyricMatches: [],
    lyricMatchIndex: 0,
    plainLyrics: "",
    status: "Open Spotify Web and play a song",
    activeIndex: -1,
    progressMs: 0,
    durationMs: 0,
    lastObservedAt: 0,
    isPlaying: false,
    panel: null,
    list: null,
    playlistButton: null,
    playlistPane: null,
    playlistList: null,
    playlistHeadingNode: null,
    playlistSubheadingNode: null,
    progressRange: null,
    progressCurrentNode: null,
    progressTotalNode: null,
    offsetOutputNode: null,
    lyricMatchBarNode: null,
    lyricMatchOutputNode: null,
    title: null,
    subtitle: null,
    statusNode: null,
    statusActionsNode: null,
    toggleButton: null,
    closeButton: null,
    dragHandle: null,
    collapsed: true,
    hidden: false,
    settingsOpen: false,
    opacity: 0.88,
    backgroundColor: "#0e1012",
    fontSize: 16,
    activeLineViewportPercent: 75,
    activeColor: "#b81a35",
    pitchSemitones: 0,
    manualOffsetMs: 0,
    dragging: null,
    pitchStateNode: null,
    playlistOpen: false,
    playlistEntries: [],
    playlistContextTitle: "Current page tracks",
    playlistContextSubtitle: "Open a playlist, album, or queue to browse loaded tracks",
    pitchEngineActive: false,
    pitchEngineNeedsGesture: false,
    pitchEngineMode: "off",
    pitchEngineMessage: "High-quality pitch standby",
    progressSeeking: false,
    progressPreviewMs: null,
    playbackReady: false,
    lyricsRequestId: 0,
    transportRetry: null,
    suppressToggleClick: false,
    statusActionsTimeoutId: null,
    statusActionsLockedUntil: 0
  };

  const cleanText = (value) =>
    (value || "")
      .replace(/\s+/g, " ")
      .replace(/\s+-\s+Spotify$/, "")
      .trim();

  const timeToMs = (value) => {
    if (!value || !value.includes(":")) return 0;
    const parts = value.split(":").map((part) => Number(part));
    if (parts.some((part) => Number.isNaN(part))) return 0;
    if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  };

  const colorToRgbTriplet = (color, fallback = "14 16 18") => {
    const normalized = /^#[0-9a-f]{6}$/i.test(color || "") ? color.slice(1) : "";
    if (!normalized) return fallback;
    return [
      parseInt(normalized.slice(0, 2), 16),
      parseInt(normalized.slice(2, 4), 16),
      parseInt(normalized.slice(4, 6), 16)
    ].join(" ");
  };

  const normalizeTitle = (title) =>
    cleanText(title)
      .replace(/\s*\([^)]*(remaster|remastered|deluxe|explicit|feat\.?|with)[^)]*\)\s*/gi, " ")
      .replace(/\s*\[[^\]]*(remaster|remastered|deluxe|explicit|feat\.?|with)[^\]]*\]\s*/gi, " ")
      .replace(/\s+-\s+(remaster(ed)?|live|mono|stereo).*$/i, "")
      .replace(/\s+/g, " ")
      .trim();

  const formatClock = (ms) => {
    const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  };

  const clampActiveLinePositionPercent = (percent) =>
    Math.min(ACTIVE_LINE_POSITION_MAX, Math.max(ACTIVE_LINE_POSITION_MIN, Number(percent) || ACTIVE_LINE_POSITION_MIN));

  const denormalizeActiveLinePosition = (normalized) =>
    ACTIVE_LINE_POSITION_MIN
    + (Math.min(100, Math.max(0, Number(normalized) || 0))
      * (ACTIVE_LINE_POSITION_MAX - ACTIVE_LINE_POSITION_MIN) / 100);

  const migrateLegacyActiveLinePositionNormalized = (legacyNormalized) =>
    Math.round(Math.min(100, Math.max(0, ((Number(legacyNormalized) || 0) - 50) * 2)));

  const parseLrc = (lrc) => {
    if (!lrc) return [];
    const lines = [];
    const timestampPattern = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

    for (const rawLine of lrc.split(/\r?\n/)) {
      const matches = [...rawLine.matchAll(timestampPattern)];
      if (!matches.length) continue;

      const text = rawLine.replace(timestampPattern, "").trim();
      if (!text) continue;

      for (const match of matches) {
        const minutes = Number(match[1]);
        const seconds = Number(match[2]);
        const fraction = match[3] || "0";
        const ms = Number(fraction.padEnd(3, "0").slice(0, 3));
        lines.push({
          time: minutes * 60 * 1000 + seconds * 1000 + ms,
          text
        });
      }
    }

    return lines.sort((a, b) => a.time - b.time);
  };

  const normalizePlaylistContextTitle = (title) => {
    const value = cleanText(title);
    if (!value) return "Current page tracks";

    const localizedAliases = {
      "主页": "Home",
      "首页": "Home",
      "搜索": "Search",
      "队列": "Queue",
      "音乐库": "Your Library",
      "你的音乐库": "Your Library"
    };

    return localizedAliases[value] || value;
  };

  const resolveTracklistContainer = (row) =>
    row?.closest('[data-testid="playlist-tracklist"], [data-testid="entity-tracklist"], [role="grid"], [aria-rowcount]') || null;

  const resolveTracklistSection = (row) => row?.closest("section") || null;

  const buildTrackKey = (track) =>
    [track.normalizedTitle?.toLowerCase(), track.primaryArtist?.toLowerCase(), track.durationMs || ""].join("|");

  const linesForDisplay = () =>
    state.lyrics.length
      ? state.lyrics
      : state.plainLyrics.split(/\r?\n/).filter(Boolean).map((text, index) => ({ time: index * 4000, text }));

  const hasLyricCandidateContent = (candidate) =>
    Boolean(candidate?.syncedLyrics || candidate?.plainLyrics);

  const lyricCandidatesForDisplay = () =>
    (Array.isArray(state.lyricMatches) ? state.lyricMatches : []).filter(hasLyricCandidateContent);

  const hasLyricsContent = (lyrics = state.lyrics, plainLyrics = state.plainLyrics) =>
    Boolean((lyrics && lyrics.length) || (plainLyrics && plainLyrics.split(/\r?\n/).some(Boolean)));

  const sendMessage = (message) =>
    chrome.runtime.sendMessage(message).catch(() => ({ ok: false, error: "Extension background is unavailable" }));

  const clampPanelTop = (panel, top) => {
    if (!panel) return 8;
    const panelHeight = panel.offsetHeight || 44;
    return Math.min(Math.max(8, top), Math.max(8, window.innerHeight - panelHeight - 8));
  };

  const stickPanelToRight = (panel) => {
    if (!panel) return;
    panel.style.left = "auto";
    panel.style.bottom = "auto";
    panel.style.right = panel.classList.contains("is-collapsed") ? "0" : "18px";
  };

  const setPanelTop = (panel, top) => {
    if (!panel) return;
    panel.style.top = `${clampPanelTop(panel, top)}px`;
    stickPanelToRight(panel);
  };

  const ensurePanelTop = (panel) => {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const hasExplicitTop = Boolean(panel.style.top);
    const fallbackTop = state.collapsed
      ? (window.innerHeight - rect.height) / 2
      : window.innerHeight - rect.height - 104;
    const nextTop = hasExplicitTop && Number.isFinite(rect.top) ? rect.top : fallbackTop;
    setPanelTop(panel, nextTop);
  };

  const isPlaybackReady = () => Boolean(state.playbackReady);

  const renderControlAvailability = () => {
    if (!state.panel) return;

    state.panel.querySelectorAll("[data-spotify-control]").forEach((button) => {
      button.disabled = !isPlaybackReady();
    });

    if (state.progressRange) {
      state.progressRange.disabled = !isPlaybackReady() || (Number(state.durationMs) || 0) <= 0;
    }

    if (state.playlistButton) {
      state.playlistButton.disabled = !isPlaybackReady();
    }

    state.panel.querySelector(".srl-playlist-refresh")?.toggleAttribute("disabled", !isPlaybackReady());
    state.panel.querySelector(".srl-settings-button")?.toggleAttribute("disabled", false);
  };

  const createPanel = () => {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.className = IS_SPOTIFY ? "is-source-tab" : "is-floating-tab";
    panel.style.setProperty("--srl-icon-url", `url("${chrome.runtime.getURL("icons/icon-32.png")}")`);
    panel.innerHTML = `
      <div class="srl-header">
        <button class="srl-toggle" type="button" title="Collapse lyrics" aria-label="Collapse lyrics">Lyrics</button>
        <div class="srl-meta srl-drag-handle" title="Drag lyrics window">
          <div class="srl-title">Spotify Lyrics</div>
          <div class="srl-subtitle">Waiting for playback</div>
        </div>
        <div class="srl-actions">
          <button class="srl-playlist-button" type="button" title="Track list" aria-label="Track list">&#9776;</button>
          <button class="srl-settings-button" type="button" title="Settings" aria-label="Settings">&#9881;</button>
          <button class="srl-close" type="button" title="Hide lyrics on this page" aria-label="Hide lyrics">x</button>
        </div>
      </div>
      <div class="srl-player-controls" aria-label="Spotify controls">
        <button type="button" data-spotify-control="seek" data-seconds="-5" title="Back 5 seconds" aria-label="Back 5 seconds">
          <span aria-hidden="true">-5s</span>
        </button>
        <button type="button" data-spotify-control="previous" title="Previous track" aria-label="Previous track">
          <span class="srl-skip-icon srl-skip-prev" aria-hidden="true"></span>
        </button>
        <button class="srl-play-toggle" type="button" data-spotify-control="playpause" title="Pause" aria-label="Pause">
          <span class="srl-play-icon" aria-hidden="true"></span>
        </button>
        <button type="button" data-spotify-control="next" title="Next track" aria-label="Next track">
          <span class="srl-skip-icon srl-skip-next" aria-hidden="true"></span>
        </button>
        <button type="button" data-spotify-control="seek" data-seconds="5" title="Forward 5 seconds" aria-label="Forward 5 seconds">
          <span aria-hidden="true">+5s</span>
        </button>
      </div>
      <div class="srl-progress">
        <input class="srl-progress-range" type="range" min="0" max="1000" value="0" aria-label="Playback progress">
        <div class="srl-progress-times">
          <span class="srl-progress-current">0:00</span>
          <span class="srl-progress-total">0:00</span>
        </div>
      </div>
      <div class="srl-status" role="status">Open Spotify Web and play a song</div>
      <div class="srl-status-actions is-hidden" aria-label="Spotify recovery actions"></div>
      <div class="srl-lyrics-toolbar" aria-label="Lyrics timing controls">
        <span class="srl-lyrics-toolbar-label">Sync</span>
        <button type="button" data-offset="-500" title="Lyrics earlier">-0.5s</button>
        <output class="srl-offset-output">0.0s</output>
        <button type="button" data-offset="500" title="Lyrics later">+0.5s</button>
        <div class="srl-lyric-match-bar is-hidden" aria-label="Lyrics result selection">
          <button type="button" data-lyric-match-nav="-1" title="Previous lyrics result" aria-label="Previous lyrics result">&lt;</button>
          <output class="srl-lyric-match-output">1/1</output>
          <button type="button" data-lyric-match-nav="1" title="Next lyrics result" aria-label="Next lyrics result">&gt;</button>
        </div>
      </div>
      <div class="srl-playlist-pane is-hidden" aria-label="Track list browser">
        <div class="srl-playlist-toolbar">
          <div class="srl-playlist-meta">
            <div class="srl-playlist-heading">Current page tracks</div>
            <div class="srl-playlist-subheading">Open a playlist, album, or queue to browse loaded tracks</div>
          </div>
          <button class="srl-playlist-refresh" type="button" title="Refresh track list" aria-label="Refresh track list">Sync</button>
        </div>
        <div class="srl-playlist-list"></div>
      </div>
      <div class="srl-settings is-hidden" aria-label="Lyrics settings">
        <label class="srl-setting-row">
          <span>Font size</span>
          <input data-setting="fontSize" type="range" min="13" max="26" value="16" aria-label="Font size">
          <output>16px</output>
        </label>
        <label class="srl-setting-row">
          <span>Lyric focus</span>
          <input data-setting="activeLinePosition" type="range" min="0" max="100" value="0" aria-label="Lyric focus position">
          <output>0%</output>
        </label>
        <label class="srl-setting-row">
          <span>Pitch</span>
          <input data-setting="pitch" type="range" min="-6" max="6" step="1" value="0" aria-label="Pitch shift">
          <output>0 st</output>
        </label>
        <label class="srl-setting-row">
          <span>Opacity</span>
          <input data-setting="opacity" type="range" min="15" max="96" value="88" aria-label="Background opacity">
          <output>88%</output>
        </label>
        <div class="srl-setting-row srl-setting-row-colors">
          <span>Colors</span>
          <div class="srl-color-controls">
            <label class="srl-color-control">
              <span>Background</span>
              <input data-setting="backgroundColor" type="color" value="#0e1012" aria-label="Background color">
            </label>
            <label class="srl-color-control">
              <span>Highlight</span>
              <input data-setting="activeColor" type="color" value="#b81a35" aria-label="Highlight color">
            </label>
          </div>
        </div>
        <div class="srl-pitch-state">High-quality pitch standby</div>
        <a
          class="srl-support-link"
          href="https://github.com/KyanZhu/SpotifyRollingLyrics#support"
          target="_blank"
          rel="noreferrer noopener"
        >☕ Buy me a coffee</a>
      </div>
      <div class="srl-list" aria-live="polite"></div>
    `;

    document.documentElement.appendChild(panel);
    state.panel = panel;
    state.list = panel.querySelector(".srl-list");
    state.playlistButton = panel.querySelector(".srl-playlist-button");
    state.playlistPane = panel.querySelector(".srl-playlist-pane");
    state.playlistList = panel.querySelector(".srl-playlist-list");
    state.playlistHeadingNode = panel.querySelector(".srl-playlist-heading");
    state.playlistSubheadingNode = panel.querySelector(".srl-playlist-subheading");
    state.progressRange = panel.querySelector(".srl-progress-range");
    state.progressCurrentNode = panel.querySelector(".srl-progress-current");
    state.progressTotalNode = panel.querySelector(".srl-progress-total");
    state.offsetOutputNode = panel.querySelector(".srl-offset-output");
    state.lyricMatchBarNode = panel.querySelector(".srl-lyric-match-bar");
    state.lyricMatchOutputNode = panel.querySelector(".srl-lyric-match-output");
    state.title = panel.querySelector(".srl-title");
    state.subtitle = panel.querySelector(".srl-subtitle");
    state.statusNode = panel.querySelector(".srl-status");
    state.statusActionsNode = panel.querySelector(".srl-status-actions");
    state.toggleButton = panel.querySelector(".srl-toggle");
    state.closeButton = panel.querySelector(".srl-close");
    state.dragHandle = panel.querySelector(".srl-drag-handle");
    state.pitchStateNode = panel.querySelector(".srl-pitch-state");
    const settingsButton = panel.querySelector(".srl-settings-button");
    const settingsPane = panel.querySelector(".srl-settings");

    panel.classList.toggle("is-collapsed", state.collapsed);
    state.toggleButton.title = state.collapsed ? "Expand lyrics" : "Collapse lyrics";
    state.toggleButton.setAttribute("aria-label", state.toggleButton.title);

    state.toggleButton.addEventListener("click", () => {
      if (state.suppressToggleClick) {
        state.suppressToggleClick = false;
        return;
      }
      const panelTop = state.panel.getBoundingClientRect().top;
      state.collapsed = !state.collapsed;
      panel.classList.toggle("is-collapsed", state.collapsed);
      state.toggleButton.title = state.collapsed ? "Expand lyrics" : "Collapse lyrics";
      state.toggleButton.setAttribute("aria-label", state.toggleButton.title);
      window.requestAnimationFrame(() => setPanelTop(panel, panelTop));
    });

    state.closeButton.addEventListener("click", () => {
      state.hidden = true;
      panel.classList.add("is-hidden");
    });

    settingsButton.addEventListener("click", () => {
      state.settingsOpen = !state.settingsOpen;
      if (state.settingsOpen && state.playlistOpen) {
        state.playlistOpen = false;
        panel.classList.remove("is-playlist-open");
        state.playlistPane?.classList.add("is-hidden");
        state.playlistButton?.setAttribute("aria-pressed", "false");
      }
      settingsPane.classList.toggle("is-hidden", !state.settingsOpen);
      panel.classList.toggle("is-settings-open", state.settingsOpen);
      settingsButton.setAttribute("aria-pressed", String(state.settingsOpen));
    });

    state.playlistButton?.addEventListener("click", () => {
      state.playlistOpen = !state.playlistOpen;
      if (state.playlistOpen && state.settingsOpen) {
        state.settingsOpen = false;
        settingsPane.classList.add("is-hidden");
        panel.classList.remove("is-settings-open");
        settingsButton.setAttribute("aria-pressed", "false");
      }
      panel.classList.toggle("is-playlist-open", state.playlistOpen);
      state.playlistPane?.classList.toggle("is-hidden", !state.playlistOpen);
      state.playlistButton?.setAttribute("aria-pressed", String(state.playlistOpen));
      if (state.playlistOpen) refreshPlaylistEntries();
    });

    panel.querySelector(".srl-playlist-refresh")?.addEventListener("click", () => {
      refreshPlaylistEntries();
    });

    state.playlistList?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-playlist-entry]");
      if (!button) return;
      playPlaylistEntry(button.dataset.playlistEntry);
    });

    state.statusActionsNode?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-status-action]");
      if (!button) return;
      sendMessage({
        type: "spotify-rolling-lyrics:spotifyAssist",
        action: button.dataset.statusAction
      }).then(() => {
        if (IS_SPOTIFY && button.dataset.statusAction === "refreshSpotify") return;
        window.setTimeout(() => {
          showSpotifyAssistStatus();
        }, 300);
      });
    });

    panel.querySelectorAll("[data-offset]").forEach((button) => {
      button.addEventListener("click", () => {
        state.manualOffsetMs += Number(button.dataset.offset);
        if (state.offsetOutputNode) state.offsetOutputNode.textContent = `${(state.manualOffsetMs / 1000).toFixed(1)}s`;
        updateActiveLine();
      });
    });

    panel.querySelectorAll("[data-lyric-match-nav]").forEach((button) => {
      button.addEventListener("click", () => {
        const matches = lyricCandidatesForDisplay();
        if (matches.length <= 1) return;
        const nextIndex = (state.lyricMatchIndex + Number(button.dataset.lyricMatchNav) + matches.length) % matches.length;
        if (IS_SPOTIFY) {
          applyLyricMatchSelection(nextIndex, { publish: true, remember: true });
          return;
        }
        sendMessage({
          type: "spotify-rolling-lyrics:spotifyControl",
          action: "selectLyricMatch",
          value: nextIndex
        });
      });
    });

    panel.querySelectorAll("[data-spotify-control]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.dataset.spotifyControl;
        const isTransportAction = action === "playpause" || action === "previous" || action === "next";
        if (!isTransportAction && !isPlaybackReady()) {
          showSpotifyAssistStatus();
          return;
        }

        const previousPlayingState = state.isPlaying;
        if (action === "playpause") {
          state.isPlaying = !state.isPlaying;
          updatePlayButton();
        }

        const response = await sendMessage({
          type: "spotify-rolling-lyrics:spotifyControl",
          action,
          seconds: Number(button.dataset.seconds || 0)
        });
        if (response?.ok) {
          if (!IS_SPOTIFY && action === "playpause" && !previousPlayingState) {
            const started = await ensureRemotePlaybackStarted();
            if (!started) {
              state.isPlaying = false;
              updatePlayButton();
            }
          }
          return;
        }

        if (action === "playpause") {
          state.isPlaying = previousPlayingState;
          updatePlayButton();
        }
        showSpotifyAssistStatus();
      });
    });

    panel.querySelector('[data-setting="fontSize"]').addEventListener("input", (event) => {
      setFontSize(Number(event.target.value), true);
    });

    panel.querySelector('[data-setting="activeColor"]').addEventListener("input", (event) => {
      setActiveColor(event.target.value, true);
    });

    panel.querySelector('[data-setting="backgroundColor"]').addEventListener("input", (event) => {
      setBackgroundColor(event.target.value, true);
    });

    panel.querySelector('[data-setting="opacity"]').addEventListener("input", (event) => {
      setOpacity(Number(event.target.value) / 100, true);
    });

    panel.querySelector('[data-setting="activeLinePosition"]').addEventListener("input", (event) => {
      setActiveLinePositionNormalized(Number(event.target.value), true);
    });

    panel.querySelector('[data-setting="pitch"]').addEventListener("input", (event) => {
      setPitchSemitones(Number(event.target.value), {
        persist: true,
        sync: true
      });
    });

    state.progressRange?.addEventListener("input", (event) => {
      if (!isPlaybackReady() || !state.durationMs) return;
      const ratio = Number(event.target.value) / 1000;
      state.progressSeeking = true;
      state.progressPreviewMs = Math.round(state.durationMs * ratio);
      renderProgress();
    });

    state.progressRange?.addEventListener("change", (event) => {
      if (!isPlaybackReady() || !state.durationMs) return;
      const ratio = Number(event.target.value) / 1000;
      const nextMs = Math.round(state.durationMs * ratio);
      commitSeek(nextMs);
    });

    state.progressRange?.addEventListener("blur", () => {
      if (!state.progressSeeking) return;
      state.progressSeeking = false;
      state.progressPreviewMs = null;
      renderProgress();
    });

    ensurePanelTop(panel);
    wireDragging();
    renderPitchState();
    renderLyricMatchControls();
    renderProgress();
    renderPlaylistEntries();
    renderControlAvailability();
  };

  const renderLyricMatchControls = () => {
    if (!state.lyricMatchBarNode || !state.lyricMatchOutputNode) return;
    const matches = lyricCandidatesForDisplay();
    const visible = matches.length > 1;
    state.lyricMatchBarNode.classList.toggle("is-hidden", !visible);
    if (!visible) {
      state.lyricMatchOutputNode.textContent = "1/1";
      return;
    }
    const safeIndex = Math.min(matches.length - 1, Math.max(0, state.lyricMatchIndex || 0));
    state.lyricMatchOutputNode.textContent = `${safeIndex + 1}/${matches.length}`;
  };

  const renderStatusActions = (actions = [], options = {}) => {
    if (!state.statusActionsNode) return;
    const durationMs = Math.max(0, Number(options.durationMs) || 0);
    const force = Boolean(options.force);
    const now = Date.now();
    if (!actions.length && !force && state.statusActionsLockedUntil > now) return;

    if (state.statusActionsTimeoutId) {
      window.clearTimeout(state.statusActionsTimeoutId);
      state.statusActionsTimeoutId = null;
    }

    state.statusActionsNode.textContent = "";
    state.statusActionsNode.classList.toggle("is-hidden", !actions.length);
    state.statusActionsLockedUntil = durationMs > 0 ? now + durationMs : 0;
    if (!actions.length) return;

    const fragment = document.createDocumentFragment();
    actions.forEach((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "srl-status-action";
      button.dataset.statusAction = action.type;
      button.textContent = action.label;
      fragment.appendChild(button);
    });
    state.statusActionsNode.appendChild(fragment);

    if (durationMs > 0) {
      state.statusActionsTimeoutId = window.setTimeout(() => {
        renderStatusActions([], { force: true });
      }, durationMs);
    }
  };

  const showSpotifyAssistStatus = async () => {
    const response = await sendMessage({ type: "spotify-rolling-lyrics:getSpotifyContext" });
    if (!response?.ok || !response.spotifyContext) {
      renderStatus("Spotify Web is not ready yet. Open or refresh Spotify Web, then try again.");
      renderStatusActions([{ type: "openSpotify", label: "Open Spotify" }]);
      renderControlAvailability();
      return;
    }

    const { message, actions } = response.spotifyContext;
    renderStatus(message || "Spotify Web is ready.");
    renderStatusActions(actions || []);
    renderControlAvailability();
  };

  const ensureRemotePlaybackStarted = async () => {
    await wait(1100);
    const stateResponse = await sendMessage({ type: "spotify-rolling-lyrics:getState" });
    if (stateResponse?.ok) applyPlayback(stateResponse.playback);
    if (stateResponse?.playback?.isPlaying) return true;

    const contextResponse = await sendMessage({ type: "spotify-rolling-lyrics:getSpotifyContext" });
    const spotifyContext = contextResponse?.spotifyContext;
    const preferredAction = spotifyContext?.actions?.some((action) => action.type === "focusSpotify")
      ? "focusSpotify"
      : "openSpotify";

    await sendMessage({
      type: "spotify-rolling-lyrics:spotifyAssist",
      action: preferredAction
    }).catch(() => {});
    await showSpotifyAssistStatus();
    return false;
  };

  const setOpacity = (opacity, shouldPersist = false) => {
    state.opacity = Math.min(0.96, Math.max(0.15, opacity || 0.88));
    state.panel?.style.setProperty("--srl-bg-opacity", String(state.opacity));
    const input = state.panel?.querySelector('[data-setting="opacity"]');
    const output = input?.closest(".srl-setting-row")?.querySelector("output");
    if (input) input.value = String(Math.round(state.opacity * 100));
    if (output) output.textContent = `${Math.round(state.opacity * 100)}%`;
    if (shouldPersist) chrome.storage.local.set({ spotifyRollingLyricsOpacity: state.opacity });
  };

  const setBackgroundColor = (color, shouldPersist = false) => {
    state.backgroundColor = /^#[0-9a-f]{6}$/i.test(color || "") ? color : "#0e1012";
    state.panel?.style.setProperty("--srl-bg-color-rgb", colorToRgbTriplet(state.backgroundColor));
    const input = state.panel?.querySelector('[data-setting="backgroundColor"]');
    if (input) input.value = state.backgroundColor;
    if (shouldPersist) chrome.storage.local.set({ spotifyRollingLyricsBackgroundColor: state.backgroundColor });
  };

  const setActiveLinePositionNormalized = (normalized, shouldPersist = false) => {
    const nextNormalized = Math.min(100, Math.max(0, Number(normalized) || 0));
    state.activeLineViewportPercent = clampActiveLinePositionPercent(denormalizeActiveLinePosition(nextNormalized));
    const input = state.panel?.querySelector('[data-setting="activeLinePosition"]');
    const output = input?.closest(".srl-setting-row")?.querySelector("output");
    if (input) input.value = String(nextNormalized);
    if (output) output.textContent = `${nextNormalized}%`;
    if (shouldPersist) chrome.storage.local.set({ spotifyRollingLyricsActiveLinePosition: nextNormalized });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => updateActiveLine(true));
    });
  };

  const setFontSize = (fontSize, shouldPersist = false) => {
    state.fontSize = Math.min(26, Math.max(13, fontSize || 16));
    state.panel?.style.setProperty("--srl-font-size", `${state.fontSize}px`);
    const input = state.panel?.querySelector('[data-setting="fontSize"]');
    const output = input?.closest(".srl-setting-row")?.querySelector("output");
    if (input) input.value = String(state.fontSize);
    if (output) output.textContent = `${state.fontSize}px`;
    if (shouldPersist) chrome.storage.local.set({ spotifyRollingLyricsFontSize: state.fontSize });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => updateActiveLine(true));
    });
  };

  const setActiveColor = (color, shouldPersist = false) => {
    state.activeColor = /^#[0-9a-f]{6}$/i.test(color || "") ? color : "#b81a35";
    state.panel?.style.setProperty("--srl-active-color", state.activeColor);
    const input = state.panel?.querySelector('[data-setting="activeColor"]');
    if (input) input.value = state.activeColor;
    if (shouldPersist) chrome.storage.local.set({ spotifyRollingLyricsActiveColor: state.activeColor });
  };

  const renderPitchState = () => {
    if (!state.pitchStateNode) return;
    state.pitchStateNode.textContent = state.pitchEngineMessage;
    state.pitchStateNode.classList.toggle("is-active", state.pitchEngineActive);
    state.pitchStateNode.classList.toggle("is-warning", state.pitchEngineNeedsGesture);
  };

  const applyPitchState = (pitchState) => {
    state.pitchEngineActive = Boolean(pitchState?.active);
    state.pitchEngineNeedsGesture = Boolean(pitchState?.needsGesture);
    state.pitchEngineMode = pitchState?.mode || "off";
    state.pitchEngineMessage = pitchState?.message || "High-quality pitch standby";
    renderPitchState();
    if (state.pitchEngineNeedsGesture && !IS_SPOTIFY) {
      renderStatus(state.pitchEngineMessage);
      renderStatusActions([{ type: "focusSpotify", label: "Open Spotify" }], { durationMs: TEMP_STATUS_ACTION_MS });
    }
  };

  const renderProgress = () => {
    if (!state.progressRange) return;
    const duration = Math.max(0, Number(state.durationMs) || 0);
    const progress = state.progressSeeking && Number.isFinite(state.progressPreviewMs)
      ? state.progressPreviewMs
      : estimatedProgress();
    const clampedProgress = duration ? Math.min(duration, Math.max(0, progress)) : Math.max(0, progress);

    state.progressRange.disabled = !isPlaybackReady() || duration <= 0;
    if (!state.progressSeeking) {
      const ratio = duration > 0 ? Math.round((clampedProgress / duration) * 1000) : 0;
      state.progressRange.value = String(Math.max(0, Math.min(1000, ratio)));
    }
    if (state.progressCurrentNode) state.progressCurrentNode.textContent = formatClock(clampedProgress);
    if (state.progressTotalNode) state.progressTotalNode.textContent = formatClock(duration);
  };

  const readPlaylistContextTitle = () =>
    normalizePlaylistContextTitle(
      document.querySelector('main h1')?.textContent ||
      document.querySelector('[data-testid="entityTitle"]')?.textContent ||
      document.querySelector('[data-testid="context-item-info-title"]')?.textContent ||
      "Current page tracks"
    );

  const extractPlaylistEntries = () => {
    const rows = [...document.querySelectorAll('div[data-testid="tracklist-row"]')];
    const primaryContainer = rows[0] ? resolveTracklistContainer(rows[0]) : null;
    const primarySection = rows[0] ? resolveTracklistSection(rows[0]) : null;
    const deduped = new Map();

    rows.forEach((row, rowOffset) => {
      if (primaryContainer && resolveTracklistContainer(row) !== primaryContainer) return;
      if (primarySection && resolveTracklistSection(row) !== primarySection) return;

      const title = cleanText(
        row.querySelector('a[data-testid="internal-track-link"] [data-encore-id="text"]')?.textContent ||
        row.querySelector('a[data-testid="internal-track-link"] div')?.textContent
      );
      const artistNodes = [...row.querySelectorAll('a[href^="/artist/"]')];
      const artist = artistNodes.length
        ? [...new Set(artistNodes.map((node) => cleanText(node.textContent)).filter(Boolean))].join(", ")
        : cleanText(row.querySelector('span[data-encore-id="text"]')?.textContent);
      const duration = cleanText(
        row.querySelector('[data-testid="tracklist-row__duration"]')?.textContent ||
        row.querySelector('div[aria-colindex="5"] div[data-encore-id="text"]')?.textContent
      );
      const href = row.querySelector('a[data-testid="internal-track-link"]')?.getAttribute("href") || "";
      const rowIndex = Number(row.closest('[role="row"]')?.getAttribute("aria-rowindex")) || rowOffset + 1;

      if (!title) return;

      const id = href || `${rowIndex}|${title}|${artist}|${duration}`;
      if (deduped.has(id)) return;

      deduped.set(id, {
        id,
        href,
        rowIndex,
        title,
        artist,
        duration,
        isCurrent: state.track
          ? buildTrackKey({
            normalizedTitle: normalizeTitle(title),
            primaryArtist: artist.split(",")[0]?.trim() || artist,
            durationMs: timeToMs(duration)
          }) === state.trackKey
          : false
      });
    });

    return {
      title: readPlaylistContextTitle(),
      subtitle: deduped.size
        ? `Loaded tracks: ${deduped.size}`
        : "Open a playlist, album, or queue to browse loaded tracks",
      entries: [...deduped.values()].sort((a, b) => a.rowIndex - b.rowIndex)
    };
  };

  const renderPlaylistEntries = () => {
    if (!state.playlistList || !state.playlistHeadingNode || !state.playlistSubheadingNode) return;

    state.playlistHeadingNode.textContent = state.playlistContextTitle;
    state.playlistSubheadingNode.textContent = state.playlistContextSubtitle;
    state.playlistList.textContent = "";

    if (!state.playlistEntries.length) {
      const empty = document.createElement("div");
      empty.className = "srl-playlist-empty";
      empty.textContent = "No selectable tracks are loaded on this page yet. Open a playlist, album, or queue and try again.";
      state.playlistList.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    state.playlistEntries.forEach((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "srl-playlist-entry";
      if (entry.isCurrent) button.classList.add("is-current");
      button.dataset.playlistEntry = entry.id;
      button.innerHTML = `
        <span class="srl-playlist-index">${entry.rowIndex}</span>
        <span class="srl-playlist-track">
          <span class="srl-playlist-track-title">${entry.title}</span>
          <span class="srl-playlist-track-artist">${entry.artist || "Unknown artist"}</span>
        </span>
        <span class="srl-playlist-duration">${entry.duration || ""}</span>
      `;
      fragment.appendChild(button);
    });
    state.playlistList.appendChild(fragment);
  };

  const refreshPlaylistEntries = (options = {}) => {
    if (!IS_SPOTIFY) {
      sendMessage({ type: "spotify-rolling-lyrics:getState" }).then((response) => {
        if (response?.ok) applyPlayback(response.playback);
      });
      return;
    }

    const playlistData = extractPlaylistEntries();
    state.playlistContextTitle = playlistData.title;
    state.playlistContextSubtitle = playlistData.subtitle;
    state.playlistEntries = playlistData.entries;
    renderPlaylistEntries();

    if (options.publish) publishPlayback();
  };

  const playPlaylistEntry = (entryOrId) => {
    const entry = typeof entryOrId === "string"
      ? state.playlistEntries.find((item) => item.id === entryOrId)
      : entryOrId;
    if (!entry) return;

    if (!IS_SPOTIFY) {
      sendMessage({
        type: "spotify-rolling-lyrics:spotifyControl",
        action: "playPlaylistEntry",
        entry
      });
      return;
    }

    const rows = [...document.querySelectorAll('div[data-testid="tracklist-row"]')];
    const row = rows.find((item) => {
      const href = item.querySelector('a[data-testid="internal-track-link"]')?.getAttribute("href") || "";
      if (entry.href && href === entry.href) return true;
      const title = cleanText(
        item.querySelector('a[data-testid="internal-track-link"] [data-encore-id="text"]')?.textContent ||
        item.querySelector('a[data-testid="internal-track-link"] div')?.textContent
      );
      return title === entry.title;
    });

    if (!row) return;

    row.scrollIntoView({ block: "center", behavior: "smooth" });
    const playButton = row.querySelector('button[data-testid="play-button"], button[aria-label*="Play"], button[aria-label*="播放"], button[aria-label*="Pause"], button[aria-label*="暂停"]');
    if (playButton) {
      playButton.click();
    } else {
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
      row.click();
    }

    window.setTimeout(observeSpotify, 300);
  };

  const commitSeek = (nextMs) => {
    const clampedMs = Math.max(0, Math.min(Number(state.durationMs) || 0, Number(nextMs) || 0));
    state.progressSeeking = false;
    state.progressPreviewMs = null;
    state.progressMs = clampedMs;
    state.lastObservedAt = Date.now();
    renderProgress();
    updateActiveLine();
    sendMessage({
      type: "spotify-rolling-lyrics:spotifyControl",
      action: "seekToMs",
      ms: clampedMs
    });
  };

  const syncPitchWithExtension = (semitones) =>
    sendMessage({
      type: "spotify-rolling-lyrics:spotifyControl",
      action: "setPitch",
      value: semitones
    }).then((response) => {
      if (response?.pitchState) applyPitchState(response.pitchState);
      return response;
    });

  const setPitchSemitones = (semitones, options = {}) => {
    const shouldPersist = Boolean(options.persist);
    const shouldSync = Boolean(options.sync);
    state.pitchSemitones = Math.min(6, Math.max(-6, Number.isFinite(semitones) ? semitones : 0));
    const input = state.panel?.querySelector('[data-setting="pitch"]');
    const output = input?.closest(".srl-setting-row")?.querySelector("output");
    if (input) input.value = String(state.pitchSemitones);
    if (output) output.textContent = `${state.pitchSemitones > 0 ? "+" : ""}${state.pitchSemitones} st`;

    if (shouldSync) {
      state.pitchEngineMessage = state.pitchSemitones === 0
        ? "High-quality pitch standby"
        : "Connecting high-quality pitch...";
      state.pitchEngineNeedsGesture = false;
      renderPitchState();
      syncPitchWithExtension(state.pitchSemitones).catch(() => {
        applyPitchState({
          active: false,
          needsGesture: false,
          mode: "tabCapture",
          message: "Unable to connect high-quality pitch. Refresh the extension and try again."
        });
      });
    }

    if (shouldPersist) {
      chrome.storage.local.set({ spotifyRollingLyricsPitchSemitones: state.pitchSemitones });
    }
  };

  const loadSettings = async () => {
    const result = await chrome.storage.local.get({
      spotifyRollingLyricsOpacity: 0.88,
      spotifyRollingLyricsBackgroundColor: "#0e1012",
      spotifyRollingLyricsFontSize: 16,
      spotifyRollingLyricsActiveColor: "#b81a35",
      spotifyRollingLyricsPitchSemitones: 0,
      spotifyRollingLyricsActiveLinePosition: 0,
      spotifyRollingLyricsActiveLinePositionScaleVersion: 0
    });
    const activeLinePositionNormalized = result.spotifyRollingLyricsActiveLinePositionScaleVersion >= 2
      ? result.spotifyRollingLyricsActiveLinePosition
      : migrateLegacyActiveLinePositionNormalized(result.spotifyRollingLyricsActiveLinePosition);
    setOpacity(result.spotifyRollingLyricsOpacity);
    setBackgroundColor(result.spotifyRollingLyricsBackgroundColor);
    setFontSize(result.spotifyRollingLyricsFontSize);
    setActiveColor(result.spotifyRollingLyricsActiveColor);
    setActiveLinePositionNormalized(activeLinePositionNormalized);
    setPitchSemitones(result.spotifyRollingLyricsPitchSemitones, {
      sync: IS_SPOTIFY
    });
    if (result.spotifyRollingLyricsActiveLinePositionScaleVersion < ACTIVE_LINE_POSITION_SCALE_VERSION) {
      chrome.storage.local.set({
        spotifyRollingLyricsActiveLinePosition: activeLinePositionNormalized,
        spotifyRollingLyricsActiveLinePositionScaleVersion: ACTIVE_LINE_POSITION_SCALE_VERSION
      });
    }
  };

  const setTransportRetry = (nextRetry) => {
    if (state.transportRetry?.timeoutId) {
      window.clearTimeout(state.transportRetry.timeoutId);
    }
    state.transportRetry = nextRetry;
  };

  const clearTransportRetry = () => setTransportRetry(null);

  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  const actualSpotifyPlayingState = () => {
    const media = mediaElementForPlayback();
    if (media) return !media.paused;

    const button = document.querySelector('[data-testid="control-button-playpause"]');
    const label = [
      button?.getAttribute("aria-label"),
      button?.getAttribute("title"),
      button?.textContent
    ].map(cleanText).join(" ");

    if (/pause|暂停|暫停/i.test(label)) return true;
    if (/play|播放/i.test(label)) return false;
    return null;
  };

  const clickSpotifyButton = async (action, options = {}) => {
    const testIds = {
      previous: "control-button-skip-back",
      next: "control-button-skip-forward",
      playpause: "control-button-playpause"
    };
    const button = document.querySelector(`[data-testid="${testIds[action]}"]`);
    if (!button) return false;
    button.click();
    if (action === "playpause" && options.updateState !== false) {
      state.isPlaying = !state.isPlaying;
      updatePlayButton();
      window.setTimeout(observeSpotify, 350);
      await wait(300);
      const actualState = actualSpotifyPlayingState();
      if (typeof actualState === "boolean") {
        state.isPlaying = actualState;
        updatePlayButton();
        if (typeof options.expectPlaying === "boolean" && actualState !== options.expectPlaying) {
          return false;
        }
      }
    }
    return true;
  };

  const mediaElementForPlayback = () => document.querySelector("audio, video");

  const attemptSpotifyTransportAction = async (action, options = {}) => {
    if (action === "playpause") {
      const media = mediaElementForPlayback();
      const wantsPlay = options.forcePlay === true || (!state.isPlaying && options.forcePause !== true);
      const wantsPause = options.forcePause === true || (state.isPlaying && options.forcePlay !== true);

      if (media && wantsPlay && typeof media.play === "function") {
        try {
          await media.play();
          state.isPlaying = true;
          updatePlayButton();
          window.setTimeout(observeSpotify, 350);
          return true;
        } catch (_) {
          // Fall through to Spotify's own transport button.
        }
      }

      if (media && wantsPause && typeof media.pause === "function") {
        try {
          media.pause();
          state.isPlaying = false;
          updatePlayButton();
          window.setTimeout(observeSpotify, 350);
          return true;
        } catch (_) {
          // Fall through to Spotify's own transport button.
        }
      }

      return clickSpotifyButton(action, {
        ...options,
        expectPlaying: wantsPlay
      });
    }

    return clickSpotifyButton(action, options);
  };

  const scheduleSpotifyTransportRetry = (action, options = {}) => {
    const nextAttempt = Number(options.attempt || 0) + 1;
    if (nextAttempt > 8) {
      clearTransportRetry();
      return;
    }

    const retry = {
      action,
      attempt: nextAttempt,
      timeoutId: window.setTimeout(async () => {
        const currentRetry = state.transportRetry;
        if (!currentRetry || currentRetry.action !== action || currentRetry.attempt !== nextAttempt) return;
        const applied = await attemptSpotifyTransportAction(action, {
          updateState: action === "playpause",
          forcePlay: action === "playpause" ? !state.isPlaying : undefined,
          forcePause: false
        });
        if (applied) {
          clearTransportRetry();
          return;
        }
        scheduleSpotifyTransportRetry(action, { attempt: nextAttempt });
      }, 500)
    };
    setTransportRetry(retry);
  };

  const seekSpotify = (seconds) => {
    const nextMs = Math.min(Math.max(0, state.progressMs + seconds * 1000), state.durationMs);
    seekSpotifyToMs(nextMs);
  };

  const setSpotifyProgressInputValue = (progressInput, targetMs) => {
    const durationMs = Math.max(0, Number(state.durationMs) || 0);
    if (!progressInput || durationMs <= 0) return false;

    const min = Number(progressInput.min || 0);
    const max = Number(progressInput.max || 100);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return false;

    const clampedMs = Math.max(0, Math.min(durationMs, Number(targetMs) || 0));
    const ratio = durationMs > 0 ? clampedMs / durationMs : 0;
    const nextValue = min + ratio * (max - min);

    progressInput.value = String(nextValue);
    progressInput.dispatchEvent(new Event("input", { bubbles: true }));
    progressInput.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };

  const seekSpotifyToMs = (ms) => {
    const nextMs = Math.max(0, Math.min(Number(state.durationMs) || 0, Number(ms) || 0));
    const progressInput = document.querySelector('[data-testid="playback-progressbar"] input[type="range"]');
    if (setSpotifyProgressInputValue(progressInput, nextMs)) {
      return;
    }

    const media = document.querySelector("audio, video");
    if (media && Number.isFinite(media.duration)) {
      media.currentTime = nextMs / 1000;
      return;
    }
  };

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "spotify-rolling-lyrics:pitchStateUpdated") {
      applyPitchState(message.pitchState);
      return;
    }

    if (message?.type !== "spotify-rolling-lyrics:spotifyControl" || !IS_SPOTIFY) return;
    if (message.action === "previous" || message.action === "next" || message.action === "playpause") {
      attemptSpotifyTransportAction(message.action, { updateState: true }).then((applied) => {
        if (applied) {
          clearTransportRetry();
          return;
        }
        if (message.suppressRetry) {
          clearTransportRetry();
          return;
        }
        scheduleSpotifyTransportRetry(message.action);
      });
    }
    if (message.action === "seek") seekSpotify(Number(message.seconds || 0));
    if (message.action === "seekToMs") seekSpotifyToMs(Number(message.ms || 0));
    if (message.action === "playPlaylistEntry") playPlaylistEntry(message.entry);
    if (message.action === "selectLyricMatch") {
      applyLyricMatchSelection(Number(message.value), { publish: true, remember: true });
    }
    if (message.action === "setPitch") {
      setPitchSemitones(Number(message.value), {
        persist: false,
        sync: false
      });
    }
  });

  const wireDragging = () => {
    const beginVerticalDrag = (event) => {
      if (event.button !== 0) return;
      const rect = state.panel.getBoundingClientRect();
      state.dragging = {
        pointerId: event.pointerId,
        offsetY: event.clientY - rect.top,
        moved: false
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      state.panel.classList.add("is-dragging");
    };

    state.dragHandle.addEventListener("pointerdown", beginVerticalDrag);
    state.toggleButton.addEventListener("pointerdown", (event) => {
      if (!state.collapsed) return;
      beginVerticalDrag(event);
    });

    const handleVerticalMove = (event) => {
      if (!state.dragging || state.dragging.pointerId !== event.pointerId) return;
      const nextTop = event.clientY - state.dragging.offsetY;
      if (Math.abs(nextTop - state.panel.getBoundingClientRect().top) > 2) {
        state.dragging.moved = true;
      }
      setPanelTop(state.panel, nextTop);
    };

    state.dragHandle.addEventListener("pointermove", handleVerticalMove);
    state.toggleButton.addEventListener("pointermove", (event) => {
      if (!state.collapsed) return;
      handleVerticalMove(event);
    });

    const stopDragging = (event) => {
      if (!state.dragging || state.dragging.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      state.suppressToggleClick = Boolean(state.dragging.moved && event.currentTarget === state.toggleButton);
      state.dragging = null;
      state.panel.classList.remove("is-dragging");
    };

    state.dragHandle.addEventListener("pointerup", stopDragging);
    state.dragHandle.addEventListener("pointercancel", stopDragging);
    state.toggleButton.addEventListener("pointerup", stopDragging);
    state.toggleButton.addEventListener("pointercancel", stopDragging);
    window.addEventListener("resize", () => ensurePanelTop(state.panel));
  };

  const renderStatus = (message) => {
    state.status = message;
    if (!state.statusNode) return;
    state.statusNode.textContent = message;
    state.statusNode.classList.toggle("is-hidden", !message);
    renderStatusActions([]);
  };

  const clearStatus = () => {
    state.status = "";
    if (!state.statusNode) return;
    state.statusNode.textContent = "";
    state.statusNode.classList.add("is-hidden");
    renderStatusActions([]);
  };

  const resetManualOffset = () => {
    state.manualOffsetMs = 0;
    if (state.offsetOutputNode) state.offsetOutputNode.textContent = "0.0s";
  };

  const applyLyricMatchSelection = (index, options = {}) => {
    const matches = lyricCandidatesForDisplay();
    if (!matches.length) {
      state.lyricMatchIndex = 0;
      renderLyricMatchControls();
      return false;
    }

    const nextIndex = Math.min(matches.length - 1, Math.max(0, Number(index) || 0));
    const selectedMatch = matches[nextIndex];
    state.lyricMatchIndex = nextIndex;
    state.lyrics = parseLrc(selectedMatch?.syncedLyrics);
    state.plainLyrics = selectedMatch?.plainLyrics || "";
    renderLyricMatchControls();
    renderLyrics({
      emptyStatus: state.track ? "No lyrics found for this selection" : "Waiting for Spotify playback"
    });
    if (options.remember) rememberLyricMatchSelection(state.track, nextIndex);
    if (options.publish) publishPlayback();
    return true;
  };

  const renderLyrics = (options = {}) => {
    if (!state.list) return;
    state.list.textContent = "";

    const lines = linesForDisplay();
    if (!lines.length) {
      renderStatus(options.emptyStatus || (state.track ? "No lyrics found for this track" : "Waiting for Spotify playback"));
      return;
    }

    const fragment = document.createDocumentFragment();
    lines.forEach((line, index) => {
      const item = document.createElement("div");
      item.className = "srl-line";
      item.dataset.index = String(index);
      item.textContent = line.text;
      fragment.appendChild(item);
    });

    state.list.appendChild(fragment);
    clearStatus();
    state.activeIndex = -1;
    if (state.playlistOpen) refreshPlaylistEntries();
    updateActiveLine(true);
  };

  const readSpotifyTrack = () => {
    const candidates = [
      document.querySelector('[data-testid="context-item-info-title"]'),
      document.querySelector('[data-testid="now-playing-widget"] a[href^="/track/"]'),
      document.querySelector('footer a[href^="/track/"]')
    ].filter(Boolean);

    const titleNode = candidates.find((node) => cleanText(node.textContent));
    const title = cleanText(titleNode?.textContent || document.title.split(" - ")[0]);

    const artistLinks = [
      ...document.querySelectorAll('[data-testid="context-item-info-artist"] a'),
      ...document.querySelectorAll('[data-testid="now-playing-widget"] a[href^="/artist/"]'),
      ...document.querySelectorAll('footer a[href^="/artist/"]')
    ];
    const artists = [...new Set(artistLinks.map((node) => cleanText(node.textContent)).filter(Boolean))];

    const albumNode = document.querySelector('[data-testid="cover-art-link"] img');
    const album = cleanText(albumNode?.alt || "");

    const progress = timeToMs(cleanText(document.querySelector('[data-testid="playback-position"]')?.textContent));
    const duration = timeToMs(cleanText(document.querySelector('[data-testid="playback-duration"]')?.textContent));
    const playButton = document.querySelector('[data-testid="control-button-playpause"]');
    const playLabel = [
      playButton?.getAttribute("aria-label"),
      playButton?.getAttribute("title"),
      playButton?.textContent
    ].map(cleanText).join(" ");
    const isPlaying = /pause|暂停|暫停/i.test(playLabel)
      ? true
      : /play|播放/i.test(playLabel)
        ? false
        : state.isPlaying;

    if (!title || !artists.length) return null;

    return {
      title,
      normalizedTitle: normalizeTitle(title),
      artists,
      artist: artists.join(", "),
      primaryArtist: artists[0],
      album,
      progressMs: progress,
      durationMs: duration,
      isPlaying
    };
  };

  const fetchLyrics = async (track) => {
    const response = await sendMessage({
      type: "spotify-rolling-lyrics:getLyrics",
      track
    });

    if (!response?.ok) throw new Error(response?.error || "Lyrics request failed");
    return response.lyrics;
  };

  const rememberLyricMatchSelection = (track, index) => {
    if (!IS_SPOTIFY || !track) return;
    sendMessage({
      type: "spotify-rolling-lyrics:rememberLyricMatch",
      track,
      lyricMatchIndex: index
    }).catch(() => {});
  };

  const publishPlayback = () => {
    if (!IS_SPOTIFY) return;
    sendMessage({
      type: "spotify-rolling-lyrics:playbackUpdated",
      playback: {
        track: state.track,
        lyrics: state.lyrics,
        lyricMatches: state.lyricMatches,
        lyricMatchIndex: state.lyricMatchIndex,
        plainLyrics: state.plainLyrics,
        status: state.status,
        playlistEntries: state.playlistEntries,
        playlistContextTitle: state.playlistContextTitle,
        playlistContextSubtitle: state.playlistContextSubtitle,
        progressMs: state.progressMs,
        durationMs: state.durationMs,
        isPlaying: state.isPlaying,
        observedAt: Date.now()
      }
    });
  };

  const loadTrack = async (track) => {
    const requestId = state.lyricsRequestId + 1;
    const requestTrackKey = buildTrackKey(track);
    state.lyricsRequestId = requestId;
    state.track = track;
    state.trackKey = requestTrackKey;
    state.lyrics = [];
    state.lyricMatches = [];
    state.lyricMatchIndex = 0;
    state.plainLyrics = "";
    resetManualOffset();
    state.title.textContent = track.title;
    state.subtitle.textContent = track.artist;
    state.list.textContent = "";
    renderStatus("Searching lyrics...");
    publishPlayback();

    try {
      const result = await fetchLyrics(track);
      if (state.lyricsRequestId !== requestId || state.trackKey !== requestTrackKey) return;
      if (!result) {
        state.lyricMatches = [];
        state.lyricMatchIndex = 0;
        renderLyricMatchControls();
        renderStatus("No lyrics found for this track");
        publishPlayback();
        return;
      }

      state.lyricMatches = Array.isArray(result.matches) ? result.matches : [];
      const initialMatchIndex = Math.max(0, Number(result.selectedMatchIndex) || 0);
      state.lyricMatchIndex = initialMatchIndex;
      if (!applyLyricMatchSelection(initialMatchIndex)) {
        state.lyrics = parseLrc(result.syncedLyrics);
        state.plainLyrics = result.plainLyrics || "";
        renderLyrics();
      }
      publishPlayback();
    } catch (error) {
      if (state.lyricsRequestId !== requestId || state.trackKey !== requestTrackKey) return;
      state.lyricMatches = [];
      state.lyricMatchIndex = 0;
      renderLyricMatchControls();
      renderStatus(`Lyrics unavailable: ${error.message}`);
      publishPlayback();
    }
  };

  const updatePlaybackState = (track) => {
    const now = Date.now();
    const jumped = Math.abs(track.progressMs - state.progressMs) > 1500;

    state.durationMs = track.durationMs;
    state.isPlaying = track.isPlaying;

    if (jumped || !state.lastObservedAt) {
      state.progressMs = track.progressMs;
      state.lastObservedAt = now;
      renderProgress();
      return;
    }

    if (track.progressMs !== state.progressMs) {
      state.progressMs = track.progressMs;
      state.lastObservedAt = now;
    }
    renderProgress();
  };

  const estimatedProgress = () => {
    if (!state.isPlaying) return state.progressMs;
    const elapsed = Date.now() - state.lastObservedAt;
    const estimate = state.progressMs + elapsed;
    return state.durationMs ? Math.min(estimate, state.durationMs) : estimate;
  };

  const scrollActiveLineIntoView = (current) => {
    if (!current || !state.list || !state.panel || state.settingsOpen) return;
    const listStyle = window.getComputedStyle(state.list);
    const topPadding = Number.parseFloat(listStyle.paddingTop) || 0;
    const focusRatio = clampActiveLinePositionPercent(state.activeLineViewportPercent) / 100;
    const listTopInPanel = state.list.offsetTop;
    const targetPanelY = state.panel.clientHeight * focusRatio;
    const targetListY = Math.max(0, targetPanelY - listTopInPanel);
    const targetOffset = current.offsetTop - topPadding - (targetListY - current.clientHeight / 2);
    state.list.scrollTo({ top: Math.max(0, targetOffset), behavior: "smooth" });
  };

  const updateActiveLine = (forceScroll = false) => {
    renderProgress();
    if (!state.list) return;
    const lines = linesForDisplay();
    if (!lines.length) return;

    const progress = estimatedProgress() + state.manualOffsetMs;
    let activeIndex = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].time <= progress + 120) activeIndex = index;
      else break;
    }

    const current = state.list.querySelector(`[data-index="${activeIndex}"]`);
    if (activeIndex === state.activeIndex) {
      if (forceScroll) scrollActiveLineIntoView(current);
      return;
    }

    state.list.querySelector(".srl-line.is-active")?.classList.remove("is-active");
    current?.classList.add("is-active");
    scrollActiveLineIntoView(current);
    state.activeIndex = activeIndex;
  };

  const applyPlayback = (playback) => {
    createPanel();
    if (state.hidden) return;

    const track = playback?.track;
    if (!track) {
      state.playbackReady = false;
      state.track = null;
      state.trackKey = "";
      state.lyrics = [];
    state.lyricMatches = [];
      state.lyricMatchIndex = 0;
      state.plainLyrics = "";
      state.progressMs = 0;
      state.durationMs = 0;
      state.isPlaying = false;
      state.playlistEntries = [];
      if (state.list) state.list.textContent = "";
      renderLyricMatchControls();
      renderPlaylistEntries();
      renderProgress();
      updatePlayButton();
      renderControlAvailability();
      if (playback?.status) renderStatus(playback.status);
      else clearStatus();
      showSpotifyAssistStatus();
      return;
    }

    const nextTrackKey = buildTrackKey(track);
    const lyricsChanged = nextTrackKey !== state.trackKey;
    const lyricSelectionChanged = state.lyricMatchIndex !== Math.max(0, Number(playback.lyricMatchIndex) || 0);
    if (lyricsChanged) resetManualOffset();
    state.track = track;
    state.trackKey = nextTrackKey;
    state.lyrics = playback.lyrics || [];
    state.plainLyrics = playback.plainLyrics || "";
    state.lyricMatches = Array.isArray(playback.lyricMatches) ? playback.lyricMatches : [];
    state.lyricMatchIndex = Math.max(0, Number(playback.lyricMatchIndex) || 0);
    state.playlistEntries = playback.playlistEntries || [];
    state.playlistContextTitle = playback.playlistContextTitle || "Current page tracks";
    state.playlistContextSubtitle = playback.playlistContextSubtitle || "Open a playlist, album, or queue to browse loaded tracks";
    state.progressMs = playback.progressMs || 0;
    state.durationMs = playback.durationMs || 0;
    state.isPlaying = Boolean(playback.isPlaying);
    state.lastObservedAt = playback.observedAt || Date.now();
    state.playbackReady = true;

    state.title.textContent = track.title;
    state.subtitle.textContent = track.artist;
    renderLyricMatchControls();
    updatePlayButton();
    renderProgress();
    renderPlaylistEntries();
    renderControlAvailability();
    if (playback.status) renderStatus(playback.status);
    else clearStatus();

    if (lyricsChanged || lyricSelectionChanged || !state.list.children.length) {
      if (hasLyricsContent(state.lyrics, state.plainLyrics)) {
        renderLyrics();
      } else {
        state.list.textContent = "";
        renderStatus(playback.status || "Searching lyrics...");
      }
    } else {
      updateActiveLine(true);
    }
  };

  const observeSpotify = async () => {
    createPanel();
    const track = readSpotifyTrack();

    if (!track) {
      state.lyricsRequestId += 1;
      state.playbackReady = false;
      renderControlAvailability();
      renderStatus("Waiting for Spotify playback");
      publishPlayback();
      return;
    }

    state.playbackReady = true;
    updatePlaybackState(track);
    updatePlayButton();
    renderControlAvailability();
    refreshPlaylistEntries();

    const nextTrackKey = buildTrackKey(track);
    if (nextTrackKey && nextTrackKey !== state.trackKey) {
      await loadTrack(track);
    } else {
      publishPlayback();
    }
    if (state.playlistOpen) refreshPlaylistEntries();
    updateActiveLine();
  };

  const updatePlayButton = () => {
    const button = state.panel?.querySelector(".srl-play-toggle");
    if (!button) return;
    button.classList.toggle("is-playing", state.isPlaying);
    button.title = state.isPlaying ? "Pause" : "Play";
    button.setAttribute("aria-label", button.title);
  };

  const startSpotifySource = () => {
    createPanel();
    renderStatus("Waiting for the Spotify player to finish loading...");
    renderStatusActions([{ type: "refreshSpotify", label: "Refresh Spotify" }]);
    observeSpotify();
    sendMessage({ type: "spotify-rolling-lyrics:getPitchState" }).then((response) => {
      if (response?.ok) applyPitchState(response.pitchState);
    });
    setInterval(observeSpotify, 1500);
    setInterval(updateActiveLine, TICK_MS);

    const observer = new MutationObserver(() => {
      window.clearTimeout(observer.queued);
      observer.queued = window.setTimeout(observeSpotify, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  };

  const startFloatingViewer = async () => {
    createPanel();
    showSpotifyAssistStatus();
    const response = await sendMessage({ type: "spotify-rolling-lyrics:getState" });
    if (response?.ok) applyPlayback(response.playback);
    sendMessage({ type: "spotify-rolling-lyrics:getPitchState" }).then((pitchResponse) => {
      if (pitchResponse?.ok) applyPitchState(pitchResponse.pitchState);
    });
    setInterval(updateActiveLine, TICK_MS);

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== "spotify-rolling-lyrics:stateUpdated") return;
      applyPlayback(message.playback);
    });
  };

  const start = () => {
    if (IS_SPOTIFY) startSpotifySource();
    else startFloatingViewer();
    loadSettings();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
