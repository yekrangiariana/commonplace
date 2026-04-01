/**
 * Swipe Navigation for Touch Devices
 * Enables swiping between main tabs: rss → library → projects → settings
 */

// Tab order for swipe navigation (reader excluded - it's a detail view)
const TAB_ORDER = ["rss", "library", "projects", "settings"];

// Swipe thresholds
const MIN_SWIPE_DISTANCE = 50; // Minimum pixels to trigger swipe
const MAX_SWIPE_TIME = 300; // Max milliseconds for a valid swipe
const HORIZONTAL_RATIO = 1.5; // Must be this much more horizontal than vertical
const ANIMATION_DURATION = 120; // ms

let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;
let isSwiping = false;
let isAnimating = false;

/**
 * Initialize swipe navigation
 * @param {Function} switchTabFn - The switchTab function from main.js
 * @param {Function} getActiveTabFn - Function that returns current active tab
 */
export function initSwipeNavigation(switchTabFn, getActiveTabFn) {
  // Only enable on touch devices
  if (!("ontouchstart" in window)) {
    return;
  }

  const appMain = document.querySelector(".app-main");
  if (!appMain) return;

  appMain.addEventListener("touchstart", handleTouchStart, { passive: true });
  appMain.addEventListener("touchend", (e) =>
    handleTouchEnd(e, switchTabFn, getActiveTabFn),
  );
}

function handleTouchStart(e) {
  if (isAnimating) return;
  const touch = e.touches[0];
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  touchStartTime = Date.now();
  isSwiping = true;
}

function handleTouchEnd(e, switchTabFn, getActiveTabFn) {
  if (!isSwiping || isAnimating) return;
  isSwiping = false;

  const touch = e.changedTouches[0];
  const deltaX = touch.clientX - touchStartX;
  const deltaY = touch.clientY - touchStartY;
  const deltaTime = Date.now() - touchStartTime;

  // Check if it's a valid horizontal swipe
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);

  // Must be horizontal enough and fast enough
  if (
    absX < MIN_SWIPE_DISTANCE ||
    deltaTime > MAX_SWIPE_TIME ||
    absX < absY * HORIZONTAL_RATIO
  ) {
    return;
  }

  const activeTab = getActiveTabFn();

  // Don't swipe in reader view (use back button instead)
  if (activeTab === "reader") {
    return;
  }

  const currentIndex = TAB_ORDER.indexOf(activeTab);
  if (currentIndex === -1) return;

  // Swipe left = next tab (direction 1), swipe right = previous tab (direction -1)
  const direction = deltaX < 0 ? 1 : -1;
  const newIndex = currentIndex + direction;

  // Bounds check
  if (newIndex < 0 || newIndex >= TAB_ORDER.length) {
    return;
  }

  const newTab = TAB_ORDER[newIndex];
  animateTransition(activeTab, newTab, direction, switchTabFn);
}

/**
 * Animate the tab transition
 * @param {string} fromTab - Current tab ID
 * @param {string} toTab - Target tab ID
 * @param {number} direction - 1 for left, -1 for right
 * @param {Function} switchTabFn - Tab switch function
 */
function animateTransition(fromTab, toTab, direction, switchTabFn) {
  isAnimating = true;

  const fromPanel = document.querySelector(`[data-tab-panel="${fromTab}"]`);
  const toPanel = document.querySelector(`[data-tab-panel="${toTab}"]`);

  if (!fromPanel || !toPanel) {
    switchTabFn(toTab);
    isAnimating = false;
    return;
  }

  // Prepare the incoming panel
  toPanel.classList.add("is-active");
  toPanel.classList.add(
    direction > 0 ? "swipe-enter-right" : "swipe-enter-left",
  );

  // Animate the outgoing panel
  fromPanel.classList.add(
    direction > 0 ? "swipe-exit-left" : "swipe-exit-right",
  );

  // After animation, clean up and switch
  setTimeout(() => {
    // Remove animation classes
    fromPanel.classList.remove("swipe-exit-left", "swipe-exit-right");
    toPanel.classList.remove("swipe-enter-left", "swipe-enter-right");

    // Now do the actual tab switch (which handles state, URL, etc.)
    switchTabFn(toTab);
    isAnimating = false;
  }, ANIMATION_DURATION);
}
