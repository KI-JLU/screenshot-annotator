/** Companion base URL + bearer token, persisted in chrome.storage.local. */
import { DEFAULT_BASE_URL, normalizeBaseUrl, type CompanionSettings } from "./api.ts";

const KEY = "wr:companion";

export async function loadSettings(): Promise<CompanionSettings> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<CompanionSettings> | undefined;
  const settings: CompanionSettings = { baseUrl: normalizeBaseUrl(stored?.baseUrl ?? DEFAULT_BASE_URL) };
  if (stored?.token) settings.token = stored.token;
  return settings;
}

export async function saveSettings(settings: CompanionSettings): Promise<void> {
  const value: CompanionSettings = { baseUrl: normalizeBaseUrl(settings.baseUrl) };
  if (settings.token) value.token = settings.token;
  await chrome.storage.local.set({ [KEY]: value });
}

export function onSettingsChanged(cb: (s: CompanionSettings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && KEY in changes) void loadSettings().then(cb);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
