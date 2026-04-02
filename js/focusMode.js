export function createFocusModeController(deps) {
  const {
    dom,
    state,
    getActiveReaderArticle,
    getLibraryReadingOrder,
    markArticleAsOpened,
    renderAndSyncUrl,
    applyDisplayPreferences,
    getIsApplyingRoute,
    setIsApplyingRoute,
    onSelectionDetected,
  } = deps;

  let pendingFocusModePage = null;

  const focusModeState = {
    currentPage: 0,
    totalPages: 1,
    pageWidth: 0,
    verticalWheelDelta: 0,
    touchStartX: 0,
    touchStartY: 0,
    textSize: 100,
    theme: "black",
    columnMode: "double",
  };

  function getFocusModeContentMarkup() {
    const activeArticle = getActiveReaderArticle();
    const title =
      activeArticle?.title || dom.readerTitle?.textContent || "Reading";
    const safeTitle = String(title)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");

    return `<h1 class="focus-mode-content-title">${safeTitle}</h1>${dom.readerSurface.innerHTML}`;
  }

  function attachEventHandlers() {
    dom.readerFocusButton?.addEventListener("click", () => {
      open();
    });

    dom.focusModeClose?.addEventListener("click", () => {
      close();
    });

    const focusModeReadingToggle = document.getElementById(
      "focus-mode-reading-toggle",
    );
    const focusModeReadingMenu = document.getElementById(
      "focus-mode-reading-menu",
    );

    if (focusModeReadingToggle && focusModeReadingMenu) {
      focusModeReadingToggle.addEventListener("click", () => {
        focusModeReadingMenu.hidden = !focusModeReadingMenu.hidden;
      });

      const fontOptions = focusModeReadingMenu.querySelectorAll(
        ".focus-mode-font-option",
      );
      fontOptions.forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const font = e.target.dataset.font;
          if (font && ["mono", "sans", "guardian", "josefin"].includes(font)) {
            state.displayFont = font;
            applyDisplayPreferences();
            refreshReadingMenu();
          }
        });
      });

      const themeOptions = focusModeReadingMenu.querySelectorAll(
        ".focus-mode-theme-option",
      );
      themeOptions.forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const theme = e.target.dataset.focusTheme;
          if (theme === "black" || theme === "paper") {
            focusModeState.theme = theme;
            applyTheme();
            refreshReadingMenu();
          }
        });
      });

      const layoutOptions = focusModeReadingMenu.querySelectorAll(
        ".focus-mode-layout-option",
      );
      layoutOptions.forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const layout = e.target.dataset.focusLayout;
          if (["single", "double"].includes(layout)) {
            focusModeState.columnMode = layout;
            refreshReadingMenu();
            if (isOpen()) {
              calculatePages();
            }
          }
        });
      });

      document.addEventListener("click", (event) => {
        if (
          !focusModeReadingMenu.hidden &&
          !event.target.closest(".focus-mode-setting-group")
        ) {
          focusModeReadingMenu.hidden = true;
        }
      });
    }

    const focusModeSizeUp = document.getElementById("focus-mode-size-up");
    const focusModeSizeDown = document.getElementById("focus-mode-size-down");

    if (focusModeSizeUp) {
      focusModeSizeUp.addEventListener("click", () => {
        if (focusModeState.textSize < 200) {
          focusModeState.textSize = Math.min(200, focusModeState.textSize + 10);
          updateTextSize();
        }
      });
    }

    if (focusModeSizeDown) {
      focusModeSizeDown.addEventListener("click", () => {
        if (focusModeState.textSize > 80) {
          focusModeState.textSize = Math.max(80, focusModeState.textSize - 10);
          updateTextSize();
        }
      });
    }

    document.addEventListener("keydown", (event) => {
      if (!isOpen()) {
        return;
      }

      if (event.key === "Escape") {
        close();
      } else if (event.key === "ArrowLeft") {
        prevPage();
      } else if (event.key === "ArrowRight") {
        nextPage();
      }
    });

    window.addEventListener("resize", () => {
      if (isOpen()) {
        calculatePages();
      }
    });

    document.addEventListener("selectionchange", () => {
      if (!isOpen()) {
        return;
      }

      setTimeout(() => {
        const selection = window.getSelection();
        if (selection && selection.toString().trim()) {
          onSelectionDetected?.();
        }
      }, 10);
    });
  }

  function open(options = {}) {
    if (!dom.focusModeOverlay || !dom.focusModeContent || !dom.readerSurface) {
      return;
    }

    const {
      initialPage = 0,
      pushHistory = true,
      replaceHistory = false,
    } = options;

    dom.focusModeContent.innerHTML = getFocusModeContentMarkup();

    const highlightColor =
      document.documentElement.getAttribute("data-highlight-color") || "green";
    dom.focusModeOverlay.setAttribute("data-highlight-color", highlightColor);
    applyTheme();

    dom.focusModeOverlay.hidden = false;
    document.body.style.overflow = "hidden";

    focusModeState.currentPage = Math.max(0, initialPage);
    focusModeState.verticalWheelDelta = 0;
    pendingFocusModePage = focusModeState.currentPage;

    const focusModeReadingMenu = document.getElementById(
      "focus-mode-reading-menu",
    );
    if (focusModeReadingMenu) {
      focusModeReadingMenu.hidden = true;
    }

    refreshReadingMenu();
    updateTextSize();

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        calculatePages();

        if (pushHistory || replaceHistory) {
          syncRoute({ replace: replaceHistory });
        }
      });
    });

    dom.focusModeContentWrapper?.addEventListener(
      "touchstart",
      handleTouchStart,
      { passive: true },
    );
    dom.focusModeContentWrapper?.addEventListener("touchend", handleTouchEnd);
    dom.focusModeContentWrapper?.addEventListener("wheel", handleWheel, {
      passive: false,
    });
  }

  function close(options = {}) {
    if (!dom.focusModeOverlay) {
      return;
    }

    const { skipRouteSync = false } = options;

    dom.focusModeOverlay.hidden = true;
    document.body.style.overflow = "";
    focusModeState.verticalWheelDelta = 0;
    pendingFocusModePage = null;

    if (!skipRouteSync) {
      syncRoute({ closing: true });
    }

    dom.focusModeContentWrapper?.removeEventListener(
      "touchstart",
      handleTouchStart,
    );
    dom.focusModeContentWrapper?.removeEventListener(
      "touchend",
      handleTouchEnd,
    );
    dom.focusModeContentWrapper?.removeEventListener("wheel", handleWheel);

    if (dom.focusModeContent) {
      dom.focusModeContent.style.transform = "";
      dom.focusModeContent.style.left = "";
      dom.focusModeContent.style.width = "";
      dom.focusModeContent.style.height = "";
    }

    const focusModeReadingMenu = document.getElementById(
      "focus-mode-reading-menu",
    );
    if (focusModeReadingMenu) {
      focusModeReadingMenu.hidden = true;
    }
  }

  function calculatePages() {
    if (!dom.focusModeContentWrapper || !dom.focusModeContent) {
      return;
    }

    const wrapper = dom.focusModeContentWrapper;
    const content = dom.focusModeContent;
    const wrapperStyles = window.getComputedStyle(wrapper);
    const paddingLeft = Number.parseFloat(wrapperStyles.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(wrapperStyles.paddingRight) || 0;

    const viewportWidth = Math.max(
      0,
      wrapper.clientWidth - paddingLeft - paddingRight,
    );
    const viewportHeight = wrapper.clientHeight;

    const columnGap = 48;
    const verticalPadding = 24;

    const columnsPerPage = focusModeState.columnMode === "single" ? 1 : 2;

    const columnWidth =
      (viewportWidth - columnGap * (columnsPerPage - 1)) / columnsPerPage;

    content.style.transform = "none";
    content.style.left = `${paddingLeft}px`;
    content.style.height = `${viewportHeight - verticalPadding * 2}px`;
    content.style.width = `${viewportWidth}px`;
    content.style.padding = `${verticalPadding}px 0`;
    content.style.columnWidth = `${columnWidth}px`;
    content.style.columnGap = `${columnGap}px`;
    content.style.columnFill = "auto";

    void content.offsetHeight;

    const scrollWidth = content.scrollWidth;
    const previousPageWidth = focusModeState.pageWidth;
    const previousOffset = focusModeState.currentPage * previousPageWidth;
    const pageWidth = columnsPerPage * (columnWidth + columnGap);

    const totalPages = Math.max(1, Math.ceil(scrollWidth / pageWidth));

    focusModeState.pageWidth = pageWidth;
    focusModeState.totalPages = totalPages;
    focusModeState.currentPage = Math.max(
      0,
      Math.min(
        totalPages - 1,
        previousPageWidth > 0
          ? Math.round(previousOffset / pageWidth)
          : focusModeState.currentPage,
      ),
    );

    goToPage(focusModeState.currentPage, { updateHistory: false });
  }

  function goToPage(page, options = {}) {
    if (!dom.focusModeContent) return;

    const { updateHistory = true, replaceHistory = false } = options;

    focusModeState.currentPage = Math.max(
      0,
      Math.min(page, focusModeState.totalPages - 1),
    );
    pendingFocusModePage = focusModeState.currentPage;
    const offset = -focusModeState.currentPage * focusModeState.pageWidth;
    dom.focusModeContent.style.transform = `translateX(${offset}px)`;
    updatePageIndicator();

    if (updateHistory) {
      syncRoute({ replace: replaceHistory });
    }
  }

  function prevPage() {
    if (focusModeState.currentPage > 0) {
      goToPage(focusModeState.currentPage - 1);
      return true;
    }

    return openAdjacentArticle(-1, "end");
  }

  function nextPage() {
    if (focusModeState.currentPage < focusModeState.totalPages - 1) {
      goToPage(focusModeState.currentPage + 1);
      return true;
    }

    return openAdjacentArticle(1, "start");
  }

  function updatePageIndicator() {
    if (!dom.focusModePageIndicator) return;
    dom.focusModePageIndicator.textContent = `${focusModeState.currentPage + 1} / ${focusModeState.totalPages}`;
  }

  function syncContent() {
    if (!isOpen() || !dom.focusModeContent || !dom.readerSurface) {
      return;
    }

    const currentPage = focusModeState.currentPage;
    dom.focusModeContent.innerHTML = getFocusModeContentMarkup();

    requestAnimationFrame(() => {
      calculatePages();
      goToPage(Math.min(currentPage, focusModeState.totalPages - 1), {
        updateHistory: false,
      });
    });
  }

  function reconcileWithRoute() {
    if (!dom.focusModeOverlay) {
      return;
    }

    if (pendingFocusModePage == null) {
      if (!dom.focusModeOverlay.hidden) {
        close({ skipRouteSync: true });
      }
      return;
    }

    if (dom.focusModeOverlay.hidden) {
      open({
        initialPage: pendingFocusModePage,
        pushHistory: false,
        replaceHistory: false,
      });
      return;
    }

    const targetPage = pendingFocusModePage;
    syncContent();
    requestAnimationFrame(() => {
      goToPage(Math.min(targetPage, focusModeState.totalPages - 1), {
        updateHistory: false,
      });
    });
  }

  function setPendingPage(page) {
    pendingFocusModePage = page;
  }

  function clearPendingPage() {
    pendingFocusModePage = null;
  }

  function isOpen() {
    return Boolean(dom.focusModeOverlay && !dom.focusModeOverlay.hidden);
  }

  function getCurrentPage() {
    return focusModeState.currentPage;
  }

  function getRoutePageFromSegments(routeHead, segments) {
    if (routeHead === "library" && segments[2] === "f" && segments[3]) {
      const routePage = Number.parseInt(segments[3], 10);
      return Number.isFinite(routePage) ? Math.max(0, routePage - 1) : 0;
    }

    if (routeHead === "rss" && segments[2] === "f" && segments[3]) {
      const routePage = Number.parseInt(segments[3], 10);
      return Number.isFinite(routePage) ? Math.max(0, routePage - 1) : 0;
    }

    if (routeHead === "reader" && segments[1] === "f" && segments[2]) {
      return Math.max(0, (Number.parseInt(segments[2], 10) || 1) - 1);
    }

    return null;
  }

  function getReaderRouteSuffix() {
    return isOpen() ? `/f/${focusModeState.currentPage + 1}` : "";
  }

  function applyTheme() {
    if (!dom.focusModeOverlay) {
      return;
    }

    const theme = focusModeState.theme === "paper" ? "paper" : "black";
    dom.focusModeOverlay.setAttribute("data-focus-theme", theme);
  }

  function refreshReadingMenu() {
    const focusModeReadingMenu = document.getElementById(
      "focus-mode-reading-menu",
    );
    const focusModeSizeLabel = document.getElementById("focus-mode-size-label");

    if (focusModeSizeLabel) {
      focusModeSizeLabel.textContent = `${focusModeState.textSize}%`;
    }

    if (!focusModeReadingMenu) {
      return;
    }

    const fontOptions = focusModeReadingMenu.querySelectorAll(
      ".focus-mode-font-option",
    );
    fontOptions.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.font === state.displayFont);
    });

    const themeOptions = focusModeReadingMenu.querySelectorAll(
      ".focus-mode-theme-option",
    );
    themeOptions.forEach((btn) => {
      btn.classList.toggle(
        "is-active",
        btn.dataset.focusTheme === focusModeState.theme,
      );
    });

    const layoutOptions = focusModeReadingMenu.querySelectorAll(
      ".focus-mode-layout-option",
    );
    layoutOptions.forEach((btn) => {
      btn.classList.toggle(
        "is-active",
        btn.dataset.focusLayout === focusModeState.columnMode,
      );
    });
  }

  function updateTextSize() {
    const focusModeSizeLabel = document.getElementById("focus-mode-size-label");
    const focusModeContent = document.getElementById("focus-mode-content");

    if (focusModeSizeLabel) {
      focusModeSizeLabel.textContent = `${focusModeState.textSize}%`;
    }

    if (focusModeContent) {
      focusModeContent.style.fontSize = `${focusModeState.textSize}%`;
    }
  }

  function getFocusModeBaseHash() {
    const currentHash = window.location.hash || "#reader";
    return currentHash.replace(/\/f\/\d+$/, "");
  }

  function syncRoute(options = {}) {
    const { replace = false, closing = false } = options;

    if (getIsApplyingRoute()) {
      return;
    }

    const baseHash = getFocusModeBaseHash();
    const nextHash = closing
      ? baseHash
      : `${baseHash}/f/${focusModeState.currentPage + 1}`;

    if (window.location.hash === nextHash) {
      return;
    }

    setIsApplyingRoute(true);
    window.history[replace ? "replaceState" : "pushState"]({}, "", nextHash);
    setIsApplyingRoute(false);
  }

  function getAdjacentReadableArticle(direction) {
    if (!state.selectedArticleId) {
      return null;
    }

    const readingOrder = getLibraryReadingOrder(state);
    const currentIndex = readingOrder.findIndex(
      (article) => article.id === state.selectedArticleId,
    );

    if (currentIndex === -1) {
      return null;
    }

    return readingOrder[currentIndex + direction] || null;
  }

  function openAdjacentArticle(direction, edge = "start") {
    const adjacentArticle = getAdjacentReadableArticle(direction);
    if (!adjacentArticle) {
      return false;
    }

    state.selectedArticleId = adjacentArticle.id;
    state.activeTab = "reader";
    markArticleAsOpened(adjacentArticle.id);
    pendingFocusModePage = edge === "end" ? Number.MAX_SAFE_INTEGER : 0;

    renderAndSyncUrl();
    syncContent();

    requestAnimationFrame(() => {
      const targetPage = edge === "end" ? focusModeState.totalPages - 1 : 0;
      pendingFocusModePage = Math.max(0, targetPage);
      goToPage(pendingFocusModePage, { updateHistory: false });
      syncRoute({ replace: true });
    });

    return true;
  }

  function handleTouchStart(e) {
    const touch = e.touches[0];
    focusModeState.touchStartX = touch.clientX;
    focusModeState.touchStartY = touch.clientY;
  }

  function handleTouchEnd(e) {
    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - focusModeState.touchStartX;
    const deltaY = touch.clientY - focusModeState.touchStartY;

    if (Math.abs(deltaX) > 50 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
      if (deltaX < 0) {
        nextPage();
      } else {
        prevPage();
      }
      e.preventDefault();
    }
  }

  function handleWheel(e) {
    const dominantDelta =
      Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;

    if (Math.abs(dominantDelta) < 4) {
      return;
    }

    e.preventDefault();
    focusModeState.verticalWheelDelta += dominantDelta;

    if (focusModeState.verticalWheelDelta >= 70) {
      focusModeState.verticalWheelDelta = 0;
      nextPage();
    } else if (focusModeState.verticalWheelDelta <= -70) {
      focusModeState.verticalWheelDelta = 0;
      prevPage();
    }
  }

  return {
    attachEventHandlers,
    open,
    close,
    calculatePages,
    prevPage,
    nextPage,
    syncContent,
    reconcileWithRoute,
    setPendingPage,
    clearPendingPage,
    isOpen,
    getCurrentPage,
    getRoutePageFromSegments,
    getReaderRouteSuffix,
  };
}
