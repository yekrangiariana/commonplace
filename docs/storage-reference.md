# Storage Reference

This document lists what data the app stores, where it lives, and the key/schema used.

## 1) Runtime Config File (not browser persistence)

Source files:
- `app-settings.json` (local machine file, user-specific)
- `app-settings.example.json` (tracked template)
- Loaded by `js/config.js` into `runtimeConfig` in `js/state.js`

Fields:
- `fetchServiceUrl` (string): Supabase edge function URL for article/RSS fetch proxy.
- `supabaseAnonKey` (string): optional auth header value used when calling fetch service.
- `requestTimeoutMs` (number): request timeout for remote fetch calls.

Notes:
- This file is fetched with `cache: "no-store"` and copied into in-memory runtime config.
- This is configuration, not app content data.

## 2) IndexedDB (primary persistence)

Database:
- Name: `bookmark-manager-db`
- Version: `4`
- Opened/managed in `js/storage.js`

Object stores:

### 2.1 `bookmarks`
Key path: `id`

Stored record shape (bookmark article data), including common fields like:
- `id`, `url`, `title`, `blocks`, `highlights`, `tags`, `projects`
- metadata such as `createdAt`, `updatedAt`, `lastOpenedAt`, `imageUrl`
- derived helper field `previewText` may be added during hydration if missing

Used for:
- Saved library articles and all article-level content/highlights.

### 2.2 `projects`
Key path: `id`

Stored record shape (project data), including:
- `id`, `name`, `description`, `articleIds`, `createdAt`, `updatedAt`
- `stage` (`idea|research|done`, normalized on hydration)

Used for:
- Project taxonomy and article grouping.

### 2.3 `meta`
Key path: `key` with singleton key `appMeta`

Stores app UI/settings state and lightweight metadata, including:
- Selection/navigation:
  - `selectedArticleId`, `selectedProjectId`, `selectedProjectSidebarArticleId`, `activeTab`
- Library filters/display:
  - `libraryTagFilters`, `libraryProjectFilters`, `libraryView`, `librarySort`,
  - `libraryShowImages`, `libraryShowTags`
- Projects page controls:
  - `projectsStageFilter`, `projectsView`, `projectsSort`
- Settings page section:
  - `settingsSection`
- Auto-tagging:
  - `autoTagEnabled`, `autoTagUseDefaultCountries`, `autoTagCustomRules`
- Display/TTS:
  - `displayFont`, `theme`, `displayHighlightColor`, `ttsVoiceId`, `ttsRate`
- RSS UI/settings:
  - `rssActiveFeedId`, `rssFolderFilter`, `rssView`, `rssSort`, `rssRetentionDays`
- Tag cache:
  - `savedTags`

Notes:
- RSS feed payloads are no longer stored in `meta` on current schema (migrated out to dedicated RSS stores).

### 2.4 `rssFeeds`
Key path: `id`

Stored record shape:
- `id`
- `url`
- `title`
- `folder`
- `lastFetchedAt`
- `itemsVersion`

Used for:
- Feed-level metadata and versioning for UI sort memoization.

### 2.5 `rssItems`
Key path: `key`

`key` format:
- `${feedId}::${stableId}`
- `stableId` prefers `canonicalUrl`, then item `id`, then list index fallback.

Stored record shape:
- `key`, `feedId`
- `id`, `url`, `canonicalUrl`
- `title`, `excerpt`, `pubDate`, `author`, `thumbnail`
- `lastOpenedAt`

Used for:
- RSS item payloads separate from `meta`/feed records.

### 2.6 `imageCache`
Key path: `id` (article id)

Stored record shape:
- `id`
- `blob` (compressed image blob when available)

Used for:
- Persistent article image cache for library cards.

### 2.7 `kv` (legacy compatibility store)
Legacy keys:
- `appState` (old monolithic state snapshot)

Used for:
- Backward compatibility migration only.
- Still created/read for migration; no longer primary storage target.

## 3) localStorage (fallback + migration source)

Storage key:
- `bookmark-manager-state-v1` (from `STORAGE_KEY` in `js/state.js`)

Usage:
- Read as fallback if IndexedDB is unavailable or read fails.
- Used as migration source into normalized IndexedDB stores.
- Written as last-resort persistence when IndexedDB writes fail.
- Cleared after successful migration into IndexedDB.

Data shape:
- Full serialized app snapshot (bookmarks/projects/settings/rss/etc.), equivalent to `serializeState` output.

## 4) In-memory only (not persisted)

State fields in `js/state.js` that are runtime-only:
- `pendingSelection`: transient text-selection context for highlighter menu.
- `rssReaderArticle`: transient RSS-opened reader article before explicit library save.

Runtime caches in modules:
- `blobUrlCache` in `js/services/imageCache.js`:
  - Map of `articleId -> objectURL`, LRU-evicted, session lifetime.
- `rssSortedItemsCache` in `js/main.js`:
  - Per-feed/sort memoized arrays for render performance.
- `derivedIndexes` cache in `js/derivedIndexes.js`:
  - Recomputed indexes memoized by persist epoch.
- Pagination state map in `js/pages/pagination.js`:
  - Current page tracking per scope.

## 5) URL State (address bar)

Stored in browser URL hash (not storage APIs), managed in `js/main.js`:
- Example routes: `#add`, `#library`, `#projects`, `#rss`, plus tag/project/article route variants.

Used for:
- Restoring visible page/filters via navigation and deep links.

## 6) Data Retention and Cleanup

RSS retention policy:
- Controlled by `rssRetentionDays` (`7`, `14`, `30`, or `"never"`).
- Applied during hydration and runtime prune flow.
- RSS items older than retention cutoff are removed unless their canonicalized URL matches a saved bookmark URL.

Global reset:
- `clearAllPersistedData()` clears localStorage fallback key and deletes the IndexedDB database.

## 7) Migration Summary

Migration paths implemented in `js/storage.js`:
- Legacy `kv/appState` -> normalized stores (`bookmarks`, `projects`, `meta`, RSS stores).
- Legacy `meta.rssFeeds` -> split into `rssFeeds` + `rssItems`, then removed from meta record.
- localStorage snapshot -> normalized IndexedDB on successful bootstrap.

## 8) Practical "Where is X stored?" Cheatsheet

- Articles/highlights/tags/projects on articles: `IndexedDB.bookmarks`
- Projects and project stage: `IndexedDB.projects`
- UI filters/sorts/theme/TTS/autotag settings: `IndexedDB.meta` (`appMeta`)
- RSS feed definitions: `IndexedDB.rssFeeds`
- RSS item payloads/read markers: `IndexedDB.rssItems`
- Cached card images: `IndexedDB.imageCache` (+ runtime blob URL map)
- Emergency persistence fallback: `localStorage[bookmark-manager-state-v1]`
- Fetch service URL and keys: `app-settings.json` -> runtime config in memory
- Temporary selection/transient reader objects: in-memory only
