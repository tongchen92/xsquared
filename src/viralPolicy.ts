const GENERIC_SOURCE_NAMES = new Set(["viral feed", "feed", "trending", "default", "for you", "home"]);

export function sourceHasExplicitViralFocus(source) {
  const c = (source && source.config) || {};
  return Boolean(String(c.filter || "").trim() || String(c.relevanceFocus || "").trim());
}

export function viralContextForSource(source) {
  const c = (source && source.config) || {};
  const filter = String(c.filter || "").trim();
  if (filter) return filter;
  const focus = String(c.relevanceFocus || "").trim();
  if (focus) return focus;
  const name = String((source && source.name) || "").trim();
  if (name && !GENERIC_SOURCE_NAMES.has(name.toLowerCase())) return name;
  return "";
}

export function requireViralContext(source) {
  const context = viralContextForSource(source);
  if (!context) {
    throw new Error("viral source needs a filter or relevance focus before generation");
  }
  return context;
}

export function rankerTrustedForAutoDraft(ranker) {
  if (!ranker) return false;
  if (ranker.model === "local-heuristic") return false;
  if (ranker.fallbackReason || ranker.skippedDeepSeek) return false;
  return true;
}
