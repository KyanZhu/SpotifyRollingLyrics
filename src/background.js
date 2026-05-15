const API_BASE = "https://lrclib.net/api/get";
const OFFSCREEN_URL = "src/offscreen.html";
const cache = new Map();
const pitchSessions = new Map();
let activePitchTabId = null;
let latestPlayback = {
  track: null,
  lyrics: [],
  plainLyrics: "",
  status: "Open Spotify Web and play a song",
  sourceTabId: null,
  playlistEntries: [],
  playlistContextTitle: "Current page tracks",
  playlistContextSubtitle: "Open a playlist, album, or queue to browse loaded tracks",
  progressMs: 0,
  durationMs: 0,
  isPlaying: false,
  observedAt: 0,
  sourceUrl: ""
};

const cacheKeyFor = (track) =>
  [track.normalizedTitle, track.primaryArtist, track.album || "", track.durationMs || ""]
    .map((value) => String(value).toLowerCase())
    .join("|");

const getPitchSession = (tabId) => ({
  active: false,
  semitones: 0,
  needsGesture: false,
  message: "High-quality pitch standby",
  mode: "off",
  ...(pitchSessions.get(tabId) || {})
});

const setPitchSession = async (tabId, patch) => {
  const next = { ...getPitchSession(tabId), ...patch };
  pitchSessions.set(tabId, next);
  await chrome.tabs.sendMessage(tabId, {
    type: "spotify-rolling-lyrics:pitchStateUpdated",
    pitchState: next
  }).catch(() => {});
  return next;
};

const clearPitchSession = async (tabId, message = "High-quality pitch standby") => {
  const session = await setPitchSession(tabId, {
    active: false,
    semitones: 0,
    needsGesture: false,
    mode: "off",
    message
  });
  if (activePitchTabId === tabId) activePitchTabId = null;
  return session;
};

const isSpotifyTab = (tab) => typeof tab?.url === "string" && tab.url.startsWith("https://open.spotify.com/");

const getSpotifyTabs = async () => chrome.tabs.query({ url: "https://open.spotify.com/*" });

const buildSpotifyAssistContext = async (preferredTabId) => {
  const spotifyTabs = await getSpotifyTabs();
  if (!spotifyTabs.length) {
    return {
      state: "missing",
      message: "Spotify Web is not open. Open Spotify Web, then start playback or refresh the Spotify page to sync this panel.",
      actions: [
        { type: "openSpotify", label: "Open Spotify" }
      ]
    };
  }

  const targetTabId = await resolveSpotifyTargetTabId(preferredTabId);
  const targetTab = targetTabId ? await chrome.tabs.get(targetTabId).catch(() => null) : null;
  const isObservedRecently = Boolean(latestPlayback.sourceTabId) && Date.now() - latestPlayback.observedAt < 15000;

  if (targetTab?.status !== "complete") {
    return {
      state: "loading",
      message: "Spotify Web is still loading. Wait a moment, or switch to the Spotify page and refresh it if playback does not sync.",
      actions: [
        { type: "focusSpotify", label: "Open Spotify" },
        { type: "refreshSpotify", label: "Refresh Spotify" }
      ]
    };
  }

  if (!isObservedRecently) {
    return {
      state: "needs_refresh",
      message: "Spotify Web is open but not synced yet. Switch to the Spotify page and refresh it before using controls here.",
      actions: [
        { type: "focusSpotify", label: "Open Spotify" },
        { type: "refreshSpotify", label: "Refresh Spotify" }
      ]
    };
  }

  if (!latestPlayback.track) {
    return {
      state: "ready_no_track",
      message: "Spotify Web is ready. Start playback on the Spotify page to sync lyrics and controls.",
      actions: [
        { type: "focusSpotify", label: "Open Spotify" }
      ]
    };
  }

  return {
    state: "ready",
    message: "",
    actions: []
  };
};

const resolveSpotifyTargetTabId = async (preferredTabId) => {
  if (preferredTabId) {
    const preferredTab = await chrome.tabs.get(preferredTabId).catch(() => null);
    if (isSpotifyTab(preferredTab)) return preferredTabId;
  }

  if (latestPlayback.sourceTabId) {
    const sourceTab = await chrome.tabs.get(latestPlayback.sourceTabId).catch(() => null);
    if (isSpotifyTab(sourceTab)) return latestPlayback.sourceTabId;
  }

  if (activePitchTabId) {
    const activePitchTab = await chrome.tabs.get(activePitchTabId).catch(() => null);
    if (isSpotifyTab(activePitchTab)) return activePitchTabId;
  }

  const spotifyTabs = await getSpotifyTabs();
  return spotifyTabs[0]?.id || null;
};

const ensureOffscreenDocument = async () => {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });

  if (existingContexts.length) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Capture Spotify tab audio and process pitch in an offscreen AudioContext."
  });
};

const sendOffscreenMessage = async (message) => {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ target: "offscreen", ...message });
};

const setOffscreenPitch = async (tabId, semitones) => {
  await sendOffscreenMessage({
    type: "spotify-rolling-lyrics:offscreenSetPitch",
    tabId,
    semitones
  });
};

const stopOffscreenPitch = async (tabId) => {
  await sendOffscreenMessage({
    type: "spotify-rolling-lyrics:offscreenStop",
    tabId
  });
};

const capturePitchForTab = async (tab, semitones) => {
  if (!tab?.id || !isSpotifyTab(tab)) {
    throw new Error("Open Spotify Web in the current tab before enabling high quality pitch.");
  }

  if (activePitchTabId && activePitchTabId !== tab.id) {
    await stopOffscreenPitch(activePitchTabId).catch(() => {});
    await clearPitchSession(activePitchTabId, "High-quality pitch moved to a different Spotify tab");
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await sendOffscreenMessage({
    type: "spotify-rolling-lyrics:offscreenStart",
    tabId: tab.id,
    streamId,
    semitones,
    workletUrl: chrome.runtime.getURL("src/soundtouch-processor.js")
  });

  activePitchTabId = tab.id;
  return setPitchSession(tab.id, {
    active: true,
    semitones,
    needsGesture: false,
    mode: "tabCapture",
    message: semitones === 0 ? "High-quality pitch connected" : `High-quality pitch connected: ${semitones > 0 ? "+" : ""}${semitones} st`
  });
};

const ensurePitchReady = async (tabId, semitones, options = {}) => {
  const session = getPitchSession(tabId);
  const tab = await chrome.tabs.get(tabId);

  if (!isSpotifyTab(tab)) {
    return clearPitchSession(tabId, "The target tab is not Spotify Web");
  }

  if (semitones === 0) {
    if (session.active && activePitchTabId === tabId) {
      await stopOffscreenPitch(tabId).catch(() => {});
    }
    return clearPitchSession(tabId, "High-quality pitch standby");
  }

  if (session.active && activePitchTabId === tabId) {
    await setOffscreenPitch(tabId, semitones);
    return setPitchSession(tabId, {
      active: true,
      semitones,
      needsGesture: false,
      mode: "tabCapture",
      message: semitones === 0 ? "High-quality pitch connected" : `High-quality pitch connected: ${semitones > 0 ? "+" : ""}${semitones} st`
    });
  }

  try {
    return await capturePitchForTab(tab, semitones);
  } catch (error) {
    const needsGesture = !options.fromAction;
    return setPitchSession(tabId, {
      active: false,
      semitones,
      needsGesture,
      mode: "tabCapture",
      message: needsGesture
        ? "Switch to the Spotify Web tab, then click the extension toolbar icon once to authorize audio capture and enable high-quality pitch."
        : (error && error.message) || "Unable to start high-quality pitch"
    });
  }
};

const fetchLyrics = async (track) => {
  const cacheKey = cacheKeyFor(track);
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const params = new URLSearchParams({
    track_name: track.normalizedTitle,
    artist_name: track.primaryArtist
  });

  if (track.album) params.set("album_name", track.album);
  if (track.durationMs) params.set("duration", String(Math.round(track.durationMs / 1000)));

  const response = await fetch(`${API_BASE}?${params.toString()}`, {
    headers: { Accept: "application/json" }
  });

  if (response.status === 404) {
    cache.set(cacheKey, null);
    return null;
  }

  if (!response.ok) {
    throw new Error(`LRCLIB responded with ${response.status}`);
  }

  const data = await response.json();
  cache.set(cacheKey, data);
  return data;
};

const broadcastPlayback = async () => {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, {
      type: "spotify-rolling-lyrics:stateUpdated",
      playback: latestPlayback
    }).catch(() => {});
  }
};

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  const targetTabId = await resolveSpotifyTargetTabId(tab.id);
  if (!targetTabId) return;

  const session = getPitchSession(targetTabId);
  if (session.semitones === 0) {
    await clearPitchSession(targetTabId, "Set Pitch to a non-zero value first. Then switch to the Spotify Web tab and click the extension icon to authorize high-quality pitch.");
    return;
  }
  await ensurePitchReady(targetTabId, session.semitones, { fromAction: true });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activePitchTabId !== tabId) return;
  activePitchTabId = null;
  pitchSessions.delete(tabId);
  stopOffscreenPitch(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (activePitchTabId !== tabId) return;
  if (typeof changeInfo.url === "string" && !changeInfo.url.startsWith("https://open.spotify.com/")) {
    stopOffscreenPitch(tabId).catch(() => {});
    clearPitchSession(tabId, "Left Spotify Web. High-quality pitch stopped.").catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false;

  if (message?.type === "spotify-rolling-lyrics:getLyrics") {
    fetchLyrics(message.track)
      .then((lyrics) => sendResponse({ ok: true, lyrics }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message?.type === "spotify-rolling-lyrics:playbackUpdated") {
    latestPlayback = {
      ...latestPlayback,
      ...message.playback,
      sourceTabId: sender.tab?.id || latestPlayback.sourceTabId,
      sourceUrl: sender.tab?.url || latestPlayback.sourceUrl,
      observedAt: Date.now()
    };
    broadcastPlayback();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "spotify-rolling-lyrics:getState") {
    sendResponse({ ok: true, playback: latestPlayback });
    return false;
  }

  if (message?.type === "spotify-rolling-lyrics:getSpotifyContext") {
    buildSpotifyAssistContext(sender.tab?.id)
      .then((spotifyContext) => sendResponse({ ok: true, spotifyContext }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "spotify-rolling-lyrics:getPitchState") {
    resolveSpotifyTargetTabId(sender.tab?.id)
      .then((tabId) => sendResponse({ ok: true, pitchState: tabId ? getPitchSession(tabId) : getPitchSession(-1) }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "spotify-rolling-lyrics:offscreenState") {
    const tabId = Number(message.tabId);
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false });
      return false;
    }

    setPitchSession(tabId, {
      active: Boolean(message.active),
      semitones: Number.isFinite(message.semitones) ? message.semitones : getPitchSession(tabId).semitones,
      needsGesture: false,
      mode: message.mode || "tabCapture",
      message: message.message || getPitchSession(tabId).message
    }).then(() => sendResponse({ ok: true }));

    return true;
  }

  if (message?.type === "spotify-rolling-lyrics:spotifyControl") {
    const preferredTabId = sender.tab?.id;

    if (message.action === "setPitch") {
      const semitones = Math.min(6, Math.max(-6, Number(message.value) || 0));

      resolveSpotifyTargetTabId(preferredTabId)
        .then((targetTabId) => {
          if (!targetTabId) throw new Error("No open Spotify Web tab found");
          return ensurePitchReady(targetTabId, semitones, { fromAction: false });
        })
        .then((pitchState) => sendResponse({ ok: true, pitchState }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));

      return true;
    }

    resolveSpotifyTargetTabId(preferredTabId)
      .then((targetTabId) => {
        if (!targetTabId) {
          sendResponse({ ok: false, error: "No open Spotify Web tab found" });
          return;
        }

        chrome.tabs.sendMessage(targetTabId, {
          type: "spotify-rolling-lyrics:spotifyControl",
          action: message.action,
          value: message.value,
          seconds: message.seconds,
          ms: message.ms,
          entry: message.entry
        }).catch(() => {});
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message?.type === "spotify-rolling-lyrics:spotifyAssist") {
    resolveSpotifyTargetTabId(sender.tab?.id)
      .then(async (targetTabId) => {
        if (message.action === "openSpotify") {
          const existingTabId = targetTabId;
          if (existingTabId) {
            const existingTab = await chrome.tabs.get(existingTabId).catch(() => null);
            if (existingTab?.windowId) await chrome.windows.update(existingTab.windowId, { focused: true }).catch(() => {});
            await chrome.tabs.update(existingTabId, { active: true }).catch(() => {});
            sendResponse({ ok: true });
            return;
          }
          await chrome.tabs.create({ url: "https://open.spotify.com/" });
          sendResponse({ ok: true });
          return;
        }

        if (!targetTabId) {
          sendResponse({ ok: false, error: "No open Spotify Web tab found" });
          return;
        }

        const targetTab = await chrome.tabs.get(targetTabId).catch(() => null);
        if (targetTab?.windowId) await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
        await chrome.tabs.update(targetTabId, { active: true }).catch(() => {});

        if (message.action === "refreshSpotify") {
          await chrome.tabs.reload(targetTabId).catch(() => {});
        }

        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
