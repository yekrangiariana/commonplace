/**
 * Sync Merge Engine
 *
 * Per-item conflict resolution for cloud sync.
 * - Tombstones track deletions so they propagate across devices
 * - Bookmarks use per-field merge (union arrays, per-field timestamp for scalars)
 * - Projects use per-field merge (name, content, stage resolved independently)
 * - Feeds use version-based last-write-wins
 * - Settings use per-key timestamp resolution (latest _metaTimestamps wins)
 */

const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Sync field helpers ──

/**
 * Ensure every item has _sv (sync version) and _su (sync updated) fields.
 * Items without them get version 1 and _su = createdAt or now.
 * Migration-only — for items that existed before sync was added.
 */
export function stampSyncFields(items) {
  const now = new Date().toISOString();
  for (const item of items) {
    if (typeof item._sv !== "number") {
      item._sv = 1;
    }
    if (!item._su) {
      item._su = item.createdAt || now;
    }
  }
  return items;
}

// ── Tombstone helpers ──

export function createEmptyTombstones() {
  return { bookmarks: {}, projects: {}, rssFeeds: {} };
}

export function recordTombstone(tombstones, type, id) {
  if (!tombstones[type]) tombstones[type] = {};
  tombstones[type][id] = new Date().toISOString();
}

/**
 * Merge two tombstone maps. Keep the latest timestamp for each id.
 * Purge entries older than 30 days.
 */
export function mergeTombstones(local, remote) {
  const merged = createEmptyTombstones();
  const cutoff = new Date(Date.now() - TOMBSTONE_MAX_AGE_MS).toISOString();

  for (const type of ["bookmarks", "projects", "rssFeeds"]) {
    const localMap = local?.[type] || {};
    const remoteMap = remote?.[type] || {};
    const allIds = new Set([...Object.keys(localMap), ...Object.keys(remoteMap)]);

    for (const id of allIds) {
      const localTs = localMap[id];
      const remoteTs = remoteMap[id];
      const latest = localTs && remoteTs
        ? (localTs > remoteTs ? localTs : remoteTs)
        : (localTs || remoteTs);

      // Purge old tombstones
      if (latest >= cutoff) {
        merged[type][id] = latest;
      }
    }
  }

  return merged;
}

// ── Array merge core ──

function indexById(items) {
  const map = {};
  for (const item of items) {
    if (item.id) map[item.id] = item;
  }
  return map;
}

function newerTimestamp(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

// ── Per-field timestamp resolution ──

/**
 * For a given field, return the value from whichever side has the newer
 * field-level timestamp (_ft[field]). Falls back to item-level _su.
 */
function pickFieldByTimestamp(local, remote, field) {
  const localFt = local._ft?.[field] || local._su || "";
  const remoteFt = remote._ft?.[field] || remote._su || "";
  return remoteFt > localFt ? remote[field] : local[field];
}

// ── Bookmark per-field merge ──

/** Scalar content fields on bookmarks resolved per-field. */
const BOOKMARK_SCALAR_FIELDS = [
  "title", "url", "description", "source", "publishedAt",
  "previewText", "imageUrl", "fetchedAt", "createdAt",
  "tweetHtml", "blocks",
];

function mergeBookmarkPair(local, remote) {
  const merged = { id: local.id };

  // Per-field resolution for scalar content fields
  for (const field of BOOKMARK_SCALAR_FIELDS) {
    if (local[field] === remote[field]) {
      merged[field] = local[field];
    } else {
      merged[field] = pickFieldByTimestamp(local, remote, field);
    }
  }

  // Union array fields — never lose data
  merged.tags = unionArrays(local.tags, remote.tags);
  merged.projectIds = unionArrays(local.projectIds, remote.projectIds);
  merged.highlights = mergeHighlights(local.highlights, remote.highlights);

  // Take latest timestamps
  merged.lastOpenedAt = newerTimestamp(local.lastOpenedAt, remote.lastOpenedAt);

  // Merge field timestamps
  merged._ft = mergeFieldTimestamps(local._ft, remote._ft);

  // Bump sync version past both
  merged._sv = Math.max(local._sv || 1, remote._sv || 1) + 1;
  merged._su = new Date().toISOString();

  // Carry forward any extra fields (e.g., _rssOrigin, isTransientRss)
  for (const key of Object.keys(local)) {
    if (!(key in merged)) merged[key] = local[key];
  }
  for (const key of Object.keys(remote)) {
    if (!(key in merged)) merged[key] = remote[key];
  }

  return merged;
}

function mergeFieldTimestamps(localFt, remoteFt) {
  if (!localFt && !remoteFt) return undefined;
  const merged = {};
  const allKeys = new Set([
    ...Object.keys(localFt || {}),
    ...Object.keys(remoteFt || {}),
  ]);
  for (const key of allKeys) {
    merged[key] = newerTimestamp(localFt?.[key], remoteFt?.[key]);
  }
  return merged;
}

function unionArrays(a, b) {
  if (!Array.isArray(a) && !Array.isArray(b)) return [];
  if (!Array.isArray(a)) return [...b];
  if (!Array.isArray(b)) return [...a];

  // For string arrays (tags, projectIds)
  if (a.length === 0 && b.length === 0) return [];
  if (typeof a[0] === "string" || typeof b[0] === "string") {
    return [...new Set([...a, ...b])];
  }

  // For object arrays — shouldn't normally hit this path for tags/projectIds
  return [...a, ...b];
}

/**
 * Merge highlights by text+blockIndex identity.
 * If both sides have the same highlight, keep the one with the latest timestamp.
 */
function mergeHighlights(localHL, remoteHL) {
  if (!Array.isArray(localHL) && !Array.isArray(remoteHL)) return [];
  if (!Array.isArray(localHL)) return [...remoteHL];
  if (!Array.isArray(remoteHL)) return [...localHL];

  const seen = new Map();

  for (const h of localHL) {
    const key = highlightKey(h);
    seen.set(key, h);
  }

  for (const h of remoteHL) {
    const key = highlightKey(h);
    if (!seen.has(key)) {
      seen.set(key, h);
    }
    // If both have it, keep the existing (local) — they're the same highlight
  }

  return [...seen.values()];
}

function highlightKey(h) {
  // Use text + blockIndex as identity; fall back to text only
  return `${h.blockIndex ?? ""}:${h.text ?? ""}`;
}

// ── Project per-field merge ──

const PROJECT_SCALAR_FIELDS = ["name", "description", "content", "stage", "createdAt"];

function mergeProjectPair(local, remote) {
  const merged = { id: local.id };

  // Per-field resolution
  for (const field of PROJECT_SCALAR_FIELDS) {
    if (local[field] === remote[field]) {
      merged[field] = local[field];
    } else {
      merged[field] = pickFieldByTimestamp(local, remote, field);
    }
  }

  merged.lastOpenedAt = newerTimestamp(local.lastOpenedAt, remote.lastOpenedAt);
  merged.updatedAt = newerTimestamp(local.updatedAt, remote.updatedAt);
  merged._ft = mergeFieldTimestamps(local._ft, remote._ft);
  merged._sv = Math.max(local._sv || 1, remote._sv || 1) + 1;
  merged._su = new Date().toISOString();

  // Carry forward extra fields
  for (const key of Object.keys(local)) {
    if (!(key in merged)) merged[key] = local[key];
  }
  for (const key of Object.keys(remote)) {
    if (!(key in merged)) merged[key] = remote[key];
  }

  return merged;
}

// ── Feed merge (last-write-wins by version/timestamp) ──

function mergeFeedPair(local, remote) {
  const localV = local._sv || 1;
  const remoteV = remote._sv || 1;

  if (remoteV > localV) return remote;
  if (localV > remoteV) return local;

  const localSu = local._su || local.lastFetchedAt || "";
  const remoteSu = remote._su || remote.lastFetchedAt || "";
  return remoteSu >= localSu ? remote : local;
}

// ── Generic smart merge for an array of items ──

function smartMergeItems(localItems, remoteItems, localTombstones, remoteTombstones, mergePairFn) {
  const localMap = indexById(localItems);
  const remoteMap = indexById(remoteItems);
  const allIds = new Set([
    ...Object.keys(localMap),
    ...Object.keys(remoteMap),
  ]);

  const result = [];

  for (const id of allIds) {
    const local = localMap[id];
    const remote = remoteMap[id];
    const localDel = localTombstones[id];
    const remoteDel = remoteTombstones[id];

    // Both sides deleted → stay deleted
    if (localDel && remoteDel) continue;

    // Remote deleted this item
    if (remoteDel) {
      if (local && local._su && local._su > remoteDel) {
        // Local was edited AFTER remote deleted → resurrect (keep local)
        result.push(local);
      }
      // Otherwise: respect remote deletion
      continue;
    }

    // Local deleted this item
    if (localDel) {
      if (remote && remote._su && remote._su > localDel) {
        // Remote was edited AFTER local deleted → resurrect (keep remote)
        result.push(remote);
      }
      // Otherwise: respect local deletion
      continue;
    }

    // Neither deleted
    if (local && remote) {
      result.push(mergePairFn(local, remote));
    } else if (local) {
      result.push(local);
    } else if (remote) {
      result.push(remote);
    }
  }

  return result;
}

// ── Meta merge (per-key timestamp resolution) ──

/** Settings keys that should be synced with per-key timestamps. */
const SYNCED_SETTINGS_KEYS = [
  "savedTags", "autoTagEnabled", "autoTagUseDefaultCountries", "autoTagCustomRules",
  "displayFont", "theme", "displayHighlightColor", "splashEnabled",
  "ttsVoiceId", "ttsRate", "libraryView", "librarySort", "libraryShowImages",
  "libraryShowTags", "projectsView", "projectsSort", "rssView", "rssSort",
  "rssReadFilter", "rssRetentionDays", "rssAutoRefreshMinutes",
];

function mergeMeta(localMeta, remoteMeta) {
  const localTs = localMeta._metaTimestamps || {};
  const remoteTs = remoteMeta._metaTimestamps || {};
  const merged = {};

  // Per-key resolution: take value from whichever side has the newer timestamp
  for (const key of SYNCED_SETTINGS_KEYS) {
    const localHas = key in localMeta;
    const remoteHas = key in remoteMeta;

    if (localHas && remoteHas) {
      const lt = localTs[key] || "";
      const rt = remoteTs[key] || "";
      merged[key] = rt > lt ? remoteMeta[key] : localMeta[key];
    } else if (localHas) {
      merged[key] = localMeta[key];
    } else if (remoteHas) {
      merged[key] = remoteMeta[key];
    }
  }

  // Merge timestamps — keep latest per key
  const mergedTs = {};
  const allTsKeys = new Set([...Object.keys(localTs), ...Object.keys(remoteTs)]);
  for (const key of allTsKeys) {
    mergedTs[key] = newerTimestamp(localTs[key], remoteTs[key]);
  }
  merged._metaTimestamps = mergedTs;

  return merged;
}

// ── Top-level merge ──

/**
 * Merge local and remote sync data with full conflict resolution.
 *
 * @param {object} localData - { bookmarks, projects, rssFeeds, meta }
 * @param {object} remoteData - { bookmarks, projects, rssFeeds, meta }
 * @returns {{ bookmarks, projects, rssFeeds, meta, tombstones }}
 */
export function mergeAll(localData, remoteData) {
  const localTombstones = localData.meta?._tombstones || createEmptyTombstones();
  const remoteTombstones = remoteData.meta?._tombstones || createEmptyTombstones();

  // Merge tombstones first (purges old entries)
  const mergedTombstones = mergeTombstones(localTombstones, remoteTombstones);

  // Stamp sync fields on items that lack them (migration)
  stampSyncFields(localData.bookmarks || []);
  stampSyncFields(remoteData.bookmarks || []);
  stampSyncFields(localData.projects || []);
  stampSyncFields(remoteData.projects || []);
  stampSyncFields(localData.rssFeeds || []);
  stampSyncFields(remoteData.rssFeeds || []);

  const bookmarks = smartMergeItems(
    localData.bookmarks || [],
    remoteData.bookmarks || [],
    mergedTombstones.bookmarks,
    mergedTombstones.bookmarks,
    mergeBookmarkPair,
  );

  const projects = smartMergeItems(
    localData.projects || [],
    remoteData.projects || [],
    mergedTombstones.projects,
    mergedTombstones.projects,
    mergeProjectPair,
  );

  const rssFeeds = smartMergeItems(
    localData.rssFeeds || [],
    remoteData.rssFeeds || [],
    mergedTombstones.rssFeeds,
    mergedTombstones.rssFeeds,
    mergeFeedPair,
  );

  // Meta: merge settings, attach merged tombstones
  const localMetaClean = { ...(localData.meta || {}) };
  const remoteMetaClean = { ...(remoteData.meta || {}) };
  delete localMetaClean._tombstones;
  delete remoteMetaClean._tombstones;
  const meta = mergeMeta(localMetaClean, remoteMetaClean);
  meta._tombstones = mergedTombstones;

  return { bookmarks, projects, rssFeeds, meta };
}
