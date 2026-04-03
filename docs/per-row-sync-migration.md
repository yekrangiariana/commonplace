# Per-Row Sync Migration Plan

Migration from blob-based sync (one `sync_data` row per user) to proper per-row
Supabase tables with simple LWW conflict resolution.

**Goal:** Fast, reliable cross-device sync without the complexity of per-field
merge. IndexedDB stays on the client. Only the Supabase schema and sync logic change.

---

## New Supabase Schema

Six tables replace the single `sync_data` table:

### `bookmarks`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | Client-generated UUID |
| user_id | UUID FK → auth.users | RLS filter |
| title | TEXT | |
| url | TEXT | |
| description | TEXT | |
| source | TEXT | |
| published_at | TIMESTAMPTZ | |
| preview_text | TEXT | |
| image_url | TEXT | |
| fetched_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |
| tweet_html | TEXT | |
| blocks | JSONB | Array of content blocks |
| tags | JSONB | String array |
| project_ids | JSONB | String array |
| highlights | JSONB | Array of highlight objects |
| last_opened_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | Server-managed via trigger |
| _deleted | BOOLEAN DEFAULT false | Soft delete |

### `projects`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| user_id | UUID FK → auth.users | |
| name | TEXT | |
| description | TEXT | |
| content | TEXT | Markdown editor content |
| stage | TEXT | idea / research / done |
| created_at | TIMESTAMPTZ | |
| last_opened_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | Trigger-managed |
| _deleted | BOOLEAN DEFAULT false | |

### `rss_feeds`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| user_id | UUID FK → auth.users | |
| feed_url | TEXT | |
| title | TEXT | |
| folder | TEXT | |
| items | JSONB | Array of feed items |
| last_fetched_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | Trigger-managed |
| _deleted | BOOLEAN DEFAULT false | |

### `user_settings`
| Column | Type | Notes |
|--------|------|-------|
| user_id | UUID PK FK → auth.users | One row per user |
| settings | JSONB | All synced settings as object |
| updated_at | TIMESTAMPTZ | Trigger-managed |

Settings blob contains: `savedTags`, `displayFont`, `theme`,
`displayHighlightColor`, `splashEnabled`, `autoTagEnabled`,
`autoTagUseDefaultCountries`, `autoTagCustomRules`, `ttsVoiceId`, `ttsRate`,
`libraryView`, `librarySort`, `libraryShowImages`, `libraryShowTags`,
`projectsView`, `projectsSort`, `rssView`, `rssSort`, `rssReadFilter`,
`rssRetentionDays`, `rssAutoRefreshMinutes`.

### Triggers

Each table with `updated_at` gets an auto-update trigger:

```sql
CREATE EXTENSION IF NOT EXISTS moddatetime SCHEMA extensions;

CREATE TRIGGER update_bookmarks_updated_at
  BEFORE UPDATE ON bookmarks
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');
-- (repeat for projects, rss_feeds, user_settings)
```

### RLS Policies

All tables get the same pattern:
```sql
ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own bookmarks"
  ON bookmarks FOR ALL USING (user_id = auth.uid());
-- (repeat for each table)
```

### Realtime Publication

```sql
ALTER PUBLICATION supabase_realtime
  ADD TABLE bookmarks, projects, rss_feeds, user_settings;
```

---

## Conflict Resolution: LWW Per Row

Every row has a server-managed `updated_at` timestamp.

- **Push**: client sends `updated_at` from its local copy. Supabase only applies
  the upsert if the client's `updated_at >= server's updated_at` (or row doesn't
  exist). This is a simple conditional upsert.
- **Pull**: `SELECT * FROM bookmarks WHERE user_id = ? AND updated_at > ?` — only
  fetch rows changed since last pull.
- **Delete**: set `_deleted = true`. Client filters out deleted rows locally.
  Periodic cleanup (e.g., 30 days) can hard-delete old soft-deleted rows.
- **Conflict**: last write wins. No per-field merge. If two devices edit the same
  bookmark, the one that pushes last wins entirely.

This is a trade-off: simpler, faster, but less granular than per-field merge.
For a personal app across 2-3 devices, conflicts are rare enough that LWW is
the pragmatic choice.

---

## What Changes (by file)

### supabaseClient.js
- [ ] **Remove** `fetchSyncData()` and `upsertSyncData()`
- [ ] **Add** per-table CRUD functions:
  - `fetchBookmarks(since)` → GET with `updated_at > since` filter
  - `upsertBookmark(bookmark)` → POST single row
  - `upsertBookmarks(bookmarks)` → POST batch
  - `deleteBookmark(id)` → PATCH `_deleted = true`
  - Same pattern for projects, rss_feeds
  - `fetchSettings()` → GET user_settings row
  - `upsertSettings(settings)` → POST user_settings row
- [ ] Keep all auth functions untouched

### cloudSync.js
- [ ] **Rewrite `pullSync`**:
  - Fetch each table with `updated_at > lastPullTimestamp`
  - Apply remote rows directly (LWW: if remote.updated_at > local.updated_at, use remote)
  - Much simpler — no mergeAll call
- [ ] **Rewrite `pushSyncNow`**:
  - Read dirty flags to know which tables changed
  - Push only changed items (not entire collections)
  - Track which individual items are dirty (new concept — see below)
- [ ] **Rewrite `forcePull`/`forcePush`**:
  - forcePull: fetch all rows (no since filter), replace local
  - forcePush: upsert all local rows to cloud
- [ ] **Remove** `mergeSync` (no merge concept — it's just pull + push)
- [ ] Keep `applyRemoteSyncData`, `initSyncUI`, `startAutoPull` mostly as-is
- [ ] Keep scheduling (debounce/cooldown) as-is

### syncMerge.js
- [ ] **Delete entirely** — no longer needed

### syncClock.js
- [ ] Keep as-is (used for `updated_at` stamping on client side)

### realtimeSync.js
- [ ] **Update subscription** to listen on all four tables
- [ ] Listen for INSERT, UPDATE, DELETE (not just UPDATE)
- [ ] Callback still triggers a pull — no change to the outer flow

### state.js
- [ ] **Remove** `bumpItemSync()` — no longer needed (server `updated_at` trigger handles it)
- [ ] **Remove** `stampSettingKey()` — not needed (settings is one LWW row)
- [ ] **Remove** `recordTombstone()` — soft delete in DB handles this
- [ ] **Remove** `_tombstones` and `_metaTimestamps` from state defaults
- [ ] Keep dirty flags (essential for knowing what to push)
- [ ] **Add** per-item dirty tracking (see below)

### storage.js
- [ ] **Remove** `_tombstones` and `_metaTimestamps` from serialization
- [ ] Rest stays as-is

### main.js, contextMenu.js, taxonomy.js, highlighter.js, editor.js, ttsPlayer.js
- [ ] **Remove all `bumpItemSync()` calls** (~16 call sites)
- [ ] **Remove all `stampSettingKey()` calls** (~15 call sites)
- [ ] **Remove all `recordTombstone()` calls** (~5 call sites)
- [ ] `touchBookmarks/touchProjects/touchRss` calls stay (dirty flags)
- [ ] `persistState` calls stay

---

## New Concept: Per-Item Dirty Tracking

Current system pushes the entire blob. New system needs to know which specific
items changed since last push. Two approaches:

### Option A: Dirty set (simple)
State gets `__dirtyBookmarkIds: Set()`, `__dirtyProjectIds: Set()`, etc.
When a bookmark is mutated, its ID is added to the dirty set.
On push, only upsert items in the dirty set. Clear after successful push.

### Option B: `updated_at` comparison (simpler)
Each item gets a local `updated_at` field (client-side, stamped on edit).
On push, compare each item's `updated_at` vs `lastPushTimestamp`.
Push items where `updated_at > lastPushTimestamp`.

**Recommendation: Option A** — it's explicit, no timestamp comparison needed,
and dirty sets are already partially in place via the scope-level dirty flags.

---

## Migration Path (for existing users)

Users currently have data in the `sync_data` table. Migration steps:

1. **Create new tables** in Supabase (SQL above)
2. **Write a one-time migration** in the client: on first boot after update,
   if `sync_data` row exists, read it, split into per-row inserts, write to
   new tables, then soft-delete the `sync_data` row
3. After migration period, drop `sync_data` table

---

## Implementation Order

1. **SQL**: Create new tables, triggers, RLS, publication (Supabase dashboard)
2. **supabaseClient.js**: Add new CRUD functions (keep old ones temporarily)
3. **cloudSync.js**: Rewrite pull/push to use new functions
4. **realtimeSync.js**: Update subscriptions
5. **state.js**: Add dirty ID sets, remove sync field helpers
6. **Cleanup**: Remove bumpItemSync/stampSettingKey/recordTombstone calls
7. **Delete**: syncMerge.js, old supabaseClient functions
8. **Migration**: One-time blob → per-row migration for existing users
9. **Test**: Cross-device sync end-to-end

---

## Performance Impact

| Aspect | Before (blob) | After (per-row) |
|--------|---------------|-----------------|
| Push size | Entire state (~100KB+) | Single changed row (~1KB) |
| Pull size | Entire state | Only changed rows |
| Boot pull | Full blob parse | Incremental (nothing if up-to-date) |
| Main thread | JSON parse of full blob | Minimal (small payloads) |
| Conflict resolution | Complex merge engine | Simple timestamp comparison |
| Realtime latency | Same (one UPDATE trigger) | Same (per-table triggers) |

---

## What We Lose

- **Per-field merge**: if device A edits tags and device B edits title on the
  same bookmark simultaneously, one device's change wins entirely (LWW). Previously,
  both changes would merge.
- **Union arrays**: tag additions on two devices won't auto-merge. Last push wins.

For a personal app used on 2-3 devices (rarely simultaneously), this trade-off
is acceptable. True simultaneous edits to the same item are extremely rare in
practice.
