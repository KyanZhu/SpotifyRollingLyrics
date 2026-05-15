(function () {
  let engine = null;

  const clampSemitones = (value) => Math.min(6, Math.max(-6, Number.isFinite(value) ? value : 0));

  const notifyState = async (patch) => {
    if (!engine?.tabId) return;
    await chrome.runtime.sendMessage({
      type: "spotify-rolling-lyrics:offscreenState",
      tabId: engine.tabId,
      active: Boolean(engine.active),
      semitones: engine.semitones,
      mode: "tabCapture",
      ...patch
    }).catch(() => {});
  };

  const setNodeSemitones = (semitones) => {
    if (!engine?.node) return;

    const clamped = clampSemitones(semitones);
    engine.semitones = clamped;

    const pitchSemitonesParam = engine.node.parameters.get("pitchSemitones");
    if (pitchSemitonesParam) pitchSemitonesParam.value = clamped;

    const rateParam = engine.node.parameters.get("rate");
    if (rateParam) rateParam.value = 1;

    const tempoParam = engine.node.parameters.get("tempo");
    if (tempoParam) tempoParam.value = 1;

    const pitchParam = engine.node.parameters.get("pitch");
    if (pitchParam) pitchParam.value = 1;

    const playbackRateParam = engine.node.parameters.get("playbackRate");
    if (playbackRateParam) playbackRateParam.value = 1;
  };

  const stopEngine = async (message = "High-quality pitch stopped") => {
    if (!engine) return;

    const previous = engine;
    engine = null;

    try {
      previous.source?.disconnect();
    } catch (_) {}

    try {
      previous.node?.disconnect();
    } catch (_) {}

    previous.stream?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (_) {}
    });

    try {
      await previous.audioContext?.close();
    } catch (_) {}

    await chrome.runtime.sendMessage({
      type: "spotify-rolling-lyrics:offscreenState",
      tabId: previous.tabId,
      active: false,
      semitones: previous.semitones,
      mode: "tabCapture",
      message
    }).catch(() => {});
  };

  const createTabStream = async (streamId) => navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const startEngine = async ({ tabId, streamId, semitones, workletUrl }) => {
    await stopEngine("Reconnecting high-quality pitch");

    const stream = await createTabStream(streamId);
    const audioContext = new AudioContext({ latencyHint: "interactive" });
    await audioContext.audioWorklet.addModule(workletUrl);

    const source = audioContext.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(audioContext, "soundtouch-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });

    source.connect(node);
    node.connect(audioContext.destination);

    engine = {
      active: true,
      tabId,
      semitones: clampSemitones(semitones),
      stream,
      audioContext,
      source,
      node
    };

    setNodeSemitones(engine.semitones);
    await audioContext.resume();

    stream.getTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        stopEngine("Spotify tab audio capture ended");
      }, { once: true });
    });

    await notifyState({
      active: true,
      semitones: engine.semitones,
      message: engine.semitones === 0
        ? "High-quality pitch connected"
        : `High-quality pitch connected: ${engine.semitones > 0 ? "+" : ""}${engine.semitones} st`
    });
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "offscreen") return false;

    if (message.type === "spotify-rolling-lyrics:offscreenStart") {
      startEngine(message)
        .then(() => sendResponse({ ok: true }))
        .catch(async (error) => {
          await stopEngine("High-quality pitch failed to start");
          sendResponse({ ok: false, error: error.message });
        });
      return true;
    }

    if (message.type === "spotify-rolling-lyrics:offscreenSetPitch") {
      const semitones = clampSemitones(Number(message.semitones));
      if (engine && engine.tabId === message.tabId) {
        setNodeSemitones(semitones);
        notifyState({
          active: true,
          semitones,
          message: semitones === 0
            ? "High-quality pitch connected"
            : `High-quality pitch connected: ${semitones > 0 ? "+" : ""}${semitones} st`
        }).then(() => sendResponse({ ok: true }));
        return true;
      }

      sendResponse({ ok: false, error: "Pitch engine is not active" });
      return false;
    }

    if (message.type === "spotify-rolling-lyrics:offscreenStop") {
      if (!engine || engine.tabId !== message.tabId) {
        sendResponse({ ok: true });
        return false;
      }

      stopEngine("High-quality pitch stopped").then(() => sendResponse({ ok: true }));
      return true;
    }

    return false;
  });
})();
