/*
Paste this script into the browser DevTools console while the app is open.
It seeds IndexedDB with large synthetic data for performance testing.

Default payload:
- 10,000 bookmarks (with tags, projects, imageUrl, and lorem ipsum body text)
- 200 RSS feeds
- 10,000 RSS items total by default (50 items per feed, configurable)
- 600 projects with seeded descriptions and markdown draft content

Tested against DB: bookmark-manager-db (v5)
Stores: bookmarks, projects, meta, rssFeeds, rssItems, imageCache, kv
*/

(async () => {
  const CONFIG = {
    ARTICLE_COUNT: 10000,
    PROJECT_COUNT: 600,
    TAG_POOL_SIZE: 300,
    RSS_FEED_COUNT: 200,
    RSS_ITEMS_PER_FEED: 50,
    HIGHLIGHT_EVERY_N_ARTICLES: 2,
    RESET_EXISTING: true,
    BATCH_SIZE: 500,
    DB_NAME: "bookmark-manager-db",
    DB_VERSION: 5,
  };

  const STORE = {
    BOOKMARKS: "bookmarks",
    PROJECTS: "projects",
    META: "meta",
    RSS_FEEDS: "rssFeeds",
    RSS_ITEMS: "rssItems",
    IMAGE_CACHE: "imageCache",
  };

  const META_KEY = "appMeta";

  const REQUIRED_STORES = [STORE.BOOKMARKS, STORE.PROJECTS, STORE.META];

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const LOREM_SENTENCES = [
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
    "Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
    "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.",
    "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.",
    "Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.",
    "Integer posuere erat a ante venenatis dapibus posuere velit aliquet.",
    "Curabitur blandit tempus porttitor and praesent commodo cursus magna vel scelerisque nisl consectetur.",
    "Aenean lacinia bibendum nulla sed consectetur and vivamus sagittis lacus vel augue laoreet rutrum faucibus dolor auctor.",
    "Maecenas faucibus mollis interdum and donec sed odio dui.",
    "Etiam porta sem malesuada magna mollis euismod and nullam id dolor id nibh ultricies vehicula ut id elit.",
  ];

  const tinySvg = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="100%" height="100%" fill="#d9e2ec"/><text x="24" y="56" font-family="Georgia" font-size="28" fill="#334e68">Bookmark Test Image</text></svg>',
  );
  const sharedImageUrl = `data:image/svg+xml;utf8,${tinySvg}`;

  function openDb(name, version) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, version);

      req.onerror = () => reject(req.error || new Error("Failed to open DB"));
      req.onupgradeneeded = () => {
        // App should own schema creation. We do not mutate schema here.
      };
      req.onsuccess = () => resolve(req.result);
    });
  }

  function txComplete(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Transaction failed"));
      tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
    });
  }

  async function clearStores(db, storeNames) {
    const tx = db.transaction(storeNames, "readwrite");

    for (const storeName of storeNames) {
      tx.objectStore(storeName).clear();
    }

    await txComplete(tx);
  }

  async function putBatch(db, storeName, records) {
    if (!records.length) {
      return;
    }

    const tx = db.transaction([storeName], "readwrite");
    const store = tx.objectStore(storeName);

    for (const record of records) {
      store.put(record);
    }

    await txComplete(tx);
  }

  async function putInChunks(db, storeName, records, batchSize, label) {
    const total = records.length;

    for (let i = 0; i < total; i += batchSize) {
      const chunk = records.slice(i, i + batchSize);
      await putBatch(db, storeName, chunk);

      const written = Math.min(i + chunk.length, total);
      if (written % (batchSize * 5) === 0 || written === total) {
        console.log(`${label}: ${written}/${total}`);
      }
    }
  }

  function makeId(prefix, n) {
    return `${prefix}-${String(n).padStart(6, "0")}`;
  }

  function randomPick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function randomDistinct(arr, count) {
    const set = new Set();
    while (set.size < count) {
      set.add(randomPick(arr));
    }
    return [...set];
  }

  function buildLoremParagraph(seed, sentenceCount = 4) {
    const parts = [];

    for (let i = 0; i < sentenceCount; i += 1) {
      parts.push(LOREM_SENTENCES[(seed + i) % LOREM_SENTENCES.length]);
    }

    return parts.join(" ");
  }

  function buildLoremParagraphs(seed, paragraphCount = 3, sentenceCount = 4) {
    return Array.from({ length: paragraphCount }, (_, index) =>
      buildLoremParagraph(seed + index * 2, sentenceCount),
    );
  }

  function buildProjectContent(projectNumber, stage, seed) {
    const paragraphs = buildLoremParagraphs(seed, 3, 4);
    return [
      `# Project ${projectNumber}`,
      "",
      `Stage: ${stage}`,
      "",
      paragraphs[0],
      "",
      paragraphs[1],
      "",
      paragraphs[2],
    ].join("\n");
  }

  function buildHighlightsForBlocks(articleId, blocks, createdAt, n) {
    if (CONFIG.HIGHLIGHT_EVERY_N_ARTICLES <= 0) {
      return [];
    }

    if (n % CONFIG.HIGHLIGHT_EVERY_N_ARTICLES !== 0) {
      return [];
    }

    const block1 = blocks[0]?.text || "";
    const block2 = blocks[1]?.text || "";
    const text = `${block1}\n\n${block2}`;

    if (!text) {
      return [];
    }

    const firstStart = Math.min(8, Math.max(text.length - 12, 0));
    const firstEnd = Math.min(firstStart + 52, text.length);
    const secondStart = Math.min(
      block1.length + 2,
      Math.max(text.length - 20, 0),
    );
    const secondEnd = Math.min(secondStart + 56, text.length);

    const highlights = [
      {
        id: `highlight-${articleId}-1`,
        start: firstStart,
        end: firstEnd,
        quote: text.slice(firstStart, firstEnd).trim(),
        createdAt,
      },
    ];

    if (n % (CONFIG.HIGHLIGHT_EVERY_N_ARTICLES * 3) === 0) {
      highlights.push({
        id: `highlight-${articleId}-2`,
        start: secondStart,
        end: secondEnd,
        quote: text.slice(secondStart, secondEnd).trim(),
        createdAt,
      });
    }

    return highlights.filter((h) => h.quote && h.end > h.start);
  }

  try {
    const db = await openDb(CONFIG.DB_NAME, CONFIG.DB_VERSION);

    const missingStores = REQUIRED_STORES.filter(
      (name) => !db.objectStoreNames.contains(name),
    );

    if (missingStores.length) {
      db.close();
      throw new Error(`Missing expected stores: ${missingStores.join(", ")}.`);
    }

    const hasDedicatedRssStores =
      db.objectStoreNames.contains(STORE.RSS_FEEDS) &&
      db.objectStoreNames.contains(STORE.RSS_ITEMS);

    if (!hasDedicatedRssStores) {
      console.warn(
        "Dedicated RSS stores are missing. Using legacy meta.rssFeeds fallback for seeding.",
      );
    }

    if (CONFIG.RESET_EXISTING) {
      console.log("Clearing existing app data...");
      const clearTargets = [STORE.BOOKMARKS, STORE.PROJECTS, STORE.META];

      if (hasDedicatedRssStores) {
        clearTargets.push(STORE.RSS_FEEDS, STORE.RSS_ITEMS);
      }

      if (db.objectStoreNames.contains(STORE.IMAGE_CACHE)) {
        clearTargets.push(STORE.IMAGE_CACHE);
      }

      await clearStores(db, clearTargets);
    }

    console.log("Building synthetic projects/tags...");

    const tagPool = Array.from(
      { length: CONFIG.TAG_POOL_SIZE },
      (_, i) => `tag-${String(i + 1).padStart(3, "0")}`,
    );

    const projects = Array.from({ length: CONFIG.PROJECT_COUNT }, (_, i) => {
      const id = makeId("project", i + 1);
      const createdAt = new Date(
        now - (CONFIG.PROJECT_COUNT - i) * 3600 * 1000,
      ).toISOString();
      const stage = i % 3 === 0 ? "idea" : i % 3 === 1 ? "research" : "done";
      return {
        id,
        name: `Project ${i + 1}`,
        description: buildLoremParagraph(i, 3),
        content: buildProjectContent(i + 1, stage, i),
        stage,
        articleIds: [],
        createdAt,
        updatedAt: createdAt,
      };
    });

    const projectIds = projects.map((p) => p.id);
    const projectById = new Map(
      projects.map((project) => [project.id, project]),
    );

    console.log("Building synthetic bookmarks...");

    const bookmarks = Array.from({ length: CONFIG.ARTICLE_COUNT }, (_, i) => {
      const n = i + 1;
      const id = makeId("article", n);
      const createdAt = new Date(now - i * 60 * 1000).toISOString();
      const publishedAt = new Date(now - i * dayMs).toISOString();
      const tagCount = 2 + (n % 4);
      const projectCount = n % 7 === 0 ? 2 : 1;
      const tags = randomDistinct(tagPool, tagCount).sort();
      const projectSelection = randomDistinct(projectIds, projectCount);
      const articleUrl = `https://example.com/?article=${n}`;
      const articleParagraphs = buildLoremParagraphs(n, 3, 4);

      const blocks = [
        {
          id: `b-${id}-1`,
          type: "paragraph",
          text: articleParagraphs[0],
        },
        {
          id: `b-${id}-2`,
          type: "paragraph",
          text: articleParagraphs[1],
        },
        {
          id: `b-${id}-3`,
          type: "paragraph",
          text: articleParagraphs[2],
        },
      ];
      const highlights = buildHighlightsForBlocks(id, blocks, createdAt, n);

      for (const pid of projectSelection) {
        const p = projectById.get(pid);
        if (p) {
          p.articleIds.push(id);
          p.updatedAt = createdAt;
        }
      }

      return {
        id,
        url: articleUrl,
        title: `Performance Test Article ${n}`,
        source: `Synthetic Source ${(n % 25) + 1}`,
        description: buildLoremParagraph(n + 20, 2),
        author: `Author ${(n % 40) + 1}`,
        publishedAt,
        createdAt,
        updatedAt: createdAt,
        lastOpenedAt: n % 3 === 0 ? createdAt : "",
        tags,
        projectIds: projectSelection,
        imageUrl: sharedImageUrl,
        previewText: buildLoremParagraph(n + 40, 2),
        blocks,
        highlights,
      };
    });

    const bookmarkUrlByIndex = bookmarks.map((b) => b.url);
    const savedTagsFromBookmarks = [
      ...new Set(
        bookmarks.flatMap((bookmark) =>
          Array.isArray(bookmark.tags) ? bookmark.tags : [],
        ),
      ),
    ].sort();

    console.log("Building synthetic RSS feeds/items...");

    const rssFeeds = [];
    const rssItems = [];
    const legacyRssFeeds = [];
    const totalRssItemsTarget =
      CONFIG.RSS_FEED_COUNT * CONFIG.RSS_ITEMS_PER_FEED;

    console.log(`Target RSS items: ${totalRssItemsTarget}`);

    for (let i = 0; i < CONFIG.RSS_FEED_COUNT; i += 1) {
      const feedNo = i + 1;
      const feedId = makeId("feed", feedNo);
      const folder = `Folder ${((feedNo - 1) % 120) + 1}`;
      const fetchedAt = new Date(now - i * 15 * 60 * 1000).toISOString();
      const feedUrl = `https://example.com/?feed=${feedNo}`;

      const feedItems = [];

      rssFeeds.push({
        id: feedId,
        url: feedUrl,
        title: `Synthetic Feed ${feedNo}`,
        folder,
        lastFetchedAt: fetchedAt,
        itemsVersion: 1,
      });

      for (let j = 0; j < CONFIG.RSS_ITEMS_PER_FEED; j += 1) {
        const itemNo = j + 1;
        const articleNo = feedNo * 10 + itemNo;
        const bookmarkIdx = (feedNo + itemNo - 2) % bookmarkUrlByIndex.length;
        const linkedBookmarkUrl = bookmarkUrlByIndex[bookmarkIdx];
        const url =
          linkedBookmarkUrl ||
          `https://example.com/?feed=${feedNo}&item=${itemNo}`;
        const canonicalUrl = url;
        const rssExcerpt = buildLoremParagraph(feedNo + itemNo, 3);

        const nextItem = {
          key: `${feedId}::${canonicalUrl}`,
          feedId,
          id: `rss-item-${feedNo}-${itemNo}`,
          url,
          canonicalUrl,
          title: `Feed ${feedNo} Item ${itemNo}`,
          excerpt: rssExcerpt,
          pubDate: new Date(now - articleNo * 3600 * 1000).toISOString(),
          author: `RSS Author ${(articleNo % 60) + 1}`,
          thumbnail: sharedImageUrl,
          lastOpenedAt: "",
        };

        rssItems.push(nextItem);
        feedItems.push({
          id: nextItem.id,
          url: nextItem.url,
          canonicalUrl: nextItem.canonicalUrl,
          title: nextItem.title,
          excerpt: nextItem.excerpt,
          pubDate: nextItem.pubDate,
          author: nextItem.author,
          thumbnail: nextItem.thumbnail,
          lastOpenedAt: nextItem.lastOpenedAt,
        });
      }

      legacyRssFeeds.push({
        id: feedId,
        url: feedUrl,
        title: `Synthetic Feed ${feedNo}`,
        folder,
        lastFetchedAt: fetchedAt,
        itemsVersion: 1,
        items: feedItems,
      });
    }

    const appMeta = {
      key: META_KEY,
      savedTags: savedTagsFromBookmarks,
      selectedArticleId: bookmarks[0]?.id || null,
      selectedProjectId: null,
      selectedProjectSidebarArticleId: null,
      projectShowMarkdown: false,
      activeTab: "library",
      libraryTagFilters: [],
      libraryProjectFilters: [],
      libraryView: "2",
      librarySort: "newest",
      libraryShowImages: true,
      libraryShowTags: true,
      projectsStageFilter: null,
      projectsView: "2",
      projectsSort: "newest",
      settingsSection: "display",
      autoTagEnabled: true,
      autoTagUseDefaultCountries: true,
      autoTagCustomRules: [],
      displayFont: "mono",
      theme: "light",
      displayHighlightColor: "green",
      ttsVoiceId: "",
      ttsRate: 1,
      rssActiveFeedId: rssFeeds[0]?.id || null,
      rssFolderFilter: "",
      rssView: "2",
      rssSort: "newest",
      rssRetentionDays: "never",
      ...(hasDedicatedRssStores ? {} : { rssFeeds: legacyRssFeeds }),
    };

    console.time("seed-total");

    console.log("Writing bookmarks...");
    await putInChunks(
      db,
      STORE.BOOKMARKS,
      bookmarks,
      CONFIG.BATCH_SIZE,
      "bookmarks",
    );

    console.log("Writing projects...");
    await putInChunks(
      db,
      STORE.PROJECTS,
      projects,
      CONFIG.BATCH_SIZE,
      "projects",
    );

    if (hasDedicatedRssStores) {
      console.log("Writing RSS feeds...");
      await putInChunks(
        db,
        STORE.RSS_FEEDS,
        rssFeeds,
        CONFIG.BATCH_SIZE,
        "rssFeeds",
      );

      console.log("Writing RSS items...");
      await putInChunks(
        db,
        STORE.RSS_ITEMS,
        rssItems,
        CONFIG.BATCH_SIZE,
        "rssItems",
      );
    } else {
      console.log("Writing RSS feeds into legacy meta.rssFeeds...");
    }

    console.log("Writing app meta...");
    await putBatch(db, STORE.META, [appMeta]);

    console.timeEnd("seed-total");

    console.log("Seeding complete.", {
      bookmarks: bookmarks.length,
      projects: projects.length,
      rssFeeds: rssFeeds.length,
      rssItems: rssItems.length,
      rssItemsTarget: totalRssItemsTarget,
      highlightedArticles: bookmarks.filter(
        (b) => (b.highlights || []).length > 0,
      ).length,
      rssStorageMode: hasDedicatedRssStores
        ? "dedicated-stores"
        : "legacy-meta-rssFeeds",
      retention: appMeta.rssRetentionDays,
    });

    db.close();
    console.log("Reload the page to hydrate the seeded dataset.");
  } catch (error) {
    console.error("Seed failed:", error);
  }
})();
