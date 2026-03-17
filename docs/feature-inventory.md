## 1. Article capture and ingestion

- Add articles by pasting a URL into the app.
- Fetch article content into a reader-friendly format.
- Pull article metadata automatically, including title, source, publish date, summary text, and article image when available.
- Use a server-side fetch layer through Supabase so article retrieval is more reliable than browser-only scraping.
- Normalise URLs during capture to avoid messy duplicates.
- Add tags and attach projects while saving an article.
- Get suggested tags and projects in the add-article flow.
- Reuse auto-tag suggestions generated from the article content before saving.

## 2. Clean reading experience

- Open saved articles inside an in-app reader.
- Read extracted article text without the clutter of the original webpage.
- See source attribution, publish date, and the date the article was added.
- Open the original source URL in a new tab when needed.
- Choose reading display preferences, including font style, theme, and highlight color.
- Switch between light and dark theme.

## 3. Highlighting and excerpt capture

- Select text directly inside the article reader.
- Create highlights across sentences and paragraphs.
- Save important passages as reusable excerpts.
- See a dedicated highlights list for the current article.
- Remove saved highlights individually.
- Copy the current selection as a note.
- Copy or share selected text directly from the reader selection menu.
- Copy all highlights from an article to the clipboard in one action.

## 4. Text-to-speech reading

- Listen to saved articles with built-in text-to-speech playback.
- Choose from available device voices.
- Adjust playback speed.
- Pause, resume, and seek through the article.
- See playback progress and estimated remaining time.

## 5. Library management

- View all saved articles in a dedicated library.
- Switch between list view, 2-column grid, and 3-column grid.
- Sort by newest, oldest, or most recently opened.
- Filter articles by tags.
- Filter articles by attached projects.
- Combine filters and sort modes to narrow large libraries quickly.
- Show or hide article images in the library view.
- Show or hide tag and project chips on article cards.
- See article cards with title, preview text, source context, tags, projects, image, and highlight count.
- Delete articles directly from the library.
- Use pagination to move through larger collections without overwhelming the interface.

## 6. Tag system

- Apply free-form tags to articles.
- Save and reuse a growing tag library.
- See all known tags in Settings.
- Rename a tag globally across the library.
- Delete a tag globally.
- View how many articles use each tag.
- Click article tags in the reader to filter the library instantly.

## 7. Project-based research organisation

- Create projects to group articles around a writing goal, topic, or research stream.
- Attach one article to multiple projects.
- Open projects as dedicated workspaces.
- Give each project a name, description, and writing draft.
- Track project stage with three workflow states: Idea, Research, and Done.
- Filter project cards by stage.
- Sort project lists by newest, oldest, or most recently opened.
- Switch between project list, 2-column grid, and 3-column grid views.
- See article count and highlight count for each project.
- Preview each project's current draft from the project card.
- Delete projects without leaving orphaned project links on articles.

## 8. Project writing workspace

- Write draft content directly inside a project editor.
- Use Markdown for structured writing.
- Toggle between raw Markdown and rendered preview.
- Use quick Markdown shortcuts for bold, italic, and links.
- View a live project sidebar showing related article highlights.
- Browse all highlights connected to the project across linked articles.
- Open a source article from the project sidebar and read highlighted passages in context.
- Move from research excerpts into synthesis and drafting without leaving the app.

## 9. RSS discovery and monitoring

- Subscribe to RSS feeds from websites, newsletters, or publications.
- Organise feeds into custom folders.
- Refresh the active feed to pull in new items.
- Browse RSS items inside the app instead of leaving to external readers.
- Switch RSS browsing between list view, 2-column grid, and 3-column grid.
- Sort RSS items by newest, oldest, or most recently opened.
- Open RSS items in the same reading experience used for saved articles.
- Save an RSS item into the permanent library when it deserves closer work.
- Maintain a configurable RSS retention window, including an option to keep items indefinitely.

## 10. Bulk actions and power-user workflows

- Use a custom context menu for library and project operations.
- Enter bulk selection mode for articles.
- Select multiple articles at once.
- Add one tag to many articles in one action.
- Add many articles to an existing project in one action.
- Create a new project while bulk-assigning articles.
- Enter bulk selection mode for projects.
- Move multiple projects between workflow stages in one action.
- Select all or clear selection quickly in bulk modes.

## 11. Auto-tagging and smarter organisation

- Automatically suggest tags based on article text.
- Enable or disable auto-tagging globally.
- Use built-in country and geography keyword rules.
- Add custom keyword-to-tag rules.
- Import custom rule sets from JSON.
- Review and delete custom rules in Settings.
- Surface auto-tag suggestions directly in the article add flow.

## 12. Export, persistence, and control of data

- Export all saved articles as JSON.
- Export all projects as JSON.
- Keep app data stored locally in browser storage.
- Persist interface preferences such as views, filters, sort order, theme, and settings section.
- Clear all stored app data when needed.
- Use IndexedDB as the primary storage layer, with fallback support where needed.

## 13. Media and performance conveniences

- Cache article images locally for faster browsing.
- Load images lazily in the library.
- Avoid re-sorting and over-rendering large lists unnecessarily.
- Preserve responsive browsing with pagination and cached list state.

## Differentiators worth highlighting in marketing