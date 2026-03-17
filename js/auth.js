/**
 * Simple client-side authentication module.
 * Credentials are stored in app-settings.json (gitignored).
 * Session is persisted via localStorage.
 */

const AUTH_STORAGE_KEY = "commonplace_auth_session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let authConfig = null;

/**
 * Load auth configuration from app-settings.json
 */
export async function loadAuthConfig() {
  try {
    const response = await fetch("./app-settings.json", { cache: "no-store" });
    if (!response.ok) return null;
    const settings = await response.json();
    authConfig = settings.auth || null;
    return authConfig;
  } catch {
    return null;
  }
}

/**
 * Check if authentication is required (credentials are configured)
 */
export function isAuthRequired() {
  return authConfig && authConfig.username && authConfig.password;
}

/**
 * Check if user is currently authenticated
 */
export function isAuthenticated() {
  if (!isAuthRequired()) return true;

  try {
    const session = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!session) return false;

    const { expiresAt, hash } = JSON.parse(session);
    if (Date.now() > expiresAt) {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      return false;
    }

    // Verify hash matches current credentials
    const expectedHash = simpleHash(authConfig.username + authConfig.password);
    return hash === expectedHash;
  } catch {
    return false;
  }
}

/**
 * Attempt login with provided credentials
 */
export function login(username, password) {
  if (!authConfig) return false;

  const isValid =
    username === authConfig.username && password === authConfig.password;

  if (isValid) {
    const session = {
      expiresAt: Date.now() + SESSION_DURATION_MS,
      hash: simpleHash(authConfig.username + authConfig.password),
    };
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  }

  return isValid;
}

/**
 * Log out and clear session
 */
export function logout() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

/**
 * Simple hash function for session validation
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

/**
 * Initialize login modal behavior
 */
export function initLoginModal(onSuccess) {
  const modal = document.getElementById("login-modal");
  const form = document.getElementById("login-form");
  const errorEl = document.getElementById("login-error");
  const usernameInput = document.getElementById("login-username");
  const passwordInput = document.getElementById("login-password");

  if (!modal || !form) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (login(username, password)) {
      modal.classList.add("login-modal--hidden");
      errorEl.textContent = "";
      usernameInput.value = "";
      passwordInput.value = "";
      if (onSuccess) onSuccess();
    } else {
      errorEl.textContent = "Invalid username or password";
      passwordInput.value = "";
      passwordInput.focus();
    }
  });

  // Focus username input when modal is shown
  usernameInput.focus();
}

/**
 * Show the login modal
 */
export function showLoginModal() {
  const modal = document.getElementById("login-modal");
  if (modal) {
    modal.classList.remove("login-modal--hidden");
    const usernameInput = document.getElementById("login-username");
    if (usernameInput) usernameInput.focus();
  }
}
