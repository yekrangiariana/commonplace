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
  } catch {
    // Optional settings file. Missing file keeps defaults.
  }
}
