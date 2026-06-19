/** Read the current URL query params (call once for initial state). */
export function initialParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/** Replace the URL query string from `entries` (drops empty values). Uses replaceState so it
 * doesn't spam browser history as filters/search change — a refresh just restores the state. */
export function syncUrl(entries: Record<string, string | undefined>): void {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(entries)) if (v != null && v !== "") sp.set(k, v);
  const qs = sp.toString();
  window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
}
