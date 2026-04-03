-- Per-Row Sync Schema for Commonplace
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor)

-- 1. Enable moddatetime extension for auto-updating updated_at
CREATE EXTENSION IF NOT EXISTS moddatetime SCHEMA extensions;

-- 2. Create tables

CREATE TABLE IF NOT EXISTS bookmarks (
  id         TEXT        NOT NULL,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title      TEXT,
  url        TEXT,
  description TEXT,
  source     TEXT,
  published_at TIMESTAMPTZ,
  preview_text TEXT,
  image_url  TEXT,
  fetched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  tweet_html TEXT,
  blocks     JSONB       DEFAULT '[]'::jsonb,
  tags       JSONB       DEFAULT '[]'::jsonb,
  project_ids JSONB      DEFAULT '[]'::jsonb,
  highlights JSONB       DEFAULT '[]'::jsonb,
  last_opened_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  _deleted   BOOLEAN     DEFAULT false,
  PRIMARY KEY (id, user_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT        NOT NULL,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT,
  description TEXT,
  content     TEXT,
  stage       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  last_opened_at TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  _deleted    BOOLEAN     DEFAULT false,
  PRIMARY KEY (id, user_id)
);

CREATE TABLE IF NOT EXISTS rss_feeds (
  id             TEXT        NOT NULL,
  user_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feed_url       TEXT,
  title          TEXT,
  folder         TEXT,
  items          JSONB       DEFAULT '[]'::jsonb,
  last_fetched_at TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ DEFAULT now(),
  _deleted       BOOLEAN     DEFAULT false,
  PRIMARY KEY (id, user_id)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id    UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  settings   JSONB       DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Auto-update triggers (updated_at set on every UPDATE)

CREATE TRIGGER update_bookmarks_updated_at
  BEFORE UPDATE ON bookmarks
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');

CREATE TRIGGER update_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');

CREATE TRIGGER update_rss_feeds_updated_at
  BEFORE UPDATE ON rss_feeds
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');

CREATE TRIGGER update_user_settings_updated_at
  BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');

-- 4. Row Level Security

ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own bookmarks"
  ON bookmarks FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own projects"
  ON projects FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

ALTER TABLE rss_feeds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own rss_feeds"
  ON rss_feeds FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own settings"
  ON user_settings FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- 5. Publish tables for Realtime

ALTER PUBLICATION supabase_realtime ADD TABLE bookmarks, projects, rss_feeds, user_settings;

-- 6. Indexes for incremental pull queries

CREATE INDEX IF NOT EXISTS idx_bookmarks_user_updated
  ON bookmarks (user_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_projects_user_updated
  ON projects (user_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_rss_feeds_user_updated
  ON rss_feeds (user_id, updated_at);
