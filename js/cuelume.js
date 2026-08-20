/**
 * Cuelume — curated interaction sounds synthesized via the Web Audio API.
 * No audio files, no dependencies, one shared AudioContext.
 *
 * Designed to run completely offline.
 */

export const RECIPES = {
  /** A soft two-note ascending bell, like an iOS/macOS confirmation tink. */
  chime: {
    masterGain: 0.5,
    layers: [
      { kind: "tone", waveform: "sine", frequency: 1046.5, attack: 0.006, decay: 0.22, peak: 0.09 },
      { kind: "tone", waveform: "sine", frequency: 1568, offset: 0.09, attack: 0.006, decay: 0.26, peak: 0.08 },
    ],
    shimmer: { delay: 0.12, feedback: 0.25, wet: 0.18, lowpass: 4000 },
  },
  /** A quick ascending twinkle of four notes — bright and playful. */
  sparkle: {
    masterGain: 0.5,
    layers: [
      { kind: "tone", waveform: "sine", frequency: 1760, offset: 0, attack: 0.003, decay: 0.09, peak: 0.045 },
      { kind: "tone", waveform: "sine", frequency: 2217, offset: 0.045, attack: 0.003, decay: 0.09, peak: 0.04 },
      { kind: "tone", waveform: "sine", frequency: 2637, offset: 0.09, attack: 0.003, decay: 0.1, peak: 0.038 },
      { kind: "tone", waveform: "sine", frequency: 3520, offset: 0.135, attack: 0.003, decay: 0.12, peak: 0.032 },
    ],
    shimmer: { delay: 0.07, feedback: 0.35, wet: 0.22, lowpass: 6000 },
  },
  /** A single note gliding smoothly downward, like a drop of water. */
  droplet: {
    masterGain: 0.55,
    layers: [
      { kind: "tone", waveform: "sine", frequency: 1200, glideTo: 550, glideTime: 0.14, attack: 0.004, decay: 0.2, peak: 0.075 },
    ],
    shimmer: { delay: 0.09, feedback: 0.2, wet: 0.15, lowpass: 3000 },
  },
  /** A warm, slow-swelling pad from two gently detuned sines. */
  bloom: {
    masterGain: 0.5,
    layers: [
      { kind: "tone", waveform: "sine", frequency: 528, attack: 0.06, decay: 0.32, peak: 0.06 },
      { kind: "tone", waveform: "sine", frequency: 528, detune: 12, attack: 0.06, decay: 0.34, peak: 0.05 },
    ],
    shimmer: { delay: 0.15, feedback: 0.2, wet: 0.12, lowpass: 2500 },
  },
  /** The quietest option — a breathy, textureless swell for dense lists. */
  whisper: {
    masterGain: 0.5,
    layers: [
      { kind: "noise", filterType: "lowpass", filterFrequency: 1200, filterQ: 0.7, attack: 0.04, decay: 0.16, peak: 0.05 },
    ],
  },
  /** A focused, bandpass-filtered tick with a bright sine ping on top — crisp and instant. */
  tick: {
    masterGain: 0.4,
    layers: [
      { kind: "noise", filterType: "bandpass", filterFrequency: 5400, filterQ: 1.8, attack: 0.001, decay: 0.018, peak: 0.14 },
      { kind: "tone", waveform: "sine", frequency: 2600, attack: 0.001, decay: 0.012, peak: 0.018 },
    ],
  },
  /** A dull, muted knock — the "down" half of a press/release pair, like a key bottoming out. */
  press: {
    masterGain: 0.4,
    layers: [
      { kind: "noise", filterType: "bandpass", filterFrequency: 1700, filterQ: 1.4, attack: 0.001, decay: 0.02, peak: 0.13 },
    ],
  },
  /** A brighter, springier tick — the "up" half of a press/release pair, like a key returning. */
  release: {
    masterGain: 0.4,
    layers: [
      { kind: "noise", filterType: "bandpass", filterFrequency: 4600, filterQ: 1.8, attack: 0.001, decay: 0.016, peak: 0.12 },
      { kind: "tone", waveform: "sine", frequency: 3200, offset: 0.006, attack: 0.001, decay: 0.05, peak: 0.02 },
    ],
  },
  /** A two-part click-clack, like a mechanical switch flipping between states. */
  toggle: {
    masterGain: 0.4,
    layers: [
      { kind: "noise", filterType: "bandpass", filterFrequency: 2200, filterQ: 1.6, attack: 0.001, decay: 0.016, peak: 0.12 },
      { kind: "noise", filterType: "bandpass", filterFrequency: 3800, filterQ: 1.6, offset: 0.024, attack: 0.001, decay: 0.02, peak: 0.1 },
    ],
  },
  /** A short, warm three-note ascending confirmation — "done", not a fanfare. */
  success: {
    masterGain: 0.5,
    layers: [
      { kind: "tone", waveform: "sine", frequency: 880, attack: 0.004, decay: 0.09, peak: 0.06 },
      { kind: "tone", waveform: "sine", frequency: 1108.73, offset: 0.06, attack: 0.004, decay: 0.1, peak: 0.06 },
      { kind: "tone", waveform: "sine", frequency: 1318.51, offset: 0.12, attack: 0.004, decay: 0.18, peak: 0.07 },
    ],
    shimmer: { delay: 0.1, feedback: 0.22, wet: 0.16, lowpass: 4500 },
  },
};

const SOURCE_STOP_PADDING = 0.05;
const CLEANUP_MARGIN = 0.05;
const INAUDIBLE_GAIN = 0.001;

function renderTone(context, destination, layer, startTime) {
  const oscillator = context.createOscillator();
  oscillator.type = layer.waveform;
  oscillator.frequency.setValueAtTime(layer.frequency, startTime);
  if (layer.detune) {
    oscillator.detune.value = layer.detune;
  }
  if (layer.glideTo !== undefined) {
    const glideTime = layer.glideTime ?? layer.attack + layer.decay;
    oscillator.frequency.exponentialRampToValueAtTime(layer.glideTo, startTime + glideTime);
  }
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(layer.peak, startTime + layer.attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + layer.attack + layer.decay);
  oscillator.connect(gain).connect(destination);
  oscillator.start(startTime);
  oscillator.stop(startTime + layer.attack + layer.decay + SOURCE_STOP_PADDING);
}

function renderNoise(context, destination, layer, startTime) {
  const duration = layer.attack + layer.decay + SOURCE_STOP_PADDING;
  const length = Math.max(1, Math.floor(duration * context.sampleRate));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = 2 * Math.random() - 1;
  }
  const source = context.createBufferSource();
  source.buffer = buffer;
  const filter = context.createBiquadFilter();
  filter.type = layer.filterType;
  filter.frequency.value = layer.filterFrequency;
  if (layer.filterQ !== undefined) {
    filter.Q.value = layer.filterQ;
  }
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(layer.peak, startTime + layer.attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + layer.attack + layer.decay);
  source.connect(filter).connect(gain).connect(destination);
  source.start(startTime);
  source.stop(startTime + duration);
}

function attachShimmer(context, source, destination, shimmer) {
  const delay = context.createDelay(1);
  delay.delayTime.value = shimmer.delay;
  const feedbackFilter = context.createBiquadFilter();
  feedbackFilter.type = "lowpass";
  feedbackFilter.frequency.value = shimmer.lowpass;
  const feedbackGain = context.createGain();
  feedbackGain.gain.value = shimmer.feedback;
  const wetGain = context.createGain();
  wetGain.gain.value = shimmer.wet;
  source.connect(delay);
  delay.connect(feedbackFilter);
  feedbackFilter.connect(feedbackGain);
  feedbackGain.connect(delay);
  feedbackFilter.connect(wetGain);
  wetGain.connect(destination);
  return [delay, feedbackFilter, feedbackGain, wetGain];
}

function sourceEnd(recipe) {
  return Math.max(...recipe.layers.map((layer) => (layer.offset ?? 0) + layer.attack + layer.decay + SOURCE_STOP_PADDING));
}

function shimmerTail(shimmer) {
  if (!shimmer || shimmer.feedback <= 0) {
    return 0;
  }
  if (shimmer.feedback >= 1) {
    return shimmer.delay;
  }
  return shimmer.delay * (1 + Math.ceil(Math.log(INAUDIBLE_GAIN) / Math.log(shimmer.feedback)));
}

function renderRecipe(context, recipe) {
  const now = context.currentTime;
  const master = context.createGain();
  master.gain.value = recipe.masterGain;
  master.connect(context.destination);
  const shimmerNodes = recipe.shimmer ? attachShimmer(context, master, context.destination, recipe.shimmer) : [];
  for (const layer of recipe.layers) {
    const startTime = now + (layer.offset ?? 0);
    if (layer.kind === "tone") {
      renderTone(context, master, layer, startTime);
    } else {
      renderNoise(context, master, layer, startTime);
    }
  }
  const cleanupAfterMs = (sourceEnd(recipe) + shimmerTail(recipe.shimmer) + CLEANUP_MARGIN) * 1000;
  setTimeout(() => {
    master.disconnect();
    for (const node of shimmerNodes) {
      node.disconnect();
    }
  }, cleanupAfterMs);
}

let sharedContext = null;
let enabled = true;

export function setEnabled(value) {
  if (typeof value === "boolean") {
    enabled = value;
  }
}

export function getEnabled() {
  return enabled;
}

function getAudioContext() {
  if (sharedContext) {
    return sharedContext;
  }
  if (typeof window === "undefined") {
    return null;
  }
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctor) {
    return null;
  }
  try {
    sharedContext = new Ctor();
  } catch {
    return null;
  }
  return sharedContext;
}

export function play(sound = "chime") {
  if (!enabled || !RECIPES[sound]) {
    return;
  }
  const context = getAudioContext();
  if (!context) {
    return;
  }
  const recipe = RECIPES[sound];
  if (context.state === "running") {
    renderRecipe(context, recipe);
  } else {
    try {
      void context.resume().then(() => {
        if (enabled && context.state === "running") {
          renderRecipe(context, recipe);
        }
      }, () => {});
    } catch {
      // Some browsers throw when resuming is blocked by user gesture policy.
    }
  }
}

// Event delegation configuration
const DEBOUNCE_HOVER_MS = 150;
const boundDocuments = new WeakSet();
const eventHolders = new WeakSet();
let lastHoverTime = -Infinity;

function getAttributeSound(element, attributeName, defaultSound) {
  const value = element.getAttribute(attributeName);
  return RECIPES[value] ? value : defaultSound;
}

function isMouseHover(event) {
  return event.pointerType === "mouse" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function findClosestWithAttribute(root, event, attributeName) {
  if (!(event.target instanceof Element)) {
    return null;
  }
  const closest = event.target.closest(`[${attributeName}]`);
  return closest && root.contains(closest) ? closest : null;
}

function registerEvent(root, eventName, attributeName, defaultSound, onlyMouse = false) {
  root.addEventListener(eventName, (event) => {
    const target = findClosestWithAttribute(root, event, attributeName);
    if (!target || eventHolders.has(event)) {
      return;
    }
    if (onlyMouse && !isMouseHover(event)) {
      return;
    }

    if (eventName === "pointerenter") {
      const related = event.relatedTarget;
      if (related instanceof Node && target.contains(related)) {
        return;
      }
      const now = performance.now();
      if (now - lastHoverTime < DEBOUNCE_HOVER_MS) {
        return;
      }
      lastHoverTime = now;
    }

    eventHolders.add(event);
    play(getAttributeSound(target, attributeName, defaultSound));
  }, true);
}

export function bind() {
  if (typeof document === "undefined") {
    return;
  }
  const doc = document;
  if (boundDocuments.has(doc)) {
    return;
  }
  boundDocuments.add(doc);

  registerEvent(doc, "pointerenter", "data-cuelume-hover", "chime", true);
  registerEvent(doc, "pointerdown", "data-cuelume-press", "press", false);
  registerEvent(doc, "pointerup", "data-cuelume-release", "release", false);
  registerEvent(doc, "click", "data-cuelume-toggle", "toggle", false);
}
