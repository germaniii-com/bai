import type { SettingsSection } from "./settings";

/**
 * Client-side router (no library — the package's stated convention): a pure
 * mapping between the URL (pathname + query string) and a flat `Route` value
 * describing the app's navigation state. `App.tsx` owns the sync — boot
 * seeds state from `parseRoute`, user-initiated navigation goes through
 * `pushState` + state application, a replace-only effect canonicalizes
 * corrections, and `popstate` applies back/forward.
 *
 * The server side of this contract already exists: `@bai/api`'s static
 * handler serves index.html for any unknown path (SPA fallback — the
 * documented "rewrite to `/` for the client router"), and Vite's dev server
 * does the same by default. `/api/*` and `/mcp` never fall through.
 *
 * Hash routing was deliberately avoided: `#pair=<token>` is reserved by the
 * pairing flow (ARCHITECTURE §14).
 */

/** The settings sections (re-exported shape from settings.tsx). */
export type RouteSettingsSection = SettingsSection;

/**
 * A parsed route — the URL projection of the app's navigation state.
 * `image`/`video` are absent: those master-rail items are disabled
 * placeholders and never navigable.
 */
export type Route =
  | { section: "chat"; sessionId: string | null }
  | {
      section: "workspace";
      /** Absolute workspace folder path (decoded from the `?w=` slug); null = picker. */
      wsPath: string | null;
      /** The center-pane [Chat | Files] switch. */
      view: "chat" | "files";
      sessionId: string | null;
    }
  | { section: "settings"; settingsSection: RouteSettingsSection }
  | { section: "agents"; name: string | null; creating: boolean }
  | { section: "tools"; name: string | null; creating: boolean }
  | { section: "skills"; name: string | null; creating: boolean }
  | { section: "automations"; name: string | null; creating: boolean }
  | { section: "analytics" }
  | { section: "shell" };

/**
 * Opaque URL slug for a workspace path: base64url (URL-safe alphabet, no
 * padding) of the UTF-8-encoded path. Deterministic and reversible — this is
 * obfuscation for a tidy address bar, not security. Workspaces are
 * config-listed folder paths with no id (`Config.workspaces: string[]`), so
 * the path itself is the identity; the slug just keeps it out of sight.
 */
export function wsSlug(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Inverse of `wsSlug`; null on any malformed slug (→ picker fallback). */
export function wsUnslug(slug: string): string | null {
  try {
    let b64 = slug.replaceAll("-", "+").replaceAll("_", "/");
    // btoa/atob require canonical padding — restore what the slug stripped.
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const path = new TextDecoder().decode(bytes);
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

/** decodeURIComponent that never throws (malformed % sequences → raw). */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Parse a URL into a route. Pure string-in/string-out (no `window`), so it
 * unit-tests under bun like the other state modules. Anything unrecognized —
 * unknown sections, junk slugs, stray segments — falls back to the chat
 * draft rather than erroring; the app treats the URL as advisory.
 */
export function parseRoute(pathname: string, search: string): Route {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  const params = new URLSearchParams(search);
  const [head, rawNext] = segments;
  const next = rawNext !== undefined ? safeDecode(rawNext) : undefined;
  switch (head) {
    case "chat": {
      // /chat (draft) or /chat/{sessionId}; extra segments fall back to draft.
      const sessionId = next !== undefined && segments.length === 2 ? next : null;
      return { section: "chat", sessionId };
    }
    case "workspace": {
      const w = params.get("w");
      const wsPath = w !== null && w.length > 0 ? wsUnslug(w) : null;
      const view = params.get("view") === "files" ? "files" : "chat";
      const s = params.get("s");
      return { section: "workspace", wsPath, view, sessionId: s !== null && s.length > 0 ? s : null };
    }
    case "settings": {
      const sub = next;
      const settingsSection: RouteSettingsSection =
        sub === "user" || sub === "providers" ? sub : "general";
      return { section: "settings", settingsSection };
    }
    case "agents":
    case "tools":
    case "skills":
    case "automations": {
      // /{section} (list), /{section}/new (create form), /{section}/{name}.
      if (next === undefined || segments.length !== 2) return { section: head, name: null, creating: false };
      if (next === "new") return { section: head, name: null, creating: true };
      return { section: head, name: next, creating: false };
    }
    case "analytics":
      // /analytics — a single page, no sub-state.
      return { section: "analytics" };
    case "shell":
      // /shell — the web terminal, a single page, no sub-state.
      return { section: "shell" };
    default:
      // "/", unknown paths — the chat draft is the app's home.
      return { section: "chat", sessionId: null };
  }
}

/**
 * Serialize a route to the canonical URL (pathname + query string). The
 * inverse of `parseRoute` for every route `parseRoute` can produce.
 */
export function routeToPath(route: Route): string {
  switch (route.section) {
    case "chat":
      return route.sessionId !== null ? `/chat/${encodeURIComponent(route.sessionId)}` : "/chat";
    case "workspace": {
      const params = new URLSearchParams();
      if (route.wsPath !== null) params.set("w", wsSlug(route.wsPath));
      if (route.view === "files") params.set("view", "files");
      if (route.sessionId !== null) params.set("s", route.sessionId);
      const qs = params.toString();
      return qs.length > 0 ? `/workspace?${qs}` : "/workspace";
    }
    case "settings":
      return `/settings/${route.settingsSection}`;
    case "agents":
    case "tools":
    case "skills":
    case "automations":
      if (route.creating) return `/${route.section}/new`;
      return route.name !== null
        ? `/${route.section}/${encodeURIComponent(route.name)}`
        : `/${route.section}`;
    case "analytics":
      return "/analytics";
    case "shell":
      return "/shell";
  }
}
