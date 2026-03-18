/**
 * Splash-screen typing animation.
 * Self-contained — exposes a Promise-based API for main.js.
 */

export function runSplashTyping() {
  const el = document.getElementById("splash-eyebrow");
  if (!el) return Promise.resolve();

  const text = "Collect, Connect, Compose";
  let charIndex = 0;

  // Add blinking cursor
  const cursor = document.createElement("span");
  cursor.className = "splash-cursor";
  el.appendChild(cursor);

  return new Promise((resolve) => {
    function typeNext() {
      if (charIndex < text.length) {
        // Insert character before the cursor
        cursor.before(text[charIndex]);
        charIndex++;
        // Slight random variance for natural feel
        const delay =
          text[charIndex - 1] === " " ? 60 : 50 + Math.random() * 50;
        setTimeout(typeNext, delay);
      } else {
        // Done typing — hold briefly, remove cursor, then resolve
        setTimeout(() => {
          cursor.remove();
          resolve();
        }, 500);
      }
    }
    // Brief pause before typing starts
    setTimeout(typeNext, 400);
  });
}

export function dismissSplash() {
  const splash = document.getElementById("splash-screen");
  if (!splash) return;
  splash.classList.add("splash-hidden");
  splash.addEventListener("transitionend", () => splash.remove(), {
    once: true,
  });
}
