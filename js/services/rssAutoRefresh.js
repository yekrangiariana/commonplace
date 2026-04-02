const RSS_AUTO_REFRESH_ALLOWED_MINUTES = [1, 5, 10, 15, 30];

export function normalizeRssAutoRefreshMinutes(value) {
  if (value === "off") {
    return "off";
  }

  const minutes = Number(value);

  if (RSS_AUTO_REFRESH_ALLOWED_MINUTES.includes(minutes)) {
    return minutes;
  }

  return "off";
}

export function createRssAutoRefreshController(options) {
  const getIntervalMinutes = options?.getIntervalMinutes || (() => "off");
  const getLastFetchedAtMs = options?.getLastFetchedAtMs || (() => 0);
  const canRefresh = options?.canRefresh || (() => false);
  const onRefresh = options?.onRefresh || (async () => {});

  let timerId = null;
  let visibilityRefreshTimer = null;
  let isStarted = false;
  let isRefreshing = false;

  const clearTimer = () => {
    if (timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
  };

  const scheduleIn = (delayMs) => {
    clearTimer();
    timerId = window.setTimeout(
      () => {
        maybeRefresh("interval");
      },
      Math.max(1000, delayMs),
    );
  };

  const isVisible = () => document.visibilityState === "visible";

  const getIntervalMs = () => {
    const normalized = normalizeRssAutoRefreshMinutes(getIntervalMinutes());

    if (normalized === "off") {
      return 0;
    }

    return normalized * 60 * 1000;
  };

  const scheduleNext = () => {
    clearTimer();

    if (!isStarted || !canRefresh() || !isVisible()) {
      return;
    }

    const intervalMs = getIntervalMs();

    if (!intervalMs) {
      return;
    }

    const lastFetchedAtMs = Number(getLastFetchedAtMs() || 0);

    if (lastFetchedAtMs > 0) {
      const elapsedMs = Date.now() - lastFetchedAtMs;
      const remainingMs = intervalMs - elapsedMs;

      if (remainingMs <= 0) {
        scheduleIn(1000);
        return;
      }

      scheduleIn(remainingMs);
      return;
    }

    // New feeds with no fetch timestamp get a delayed first refresh.
    scheduleIn(intervalMs);
  };

  const maybeRefresh = async (reason) => {
    if (!isStarted || isRefreshing || !canRefresh() || !isVisible()) {
      scheduleNext();
      return;
    }

    const intervalMs = getIntervalMs();

    if (!intervalMs) {
      clearTimer();
      return;
    }

    const lastFetchedAtMs = Number(getLastFetchedAtMs() || 0);

    if (lastFetchedAtMs > 0 && Date.now() - lastFetchedAtMs < intervalMs) {
      scheduleNext();
      return;
    }

    isRefreshing = true;

    try {
      await onRefresh({ reason });
    } finally {
      isRefreshing = false;
      scheduleNext();
    }
  };

  const handleVisibilityChange = () => {
    if (!isStarted) {
      return;
    }

    if (isVisible()) {
      // Delay the refresh so fold/unfold animations complete before any
      // network activity starts, preventing jank on foldable devices.
      if (visibilityRefreshTimer !== null) {
        window.clearTimeout(visibilityRefreshTimer);
      }
      visibilityRefreshTimer = window.setTimeout(() => {
        visibilityRefreshTimer = null;
        void maybeRefresh("visible");
      }, 600);
      return;
    }

    // Page is hidden — cancel any pending visibility refresh and the interval.
    if (visibilityRefreshTimer !== null) {
      window.clearTimeout(visibilityRefreshTimer);
      visibilityRefreshTimer = null;
    }
    clearTimer();
  };

  const handleFocus = () => {
    if (!isStarted) {
      return;
    }

    void maybeRefresh("focus");
  };

  return {
    start() {
      if (isStarted) {
        return;
      }

      isStarted = true;
      document.addEventListener("visibilitychange", handleVisibilityChange);
      window.addEventListener("focus", handleFocus);
      scheduleNext();
    },
    stop() {
      if (!isStarted) {
        return;
      }

      isStarted = false;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    },
    sync() {
      if (!isStarted) {
        return;
      }

      scheduleNext();
    },
  };
}
