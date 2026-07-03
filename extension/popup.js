// Popup logic using cross-browser standard extensions API
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// State
let currentTab = null;
let contentType = 'article'; // 'article' or 'tweet'

// DOM elements
const titleInput = document.getElementById('page-title');
const urlInput = document.getElementById('page-url');
const addBtn = document.getElementById('add-btn');
const settingsBtn = document.getElementById('settings-btn');
const statusText = document.getElementById('status-text');
const typeButtons = document.querySelectorAll('.type-btn');

// Initialize popup
async function init() {
  try {
    // Query active tab in the current window
    const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
    
    if (tab) {
      currentTab = tab;
      
      // Auto-detect if it's a tweet url
      if (isTweetUrl(tab.url)) {
        contentType = 'tweet';
        setActiveTypeButton('tweet');
      }

      // Prefill values
      titleInput.value = tab.title || '';
      urlInput.value = tab.url || '';
    } else {
      showStatus('No active tab detected.', 'error');
    }
  } catch (error) {
    console.error('Error initializing popup:', error);
    showStatus('Failed to retrieve tab metadata.', 'error');
  }
}

// Check if URL is a Twitter/X URL
function isTweetUrl(url) {
  if (!url) return false;
  return /^(https?:\/\/)?(www\.)?(twitter\.com|x\.com)\//i.test(url);
}

// Handle type button toggles
typeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    contentType = btn.getAttribute('data-type');
    setActiveTypeButton(contentType);
  });
});

function setActiveTypeButton(type) {
  typeButtons.forEach(btn => {
    if (btn.getAttribute('data-type') === type) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

// Open settings page
settingsBtn.addEventListener('click', () => {
  if (browserAPI.runtime.openOptionsPage) {
    browserAPI.runtime.openOptionsPage();
  } else {
    window.open(browserAPI.runtime.getURL('options.html'));
  }
});

// Submit/Add to Commonplace
addBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  const title = titleInput.value.trim();

  if (!url) {
    showStatus('URL is required!', 'error');
    return;
  }

  showStatus('Sending to Commonplace...', 'info');
  addBtn.disabled = true;

  try {
    // Send message to background script
    const response = await browserAPI.runtime.sendMessage({
      action: 'addLink',
      url: url,
      title: title,
      type: contentType
    });

    if (response && response.success) {
      showStatus('Link opened in Commonplace!', 'success');
      // Automatically close popup after a short delay
      setTimeout(() => window.close(), 1000);
    } else {
      showStatus(response?.error || 'Failed to open Commonplace.', 'error');
      addBtn.disabled = false;
    }
  } catch (error) {
    console.error('Error sending message:', error);
    showStatus('Failed to connect to extension handler.', 'error');
    addBtn.disabled = false;
  }
});

// Show status messages
function showStatus(text, type) {
  statusText.textContent = text;
  statusText.className = 'show';

  if (type === 'success') {
    statusText.classList.add('success-text');
  } else if (type === 'error') {
    statusText.classList.add('error-text');
  } else {
    statusText.classList.add('info-text');
  }
}

// Run initializer
document.addEventListener('DOMContentLoaded', init);
