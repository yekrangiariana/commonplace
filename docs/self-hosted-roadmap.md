# Roadmap: Self-Hosted Enhancements

This document tracks planned features, enhancements, and extensions for the self-hosted version of Commonplace.

---

## 1. Local Scraper Integration (Edge Functions replacement)
Currently, fetching article text is handled via a mock endpoint (`/functions/v1/fetch-article`).
* **Goal**: Implement a fully local HTML parser and reader view extractor inside the Node.js server.
* **Proposed Stack**: Use `@mozilla/readability` and `jsdom` (or `cheerio` / `puppeteer`) to scrape and parse articles directly on the laptop.
* **Benefit**: Zero external scraping dependencies; fully functional reading extraction offline.

---

## 2. Multi-User Authentication
Although currently designed for a single owner/user, the SQLite database schema is built with `user_id` scoping to support multi-user expandability.
* **Goal**: Enable administrative user creation and secure user accounts.
* **Steps**:
  - Restrict the public registration screen after the initial admin account setup.
  - Implement an admin dashboard section in the UI to invite or add new users.
  - Generate separate scoping for RSS feeds and projects under unique `user_id` hashes.

---

## 3. Browser Extension Support
Extend compatibility to support browser companion extensions.
* **Goal**: Allow browser extensions to save bookmarks directly to the self-hosted server.
* **Steps**:
  - Whitelist client extension protocols inside the server's CORS filters (`Access-Control-Allow-Origin: chrome-extension://...`).
  - Provide an API token generation interface under the user account settings, allowing extensions to authenticate using permanent API tokens instead of session cookies.

---

## 4. Local Backup & Restore Utility
Since all user data is stored inside a single SQLite database file, backups are incredibly easy.
* **Goal**: Automate local daily database backups.
* **Steps**:
  - Write a simple cron or startup hook that copies `data/commonplace.db` to a backup location (`data/backups/commonplace-YYYY-MM-DD.db`).
  - Add an import/export backup action in the dashboard's Settings UI.
