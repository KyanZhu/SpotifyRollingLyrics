(function () {
  if (window.__spotifyRollingLyricsPitchEngine) return;
  window.__spotifyRollingLyricsPitchEngine = true;

  const script = document.currentScript;
  const processorUrl = script?.dataset.workletUrl;
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const settings = { semitones: 0 };
  const mediaRecords = new WeakMap();
  let runtime = null;
  let lastDatasetValue = null;

  const ratioFromSemitones = (st) => Math.pow(2, st / 12);

  const getMediaElements = () => Array.from(document.querySelectorAll("audio, video"));

  const getPrimaryMedia = () => {
    const media = getMediaElements();
    return media.find((item) => !item.paused && !item.ended) || media[0] || null;
  };

  const setPreservesPitch = (media, enabled) => {
    try {
      media.preservesPitch = enabled;
      media.mozPreservesPitch = enabled;
      media.webkitPreservesPitch = enabled;
    } catch (_) {}
  };

  const setPlaybackRate = (media, value) => {
    if (!media || !Number.isFinite(value) || value <= 0) return;
    try {
      media.defaultPlaybackRate = value;
      if (Math.abs(media.playbackRate - value) > 0.001) {
        media.playbackRate = value;
      }
    } catch (_) {}
  };

  const lockPlaybackRate = (media) => {
    if (!media || media.__srlPlaybackRateLocked) return;

    const proto = Object.getPrototypeOf(media);
    const playbackRateDescriptor = Object.getOwnPropertyDescriptor(proto, "playbackRate");
    const defaultPlaybackRateDescriptor = Object.getOwnPropertyDescriptor(proto, "defaultPlaybackRate");

    if (!playbackRateDescriptor?.get || !playbackRateDescriptor?.set || !defaultPlaybackRateDescriptor?.set) return;

    Object.defineProperty(media, "playbackRate", {
      configurable: true,
      enumerable: playbackRateDescriptor.enumerable ?? true,
      get() {
        return playbackRateDescriptor.get.call(this);
      },
      set(value) {
        const forcedValue = settings.semitones === 0 ? value : ratioFromSemitones(settings.semitones);
        return playbackRateDescriptor.set.call(this, forcedValue);
      }
    });

    Object.defineProperty(media, "defaultPlaybackRate", {
      configurable: true,
      enumerable: defaultPlaybackRateDescriptor.enumerable ?? true,
      get() {
        return defaultPlaybackRateDescriptor.get
          ? defaultPlaybackRateDescriptor.get.call(this)
          : playbackRateDescriptor.get.call(this);
      },
      set(value) {
        const forcedValue = settings.semitones === 0 ? value : ratioFromSemitones(settings.semitones);
        return defaultPlaybackRateDescriptor.set.call(this, forcedValue);
      }
    });

    media.__srlPlaybackRateLocked = true;
  };

  const unlockPlaybackRate = (media) => {
    if (!media?.__srlPlaybackRateLocked) return;
    try {
      delete media.playbackRate;
      delete media.defaultPlaybackRate;
      delete media.__srlPlaybackRateLocked;
    } catch (_) {}
  };

  const applyFallbackPitch = (media) => {
    if (!media) return;
    if (settings.semitones === 0) {
      unlockPlaybackRate(media);
      setPreservesPitch(media, true);
      setPlaybackRate(media, 1);
      return;
    }
    lockPlaybackRate(media);
    setPreservesPitch(media, false);
    setPlaybackRate(media, ratioFromSemitones(settings.semitones));
  };

  const ensureRuntime = async () => {
    if (runtime) return runtime;
    if (!AudioContextCtor || !processorUrl) return null;

    const context = new AudioContextCtor({ latencyHint: "interactive" });
    runtime = {
      context,
      modulePromise: context.audioWorklet.addModule(processorUrl)
    };
    return runtime;
  };

  const resumeContext = async () => {
    const context = runtime?.context;
    if (!context || context.state === "running") return;
    try {
      await context.resume();
    } catch (_) {}
  };

  const setNodeParams = (record) => {
    const node = record?.node;
    const media = record?.media;
    if (!node || !media) return;

    try {
      const playbackRate = Number.isFinite(media.playbackRate) && media.playbackRate > 0
        ? media.playbackRate
        : 1;

      const rateParam = node.parameters.get("rate");
      if (rateParam) rateParam.value = 1;

      const tempoParam = node.parameters.get("tempo");
      if (tempoParam) tempoParam.value = 1;

      const pitchParam = node.parameters.get("pitch");
      if (pitchParam) pitchParam.value = 1;

      const playbackRateParam = node.parameters.get("playbackRate");
      if (playbackRateParam) playbackRateParam.value = playbackRate;

      const pitchSemitonesParam = node.parameters.get("pitchSemitones");
      if (pitchSemitonesParam) pitchSemitonesParam.value = settings.semitones;
    } catch (_) {}
  };

  const bindMediaToWorklet = async (media) => {
    if (!media) return null;

    const existing = mediaRecords.get(media);
    if (existing?.mode === "worklet") {
      setNodeParams(existing);
      await resumeContext();
      return existing;
    }
    if (existing?.mode === "fallback") {
      applyFallbackPitch(media);
      return existing;
    }

    try {
      const currentRuntime = await ensureRuntime();
      if (!currentRuntime) throw new Error("AudioContext unavailable");

      await currentRuntime.modulePromise;
      const source = currentRuntime.context.createMediaElementSource(media);
      const node = new AudioWorkletNode(currentRuntime.context, "soundtouch-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });

      source.connect(node);
      node.connect(currentRuntime.context.destination);

      const record = { media, source, node, mode: "worklet" };
      mediaRecords.set(media, record);
      setPreservesPitch(media, false);
      setNodeParams(record);
      await resumeContext();
      return record;
    } catch (_) {
      const record = { media, mode: "fallback" };
      mediaRecords.set(media, record);
      applyFallbackPitch(media);
      return record;
    }
  };

  const syncPitch = async () => {
    const mediaElements = getMediaElements();
    if (!mediaElements.length) return;

    const primaryMedia = getPrimaryMedia();

    for (const media of mediaElements) {
      const existing = mediaRecords.get(media);

      if (media === primaryMedia && settings.semitones !== 0) {
        const record = await bindMediaToWorklet(media);
        if (record?.mode === "worklet") {
          setPreservesPitch(media, false);
          setNodeParams(record);
        }
        continue;
      }

      if (existing?.mode === "worklet") {
        setNodeParams(existing);
        continue;
      }

      if (existing?.mode === "fallback" || settings.semitones === 0) {
        applyFallbackPitch(media);
      }
    }
  };

  const onMediaActivity = (event) => {
    const media = event.target;
    if (!(media instanceof HTMLMediaElement)) return;

    setPreservesPitch(media, false);
    if (settings.semitones !== 0) {
      bindMediaToWorklet(media);
    } else {
      applyFallbackPitch(media);
    }
    resumeContext();
  };

  const syncSettingsFromDataset = () => {
    const root = document.documentElement;
    if (!root) return false;

    const rawValue = root.dataset.srlPitchSemitones;
    if (rawValue === lastDatasetValue) return false;
    lastDatasetValue = rawValue;

    const semitones = Number(rawValue);
    settings.semitones = Number.isFinite(semitones) ? Math.min(24, Math.max(-24, semitones)) : 0;
    return true;
  };

  const observer = new MutationObserver(() => {
    const settingsChanged = syncSettingsFromDataset();
    if (settingsChanged) {
      syncPitch();
      return;
    }
    syncPitch();
  });

  window.addEventListener("spotify-rolling-lyrics:setPitch", (event) => {
    const semitones = Number(event.detail?.semitones);
    settings.semitones = Number.isFinite(semitones) ? Math.min(24, Math.max(-24, semitones)) : 0;
    lastDatasetValue = String(settings.semitones);
    syncPitch();
  });

  document.addEventListener("play", onMediaActivity, true);
  document.addEventListener("playing", onMediaActivity, true);
  document.addEventListener("ratechange", onMediaActivity, true);
  document.addEventListener("click", resumeContext, true);
  document.addEventListener("keydown", resumeContext, true);

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-srl-pitch-semitones"],
    childList: true,
    subtree: true
  });

  syncSettingsFromDataset();
  setInterval(() => {
    if (syncSettingsFromDataset()) {
      syncPitch();
      return;
    }
    syncPitch();
  }, 250);
  syncPitch();
})();
