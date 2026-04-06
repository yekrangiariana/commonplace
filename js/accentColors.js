/**
 * Accent Color Configuration & CSS Generator
 *
 * To add a new accent color:
 * 1. Add a color entry to ACCENT_COLORS below
 * 2. Add a <button> to the accent picker in index.html
 * 3. Add the color name to the inline flash-prevention script array in index.html
 *
 * ── Color property reference ──────────────────────────────────────────────
 *
 * swatch            Settings accent picker swatch (small color button)
 *
 * light {           Light-mode overrides
 *   success         --success variable: text, icons, active tab color, links
 *   rgb / customBg  --success-bg: header bar, tab pills, card badges, nav active state
 *   hoverOpacity /  --success-bg-hover: hover state for the above elements
 *     customBgHover
 *   borderRgb,      --success-border: header bar border, active tab borders
 *     borderOpacity
 * }
 *
 * dark {            Dark-mode overrides (same properties as light)
 *   ...
 * }
 *
 * reader {          Reader page text highlights (saved highlights)
 *   lightRgb,       Light-mode highlight background
 *     lightOpacity
 *     / customLight
 *   darkRgba        Dark-mode highlight background
 *     / customDark
 * }
 *
 * focusRgba         Focus-mode reader highlight background
 *
 * fabBg             (optional) Override for the floating action button (+ button)
 *                   If omitted, FAB uses var(--success) from light/dark
 */

const ACCENT_COLORS = {
  yellow: {
    swatch: "#f2df9f",
    light: {
      success: "#8a6b00",
      rgb: "242, 223, 159",
      bgOpacity: [0.32, 0.5],
      hoverOpacity: [0.42, 0.62],
      borderRgb: "138, 107, 0",
      borderOpacity: 0.32,
    },
    dark: {
      success: "#f2df9f",
      rgb: "242, 223, 159",
      bgOpacity: [0.2, 0.34],
      hoverOpacity: [0.28, 0.44],
      borderRgb: "242, 223, 159",
      borderOpacity: 0.45,
    },
    reader: {
      lightRgb: "255, 226, 138",
      lightOpacity: [0.35, 0.92],
      darkRgba: "rgba(255, 232, 156, 0.84)",
    },
    focusRgba: "rgba(242, 223, 159, 0.45)",
  },
  green: {
    swatch: "#2aaa73",
    light: {
      success: "#2aaa73",
      rgb: "42, 170, 115",
      bgOpacity: [0.12, 0.22],
      hoverOpacity: [0.18, 0.3],
      borderRgb: "42, 170, 115",
      borderOpacity: 0.28,
    },
    dark: {
      success: "#b4f7cf",
      rgb: "180, 247, 207",
      bgOpacity: [0.16, 0.28],
      hoverOpacity: [0.24, 0.38],
      borderRgb: "180, 247, 207",
      borderOpacity: 0.4,
    },
    reader: {
      lightRgb: "42, 170, 115",
      lightOpacity: [0.18, 0.36],
      darkRgba: "rgba(192, 252, 218, 0.58)",
    },
    focusRgba: "rgba(180, 247, 207, 0.35)",
  },
  red: {
    swatch: "#de4c42",
    light: {
      success: "#de4c42",
      rgb: "222, 76, 66",
      bgOpacity: [0.14, 0.26],
      hoverOpacity: [0.22, 0.34],
      borderRgb: "222, 76, 66",
      borderOpacity: 0.34,
    },
    dark: {
      success: "#ffaaa6",
      rgb: "255, 170, 166",
      bgOpacity: [0.18, 0.3],
      hoverOpacity: [0.26, 0.42],
      borderRgb: "255, 170, 166",
      borderOpacity: 0.46,
    },
    reader: {
      lightRgb: "222, 76, 66",
      lightOpacity: [0.2, 0.38],
      darkRgba: "rgba(255, 184, 180, 0.62)",
    },
    focusRgba: "rgba(222, 76, 66, 0.35)",
  },
  orange: {
    swatch: "#e88a3a",
    light: {
      success: "#c06a1a",
      rgb: "232, 138, 58",
      bgOpacity: [0.16, 0.3],
      hoverOpacity: [0.24, 0.38],
      borderRgb: "192, 106, 26",
      borderOpacity: 0.34,
    },
    dark: {
      success: "#f5b87a",
      rgb: "245, 184, 122",
      bgOpacity: [0.2, 0.34],
      hoverOpacity: [0.28, 0.44],
      borderRgb: "245, 184, 122",
      borderOpacity: 0.48,
    },
    reader: {
      lightRgb: "232, 138, 58",
      lightOpacity: [0.22, 0.4],
      darkRgba: "rgba(245, 184, 122, 0.64)",
    },
    focusRgba: "rgba(232, 138, 58, 0.35)",
  },
  purple: {
    swatch: "#8a74c7",
    light: {
      success: "#7c5cbf",
      rgb: "138, 116, 199",
      bgOpacity: [0.16, 0.3],
      hoverOpacity: [0.24, 0.38],
      borderRgb: "124, 92, 191",
      borderOpacity: 0.34,
    },
    dark: {
      success: "#c4aaff",
      rgb: "196, 170, 255",
      bgOpacity: [0.2, 0.34],
      hoverOpacity: [0.28, 0.44],
      borderRgb: "196, 170, 255",
      borderOpacity: 0.48,
    },
    reader: {
      lightRgb: "138, 116, 199",
      lightOpacity: [0.22, 0.4],
      darkRgba: "rgba(196, 170, 255, 0.62)",
    },
    focusRgba: "rgba(138, 116, 199, 0.4)",
  },
  rainbow: {
    swatch:
      "linear-gradient(135deg, #ee4444, #eeaa33, #44bb44, #3388ee, #8844cc)",
    light: {
      success: "#d44090",
      customBg:
        "linear-gradient(135deg, rgba(238,68,68,0.14), rgba(238,170,51,0.14), rgba(68,187,68,0.14), rgba(51,136,238,0.14), rgba(136,68,204,0.14))",
      customBgHover:
        "linear-gradient(135deg, rgba(238,68,68,0.22), rgba(238,170,51,0.22), rgba(68,187,68,0.22), rgba(51,136,238,0.22), rgba(136,68,204,0.22))",
      borderRgb: "212, 64, 144",
      borderOpacity: 0.32,
    },
    dark: {
      success: "#f0a0d0",
      customBg:
        "linear-gradient(135deg, rgba(255,120,120,0.18), rgba(255,200,100,0.18), rgba(120,230,120,0.18), rgba(100,170,255,0.18), rgba(180,120,240,0.18))",
      customBgHover:
        "linear-gradient(135deg, rgba(255,120,120,0.28), rgba(255,200,100,0.28), rgba(120,230,120,0.28), rgba(100,170,255,0.28), rgba(180,120,240,0.28))",
      borderRgb: "240, 160, 208",
      borderOpacity: 0.44,
    },
    reader: {
      customLight: "rgba(212, 64, 144, 0.22)",
      customDark: "rgba(240, 160, 208, 0.5)",
    },
    focusRgba: "rgba(212, 64, 144, 0.35)",
    fabBg:
      "linear-gradient(135deg, #ee4444, #eeaa33, #44bb44, #3388ee, #8844cc)",
  },
};

export const VALID_ACCENT_NAMES = Object.keys(ACCENT_COLORS);

export function isValidAccent(name) {
  return VALID_ACCENT_NAMES.includes(name);
}

function grad(rgb, o1, o2) {
  return `linear-gradient(180deg, rgba(${rgb}, ${o1}), rgba(${rgb}, ${o2}))`;
}

export function injectAccentStyles() {
  const rules = [];

  // Swatch CSS variables
  const vars = Object.entries(ACCENT_COLORS)
    .map(([name, c]) => {
      // For gradient swatches, we can't use a simple hex — store a fallback
      if (c.swatch.startsWith("linear-gradient")) {
        return `  --highlight-${name}: ${c.light.success};`;
      }
      return `  --highlight-${name}: ${c.swatch};`;
    })
    .join("\n");
  rules.push(`:root {\n${vars}\n}`);

  for (const [name, color] of Object.entries(ACCENT_COLORS)) {
    const { light: l, dark: d, reader: r, focusRgba } = color;

    // Theme overrides — light
    rules.push(
      `html[data-highlight-color="${name}"] {\n` +
        `  --success: ${l.success};\n` +
        `  --success-bg: ${l.customBg || grad(l.rgb, l.bgOpacity[0], l.bgOpacity[1])};\n` +
        `  --success-bg-hover: ${l.customBgHover || grad(l.rgb, l.hoverOpacity[0], l.hoverOpacity[1])};\n` +
        `  --success-border: rgba(${l.borderRgb}, ${l.borderOpacity});\n` +
        `}`,
    );

    // Theme overrides — dark
    rules.push(
      `html[data-theme="dark"][data-highlight-color="${name}"] {\n` +
        `  --success: ${d.success};\n` +
        `  --success-bg: ${d.customBg || grad(d.rgb, d.bgOpacity[0], d.bgOpacity[1])};\n` +
        `  --success-bg-hover: ${d.customBgHover || grad(d.rgb, d.hoverOpacity[0], d.hoverOpacity[1])};\n` +
        `  --success-border: rgba(${d.borderRgb}, ${d.borderOpacity});\n` +
        `}`,
    );

    // Reader highlights — light
    rules.push(
      `html[data-highlight-color="${name}"] .reader-highlight {\n` +
        `  background: ${r.customLight || grad(r.lightRgb, r.lightOpacity[0], r.lightOpacity[1])};\n` +
        `}`,
    );

    // Reader highlights — dark
    rules.push(
      `html[data-theme="dark"][data-highlight-color="${name}"] .reader-highlight {\n` +
        `  background: ${r.customDark || r.darkRgba};\n` +
        `  box-shadow: none;\n` +
        `}`,
    );

    // Focus-mode highlights
    rules.push(
      `.focus-mode-overlay[data-highlight-color="${name}"] .reader-highlight {\n` +
        `  background: ${focusRgba};\n` +
        `}`,
    );

    // Settings swatch button
    const swatchBg = color.swatch.startsWith("linear-gradient")
      ? color.swatch
      : `var(--highlight-${name})`;
    rules.push(
      `.settings-segmented--colors .settings-segmented__btn--${name} {\n` +
        `  background: ${swatchBg};\n` +
        `}`,
    );

    // FAB button override (e.g. rainbow gradient)
    if (color.fabBg) {
      rules.push(
        `html[data-highlight-color="${name}"] .desktop-fab,\n` +
          `html[data-highlight-color="${name}"] .dialog-close-fab {\n` +
          `  background: ${color.fabBg};\n` +
          `}`,
      );
    }

    // Settings tile preview — light
    rules.push(
      `.display-option-grid--accent .display-option-tile[data-display-highlight="${name}"] {\n` +
        `  background: ${l.customBg || grad(l.rgb, l.bgOpacity[0], l.bgOpacity[1])};\n` +
        `  border-color: rgba(${l.borderRgb}, ${l.borderOpacity});\n` +
        `}`,
    );

    // Settings tile preview — dark
    rules.push(
      `html[data-theme="dark"] .display-option-grid--accent .display-option-tile[data-display-highlight="${name}"] {\n` +
        `  background: ${d.customBg || grad(d.rgb, d.bgOpacity[0], d.bgOpacity[1])};\n` +
        `  border-color: rgba(${d.borderRgb}, ${d.borderOpacity});\n` +
        `}`,
    );
  }

  const style = document.createElement("style");
  style.id = "accent-color-styles";
  style.textContent = rules.join("\n");
  document.head.appendChild(style);

  // Generate swatch buttons into the settings accent picker
  const container = document.querySelector(".settings-segmented--colors");
  if (container) {
    container.innerHTML = "";
    for (const name of VALID_ACCENT_NAMES) {
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `settings-segmented__btn settings-segmented__btn--${name}`;
      btn.dataset.displayHighlight = name;
      btn.setAttribute("aria-label", label);
      container.appendChild(btn);
    }
  }
}
