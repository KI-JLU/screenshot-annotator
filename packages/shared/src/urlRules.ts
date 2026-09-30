import type { ProjectConfig, UrlRule } from "./projectConfig.ts";

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };

/** Path prefix matching respects segment boundaries: "/app" matches "/app" and "/app/x", not "/apple". */
export function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/" || prefix === "") return true;
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return pathname === p || pathname.startsWith(p + "/");
}

export function urlMatchesRule(url: string | URL, rule: UrlRule): boolean {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return false;
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  if (scheme !== rule.scheme) return false;
  if (parsed.hostname.toLowerCase() !== rule.hostname.toLowerCase()) return false;
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORTS[scheme];
  const rulePort = rule.port ?? DEFAULT_PORTS[rule.scheme];
  if (port !== rulePort) return false;
  return pathMatchesPrefix(parsed.pathname, rule.pathPrefix ?? "/");
}

/** Returns the ids of all projects with at least one matching rule. Unknown hosts yield []. */
export function matchProjects(configs: readonly ProjectConfig[], url: string): string[] {
  return configs.filter((c) => c.urlRules.some((r) => urlMatchesRule(url, r))).map((c) => c.projectId);
}
