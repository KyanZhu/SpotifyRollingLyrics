const API_GET_BASE = "https://lrclib.net/api/get";
const API_SEARCH_BASE = "https://lrclib.net/api/search";
const OFFSCREEN_URL = "src/offscreen.html";
const cache = new Map();
const pitchSessions = new Map();
const LYRICS_CACHE_INDEX_KEY = "spotifyRollingLyricsCacheIndex";
const LYRICS_CACHE_KEY_PREFIX = "spotifyRollingLyricsCache:";
const LYRICS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LYRICS_CACHE_MAX_ENTRIES = 300;
const TRANSPORT_PRIMED_KEY = "spotifyRollingLyricsTransportPrimed";
let activePitchTabId = null;
let lyricsCacheIndex = null;
let transportPrimed = null;
let latestPlayback = {
  track: null,
  lyrics: [],
  lyricMatches: [],
  lyricMatchIndex: 0,
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

const freshPlaybackState = (overrides = {}) => ({
  track: null,
  lyrics: [],
  lyricMatches: [],
  lyricMatchIndex: 0,
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
  sourceUrl: "",
  ...overrides
});

const cacheKeyFor = (track) =>
  [track.normalizedTitle, track.primaryArtist, track.album || "", track.durationMs || ""]
    .map((value) => String(value).toLowerCase())
    .join("|");

const lyricsStorageKeyFor = (cacheKey) => `${LYRICS_CACHE_KEY_PREFIX}${encodeURIComponent(cacheKey)}`;

const cloneLyricsResult = (result) => (result == null ? result : JSON.parse(JSON.stringify(result)));

const getTransportPrimed = async () => {
  if (typeof transportPrimed === "boolean") return transportPrimed;
  const stored = await chrome.storage.local.get(TRANSPORT_PRIMED_KEY);
  transportPrimed = Boolean(stored?.[TRANSPORT_PRIMED_KEY]);
  return transportPrimed;
};

const setTransportPrimed = async (value) => {
  transportPrimed = Boolean(value);
  await chrome.storage.local.set({
    [TRANSPORT_PRIMED_KEY]: transportPrimed
  });
};

const resetLatestPlayback = (overrides = {}) => {
  latestPlayback = freshPlaybackState(overrides);
  return latestPlayback;
};

const getValidatedPlaybackState = async () => {
  const sourceTabId = latestPlayback.sourceTabId;
  if (!sourceTabId) {
    return freshPlaybackState({
      status: latestPlayback.status || "Open Spotify Web and play a song"
    });
  }

  const sourceTab = await chrome.tabs.get(sourceTabId).catch(() => null);
  if (!isSpotifyTab(sourceTab)) {
    return resetLatestPlayback({
      status: "Open Spotify Web and play a song"
    });
  }

  if (sourceTab.status !== "complete") {
    return freshPlaybackState({
      sourceTabId,
      sourceUrl: sourceTab.url || latestPlayback.sourceUrl,
      status: "Spotify Web is still loading."
    });
  }

  if (!latestPlayback.observedAt || Date.now() - latestPlayback.observedAt > 15000) {
    return freshPlaybackState({
      sourceTabId,
      sourceUrl: sourceTab.url || latestPlayback.sourceUrl,
      status: "Waiting for Spotify playback"
    });
  }

  return latestPlayback;
};

const getLyricsCacheIndex = async () => {
  if (lyricsCacheIndex) return lyricsCacheIndex;
  const stored = await chrome.storage.local.get(LYRICS_CACHE_INDEX_KEY);
  const nextIndex = stored?.[LYRICS_CACHE_INDEX_KEY];
  lyricsCacheIndex = nextIndex && typeof nextIndex === "object" ? nextIndex : {};
  return lyricsCacheIndex;
};

const setLyricsCacheIndex = async (nextIndex) => {
  lyricsCacheIndex = nextIndex;
  await chrome.storage.local.set({
    [LYRICS_CACHE_INDEX_KEY]: nextIndex
  });
};

const removeLyricsCacheEntries = async (cacheKeys) => {
  if (!cacheKeys.length) return;
  const nextIndex = { ...(await getLyricsCacheIndex()) };
  const storageKeys = [];
  cacheKeys.forEach((cacheKey) => {
    delete nextIndex[cacheKey];
    storageKeys.push(lyricsStorageKeyFor(cacheKey));
    cache.delete(cacheKey);
  });
  await chrome.storage.local.remove(storageKeys);
  await setLyricsCacheIndex(nextIndex);
};

const cleanupLyricsCache = async () => {
  const now = Date.now();
  const currentIndex = { ...(await getLyricsCacheIndex()) };
  const entries = Object.entries(currentIndex);
  const expiredKeys = entries
    .filter(([, meta]) => !meta?.savedAt || now - meta.savedAt > LYRICS_CACHE_TTL_MS)
    .map(([cacheKey]) => cacheKey);

  if (expiredKeys.length) {
    await removeLyricsCacheEntries(expiredKeys);
  }

  const refreshedIndex = { ...(await getLyricsCacheIndex()) };
  const rankedEntries = Object.entries(refreshedIndex)
    .sort((left, right) => (right[1]?.lastAccessedAt || right[1]?.savedAt || 0) - (left[1]?.lastAccessedAt || left[1]?.savedAt || 0));

  if (rankedEntries.length <= LYRICS_CACHE_MAX_ENTRIES) return;
  const overflowKeys = rankedEntries
    .slice(LYRICS_CACHE_MAX_ENTRIES)
    .map(([cacheKey]) => cacheKey);
  await removeLyricsCacheEntries(overflowKeys);
};

const getPersistentLyricsCache = async (cacheKey) => {
  const index = await getLyricsCacheIndex();
  const meta = index[cacheKey];
  if (!meta) return null;

  const now = Date.now();
  if (!meta.savedAt || now - meta.savedAt > LYRICS_CACHE_TTL_MS) {
    await removeLyricsCacheEntries([cacheKey]);
    return null;
  }

  const storageKey = lyricsStorageKeyFor(cacheKey);
  const stored = await chrome.storage.local.get(storageKey);
  const entry = stored?.[storageKey];
  if (!entry || !("data" in entry)) {
    await removeLyricsCacheEntries([cacheKey]);
    return null;
  }

  index[cacheKey] = {
    ...meta,
    lastAccessedAt: now
  };
  await setLyricsCacheIndex(index);
  return cloneLyricsResult(entry.data);
};

const setPersistentLyricsCache = async (cacheKey, result) => {
  if (result == null) return;
  const now = Date.now();
  const storageKey = lyricsStorageKeyFor(cacheKey);
  const nextIndex = { ...(await getLyricsCacheIndex()) };
  await chrome.storage.local.set({
    [storageKey]: {
      savedAt: now,
      data: cloneLyricsResult(result)
    }
  });
  nextIndex[cacheKey] = {
    storageKey,
    savedAt: now,
    lastAccessedAt: now
  };
  await setLyricsCacheIndex(nextIndex);
  await cleanupLyricsCache();
};

const cleanText = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const normalizeArtist = (value) =>
  cleanText(value)
    .toLowerCase()
    .replace(/\s*(feat\.?|featuring|with)\s+.+$/i, "")
    .replace(/\s*&\s*/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeText = (value) =>
  cleanText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeTitle = (value) =>
  normalizeText(value)
    .replace(/\b(feat|featuring|with)\b.*$/i, " ")
    .replace(/\b(remaster|remastered|deluxe|explicit|live|mono|stereo|version|edit)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenize = (value) =>
  normalizeText(value)
    .split(" ")
    .filter(Boolean);

const tokenOverlapRatio = (left, right) => {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) overlap += 1;
  });
  return overlap / Math.max(leftTokens.size, rightTokens.size);
};

const durationScore = (trackDurationMs, candidateDurationSeconds) => {
  if (!trackDurationMs || !candidateDurationSeconds) return 0;
  const diffSeconds = Math.abs(Math.round(trackDurationMs / 1000) - Number(candidateDurationSeconds));
  if (diffSeconds <= 1) return 20;
  if (diffSeconds <= 3) return 15;
  if (diffSeconds <= 7) return 10;
  if (diffSeconds <= 15) return 5;
  if (diffSeconds <= 30) return 0;
  return -10;
};

const collectTrackArtists = (track) => {
  const artists = Array.isArray(track?.artists) ? track.artists : [];
  const combined = [
    ...artists,
    track?.artist,
    track?.primaryArtist
  ];
  return [...new Set(combined.map(normalizeArtist).filter(Boolean))];
};

const hasLyricsData = (candidate) =>
  Boolean(candidate?.syncedLyrics || candidate?.plainLyrics);

const scoreLyricsCandidate = (track, candidate) => {
  const trackTitle = normalizeTitle(track?.title || track?.normalizedTitle || "");
  const candidateTitle = normalizeTitle(candidate?.trackName || candidate?.name || "");
  const trackAlbum = normalizeText(track?.album || "");
  const candidateAlbum = normalizeText(candidate?.albumName || "");
  const trackArtists = collectTrackArtists(track);
  const candidateArtist = normalizeArtist(candidate?.artistName || "");
  const primaryArtist = normalizeArtist(track?.primaryArtist || "");

  let score = 0;

  if (trackTitle && candidateTitle) {
    if (trackTitle === candidateTitle) {
      score += 80;
    } else {
      const titleOverlap = tokenOverlapRatio(trackTitle, candidateTitle);
      score += Math.round(titleOverlap * 45);
      if (candidateTitle.includes(trackTitle) || trackTitle.includes(candidateTitle)) {
        score += 12;
      }
    }
  }

  if (candidateArtist && primaryArtist) {
    if (candidateArtist === primaryArtist) {
      score += 40;
    } else {
      const artistOverlap = Math.max(
        tokenOverlapRatio(primaryArtist, candidateArtist),
        ...trackArtists.map((artist) => tokenOverlapRatio(artist, candidateArtist)),
        0
      );
      score += Math.round(artistOverlap * 24);
      if (trackArtists.some((artist) => candidateArtist.includes(artist) || artist.includes(candidateArtist))) {
        score += 8;
      }
    }
  }

  if (trackAlbum && candidateAlbum) {
    if (trackAlbum === candidateAlbum) {
      score += 12;
    } else {
      score += Math.round(tokenOverlapRatio(trackAlbum, candidateAlbum) * 8);
    }
  }

  score += durationScore(track?.durationMs, candidate?.duration);

  if (candidate?.syncedLyrics) score += 10;
  else if (candidate?.plainLyrics) score += 4;
  else score -= 20;

  if (candidate?.instrumental) score -= 8;

  return score;
};

const buildGetParams = (track) => {
  const params = new URLSearchParams({
    track_name: track.normalizedTitle,
    artist_name: track.primaryArtist
  });

  if (track.album) params.set("album_name", track.album);
  if (track.durationMs) params.set("duration", String(Math.round(track.durationMs / 1000)));
  return params;
};

const buildSearchParams = (track) => {
  const params = new URLSearchParams({
    track_name: track.normalizedTitle || track.title || ""
  });

  if (track.primaryArtist) params.set("artist_name", track.primaryArtist);
  if (track.durationMs) params.set("duration", String(Math.round(track.durationMs / 1000)));
  return params;
};

const dedupeCandidates = (candidates) => {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = [
      candidate?.id || "",
      normalizeTitle(candidate?.trackName || candidate?.name || ""),
      normalizeArtist(candidate?.artistName || ""),
      candidate?.duration || ""
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const rankLyricsCandidates = (track, candidates) =>
  dedupeCandidates(candidates)
    .map((candidate) => ({
      ...candidate,
      matchScore: scoreLyricsCandidate(track, candidate)
    }))
    .sort((left, right) => {
      if (right.matchScore !== left.matchScore) return right.matchScore - left.matchScore;
      if (Boolean(right.syncedLyrics) !== Boolean(left.syncedLyrics)) {
        return Number(Boolean(right.syncedLyrics)) - Number(Boolean(left.syncedLyrics));
      }
      const leftDiff = Math.abs((Number(left.duration) || 0) - Math.round((track.durationMs || 0) / 1000));
      const rightDiff = Math.abs((Number(right.duration) || 0) - Math.round((track.durationMs || 0) / 1000));
      return leftDiff - rightDiff;
    });

const fetchSearchCandidates = async (track) => {
  const response = await fetch(`${API_SEARCH_BASE}?${buildSearchParams(track).toString()}`, {
    headers: { Accept: "application/json" }
  });

  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`LRCLIB search responded with ${response.status}`);

  const data = await response.json();
  return Array.isArray(data) ? data : [];
};

const fetchExactLyrics = async (track) => {
  const response = await fetch(`${API_GET_BASE}?${buildGetParams(track).toString()}`, {
    headers: { Accept: "application/json" }
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`LRCLIB responded with ${response.status}`);

  return response.json();
};

const buildLyricsResult = (rankedCandidates) => {
  const bestCandidate = rankedCandidates.find(hasLyricsData) || rankedCandidates[0] || null;
  if (!bestCandidate) return null;

  return {
    ...bestCandidate,
    matches: rankedCandidates.slice(0, 8),
    selectedMatchIndex: 0
  };
};

const persistLyricsMatchSelection = async (track, selectedMatchIndex) => {
  if (!track) return;
  const cacheKey = cacheKeyFor(track);
  const cachedResult = cache.get(cacheKey);
  if (!cachedResult) return;

  const matches = Array.isArray(cachedResult.matches) ? cachedResult.matches : [];
  if (!matches.length) return;

  const nextIndex = Math.min(matches.length - 1, Math.max(0, Number(selectedMatchIndex) || 0));
  if (cachedResult.selectedMatchIndex === nextIndex) return;

  const nextResult = {
    ...cachedResult,
    ...matches[nextIndex],
    matches,
    selectedMatchIndex: nextIndex
  };
  cache.set(cacheKey, nextResult);
  await setPersistentLyricsCache(cacheKey, nextResult);
};

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
  const isTransportReady = await getTransportPrimed();
  if (!spotifyTabs.length) {
    return {
      state: "missing",
      requiresFirstPlay: true,
      message: "First-time setup:\n1. Open Spotify Web.\n2. On open.spotify.com, click Spotify's own Play button once.\n3. After music starts, return here. The panel will unlock automatically.",
      actions: [
        { type: "openSpotify", label: "Open Spotify" }
      ]
    };
  }

  const targetTabId = await resolveSpotifyTargetTabId(preferredTabId);
  const targetTab = targetTabId ? await chrome.tabs.get(targetTabId).catch(() => null) : null;
  const isObservedRecently = Boolean(latestPlayback.sourceTabId) && Date.now() - latestPlayback.observedAt < 15000;

  if (!isTransportReady) {
    return {
      state: targetTab?.status === "complete" ? "needs_activation" : "loading",
      requiresFirstPlay: true,
      message: targetTab?.status === "complete"
        ? "First-time setup:\n1. Open Spotify Web.\n2. On open.spotify.com, click Spotify's own Play button once.\n3. When playback starts, come back here. Controls will unlock automatically."
        : "Spotify Web is opening.\nWhen the page finishes loading, click Spotify's own Play button once on open.spotify.com.\nThen return here.",
      actions: [
        { type: "focusSpotify", label: "Open Spotify" }
      ]
    };
  }

  if (targetTab?.status !== "complete") {
    return {
      state: "loading",
      requiresFirstPlay: false,
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
      requiresFirstPlay: false,
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
      requiresFirstPlay: false,
      message: "Spotify Web is ready. Start playback on the Spotify page to sync lyrics and controls.",
      actions: [
        { type: "focusSpotify", label: "Open Spotify" }
      ]
    };
  }

  return {
    state: "ready",
    requiresFirstPlay: false,
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
  if (cache.has(cacheKey)) return cloneLyricsResult(cache.get(cacheKey));

  const persistentCache = await getPersistentLyricsCache(cacheKey);
  if (persistentCache !== null) {
    cache.set(cacheKey, persistentCache);
    return cloneLyricsResult(persistentCache);
  }

  let rankedCandidates = [];
  let searchError = null;
  try {
    rankedCandidates = rankLyricsCandidates(track, await fetchSearchCandidates(track));
  } catch (error) {
    searchError = error;
  }

  const exactMatch = await fetchExactLyrics(track).catch(() => null);
  if (searchError && !exactMatch) throw searchError;

  if (exactMatch) {
    const exactScore = scoreLyricsCandidate(track, exactMatch);
    const alreadyPresent = rankedCandidates.some((candidate) => candidate.id === exactMatch.id);
    if (!alreadyPresent) {
      rankedCandidates.push({
        ...exactMatch,
        matchScore: exactScore
      });
      rankedCandidates.sort((left, right) => right.matchScore - left.matchScore);
    }
  }

  const result = buildLyricsResult(rankedCandidates);
  cache.set(cacheKey, result);
  await setPersistentLyricsCache(cacheKey, result);
  return cloneLyricsResult(result);
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
  if (latestPlayback.sourceTabId === tabId) {
    resetLatestPlayback({
      status: "Open Spotify Web and play a song"
    });
  }
  if (activePitchTabId !== tabId) return;
  activePitchTabId = null;
  pitchSessions.delete(tabId);
  stopOffscreenPitch(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (latestPlayback.sourceTabId === tabId) {
    if (changeInfo.status === "loading") {
      latestPlayback = freshPlaybackState({
        sourceTabId: tabId,
        sourceUrl: changeInfo.url || latestPlayback.sourceUrl,
        status: "Spotify Web is still loading."
      });
    } else if (typeof changeInfo.url === "string" && !changeInfo.url.startsWith("https://open.spotify.com/")) {
      resetLatestPlayback({
        status: "Open Spotify Web and play a song"
      });
    }
  }

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

  if (message?.type === "spotify-rolling-lyrics:rememberLyricMatch") {
    persistLyricsMatchSelection(message.track, message.lyricMatchIndex)
      .then(() => sendResponse({ ok: true }))
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
    if (isSpotifyTab(sender.tab) && message.playback?.isPlaying) {
      setTransportPrimed(true).catch(() => {});
    }
    broadcastPlayback();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "spotify-rolling-lyrics:getState") {
    getValidatedPlaybackState()
      .then((playback) => sendResponse({ ok: true, playback }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
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

        return chrome.tabs.sendMessage(targetTabId, {
          type: "spotify-rolling-lyrics:spotifyControl",
          action: message.action,
          value: message.value,
          seconds: message.seconds,
          ms: message.ms,
          entry: message.entry,
          suppressRetry: message.action === "playpause"
        })
          .then(() => sendResponse({ ok: true }))
          .catch((error) => sendResponse({
            ok: false,
            error: (error && error.message) || "Spotify Web is still loading. Wait a moment and try again."
          }));
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
