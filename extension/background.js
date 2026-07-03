// Background Service Worker using cross-browser standard extensions API
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULTS = {
  appUrl: 'https://yekrangiariana.github.io/commonplace/index.html',
  openBehavior: 'focus'
};

// Clean URLs by removing query parameters and hashes for comparison
function cleanUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    // Ignore query parameters and hashes
    return u.origin + u.pathname;
  } catch (e) {
    // Fallback for file:/// URLs or malformed URLs
    return url.split('?')[0].split('#')[0];
  }
}

// Flash extension badge text as user feedback
async function flashBadge(text, color) {
  try {
    await browserAPI.action.setBadgeText({ text });
    await browserAPI.action.setBadgeBackgroundColor({ color });
    setTimeout(async () => {
      await browserAPI.action.setBadgeText({ text: '' });
    }, 1500);
  } catch (e) {
    console.error('Failed to flash badge:', e);
  }
}

// Core function to add a link to the Commonplace app
async function addLinkToCommonplace(url, title, type) {
  const settings = await browserAPI.storage.local.get(DEFAULTS);
  const baseAppUrl = settings.appUrl;
  const openBehavior = settings.openBehavior;

  // Build target URL with parameters matching PWA share target format
  const encodedUrl = encodeURIComponent(url);
  const encodedTitle = encodeURIComponent(title || url);
  const targetUrl = `${baseAppUrl}?shared_url=${encodedUrl}&shared_title=${encodedTitle}`;

  try {
    // Check if Commonplace is already open in any tab
    const tabs = await browserAPI.tabs.query({});
    const cleanedBaseAppUrl = cleanUrl(baseAppUrl);
    
    let existingTab = null;
    for (const tab of tabs) {
      if (cleanUrl(tab.url) === cleanedBaseAppUrl) {
        existingTab = tab;
        break;
      }
    }

    if (existingTab && openBehavior === 'focus') {
      // Focus existing tab and navigate it to trigger consumeShareTarget()
      await browserAPI.tabs.update(existingTab.id, {
        url: targetUrl,
        active: true
      });
      await browserAPI.windows.update(existingTab.windowId, {
        focused: true
      });
      await flashBadge('OK', '#2aaa73'); // Green success
      return { success: true };
    } else {
      // Launch new instance based on preferences
      if (openBehavior === 'tab') {
        await browserAPI.tabs.create({ url: targetUrl });
      } else {
        // 'pwa' or 'focus' (as fallback when tab is not open): open standalone popup window
        await browserAPI.windows.create({
          url: targetUrl,
          type: 'popup',
          width: 1100,
          height: 750
        });
      }
      await flashBadge('OK', '#2aaa73'); // Green success
      return { success: true };
    }
  } catch (error) {
    console.error('Error adding link to Commonplace:', error);
    await flashBadge('ERR', '#c0392b'); // Red error
    return { success: false, error: error.message };
  }
}

// Set up Context Menus on Installation
browserAPI.runtime.onInstalled.addListener(() => {
  // Page context menu
  browserAPI.contextMenus.create({
    id: 'add-current-page',
    title: 'Add Current Page to Commonplace',
    contexts: ['page']
  });

  // Link context menu
  browserAPI.contextMenus.create({
    id: 'add-link',
    title: 'Add Link to Commonplace',
    contexts: ['link']
  });
});

// Handle Context Menu Actions
browserAPI.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'add-current-page') {
    const url = info.pageUrl || tab?.url;
    const title = tab?.title || url;
    if (url) {
      await addLinkToCommonplace(url, title, 'article');
    }
  } else if (info.menuItemId === 'add-link') {
    const url = info.linkUrl;
    if (url) {
      // Use URL as placeholder title for context-menu links
      await addLinkToCommonplace(url, url, 'article');
    }
  }
});

// Handle Keyboard Shortcuts / Commands
browserAPI.commands.onCommand.addListener(async (command) => {
  if (command === 'add-current-page') {
    try {
      const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) {
        await addLinkToCommonplace(tab.url, tab.title, 'article');
      }
    } catch (err) {
      console.error('Command capture failed:', err);
    }
  }
});

// Message listener for popup communication
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'addLink') {
    // Process async link creation
    (async () => {
      const result = await addLinkToCommonplace(message.url, message.title, message.type);
      sendResponse(result);
    })();
    return true; // Keep message channel open for async response
  }
});
