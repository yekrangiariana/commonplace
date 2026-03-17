function isMobileBrowser() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );
}

const CHUNK_MAX_LENGTH = 200;
const INTER_CHUNK_DELAY_MS = 80;

function splitIntoChunks(text, maxLength = CHUNK_MAX_LENGTH) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = -1;

    // Try to split at a sentence boundary
    for (let i = maxLength; i >= maxLength * 0.5; i--) {
      if (
        remaining[i] === "." ||
        remaining[i] === "!" ||
        remaining[i] === "?"
      ) {
        splitAt = i + 1;
        break;
      }
    }

    // Fall back to a word boundary
    if (splitAt === -1) {
      for (let i = maxLength; i >= maxLength * 0.3; i--) {
        if (remaining[i] === " ") {
          splitAt = i + 1;
          break;
        }
      }
    }

    // Hard split as last resort
    if (splitAt === -1) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks.filter(Boolean);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampRate(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return 1;
  }

  return clamp(numeric, 0.7, 1.3);
}

function clampProgress(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return clamp(numeric, 0, 100);
}

function estimateDurationSeconds(text, rate) {
  const words = (text.match(/\b\w+\b/g) || []).length;
  const wordsPerMinute = 165 * clampRate(rate);

  if (words === 0 || wordsPerMinute <= 0) {
    return 0;
  }

  return Math.max(1, Math.round((words / wordsPerMinute) * 60));
}

function formatSeconds(totalSeconds) {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function stripTagsForSpeech(text) {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function getSpeakableText(article) {
  if (!article) {
    return "";
  }

  return stripTagsForSpeech(
    (article.blocks || [])
      .map((block) => (block?.text || "").trim())
      .filter(Boolean)
      .join(" "),
  );
}

function toVoiceOption(voice) {
  const language = (voice.lang || "").toUpperCase();
  const defaultTag = voice.default ? " (Default)" : "";

  return {
    id: voice.voiceURI,
    label: `${voice.name}${language ? ` - ${language}` : ""}${defaultTag}`,
    voice,
  };
}

const DEVICE_DEFAULT_VOICE_ID = "__device_default__";
const RATE_STEP = 0.05;
const RATE_MIN = 0.7;
const RATE_MAX = 1.3;

const PREFERRED_VOICE_NAMES = [
  "Samantha",
  "Daniel",
  "Moira",
  "Karen",
  "Alex",
  "Serena",
  "Tessa",
  "Fiona",
  "Ava",
  "Allison",
];

function curateVoiceOptions(options) {
  if (!options.length) {
    return [];
  }

  const english = options.filter((option) =>
    option.voice.lang?.toLowerCase().startsWith("en"),
  );
  const pool = english.length ? english : options;
  const curated = [];
  const used = new Set();

  PREFERRED_VOICE_NAMES.forEach((name) => {
    const match = pool.find(
      (option) =>
        option.voice.name?.toLowerCase() === name.toLowerCase() &&
        !used.has(option.id),
    );

    if (!match) {
      return;
    }

    curated.push(match);
    used.add(match.id);
  });

  for (let index = 0; index < pool.length && curated.length < 4; index += 1) {
    const option = pool[index];

    if (used.has(option.id)) {
      continue;
    }

    curated.push(option);
    used.add(option.id);
  }

  return curated.slice(0, 4);
}

function pickPreferredVoiceId(options) {
  return DEVICE_DEFAULT_VOICE_ID;
}

function snapRate(value) {
  const clamped = clampRate(value);
  const snapped = Math.round(clamped / RATE_STEP) * RATE_STEP;
  return Number(clamp(snapped, RATE_MIN, RATE_MAX).toFixed(2));
}

export function initReaderTtsPlayer({
  state,
  dom,
  persistState,
  setStatus,
  getSelectedArticle,
}) {
  const synthesis = window.speechSynthesis;

  let currentArticleId = "";
  let currentText = "";
  let currentStartChar = 0;
  let progressPercent = 0;
  let isPlaying = false;
  let isPaused = false;
  let isSettingsOpen = false;
  let statusText = "Ready";
  let voiceOptions = [];
  let voicesLoaded = false;
  let voicesPromise = null;
  let activeUtterance = null;
  let playToken = 0;
  const isMobile = isMobileBrowser();
  let chunkQueue = [];
  let chunkIndex = 0;
  let chunkCharOffsets = [];
  let interChunkTimer = null;
  let progressRafId = null;
  let chunkStartTime = 0;
  let chunkStartPercent = 0;
  let chunkEndPercent = 0;

  let renderQueued = false;
  let renderVersion = 0;
  let renderedVersion = -1;
  let lastVoiceOptionsKey = "";

  function getHost() {
    return dom.readerMeta.querySelector("[data-reader-tts-player-host]");
  }

  function getSelectedVoiceId() {
    return typeof state.ttsVoiceId === "string" ? state.ttsVoiceId : "";
  }

  function updateStatus(nextStatus, shouldToast = false) {
    if (statusText === nextStatus) {
      return;
    }

    statusText = nextStatus;
    queueRender();

    if (shouldToast) {
      setStatus(nextStatus);
    }
  }

  function updateProgress(nextPercent) {
    progressPercent = clampProgress(nextPercent);

    const slider = dom.readerMeta.querySelector("[data-tts-progress]");

    if (slider) {
      slider.value = String(progressPercent.toFixed(1));
      slider.style.setProperty(
        "--tts-progress",
        `${progressPercent.toFixed(1)}%`,
      );
    }

    const remainingEl = dom.readerMeta.querySelector("[data-tts-remaining]");

    if (remainingEl) {
      const article = getSelectedArticle();
      const speakableText = article ? getSpeakableText(article) : "";
      const totalDuration = estimateDurationSeconds(
        speakableText,
        clampRate(state.ttsRate),
      );
      const secs = getRemainingSeconds(totalDuration);
      remainingEl.textContent = `${formatSeconds(secs)} left`;
    }
  }

  function queueRender() {
    renderVersion += 1;

    if (renderQueued) {
      return;
    }

    renderQueued = true;
    window.requestAnimationFrame(() => {
      renderQueued = false;

      if (renderedVersion === renderVersion) {
        return;
      }

      renderedVersion = renderVersion;
      render(getSelectedArticle());
    });
  }

  function getRemainingSeconds(totalDurationSeconds) {
    if (totalDurationSeconds <= 0) {
      return 0;
    }

    return Math.max(
      0,
      Math.round(((100 - progressPercent) / 100) * totalDurationSeconds),
    );
  }

  function getVoiceById(voiceId) {
    if (!voiceId || voiceId === DEVICE_DEFAULT_VOICE_ID) {
      return null;
    }

    return voiceOptions.find((option) => option.id === voiceId)?.voice || null;
  }

  function syncVoiceSelectionState() {
    const selected = getSelectedVoiceId();

    if (selected === DEVICE_DEFAULT_VOICE_ID) {
      return;
    }

    if (selected && getVoiceById(selected)) {
      return;
    }

    state.ttsVoiceId = pickPreferredVoiceId(voiceOptions);
    persistState(state);
  }

  function refreshVoices() {
    if (!synthesis) {
      voiceOptions = [];
      voicesLoaded = true;
      return;
    }

    const rawVoices = synthesis.getVoices() || [];

    const normalized = rawVoices
      .map(toVoiceOption)
      .sort((left, right) => left.label.localeCompare(right.label));

    voiceOptions = curateVoiceOptions(normalized);

    voicesLoaded = voiceOptions.length > 0;
    syncVoiceSelectionState();
  }

  function ensureVoicesLoaded() {
    if (!synthesis) {
      return Promise.resolve(false);
    }

    refreshVoices();

    if (voicesLoaded) {
      return Promise.resolve(true);
    }

    if (voicesPromise) {
      return voicesPromise;
    }

    voicesPromise = new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        refreshVoices();
        resolve(voicesLoaded);
      }, 900);

      synthesis.onvoiceschanged = () => {
        window.clearTimeout(timeoutId);
        refreshVoices();
        queueRender();
        resolve(voicesLoaded);
      };
    }).finally(() => {
      voicesPromise = null;
      queueRender();
    });

    return voicesPromise;
  }

  function stopProgressInterpolation() {
    if (progressRafId !== null) {
      cancelAnimationFrame(progressRafId);
      progressRafId = null;
    }
  }

  function startProgressInterpolation(token) {
    stopProgressInterpolation();

    const chunkLen = (chunkQueue[chunkIndex] || "").length;
    const wordsInChunk = (chunkQueue[chunkIndex] || "").split(/\s+/).length;
    const rate = clampRate(state.ttsRate);
    const estimatedMs = Math.max(200, (wordsInChunk / (165 * rate)) * 60000);

    chunkStartTime = performance.now();
    chunkStartPercent = progressPercent;

    // Figure out what progress will be at the end of this chunk
    const totalChars = Math.max(1, currentText.length);
    const nextOffset =
      chunkIndex + 1 < chunkCharOffsets.length
        ? chunkCharOffsets[chunkIndex + 1]
        : totalChars - currentStartChar;
    chunkEndPercent = clampProgress(
      ((currentStartChar + nextOffset) / totalChars) * 100,
    );

    function tick() {
      if (token !== playToken) {
        return;
      }

      const elapsed = performance.now() - chunkStartTime;
      const fraction = Math.min(1, elapsed / estimatedMs);
      const interpolated =
        chunkStartPercent + (chunkEndPercent - chunkStartPercent) * fraction;
      updateProgress(interpolated);

      if (fraction < 1) {
        progressRafId = requestAnimationFrame(tick);
      }
    }

    progressRafId = requestAnimationFrame(tick);
  }

  function cancelSpeech(resetFlags = true, bumpToken = true) {
    if (bumpToken) {
      playToken += 1;
    }

    if (interChunkTimer !== null) {
      clearTimeout(interChunkTimer);
      interChunkTimer = null;
    }

    stopProgressInterpolation();

    if (synthesis) {
      synthesis.cancel();
    }

    activeUtterance = null;

    if (resetFlags) {
      isPlaying = false;
      isPaused = false;
    }
  }

  function setRate(nextRate) {
    const snappedRate = snapRate(nextRate);

    if (Math.abs(snappedRate - state.ttsRate) < 0.0001) {
      return;
    }

    state.ttsRate = snappedRate;
    persistState(state);

    const article = getSelectedArticle();

    if (article && (isPlaying || isPaused)) {
      const resumePercent = progressPercent;
      speakFromPercent(article, resumePercent).catch(() => {});
    } else {
      queueRender();
    }
  }

  function speakChunkQueue(token) {
    if (token !== playToken) {
      return;
    }

    if (chunkQueue.length === 0) {
      isPlaying = false;
      isPaused = false;
      activeUtterance = null;
      updateProgress(100);
      updateStatus("Finished");
      queueRender();
      return;
    }

    const selectedVoice = getVoiceById(getSelectedVoiceId());

    // Cancel stale state before queuing — critical on mobile
    if (isMobile) {
      synthesis.cancel();
    }

    // Pre-queue every chunk into the browser's native speech queue
    // in one synchronous pass so the user-gesture context is preserved
    for (let i = chunkIndex; i < chunkQueue.length; i++) {
      const chunkText = chunkQueue[i];
      const idx = i;
      const utterance = new SpeechSynthesisUtterance(chunkText);
      utterance.rate = clampRate(state.ttsRate);

      if (selectedVoice) {
        utterance.voice = selectedVoice;
        utterance.lang = selectedVoice.lang;
      }

      utterance.onstart = () => {
        if (token !== playToken) {
          return;
        }

        chunkIndex = idx;
        isPlaying = true;
        isPaused = false;
        updateStatus("Playing");
        queueRender();
        startProgressInterpolation(token);
      };

      utterance.onend = () => {
        if (token !== playToken) {
          return;
        }

        stopProgressInterpolation();

        // Snap progress to this chunk's end
        const totalChars = Math.max(1, currentText.length);
        const spokenUpTo =
          idx + 1 < chunkCharOffsets.length
            ? chunkCharOffsets[idx + 1]
            : totalChars - currentStartChar;
        updateProgress(
          (clamp(currentStartChar + spokenUpTo, 0, totalChars) / totalChars) *
            100,
        );

        // If this was the last chunk, finalize
        if (idx === chunkQueue.length - 1) {
          chunkIndex = chunkQueue.length;
          isPlaying = false;
          isPaused = false;
          activeUtterance = null;
          updateProgress(100);
          updateStatus("Finished");
          queueRender();
        }
      };

      utterance.onerror = (event) => {
        if (token !== playToken) {
          return;
        }

        if (event.error === "interrupted" || event.error === "canceled") {
          return;
        }

        stopProgressInterpolation();
        isPlaying = false;
        isPaused = false;
        activeUtterance = null;
        updateStatus("Playback failed. Try again.", true);
        queueRender();
      };

      // Keep a reference to the current utterance for the active chunk
      if (i === chunkIndex) {
        activeUtterance = utterance;
      }

      synthesis.speak(utterance);
    }
  }

  async function speakFromPercent(article, startPercent) {
    if (!synthesis || typeof SpeechSynthesisUtterance === "undefined") {
      updateStatus("System speech is unavailable in this browser.", true);
      return;
    }

    const text = getSpeakableText(article);

    if (!text) {
      updateStatus("No readable text available for this article.", true);
      return;
    }

    // Load voices ahead of time so the speak path below stays synchronous
    await ensureVoicesLoaded();

    const safePercent = clampProgress(startPercent);
    const startChar = Math.floor((safePercent / 100) * text.length);
    const slicedText = text.slice(startChar).trim();

    if (!slicedText) {
      updateProgress(100);
      updateStatus("Finished");
      return;
    }

    // Bump token FIRST so old callbacks are invalidated before cancel fires events
    const token = playToken + 1;
    playToken = token;

    cancelSpeech(false, false);

    currentText = text;
    currentStartChar = startChar;

    chunkQueue = splitIntoChunks(slicedText);
    chunkIndex = 0;

    // Build cumulative char-offset map for progress tracking
    chunkCharOffsets = [];
    let offset = 0;
    for (const chunk of chunkQueue) {
      chunkCharOffsets.push(offset);
      offset += chunk.length;
    }

    updateStatus("Starting playback...");
    speakChunkQueue(token);
  }

  // Synchronous version — called directly from click handlers so
  // synthesis.speak() stays in the user-gesture call stack (required by
  // Chrome Android).  Voices must already be loaded before calling this.
  function speakFromPercentSync(article, startPercent) {
    if (!synthesis || typeof SpeechSynthesisUtterance === "undefined") {
      updateStatus("System speech is unavailable in this browser.", true);
      return;
    }

    const text = getSpeakableText(article);

    if (!text) {
      updateStatus("No readable text available for this article.", true);
      return;
    }

    const safePercent = clampProgress(startPercent);
    const startChar = Math.floor((safePercent / 100) * text.length);
    const slicedText = text.slice(startChar).trim();

    if (!slicedText) {
      updateProgress(100);
      updateStatus("Finished");
      return;
    }

    const token = playToken + 1;
    playToken = token;

    cancelSpeech(false, false);

    currentText = text;
    currentStartChar = startChar;

    chunkQueue = splitIntoChunks(slicedText);
    chunkIndex = 0;

    chunkCharOffsets = [];
    let offset = 0;
    for (const chunk of chunkQueue) {
      chunkCharOffsets.push(offset);
      offset += chunk.length;
    }

    updateStatus("Starting playback...");
    speakChunkQueue(token);
  }

  async function handlePlayToggle(article) {
    if (!article) {
      return;
    }

    if (!synthesis || typeof SpeechSynthesisUtterance === "undefined") {
      updateStatus("System speech is unavailable in this browser.", true);
      return;
    }

    if (isPlaying && !isPaused) {
      // Pause: cancel speech and remember chunk position
      cancelSpeech(false, true);
      isPaused = true;
      isPlaying = false;
      updateStatus("Paused");
      queueRender();
      return;
    }

    if (isPaused) {
      isPaused = false;

      // Resume: re-queue from the current chunk position, synchronously
      // so the user-gesture context is preserved for synthesis.speak()
      if (chunkQueue.length > 0 && chunkIndex < chunkQueue.length) {
        const token = playToken + 1;
        playToken = token;
        speakChunkQueue(token);
      } else {
        speakFromPercentSync(article, progressPercent);
      }
      return;
    }

    // First play — voices may not be loaded yet, so await them first
    // then call the sync path so speak() is still as close to the
    // gesture as possible.  ensureVoicesLoaded resolves immediately
    // if voices are already cached.
    await ensureVoicesLoaded();
    speakFromPercentSync(article, progressPercent);
  }

  function handleSeekToPercent(article, nextPercent) {
    const safePercent = clampProgress(nextPercent);
    updateProgress(safePercent);

    if (!article) {
      return;
    }

    if (isPlaying || isPaused) {
      speakFromPercent(article, safePercent).catch(() => {});
    }
  }

  function buildVoiceOptionsMarkup() {
    const selectedVoiceId = getSelectedVoiceId() || DEVICE_DEFAULT_VOICE_ID;

    if (!voiceOptions.length) {
      return `<option value="${DEVICE_DEFAULT_VOICE_ID}" selected>Device default</option>`;
    }

    const defaultOption = `<option value="${DEVICE_DEFAULT_VOICE_ID}" ${selectedVoiceId === DEVICE_DEFAULT_VOICE_ID ? "selected" : ""}>Device default</option>`;
    const curatedOptions = voiceOptions
      .map((option) => {
        const selected = option.id === selectedVoiceId ? "selected" : "";
        return `<option value="${option.id}" ${selected}>${option.label}</option>`;
      })
      .join("");

    return `${defaultOption}${curatedOptions}`;
  }

  function ensureHostShell(host) {
    let root = host.querySelector(".tts-player");

    if (root) {
      return root;
    }

    // Shell is being rebuilt (host was destroyed by re-render); reset the
    // memoization key so the voice dropdown is always repopulated from scratch.
    lastVoiceOptionsKey = "";

    host.innerHTML = `
      <section class="tts-player" aria-label="Text to speech">
        <div class="tts-player__transport">
          <button
            type="button"
            class="tts-player__icon-button"
            data-tts-action="toggle-play"
            title="Play"
            aria-label="Play"
          >
            <i class="fa-solid fa-play" aria-hidden="true"></i>
          </button>

          <div class="tts-player__seek-wrap">
            <div class="tts-player__seek-load-indicator"></div>
            <input
              type="range"
              min="0"
              max="100"
              step="0.1"
              value="0"
              class="tts-player__seek"
              data-tts-progress
              aria-label="Speech progress"
            />
          </div>

          <span class="tts-player__remaining" data-tts-remaining>0:00 left</span>

          <div class="reader-meta-action-wrap tts-player__settings-wrap">
            <button
              type="button"
              class="tts-player__icon-button"
              data-tts-action="toggle-settings"
              title="Voice settings"
              aria-label="Voice settings"
            >
              <i class="fa-solid fa-sliders" aria-hidden="true"></i>
            </button>
            <div
              class="reader-popover tts-player__settings-popover"
              data-reader-popover="tts-settings"
              hidden
            >
              <label class="tts-player__field">
                <span>Voice</span>
                <select data-tts-voice></select>
              </label>

              <div class="tts-player__field">
                <span>Speed</span>
                <div class="tts-player__speed-controls">
                  <button type="button" class="tts-player__speed-button" data-tts-action="speed-down" aria-label="Decrease speed">
                    <i class="fa-solid fa-minus" aria-hidden="true"></i>
                  </button>
                  <strong class="tts-player__speed-value" data-tts-rate-value>1.00x</strong>
                  <button type="button" class="tts-player__speed-button" data-tts-action="speed-up" aria-label="Increase speed">
                    <i class="fa-solid fa-plus" aria-hidden="true"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

      </section>
    `;

    root = host.querySelector(".tts-player");
    return root;
  }

  function render(article) {
    const host = getHost();

    if (!host) {
      return;
    }

    if (!article) {
      if (host.innerHTML) {
        host.innerHTML = "";
      }
      return;
    }

    const root = ensureHostShell(host);

    if (!root) {
      return;
    }

    const selectedRate = clampRate(state.ttsRate);
    const speakableText = getSpeakableText(article);
    const totalDurationSeconds = estimateDurationSeconds(
      speakableText,
      selectedRate,
    );
    const remainingSeconds = getRemainingSeconds(totalDurationSeconds);

    const playButton = root.querySelector('[data-tts-action="toggle-play"]');
    const playIcon = playButton?.querySelector("i");
    const seekWrap = root.querySelector(".tts-player__seek-wrap");
    const slider = root.querySelector("[data-tts-progress]");
    const remaining = root.querySelector("[data-tts-remaining]");
    const popover = root.querySelector('[data-reader-popover="tts-settings"]');
    const voiceSelect = root.querySelector("[data-tts-voice]");
    const rateValue = root.querySelector("[data-tts-rate-value]");
    const speedDownButton = root.querySelector(
      '[data-tts-action="speed-down"]',
    );
    const speedUpButton = root.querySelector('[data-tts-action="speed-up"]');

    if (playButton) {
      playButton.title = isPlaying && !isPaused ? "Pause" : "Play";
      playButton.setAttribute(
        "aria-label",
        isPlaying && !isPaused ? "Pause" : "Play",
      );
      playButton.disabled = !synthesis;
    }

    if (playIcon) {
      playIcon.className = `fa-solid ${isPlaying && !isPaused ? "fa-pause" : "fa-play"}`;
    }

    if (seekWrap) {
      seekWrap.classList.toggle("is-loading", false);
    }

    if (slider) {
      slider.value = progressPercent.toFixed(1);
      slider.style.setProperty(
        "--tts-progress",
        `${progressPercent.toFixed(1)}%`,
      );
    }

    if (remaining) {
      remaining.textContent = `${formatSeconds(remainingSeconds)} left`;
    }

    if (popover) {
      popover.hidden = !isSettingsOpen;
    }

    if (rateValue) {
      rateValue.textContent = `${selectedRate.toFixed(2)}x`;
    }

    if (speedDownButton) {
      speedDownButton.disabled = selectedRate <= RATE_MIN + 0.0001;
      speedDownButton.title = "Decrease speed";
    }

    if (speedUpButton) {
      speedUpButton.disabled = selectedRate >= RATE_MAX - 0.0001;
      speedUpButton.title = "Increase speed";
    }

    if (voiceSelect) {
      const optionsMarkup = buildVoiceOptionsMarkup();

      if (lastVoiceOptionsKey !== optionsMarkup) {
        voiceSelect.innerHTML = optionsMarkup;
        lastVoiceOptionsKey = optionsMarkup;
      }

      voiceSelect.disabled = !synthesis;

      const selectedVoiceId = getSelectedVoiceId() || DEVICE_DEFAULT_VOICE_ID;
      voiceSelect.value = selectedVoiceId;
    }
  }

  function handleClick(event) {
    const actionTrigger = event.target.closest("[data-tts-action]");

    if (!actionTrigger) {
      return false;
    }

    const article = getSelectedArticle();
    const action = actionTrigger.dataset.ttsAction;

    if (action === "toggle-play") {
      handlePlayToggle(article);
    } else if (action === "toggle-settings") {
      isSettingsOpen = !isSettingsOpen;
      queueRender();
    } else if (action === "speed-down") {
      setRate(state.ttsRate - RATE_STEP);
    } else if (action === "speed-up") {
      setRate(state.ttsRate + RATE_STEP);
    }

    return true;
  }

  function handleChange(event) {
    const voiceSelect = event.target.closest("[data-tts-voice]");

    if (!voiceSelect) {
      const progressSlider = event.target.closest("[data-tts-progress]");

      if (progressSlider) {
        handleSeekToPercent(getSelectedArticle(), progressSlider.value);
        return true;
      }

      return false;
    }

    state.ttsVoiceId = voiceSelect.value;
    persistState(state);

    const article = getSelectedArticle();

    if (article && (isPlaying || isPaused)) {
      speakFromPercent(article, progressPercent).catch(() => {});
    }

    updateStatus("Voice updated");
    return true;
  }

  function handleInput() {
    return false;
  }

  return {
    mount(article) {
      if (!article) {
        cancelSpeech();
        isSettingsOpen = false;
        queueRender();
        return;
      }

      if (article.id !== currentArticleId) {
        currentArticleId = article.id;
        currentText = "";
        currentStartChar = 0;
        updateProgress(0);
        cancelSpeech();
        isSettingsOpen = false;
        updateStatus("Ready");
      }

      ensureVoicesLoaded().then(() => {
        if (voiceOptions.length && !isPlaying && !isPaused) {
          updateStatus("Ready");
        }
      });
      queueRender();
    },
    closeSettingsPopover() {
      if (!isSettingsOpen) {
        return;
      }

      isSettingsOpen = false;
      queueRender();
    },
    handleClick,
    handleChange,
    handleInput,
  };
}
