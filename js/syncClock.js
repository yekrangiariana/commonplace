/**
 * Sync Clock — derives a rough server-time offset from HTTP Date headers.
 *
 * All sync timestamps go through syncNow() so devices with drifting clocks
 * converge on the same reference frame. Even a coarse correction (±1 s)
 * dramatically reduces "my removal came back" races.
 */

let offsetMs = 0;

/**
 * Call after any Supabase response to refine the offset.
 * @param {string|null} dateHeader - value of the HTTP `Date` header
 */
export function updateClockOffset(dateHeader) {
  if (!dateHeader) return;
  const serverMs = new Date(dateHeader).getTime();
  if (Number.isNaN(serverMs)) return;
  offsetMs = serverMs - Date.now();
}

/**
 * Return the current server-adjusted ISO timestamp.
 */
export function syncNow() {
  return new Date(Date.now() + offsetMs).toISOString();
}

/**
 * Current offset in ms (for diagnostics only).
 */
export function getClockOffsetMs() {
  return offsetMs;
}
