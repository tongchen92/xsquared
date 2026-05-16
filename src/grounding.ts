const CLAIM_STOPWORDS = new Set([
  "about", "after", "again", "also", "already", "because", "before", "being", "build", "builds", "built", "could", "every", "from", "gets", "give", "gives", "have", "into", "just", "more", "most", "much", "need", "needs", "only", "post", "posts", "pull", "pulls", "ready", "really", "same", "some", "than", "that", "their", "them", "then", "there", "these", "they", "this", "through", "with", "without", "your"
]);

function normalizeClaimText(text) {
  return String(text || "").toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function claimKeywords(text) {
  return Array.from(new Set(normalizeClaimText(text).split(" ").filter(function(word) {
    return word.length >= 4 && !CLAIM_STOPWORDS.has(word);
  })));
}

function suspiciousClaimLines(text) {
  const raw = String(text || "");
  const chunks = raw.split(/[\n.!?]+/).map(function(line) { return line.trim(); }).filter(Boolean);
  const suspicious = /\b(can now|now can|just launched|just shipped|just released|launched|released|shipped|introducing|is live|lets you|allows you to|turns? .+ into|drop in|ready[- ]to[- ]post|content plan|content calendar|from scratch|no more guessing|automatically|auto[- ]generates?)\b/i;
  return chunks.filter(function(line) { return suspicious.test(line); });
}

export function buildGroundingEvidence(source, context, inspiration) {
  const c = (source && source.config) || {};
  const sourceName = source && source.name && !/^viral feed$/i.test(String(source.name).trim()) ? source.name : "";
  const contextText = context && !/^viral feed$/i.test(String(context).trim()) ? context : "";
  return [
    sourceName,
    contextText,
    c.filter,
    c.relevanceFocus,
    c.angle,
    c.seedNotes,
    inspiration && inspiration.text,
    inspiration && inspiration.authorName,
    inspiration && inspiration.author
  ].filter(Boolean).join("\n");
}

export function validateDraftGrounding(input) {
  const generationSource = String(input.generationSource || "");
  if (generationSource !== "viral") return { ok: true, issues: [] };
  const text = String(input.text || "");
  const evidence = String(input._groundingEvidence || "");
  const evidenceNorm = normalizeClaimText(evidence);
  const issues = [];
  const hardPhrases = [
    "can now",
    "from scratch",
    "drop in",
    "pulls the hooks",
    "hooks angles and cadence",
    "ready to post",
    "ready-to-post",
    "content plan",
    "content calendar",
    "no more guessing",
    "automatically creates",
    "auto generates"
  ];
  for (const line of suspiciousClaimLines(text)) {
    for (const phrase of hardPhrases) {
      if (line.toLowerCase().includes(phrase) && !evidenceNorm.includes(normalizeClaimText(phrase))) {
        issues.push({
          type: "unsupported_claim_phrase",
          line,
          phrase,
          reason: "High-risk product/workflow phrase is not present in the selected source post or source context."
        });
      }
    }
    const keys = claimKeywords(line);
    const important = keys.filter(function(key) {
      return evidenceNorm.includes(key);
    });
    const invented = keys.filter(function(key) {
      return !evidenceNorm.includes(key);
    });
    const supportRatio = keys.length ? important.length / keys.length : 1;
    if (keys.length >= 3 && (important.length < 2 || supportRatio < 0.45)) {
      issues.push({
        type: "unsupported_claim",
        line,
        supportedKeywords: important,
        unsupportedKeywords: invented.slice(0, 8),
        reason: "Concrete product/workflow claim is not grounded in the selected source post or source context."
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

export function validateDraftBatch(drafts, nowIso) {
  const accepted = [];
  const rejected = [];
  drafts.forEach(function(draft, index) {
    const validation = validateDraftGrounding(draft);
    if (validation.ok) {
      draft.groundingValidation = { ok: true, checkedAt: nowIso() };
      accepted.push(draft);
    } else {
      rejected.push({
        index,
        text: String(draft.text || "").slice(0, 500),
        inspirationPosts: draft.inspirationPosts || [],
        issues: validation.issues
      });
    }
  });
  return { accepted, rejected };
}
