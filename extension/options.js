// Options management script using cross-browser standard extensions API
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Default configuration values
const DEFAULTS = {
  appUrl: 'https://yekrangiariana.github.io/commonplace/index.html',
  openBehavior: 'focus'
};

// DOM elements
const appUrlInput = document.getElementById('app-url');
const openBehaviorSelect = document.getElementById('open-behavior');
const saveBtn = document.getElementById('save-btn');
const statusMsg = document.getElementById('status-msg');

// Load saved settings
async function loadSettings() {
  try {
    const settings = await browserAPI.storage.local.get(DEFAULTS);
    appUrlInput.value = settings.appUrl;
    openBehaviorSelect.value = settings.openBehavior;
  } catch (error) {
    console.error('Failed to load settings:', error);
    showStatus('Failed to load settings.', 'error');
  }
}

// Save settings to local storage
async function saveSettings(e) {
  e.preventDefault();
  
  let appUrl = appUrlInput.value.trim();
  const openBehavior = openBehaviorSelect.value;

  // Simple validation
  if (!appUrl) {
    showStatus('Please enter a valid URL.', 'error');
    return;
  }

  // Auto-prepend scheme if missing
  if (!/^https?:\/\//i.test(appUrl) && !/^file:\/\//i.test(appUrl)) {
    appUrl = 'http://' + appUrl;
    appUrlInput.value = appUrl;
  }

  try {
    await browserAPI.storage.local.set({ appUrl, openBehavior });
    showStatus('Settings saved successfully!', 'success');
  } catch (error) {
    console.error('Failed to save settings:', error);
    showStatus('Failed to save settings.', 'error');
  }
}

// Show a temporary status message
function showStatus(message, type) {
  statusMsg.textContent = message;
  statusMsg.className = `status-msg ${type}`;
  
  // Reset after 3 seconds
  setTimeout(() => {
    statusMsg.className = 'status-msg';
    statusMsg.textContent = '';
  }, 3000);
}

// Bind events
document.addEventListener('DOMContentLoaded', loadSettings);
saveBtn.addEventListener('click', saveSettings);
