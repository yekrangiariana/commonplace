/**
 * Search Service - FlexSearch wrapper for fast full-text search
 * Provides unified search across bookmarks and projects.
 */

let flexSearchIndex = null;
let isIndexReady = false;
// Store documents for retrieval since FlexSearch Index only returns IDs
let documentStore = new Map();

/**
 * Initialize FlexSearch index - loads from IndexedDB or rebuilds from data
 * @param {Array} bookmarks - Array of bookmark objects
 * @param {Array} projects - Array of project objects
 */
export async function initSearchIndex(bookmarks = [], projects = []) {
  // FlexSearch is loaded via CDN in index.html
  if (typeof FlexSearch === "undefined") {
    console.warn("FlexSearch not loaded - search disabled");
    return;
  }

  // Always rebuild fresh on init to ensure consistency
  await rebuildIndex(bookmarks, projects);
}

/**
 * Rebuild the entire search index from scratch
 */
export async function rebuildIndex(bookmarks = [], projects = []) {
  if (typeof FlexSearch === "undefined") {
    return;
  }

  // Clear document store
  documentStore.clear();

  // Use simpler Index for more reliable results
  flexSearchIndex = new FlexSearch.Index({
    tokenize: "forward",
    resolution: 9,
    cache: 100,
  });

  // Index bookmarks
  for (const bookmark of bookmarks) {
    const doc = bookmarkToSearchDoc(bookmark);
    const searchText = `${doc.title} ${doc.content} ${doc.tags}`;
    flexSearchIndex.add(doc.id, searchText);
    documentStore.set(doc.id, doc);
  }

  // Index projects
  for (const project of projects) {
    const doc = projectToSearchDoc(project);
    const searchText = `${doc.title} ${doc.content}`;
    flexSearchIndex.add(doc.id, searchText);
    documentStore.set(doc.id, doc);
  }

  isIndexReady = true;
  console.log(`Search index built: ${bookmarks.length} bookmarks, ${projects.length} projects`);
}

/**
 * Flatten blocks to text (inline to avoid circular import)
 */
function flattenBlocksToText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks.map((block) => block?.text || "").join(" ");
}

/**
 * Convert bookmark to search document
 * Indexes: title, description, body content, tags, highlights
 */
function bookmarkToSearchDoc(bookmark) {
  const tags = (bookmark.tags || []).join(" ");
  
  // Get full body content from blocks
  const bodyText = flattenBlocksToText(bookmark.blocks);
  
  // Get highlight texts
  const highlightTexts = (bookmark.highlights || [])
    .map((h) => h.text || "")
    .join(" ");
  
  // Combine all searchable content
  const content = [
    bookmark.description || "",
    bodyText,
    highlightTexts,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id: bookmark.id,
    type: "bookmark",
    title: bookmark.title || "",
    content,
    tags,
    preview: bookmark.previewText || bookmark.description || "",
  };
}

/**
 * Convert project to search document
 * Indexes: name, description, and markdown content body
 */
function projectToSearchDoc(project) {
  // Project content is the markdown body
  const bodyContent = project.content || "";
  
  const content = [
    project.description || "",
    bodyContent,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    id: project.id,
    type: "project",
    title: project.name || "",
    content,
    preview: project.description || project.name || "",
  };
}

/**
 * Add or update a bookmark in the search index
 */
export function updateBookmarkInIndex(bookmark) {
  if (!flexSearchIndex || !isIndexReady) {
    return;
  }

  const doc = bookmarkToSearchDoc(bookmark);
  const searchText = `${doc.title} ${doc.content} ${doc.tags}`;

  // Remove old entry if exists
  try {
    flexSearchIndex.remove(doc.id);
  } catch {
    // May not exist
  }

  // Add new entry
  flexSearchIndex.add(doc.id, searchText);
  documentStore.set(doc.id, doc);
}

/**
 * Add or update a project in the search index
 */
export function updateProjectInIndex(project) {
  if (!flexSearchIndex || !isIndexReady) {
    return;
  }

  const doc = projectToSearchDoc(project);
  const searchText = `${doc.title} ${doc.content}`;

  // Remove old entry if exists
  try {
    flexSearchIndex.remove(doc.id);
  } catch {
    // May not exist
  }

  // Add new entry
  flexSearchIndex.add(doc.id, searchText);
  documentStore.set(doc.id, doc);
}

/**
 * Remove a document from the search index
 */
export function removeFromIndex(id) {
  if (!flexSearchIndex || !isIndexReady) {
    return;
  }

  try {
    flexSearchIndex.remove(id);
    documentStore.delete(id);
  } catch {
    // Document may not exist
  }
}

/**
 * Search the index
 * @param {string} query - Search query
 * @param {Object} options - Search options
 * @param {number} options.limit - Max results (default 50)
 * @param {string} options.type - Filter by type: 'bookmark', 'project', or null for all
 * @returns {Array} Array of { id, type, title, preview } objects
 */
export function search(query, options = {}) {
  if (!flexSearchIndex || !isIndexReady || !query?.trim()) {
    return [];
  }

  const { limit = 50, type = null } = options;
  const trimmedQuery = query.trim();

  try {
    // Search returns array of matching IDs
    const matchingIds = flexSearchIndex.search(trimmedQuery, {
      limit: limit * 2,
    });

    // Look up documents from our store
    let results = [];
    for (const id of matchingIds) {
      const doc = documentStore.get(id);
      if (doc) {
        results.push({
          id: doc.id,
          type: doc.type,
          title: doc.title,
          preview: doc.preview,
        });
      }
    }

    // Filter by type if specified
    if (type) {
      results = results.filter((doc) => doc.type === type);
    }

    return results.slice(0, limit);
  } catch (err) {
    console.error("Search error:", err);
    return [];
  }
}

/**
 * Check if search index is ready
 */
export function isSearchReady() {
  return isIndexReady;
}

/**
 * Get indexed document count (for debugging)
 */
export function getIndexedDocumentCount() {
  return documentStore.size;
}
