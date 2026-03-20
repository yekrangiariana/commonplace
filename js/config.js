import { DEFAULT_FETCH_TIMEOUT_MS } from "./state.js";

export async function hydrateRuntimeConfig(runtimeConfig) {
  try {
    const response = await fetch("./app-settings.json", { cache: "no-store" });

    if (!response.ok) {
      return;
    }

    const settings = await response.json();
    runtimeConfig.fetchServiceUrl = (settings.fetchServiceUrl || "").trim();
    runtimeConfig.supabaseAnonKey = (settings.supabaseAnonKey || "").trim();
    runtimeConfig.requestTimeoutMs =
      Number(settings.requestTimeoutMs) || DEFAULT_FETCH_TIMEOUT_MS;
    runtimeConfig.appVersion = (
      settings.appVersion || runtimeConfig.appVersion
    ).trim();
    runtimeConfig.appDescription = (settings.appDescription || "").trim();
    runtimeConfig.suggestedFeeds = Array.isArray(settings.suggestedFeeds)
      ? settings.suggestedFeeds
      : [];
  } catch {
    // Optional settings file. Missing file keeps defaults.
  }
}
