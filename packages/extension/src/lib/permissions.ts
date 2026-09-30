/** Optional host permissions, requested per project origin (script injection + screenshots). */
import type { ProjectConfig } from "@website-review/shared";

/** Match pattern for an origin. Ports are not part of Chrome match patterns (any port matches). */
function pattern(scheme: string, hostname: string): string {
  return `${scheme}://${hostname}/*`;
}

export function originPatternsForProject(config: ProjectConfig): string[] {
  return [...new Set(config.urlRules.map((r) => pattern(r.scheme, r.hostname)))];
}

export function originPatternForUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return pattern(u.protocol.slice(0, -1), u.hostname);
  } catch {
    return null;
  }
}

export function hasOrigins(origins: string[]): Promise<boolean> {
  return chrome.permissions.contains({ origins });
}

/** Must be called directly from a user gesture handler (before any other await). */
export function requestOrigins(origins: string[]): Promise<boolean> {
  return chrome.permissions.request({ origins });
}

export const ALL_URLS = ["<all_urls>"];
