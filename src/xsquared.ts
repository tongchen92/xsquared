#!/usr/bin/env node

import http from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const DEFAULT_ACCOUNT = process.env.XSQUARED_ACCOUNT || "acct_primary";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const APP_DIR = process.env.XSQUARED_HOME || path.join(PLUGIN_ROOT, ".xsquared");
const STORE_PATH = path.join(APP_DIR, "store.json");
const STORE_BACKUP_PATH = path.join(APP_DIR, "store.backup.json");
const CLAUDE_BIN = process.env.XSQUARED_CLAUDE_BIN || "claude";
const CLAUDE_MODEL = process.env.XSQUARED_CLAUDE_MODEL || "sonnet";
const RESEARCH_BUDGET_USD = process.env.XSQUARED_RESEARCH_BUDGET_USD || "0.50";
const LOCAL_BIRDCLAW_BIN = path.join(PLUGIN_ROOT, "node_modules", ".bin", process.platform === "win32" ? "birdclaw.cmd" : "birdclaw");
const LOCAL_BIRDCLAW_SCRIPT = path.join(PLUGIN_ROOT, "node_modules", "birdclaw", "bin", "birdclaw.mjs");
const DEFAULT_PROFILE_HANDLE = process.env.XSQUARED_HANDLE || "@therealtongchen";
const DEFAULT_PROFILE_LIMIT = process.env.XSQUARED_PROFILE_LIMIT || "200";
const PROFILE_REFRESH_MS = Number(process.env.XSQUARED_PROFILE_REFRESH_MS || String(12 * 60 * 60 * 1000));
const BIRDCLAW_CANDIDATES = process.env.BIRDCLAW_BIN
  ? [process.env.BIRDCLAW_BIN]
  : [LOCAL_BIRDCLAW_BIN, LOCAL_BIRDCLAW_SCRIPT, "birdclaw"].filter(function(candidate, index, arr) {
      return arr.indexOf(candidate) === index && (candidate === "birdclaw" || existsSync(candidate));
    });

function ensureStore() {
  mkdirSync(APP_DIR, { recursive: true });
  if (!existsSync(STORE_PATH)) {
    writeFileSync(STORE_PATH, JSON.stringify({ version: 2, strategy: { contentArea: "", updatedAt: null }, posts: [], trendSnapshots: [], profileSnapshots: [], generationSnapshots: [], rewriteRequests: [], feedSnapshots: [], directions: [], sources: [], chatMessages: [], chatConfig: {} }, null, 2));
  }
}

function readStore() {
  ensureStore();
  const store = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  store.version ||= 1;
  store.strategy ||= { contentArea: "", updatedAt: null };
  store.posts ||= [];
  store.trendSnapshots ||= [];
  store.profileSnapshots ||= [];
  store.generationSnapshots ||= [];
  store.rewriteRequests ||= [];
  store.feedSnapshots ||= [];
  store.directions ||= [];
  store.sources ||= [];
  store.chatMessages ||= [];
  store.chatConfig ||= {};
  if (store.version < 2) {
    // Back up before any mutation.
    try { writeFileSync(STORE_BACKUP_PATH, JSON.stringify(store, null, 2)); } catch {}
    // Migrate directions -> topic sources.
    for (const d of store.directions || []) {
      const newId = String(d.id || "").replace(/^dir_/, "src_topic_") || makeId("src_topic");
      if (store.sources.find(function(s) { return s.id === newId; })) continue;
      store.sources.push({
        id: newId,
        kind: "topic",
        name: d.name || "Untitled topic",
        createdAt: d.createdAt || nowIso(),
        updatedAt: d.updatedAt || d.createdAt || nowIso(),
        config: {
          angle: String(d.description || ""),
          seedNotes: Array.isArray(d.references) ? d.references.filter(Boolean).join("\n---\n") : "",
          useTweetVoice: d.useTweetSamples !== false
        },
        research: null
      });
    }
    // Backfill posts.sourceId from posts.directionId.
    for (const p of store.posts || []) {
      if (p.directionId && !p.sourceId) {
        p.sourceId = String(p.directionId).replace(/^dir_/, "src_topic_");
      }
      if (p.sourceId === undefined) p.sourceId = null;
    }
    store.version = 2;
    writeStore(store);
  } else {
    // Defensive: ensure every post has a sourceId key.
    let mutated = false;
    for (const p of store.posts || []) {
      if (p.sourceId === undefined) { p.sourceId = p.directionId ? String(p.directionId).replace(/^dir_/, "src_topic_") : null; mutated = true; }
    }
    if (mutated) writeStore(store);
  }
  // Seed the default viral source if it doesn't exist. Users only ever create topic sources;
  // the viral feed is a singleton that ships with the app.
  if (!store.sources.some(function(s) { return s.kind === "viral"; })) {
    store.sources.push({
      id: "src_viral_default",
      kind: "viral",
      name: "Viral feed",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      config: { filter: "", resource: "home", limit: 40 },
      research: null,
      lastFeedSnapshot: null
    });
    writeStore(store);
  }
  return store;
}

function writeStore(store) {
  ensureStore();
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...(options || {}) });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? String(result.error.message || result.error) : null
  };
}

function birdclaw(args) {
  let last = null;
  for (const candidate of BIRDCLAW_CANDIDATES) {
    const result: any = run(candidate, args);
    result.binary = candidate;
    if (result.ok) return result;
    last = result;
  }
  return last || run("birdclaw", args);
}

function openclaw(args, timeoutMs = 600000) {
  return run("openclaw", args, { timeout: timeoutMs });
}

const XURL_BIN = process.env.XURL_BIN || "xurl";
function xurl(args, timeoutMs = 30000) {
  return run(XURL_BIN, args, { timeout: timeoutMs });
}
function xurlAuthStatus() {
  // `xurl auth status` returns "No apps registered..." on stdout when nothing's set up.
  // When apps are registered it lists them and exits 0.
  const r = xurl(["auth", "status"], 10000);
  const out = (r.stdout + r.stderr).trim();
  const hasApps = r.ok && !/no apps registered/i.test(out);
  return { ok: hasApps, message: out };
}

function output(value, json = false) {
  if (json) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  } else if (typeof value === "string") {
    process.stdout.write(value + "\n");
  } else {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseJsonLinesOrArray(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.tweets)) return parsed.tweets;
    if (Array.isArray(parsed.items)) return parsed.items;
    if (Array.isArray(parsed.results)) return parsed.results;
    return [parsed];
  } catch {
    const objectStart = trimmed.indexOf("{");
    const arrayStart = trimmed.indexOf("[");
    const starts = [objectStart, arrayStart].filter(function(index) { return index >= 0; });
    if (starts.length) {
      const jsonStart = Math.min(...starts);
      try {
        const parsed = JSON.parse(trimmed.slice(jsonStart));
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed.tweets)) return parsed.tweets;
        if (Array.isArray(parsed.items)) return parsed.items;
        if (Array.isArray(parsed.results)) return parsed.results;
        return [parsed];
      } catch {}
    }
    return trimmed.split("\n").map(function(line) {
      return line.trim();
    }).filter(Boolean).map(function(line) {
      try {
        return JSON.parse(line);
      } catch {
        return { text: line };
      }
    });
  }
}

function birdUserTweets(handle, limit) {
  if (!handle) return null;
  const safeLimit = Math.min(200, Math.max(1, Number(limit || 100)));
  const pageCount = Math.min(10, Math.max(1, Math.ceil(safeLimit / 100)));
  return run("bird", ["user-tweets", handle, "-n", String(safeLimit), "--max-pages", String(pageCount), "--json"]);
}

function tweetText(item) {
  return String(item.text || item.full_text || item.content || item.body || item.tweet || "").trim();
}

function tweetAuthor(item) {
  const author = item.author || item.user || item.profile || item.account || null;
  if (typeof author === "string") return author;
  if (author && typeof author === "object") return author.handle || author.username || author.screen_name || author.name || null;
  return item.username || item.screen_name || item.handle || item.authorHandle || null;
}

function analyzeTerms(texts, topic) {
  const stop = new Set(["the", "and", "for", "that", "this", "with", "you", "your", "are", "was", "from", "have", "has", "but", "not", "all", "can", "will", "just", "about", "into", "they", "them", "our", "out", "what", "when", "who", "why", "how", "their", "there", "been", "more", "like", "than", "https", "http", "com", "twitter", "x"]);
  String(topic || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).forEach(function(term) {
    stop.delete(term);
  });
  const counts = new Map();
  const hashtags = new Map();
  const domains = new Map();
  for (const text of texts) {
    for (const tag of text.match(/#[A-Za-z0-9_]+/g) || []) {
      const key = tag.toLowerCase();
      hashtags.set(key, (hashtags.get(key) || 0) + 1);
    }
    for (const url of text.match(/https?:\/\/[^\s)]+/g) || []) {
      try {
        const host = new URL(url).hostname.replace(/^www\./, "");
        domains.set(host, (domains.get(host) || 0) + 1);
      } catch {}
    }
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3 || stop.has(raw)) continue;
      counts.set(raw, (counts.get(raw) || 0) + 1);
    }
  }
  function top(map, limit) {
    return Array.from(map.entries()).sort(function(a, b) {
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    }).slice(0, limit).map(function(entry) {
      return { term: entry[0], count: entry[1] };
    });
  }
  return { terms: top(counts, 20), hashtags: top(hashtags, 12), domains: top(domains, 12) };
}

function runTrends(opts) {
  const topic = opts.values.topic || "";
  const limit = opts.values.limit || "40";
  const resource = opts.values.resource || "home";
  const args = ["--json", "search", "tweets", "--resource", resource, "--hide-low-quality", "--originals-only", "--limit", String(limit)];
  if (topic) args.push(topic);
  const result = birdclaw(args);
  const rawItems = parseJsonLinesOrArray(result.stdout);
  const tweets = rawItems.map(function(item) {
    return {
      id: item.id || item.tweetId || item.tweet_id || item.url || null,
      author: item.author || item.username || item.screen_name || item.user || null,
      text: tweetText(item),
      createdAt: item.createdAt || item.created_at || item.date || null,
      url: item.url || null
    };
  }).filter(function(item) {
    return item.text;
  });
  const snapshot = {
    id: makeId("trend"),
    createdAt: nowIso(),
    topic,
    resource,
    limit: Number(limit),
    birdclaw: { ok: result.ok, status: result.status, error: result.error, stderr: result.stderr.trim() },
    sampleCount: tweets.length,
    analysis: analyzeTerms(tweets.map(function(tweet) { return tweet.text; }), topic),
    samples: tweets.slice(0, 12)
  };
  const store = readStore();
  store.trendSnapshots.unshift(snapshot);
  store.trendSnapshots = store.trendSnapshots.slice(0, 50);
  writeStore(store);
  return snapshot;
}

function extractTweets(result) {
  return parseJsonLinesOrArray(result.stdout).map(function(item) {
    return {
      id: item.id || item.tweetId || item.tweet_id || item.url || null,
      author: tweetAuthor(item),
      text: tweetText(item),
      createdAt: item.createdAt || item.created_at || item.date || null,
      url: item.url || item.permalink || null,
      raw: item
    };
  }).filter(function(item) {
    return item.text;
  });
}

function median(numbers) {
  if (!numbers.length) return 0;
  const sorted = numbers.slice().sort(function(a, b) { return a - b; });
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function topPhrases(texts, limit) {
  const counts = new Map();
  for (const text of texts) {
    const words = text.toLowerCase().replace(/https?:\/\/\S+/g, "").split(/[^a-z0-9']+/).filter(function(word) {
      return word.length > 2;
    });
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index <= words.length - size; index += 1) {
        const phrase = words.slice(index, index + size).join(" ");
        counts.set(phrase, (counts.get(phrase) || 0) + 1);
      }
    }
  }
  return Array.from(counts.entries()).filter(function(entry) {
    return entry[1] > 1;
  }).sort(function(a, b) {
    return b[1] - a[1] || a[0].localeCompare(b[0]);
  }).slice(0, limit).map(function(entry) {
    return { phrase: entry[0], count: entry[1] };
  });
}

function analyzeWritingProfile(tweets, handle) {
  const texts = tweets.map(function(tweet) { return tweet.text; });
  const lengths = texts.map(function(text) { return text.length; });
  const lineCounts = texts.map(function(text) { return text.split(/\n+/).length; });
  const questions = texts.filter(function(text) { return text.includes("?"); }).length;
  const exclamations = texts.filter(function(text) { return text.includes("!"); }).length;
  const links = texts.filter(function(text) { return /https?:\/\//.test(text); }).length;
  const threads = texts.filter(function(text) { return /\b(1\/|thread|🧵)\b/i.test(text); }).length;
  const replies = texts.filter(function(text) { return /^@\w+/.test(text.trim()); }).length;
  const hashtags = texts.filter(function(text) { return /#[A-Za-z0-9_]+/.test(text); }).length;
  const shortPosts = texts.filter(function(text) { return text.length <= 140; }).length;
  const longPosts = texts.filter(function(text) { return text.length > 240; }).length;
  const terms = analyzeTerms(texts, "");
  const phraseList = topPhrases(texts, 16);
  const samples = tweets.slice(0, 12).map(function(tweet) {
    return { id: tweet.id, createdAt: tweet.createdAt, url: tweet.url, text: tweet.text };
  });
  const sampleCount = texts.length;
  const pct = function(count) {
    return sampleCount ? Math.round((count / sampleCount) * 100) : 0;
  };
  const guidance = [];
  if (median(lengths) && median(lengths) < 180) guidance.push("Keep most posts compact; your median historical post is under 180 characters.");
  if (pct(links) < 25) guidance.push("Prefer standalone posts over link-heavy posts.");
  if (pct(hashtags) < 15) guidance.push("Use few or no hashtags.");
  if (pct(questions) >= 20) guidance.push("Question-led hooks appear often enough to be a viable pattern.");
  if (pct(replies) >= 25) guidance.push("A meaningful share of your writing is conversational; direct responses can fit the profile.");
  if (!guidance.length && sampleCount) guidance.push("Use direct, specific claims and keep formatting simple until more authored tweets are available.");
  return {
    handle: handle || null,
    sampleCount,
    metrics: {
      medianChars: median(lengths),
      medianLines: median(lineCounts),
      shortPostPct: pct(shortPosts),
      longPostPct: pct(longPosts),
      questionPct: pct(questions),
      exclamationPct: pct(exclamations),
      linkPct: pct(links),
      threadCuePct: pct(threads),
      replyPct: pct(replies),
      hashtagPct: pct(hashtags)
    },
    terms,
    phrases: phraseList,
    guidance,
    samples
  };
}

function callClaude(prompt, opts) {
  opts = opts || {};
  const args = [
    "-p",
    "--output-format", "json",
    "--model", CLAUDE_MODEL,
    "--permission-mode", "bypassPermissions",
    "--max-budget-usd", String(opts.budgetUsd || "0.50"),
    "--no-session-persistence",
    "--input-format", "text"
  ];
  if (opts.allowTools && opts.allowTools.length) {
    // Use comma-separated form so it consumes a single value.
    args.push("--allowedTools", opts.allowTools.join(","));
  } else {
    args.push("--tools", "");
  }
  // Pass prompt via stdin to avoid variadic-arg parsing collisions.
  return run(CLAUDE_BIN, args, { timeout: opts.timeoutMs || 180000, maxBuffer: 32 * 1024 * 1024, input: prompt });
}

function extractFencedJson(text) {
  const raw = String(text || "");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  try { return JSON.parse(body); } catch {}
  // Fallback: scan for outermost { ... }.
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(body.slice(first, last + 1)); } catch {}
  }
  return {};
}

function summarizeProfileForPrompt(snapshot) {
  const profile = (snapshot && snapshot.profile) || {};
  const metrics = profile.metrics || {};
  const terms = ((profile.terms && profile.terms.terms) || []).slice(0, 8).map(function(t) { return t.term; }).join(", ");
  return [
    "- median chars: " + (metrics.medianChars || "?") + ", median lines: " + (metrics.medianLines || "?"),
    "- short posts (<=140 chars): " + (metrics.shortPostPct || 0) + "%; long posts (>240): " + (metrics.longPostPct || 0) + "%",
    "- uses links: " + (metrics.linkPct || 0) + "%; hashtags: " + (metrics.hashtagPct || 0) + "%; questions: " + (metrics.questionPct || 0) + "%",
    "- recurring terms: " + (terms || "(none)"),
    "- guidance: " + ((profile.guidance || []).join(" | ") || "(none)")
  ].join("\n");
}

function buildResearchPrompt(source) {
  const c = source.config || {};
  return [
    "You are doing background research for an X (Twitter) post about a specific topic.",
    "Use the WebSearch and WebFetch tools to find 6-10 high-signal recent sources.",
    "",
    "Topic: " + source.name,
    "Angle / objective: " + (c.angle || "(none specified)"),
    "User's seed notes (treat as constraints, not as conclusions):",
    c.seedNotes ? c.seedNotes : "(none)",
    "",
    "Return a single JSON object inside a ```json fenced block, matching this shape exactly:",
    "{",
    "  \"query\": \"<the search query you used>\",",
    "  \"links\": [{\"url\":\"...\",\"title\":\"...\",\"snippet\":\"<one-sentence summary>\"}],",
    "  \"summaries\": [\"<2-5 short bullet-style takeaways from the research>\"],",
    "  \"facts\": [\"<short concrete claim with [n] citation index referring to links[n-1]>\"]",
    "}",
    "",
    "Rules:",
    "- Prefer primary sources (docs, official posts, named researchers) over content farms.",
    "- Each fact must end with a [n] index pointing to links[n-1].",
    "- No hedging, no 'as an AI'. Output the JSON and nothing else."
  ].join("\n");
}

function buildTopicGenPrompt(source, profile, count) {
  const c = source.config || {};
  const res = source.research;
  const voice = profile ? summarizeProfileForPrompt(profile) : "(no learned voice - use a direct, builder-to-builder tone, ~140-200 chars per post)";
  return [
    "You are drafting " + count + " candidate X (Twitter) posts. Output JSON only.",
    "",
    "Topic: " + source.name,
    "Angle: " + (c.angle || "(none)"),
    "User seed notes: " + (c.seedNotes || "(none)"),
    "",
    res ? "Research findings (use these - do not invent stats):" : "No research yet - write from the angle + seed notes only.",
    res ? "Summaries:\n- " + (res.summaries || []).join("\n- ") : "",
    res ? "Facts:\n- " + (res.facts || []).join("\n- ") : "",
    res && (res.links || []).length ? "Source URLs available if you cite, but you usually shouldn't link in a post." : "",
    "",
    "Voice profile:",
    voice,
    "",
    "Return a single JSON object inside a ```json fence:",
    "{ \"posts\": [ { \"text\": \"<the post>\", \"angle\": \"<3-5 word label>\", \"score\": <60-95>, \"notes\": \"<why this one might land>\" } ] }",
    "",
    "Rules:",
    "- " + count + " posts. Each <= 280 chars.",
    "- No hashtags unless the voice profile says they're used >15% of the time.",
    "- No emojis unless the voice profile shows them.",
    "- No 'thread' framing unless asked.",
    "- Each post stands alone."
  ].filter(Boolean).join("\n");
}

function buildViralGenPrompt(sourceName, inspiration, profile, count) {
  const voice = profile ? summarizeProfileForPrompt(profile) : "(direct, no hype, ~140-200 chars)";
  const lines = [
    "Draft " + count + " original X posts inspired by these recently-viral posts.",
    "Each draft should respond to ONE inspiration post with the user's own angle - NOT a quote-tweet reply, but a standalone post that takes a position.",
    "",
    "Topic context: " + sourceName,
    "",
    "Inspiration posts:"
  ];
  inspiration.forEach(function(p, i) {
    const safe = String(p.text || "").replace(/\n+/g, " ").slice(0, 280);
    lines.push("[" + (i + 1) + "] @" + (p.author || "?") + ": " + safe);
  });
  lines.push("");
  lines.push("Voice profile:");
  lines.push(voice);
  lines.push("");
  lines.push("Return JSON: { \"posts\": [ { \"text\": \"...\", \"angle\": \"...\", \"score\": 60-95, \"notes\": \"...\", \"inspirationIndex\": <1..N> } ] }");
  lines.push("");
  lines.push("Rules: same as before - <=280 chars, voice-matched, no hype.");
  return lines.join("\n");
}

function callLlmForDrafts(prompt, count) {
  if (process.env.XSQUARED_DISABLE_LLM === "1") return null;
  const r = callClaude(prompt, { budgetUsd: process.env.XSQUARED_GENERATE_BUDGET_USD || "0.50", timeoutMs: 120000 });
  if (!r.ok) return null;
  const env = r.stdout.trim() ? safeJson(r.stdout.trim()) : null;
  if (!env || typeof env !== "object" || env.is_error) return null;
  const parsed = extractFencedJson(String(env.result || ""));
  const posts = parsed && Array.isArray(parsed.posts) ? parsed.posts : [];
  if (!posts.length) return null;
  const drafts = posts.slice(0, count).map(function(p) {
    return {
      text: String((p && p.text) || "").trim(),
      angle: String((p && p.angle) || ""),
      score: Number(p && p.score) || 75,
      notes: String((p && p.notes) || ""),
      source: "xsquared-generator",
      inspirationIndex: p && p.inspirationIndex
    };
  }).filter(function(p) { return p.text; });
  // Attach cost/duration metadata.
  drafts._meta = { costUsd: Number(env.total_cost_usd || 0), durationMs: Number(env.duration_ms || 0) };
  return drafts;
}

function runResearch(sourceId) {
  const store = readStore();
  const source = store.sources.find(function(s) { return s.id === sourceId; });
  if (!source) throw new Error("source not found: " + sourceId);
  if (source.kind !== "topic") throw new Error("research only valid for topic sources");
  const t0 = Date.now();
  const r = callClaude(buildResearchPrompt(source), {
    allowTools: ["WebSearch", "WebFetch"],
    budgetUsd: RESEARCH_BUDGET_USD,
    timeoutMs: 240000
  });
  if (!r.ok) throw new Error("claude failed: " + (r.stderr.trim() || r.error || "exit " + r.status));
  const envelope = r.stdout.trim() ? safeJson(r.stdout.trim()) : null;
  if (!envelope || typeof envelope !== "object") throw new Error("claude returned unparseable output");
  if (envelope.is_error) throw new Error("claude error: " + (envelope.result || "unknown"));
  const rawText = String(envelope.result || "");
  const parsed = extractFencedJson(rawText) || {};
  const links = Array.isArray(parsed.links) ? parsed.links.slice(0, 12).map(function(link) {
    return {
      url: String((link && link.url) || ""),
      title: String((link && link.title) || ""),
      snippet: String((link && link.snippet) || "")
    };
  }) : [];
  // Cap raw at 20KB.
  const rawCapped = rawText.length > 20000 ? rawText.slice(0, 20000) + "\n...(truncated)" : rawText;
  const artifact = {
    id: makeId("res"),
    createdAt: nowIso(),
    query: String((parsed && parsed.query) || source.name),
    links,
    summaries: Array.isArray(parsed.summaries) ? parsed.summaries.slice(0, 8).map(String) : [],
    facts: Array.isArray(parsed.facts) ? parsed.facts.slice(0, 20).map(String) : [],
    raw: rawCapped,
    costUsd: Number(envelope.total_cost_usd || 0),
    durationMs: Date.now() - t0
  };
  const s2 = readStore();
  const src = s2.sources.find(function(s) { return s.id === sourceId; });
  if (!src) throw new Error("source disappeared during research: " + sourceId);
  src.research = artifact;
  src.updatedAt = nowIso();
  writeStore(s2);
  return artifact;
}

// Adapter so the template fallback keeps working unchanged.
function adaptTopicToDirection(source) {
  const c = source.config || {};
  return {
    id: source.id,
    name: source.name,
    description: c.angle || "",
    references: c.seedNotes ? String(c.seedNotes).split(/\n---\n/) : [],
    useTweetSamples: c.useTweetVoice !== false
  };
}

function mapBirdItems(items) {
  // `bird home`/`bird search` returns an array of tweets with this shape:
  //   { id, text, createdAt, author:{username,name}, authorId, media:[{type,url,previewUrl,width,height}], likeCount, retweetCount, replyCount, quotedTweet, ... }
  // We do not get entity-level url cards from bird; t.co links inside `text` are the only signal.
  return (Array.isArray(items) ? items : []).map(function(t) {
    const handle = (t.author && t.author.username) ? String(t.author.username).replace(/^@/, "") : null;
    const tweetUrl = handle && t.id ? "https://x.com/" + handle + "/status/" + t.id : null;
    const profileUrl = handle ? "https://x.com/" + handle : null;
    const images = Array.isArray(t.media)
      ? t.media.filter(function(m) { return m && (m.type === "photo" || m.type === "image") && (m.url || m.previewUrl); }).map(function(m) {
          return {
            url: m.url || m.previewUrl,
            thumbnailUrl: m.previewUrl || m.url,
            altText: m.alt || m.altText || m.alt_text || "",
            width: m.width || null,
            height: m.height || null
          };
        })
      : [];
    return {
      id: String(t.id),
      author: handle,
      authorName: (t.author && t.author.name) || null,
      text: String(t.text || "").trim(),
      createdAt: t.createdAt || null,
      likeCount: t.likeCount || 0,
      retweetCount: t.retweetCount || 0,
      replyCount: t.replyCount || 0,
      url: tweetUrl || profileUrl,
      tweetUrl,
      profileUrl,
      images,
      urlCards: []
    };
  }).filter(function(p) { return p.text; });
}

const BIRD_BIN = process.env.BIRD_BIN || "bird";
function bird(args, timeoutMs = 30000) { return run(BIRD_BIN, args, { timeout: timeoutMs }); }
function birdAuthStatus() {
  const r = bird(["whoami", "--plain"], 15000);
  const blob = (r.stdout + " " + r.stderr);
  // `bird whoami` prints "🙋 @handle (name)" + the user id when auth works.
  const handleMatch = blob.match(/@([A-Za-z0-9_]{1,15})\b/);
  const ok = r.ok && !!handleMatch && !/Make sure you are logged into x\.com/i.test(r.stdout);
  return { ok, handle: handleMatch ? handleMatch[1] : null, message: blob.trim().slice(0, 400) };
}

function viralFetch(sourceId) {
  const store = readStore();
  const source = store.sources.find(function(s) { return s.id === sourceId; });
  if (!source) throw new Error("source not found: " + sourceId);
  if (source.kind !== "viral") throw new Error("viral-fetch only valid for viral sources");
  const c = source.config || {};
  const filter = String(c.filter || "");
  const limit = Math.min(100, Math.max(5, Number(c.limit || 40)));
  const resource = c.resource || "home";

  // Real X data via `bird` (Twitter GraphQL with logged-in browser cookies). Local Birdclaw
  // SQLite fixtures are off-limits — they ship pre-seeded and aren't real tweets.
  const auth = birdAuthStatus();
  if (!auth.ok) {
    throw new Error("Not logged in to X in your browser. Open https://x.com in Chrome/Firefox and log in, then click Fetch viral feed again. bird says: " + auth.message);
  }

  let result, endpointLabel;
  if (filter) {
    result = bird(["search", filter, "-n", String(limit), "--json"], 45000);
    endpointLabel = "bird search";
  } else if (resource === "following") {
    result = bird(["home", "-n", String(limit), "--following", "--json"], 45000);
    endpointLabel = "bird home --following";
  } else {
    result = bird(["home", "-n", String(limit), "--json"], 45000);
    endpointLabel = "bird home (For You)";
  }
  if (!result.ok && !result.stdout.trim()) {
    throw new Error("bird fetch failed: " + (result.stderr.trim() || result.error || "command failed"));
  }
  const items = safeJson(result.stdout.trim());
  if (!Array.isArray(items)) {
    throw new Error("Unexpected response from bird (not an array). First 200 chars: " + String(result.stdout).slice(0, 200));
  }
  const posts = mapBirdItems(items);
  const snapshot = {
    id: makeId("feed"),
    createdAt: nowIso(),
    filter,
    resource,
    limit,
    transport: { tool: "bird", endpoint: endpointLabel, ok: result.ok, status: result.status, error: result.error, stderr: result.stderr.trim() },
    sampleCount: posts.length,
    posts: posts.slice(0, 60)
  };
  const s2 = readStore();
  const src = s2.sources.find(function(s) { return s.id === sourceId; });
  if (!src) throw new Error("source disappeared during viral fetch: " + sourceId);
  src.lastFeedSnapshot = snapshot;
  src.lastFeedSnapshotId = snapshot.id;
  src.updatedAt = nowIso();
  writeStore(s2);
  return snapshot;
}

function generateForSource(sourceId, opts) {
  opts = opts || {};
  const store = readStore();
  const source = store.sources.find(function(s) { return s.id === sourceId; });
  if (!source) throw new Error("source not found: " + sourceId);
  const profile = store.profileSnapshots[0] || null;
  let count = Number(opts.count || 5);
  if (!Number.isFinite(count) || count <= 0) count = 5;
  let drafts;
  let meta = null;
  let llmUsed = false;
  if (source.kind === "topic") {
    const inputs = callLlmForDrafts(buildTopicGenPrompt(source, profile, count), count);
    let arr;
    if (inputs && inputs.length) {
      llmUsed = true;
      meta = inputs._meta || null;
      arr = inputs;
    } else {
      arr = makeDirectionTexts(adaptTopicToDirection(source), profile, count);
    }
    arr.forEach(function(p) {
      p.sourceId = source.id;
      p.generationSource = "topic";
      p.directionId = source.id; // back-compat
      if (!p.topic) p.topic = source.name;
    });
    drafts = arr;
  } else {
    const snap = source.lastFeedSnapshot;
    if (!snap || !Array.isArray(snap.posts) || !snap.posts.length) throw new Error("fetch the viral feed first");
    const selectedIds = Array.isArray(opts.selectedPostIds) ? opts.selectedPostIds : [];
    const selected = selectedIds.length
      ? snap.posts.filter(function(p) { return selectedIds.indexOf(p.id) !== -1; })
      : snap.posts.slice(0, count);
    if (!selected.length) throw new Error("no posts selected");
    const need = selected.length;
    const inputs = callLlmForDrafts(buildViralGenPrompt(source.name, selected, profile, need), need);
    let arr;
    if (inputs && inputs.length) {
      llmUsed = true;
      meta = inputs._meta || null;
      arr = inputs;
    } else {
      arr = makeFeedInspiredTexts(selected, source.name, profile, need);
    }
    arr.forEach(function(p, i) {
      p.sourceId = source.id;
      p.generationSource = "viral";
      const insp = (function() {
        const idx = Number(p.inspirationIndex);
        if (Number.isFinite(idx) && idx >= 1 && idx <= selected.length) return selected[idx - 1];
        return selected[i] || selected[0];
      })();
      if (insp) {
        p.inspirationPosts = [{ id: insp.id, author: insp.author, text: String(insp.text || "").slice(0, 200), url: insp.url }];
      }
      if (!p.topic) p.topic = source.name;
    });
    drafts = arr;
  }
  const finalDrafts = drafts.map(normalizePost);
  const s2 = readStore();
  finalDrafts.forEach(function(d) { s2.posts.unshift(d); });
  s2.generationSnapshots.unshift({
    id: makeId("generation"),
    createdAt: nowIso(),
    sourceId: source.id,
    sourceKind: source.kind,
    profileSnapshotId: profile ? profile.id : null,
    postIds: finalDrafts.map(function(d) { return d.id; }),
    count: finalDrafts.length,
    llmUsed,
    costUsd: meta ? meta.costUsd : 0,
    durationMs: meta ? meta.durationMs : 0
  });
  s2.generationSnapshots = s2.generationSnapshots.slice(0, 50);
  // refresh source.updatedAt
  const src2 = s2.sources.find(function(s) { return s.id === sourceId; });
  if (src2) src2.updatedAt = nowIso();
  writeStore(s2);
  return { source: src2 || source, posts: finalDrafts, llmUsed, costUsd: meta ? meta.costUsd : 0, durationMs: meta ? meta.durationMs : 0 };
}

function listSources(filterKind) {
  const sources = readStore().sources;
  if (filterKind) return sources.filter(function(s) { return s.kind === filterKind; });
  return sources;
}

function getSource(id) {
  const source = readStore().sources.find(function(s) { return s.id === id; });
  if (!source) throw new Error("source not found: " + id);
  return source;
}

function createSource(input) {
  const kind = input.kind === "viral" ? "viral" : (input.kind === "topic" ? "topic" : null);
  if (!kind) throw new Error("kind must be 'topic' or 'viral'");
  const name = String(input.name || "").trim();
  if (!name) throw new Error("name is required");
  const config = input.config || {};
  let normalizedConfig;
  if (kind === "topic") {
    normalizedConfig = {
      angle: String(config.angle || "").trim(),
      seedNotes: String(config.seedNotes || "").trim(),
      useTweetVoice: config.useTweetVoice !== false
    };
  } else {
    let limit = Number(config.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = 40;
    if (limit > 200) limit = 200;
    const resource = ["home", "following", "for-you"].indexOf(config.resource) !== -1 ? config.resource : "home";
    normalizedConfig = {
      filter: String(config.filter || "").trim(),
      resource,
      limit
    };
  }
  const source = {
    id: makeId(kind === "topic" ? "src_topic" : "src_viral"),
    kind,
    name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    config: normalizedConfig
  };
  if (kind === "topic") (source as any).research = null;
  const store = readStore();
  store.sources.unshift(source);
  writeStore(store);
  return source;
}

function updateSource(id, updates) {
  const store = readStore();
  const source = store.sources.find(function(s) { return s.id === id; });
  if (!source) throw new Error("source not found: " + id);
  if (updates.name !== undefined && String(updates.name).trim()) source.name = String(updates.name).trim();
  if (updates.archived !== undefined) source.archived = Boolean(updates.archived);
  if (updates.config && typeof updates.config === "object") {
    const c = source.config || {};
    if (source.kind === "topic") {
      if (updates.config.angle !== undefined) c.angle = String(updates.config.angle || "").trim();
      if (updates.config.seedNotes !== undefined) c.seedNotes = String(updates.config.seedNotes || "");
      if (updates.config.useTweetVoice !== undefined) c.useTweetVoice = Boolean(updates.config.useTweetVoice);
    } else {
      if (updates.config.filter !== undefined) c.filter = String(updates.config.filter || "").trim();
      if (updates.config.resource !== undefined && ["home", "following", "for-you"].indexOf(updates.config.resource) !== -1) c.resource = updates.config.resource;
      if (updates.config.limit !== undefined) {
        let lim = Number(updates.config.limit);
        if (Number.isFinite(lim) && lim > 0) { if (lim > 200) lim = 200; c.limit = lim; }
      }
    }
    source.config = c;
  }
  source.updatedAt = nowIso();
  writeStore(store);
  return source;
}

function deleteSource(id) {
  const store = readStore();
  const idx = store.sources.findIndex(function(s) { return s.id === id; });
  if (idx === -1) throw new Error("source not found: " + id);
  let orphaned = 0;
  for (const p of store.posts || []) {
    if (p.sourceId === id) {
      p.sourceId = null;
      p.updatedAt = nowIso();
      orphaned += 1;
    }
  }
  store.sources.splice(idx, 1);
  writeStore(store);
  return { deleted: id, orphanedPostCount: orphaned };
}

function getPostsForSource(id) {
  return readStore().posts.filter(function(p) { return p.sourceId === id; });
}

function learnProfile(opts) {
  const handle = opts.values.handle || DEFAULT_PROFILE_HANDLE;
  const limit = opts.values.limit || DEFAULT_PROFILE_LIMIT;
  const args = ["--json", "search", "tweets", "--resource", "authored", "--limit", String(limit)];
  if (opts.values.query) args.push(opts.values.query);
  const result = birdclaw(args);
  let tweets = extractTweets(result);
  let profileSource = "birdclaw-authored";
  if (handle) {
    const normalized = handle.replace(/^@/, "").toLowerCase();
    const authored = tweets.filter(function(tweet) {
      return String(tweet.author || "").replace(/^@/, "").toLowerCase() === normalized;
    });
    if (authored.length) tweets = authored;
    if (!tweets.length) {
      const birdResult = birdUserTweets(handle, limit);
      if (birdResult && birdResult.ok) {
        const birdTweets = extractTweets(birdResult).filter(function(tweet) {
          return !/^RT\s+@/i.test(tweet.text);
        });
        if (birdTweets.length) {
          tweets = birdTweets;
          profileSource = "bird-user-tweets";
        }
      }
    }
  }
  const profile = analyzeWritingProfile(tweets, handle);
  const snapshot = {
    id: makeId("profile"),
    createdAt: nowIso(),
    handle: handle || null,
    limit: Number(limit),
    birdclaw: { ok: result.ok, status: result.status, error: result.error, stderr: result.stderr.trim(), source: profileSource },
    profile,
    note: profile.sampleCount ? "" : "No authored tweets found in Birdclaw local data. Import your X archive or run Birdclaw authored sync, then learn again."
  };
  const store = readStore();
  store.profileSnapshots.unshift(snapshot);
  store.profileSnapshots = store.profileSnapshots.slice(0, 25);
  writeStore(store);
  return snapshot;
}

function profileSnapshotIsFresh(snapshot) {
  if (!snapshot || !snapshot.createdAt) return false;
  if (String(snapshot.handle || "") !== DEFAULT_PROFILE_HANDLE) return false;
  if (!snapshot.profile || !snapshot.profile.sampleCount) return false;
  return Date.now() - new Date(snapshot.createdAt).getTime() < PROFILE_REFRESH_MS;
}

function getProfileSnapshotsWithAutoLearn(force = false) {
  const store = readStore();
  const latest = store.profileSnapshots[0] || null;
  if (force || !profileSnapshotIsFresh(latest)) {
    try {
      learnProfile({ values: { handle: DEFAULT_PROFILE_HANDLE, limit: DEFAULT_PROFILE_LIMIT } });
    } catch {
      // Profile learning should not make the dashboard unusable.
    }
  }
  return readStore().profileSnapshots;
}

function resolveOpenClawSession() {
  const store = readStore();
  const configuredId = process.env.XSQUARED_OPENCLAW_SESSION_ID || store.chatConfig.sessionId || "";
  if (configuredId) {
    return {
      connected: true,
      sessionId: configuredId,
      key: store.chatConfig.sessionKey || process.env.XSQUARED_OPENCLAW_SESSION_KEY || "configured",
      source: process.env.XSQUARED_OPENCLAW_SESSION_ID ? "env" : "store"
    };
  }
  const keyContains = process.env.XSQUARED_OPENCLAW_SESSION_KEY_CONTAINS || store.chatConfig.sessionKeyContains || "";
  const result = openclaw(["sessions", "--all-agents", "--active", "720", "--limit", "50", "--json"], 15000);
  if (!result.ok) {
    return { connected: false, error: result.stderr.trim() || result.error || "openclaw sessions failed" };
  }
  const data: any = safeJson(result.stdout.trim());
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const matches = sessions.filter(function(session) {
    const key = String(session.key || "");
    if (keyContains) return key.includes(keyContains);
    return key.includes(":telegram:group:") && key.includes(":topic:");
  });
  const session = matches[0] || null;
  if (!session || !session.sessionId) {
    return { connected: false, error: keyContains ? "No OpenClaw session matched " + keyContains : "No recent Telegram topic session found" };
  }
  return {
    connected: true,
    sessionId: session.sessionId,
    key: session.key || "",
    source: keyContains ? "auto-key-match" : "auto-recent-telegram-topic",
    updatedAt: session.updatedAt || null
  };
}

function extractAgentReply(stdout) {
  const trimmed = String(stdout || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").trim();
  if (!trimmed) return "";
  const parsed: any = safeJson(trimmed);
  if (parsed && typeof parsed === "object") {
    return String(parsed.reply || parsed.response || parsed.message || parsed.output || parsed.text || parsed.result?.reply || parsed.result?.message || parsed.result?.text || trimmed);
  }
  return trimmed;
}

function getChatState() {
  return { messages: readStore().chatMessages.slice(-25), target: resolveOpenClawSession() };
}

function appendChatMessage(role, text, extra = {}) {
  const store = readStore();
  const message = { id: makeId("chat"), role, text: String(text || ""), createdAt: nowIso(), ...extra };
  store.chatMessages.push(message);
  store.chatMessages = store.chatMessages.slice(-100);
  writeStore(store);
  return message;
}

function sendChatMessage(input) {
  const message = String(input.message || "").trim();
  if (!message) throw new Error("message is required");
  const target = resolveOpenClawSession();
  appendChatMessage("user", message, { target });
  if (!target.connected || !target.sessionId) {
    const error = target.error || "No OpenClaw session connected";
    appendChatMessage("system", error, { failed: true, target });
    throw new Error(error);
  }
  const result = openclaw(["agent", "--session-id", target.sessionId, "--message", message, "--json"], 600000);
  const reply = extractAgentReply(result.stdout) || result.stderr.trim() || result.error || "No reply returned.";
  appendChatMessage(result.ok ? "assistant" : "system", reply, { ok: result.ok, status: result.status, target });
  if (!result.ok) throw new Error(reply);
  return getChatState();
}

function setStrategy(input) {
  const store = readStore();
  store.strategy = {
    ...(store.strategy || {}),
    contentArea: String(input.contentArea || input.area || "").trim(),
    updatedAt: nowIso()
  };
  writeStore(store);
  return store.strategy;
}

function formatArea(area) {
  return String(area || "").trim() || "your chosen topic";
}

function splitArea(area) {
  const topic = formatArea(area);
  const match = topic.match(/^(.+?)\s+for\s+(.+)$/i);
  if (!match) return { topic, channel: topic, audience: "small teams" };
  let audience = match[2].trim();
  if (/^small business$/i.test(audience)) audience = "small businesses";
  return { topic, channel: match[1].trim(), audience };
}

function trendWords(snapshot) {
  return ((snapshot.analysis || {}).terms || []).slice(0, 6).map(function(item) {
    return item.term;
  }).filter(Boolean);
}

function makeGeneratedTexts(area, trendSnapshot, profileSnapshot, count) {
  const parts = splitArea(area);
  const topic = parts.topic;
  const channel = parts.channel;
  const audience = parts.audience;
  const words = trendWords(trendSnapshot);
  const termLine = words.length ? " Current signal: " + words.slice(0, 3).join(", ") + "." : "";
  const profile = profileSnapshot ? profileSnapshot.profile || {} : {};
  const compact = !profile.metrics || !profile.metrics.medianChars || profile.metrics.medianChars < 180;
  const drafts = [
    "Most " + audience + " do not need more " + channel + " hacks. They need cleaner tracking, tighter intent, and fewer places for spend to leak." + termLine,
    "The boring edge in " + channel + " for " + audience + ": know what you are paying for, cut what is not buying intent, and review the search/query layer every week.",
    "If " + channel + " is not working for " + audience + ", do not start by changing the creative. Start with the waste: bad matches, weak follow-up, unclear conversion events.",
    channel + " gets easier when " + audience + " separate two jobs: finding demand and filtering noise. Most accounts mix them together, then wonder why budget disappears.",
    "A useful " + channel + " system for " + audience + " should answer three questions fast: what worked, what wasted money, and what should change before the next dollar is spent.",
    audience + " win at " + channel + " by making the account legible. Fewer campaigns, clearer intent, better negatives, and one conversion event everyone trusts."
  ];
  return drafts.slice(0, Number(count) || 5).map(function(text, index) {
    return {
      topic,
      angle: ["waste reduction", "operating discipline", "diagnosis first", "intent filtering", "measurement loop", "small business account structure"][index] || "practical insight",
      score: Math.max(72, 88 - index * 3),
      text: compact && text.length > 230 ? text.slice(0, 227).replace(/\s+\S*$/, "") + "..." : text,
      notes: "Generated from posting area plus Birdclaw trend/profile context.",
      source: "xsquared-generator"
    };
  });
}

function makeFeedInspiredTexts(selectedPosts, area, profileSnapshot, count) {
  const parts = splitArea(area);
  const topic = parts.topic;
  const channel = parts.channel;
  const audience = parts.audience;
  const profile = profileSnapshot ? (profileSnapshot.profile || {}) : {};
  const compact = !profile.metrics || !profile.metrics.medianChars || profile.metrics.medianChars < 180;
  const angles = ["my take", "contrarian", "practical version", "nuance layer", "audience reframe", "first principle"];
  const prefixes = [
    "My take:",
    "The part this misses:",
    "The actionable version:",
    "True, but the nuance is:",
    "What " + audience + " actually need from this:",
    "First principle here:"
  ];
  const bodies = [
    channel + " for " + audience + " — the signal that matters is not the metric everyone tracks. It is what the account does when budget pressure arrives.",
    "Most teams skip diagnosis and go straight to tactics. Know what is broken before spending on what to fix in " + channel + ".",
    "Cut campaigns that spend without earning intent. One clear match type, one conversion event, one week of data before changing anything in " + channel + ".",
    "The gap between what works and what looks like it works in " + channel + " is almost always attribution. Name your conversion events clearly.",
    channel + " for " + audience + ": scale what is working, pause what is not, review the search query layer before changing anything else.",
    "The advantage in " + channel + " is not the channel itself. It is having cleaner data than competitors who are guessing."
  ];
  return selectedPosts.slice(0, Number(count) || 5).map(function(post, index) {
    const angle = angles[index % angles.length];
    const prefix = prefixes[index % prefixes.length];
    const body = bodies[index % bodies.length];
    const text = prefix + " " + body;
    const postSnippet = String(post.text || "").slice(0, 100);
    const trimmed = compact && text.length > 230 ? text.slice(0, 227).replace(/\s+\S*$/, "") + "..." : text;
    return {
      topic,
      angle,
      score: Math.max(70, 85 - index * 2),
      text: trimmed,
      notes: "Inspired by trending post: " + postSnippet + (post.url ? " — " + post.url : ""),
      source: "xsquared-generator",
      generationSource: "trending",
      inspirationPosts: [{ id: post.id, author: post.author, text: String(post.text || "").slice(0, 200), url: post.url }],
      directionId: null
    };
  });
}

function makeDirectionTexts(direction, profileSnapshot, count) {
  const profile = profileSnapshot ? (profileSnapshot.profile || {}) : {};
  const compact = !profile.metrics || !profile.metrics.medianChars || profile.metrics.medianChars < 180;
  const useTweetVoice = direction.useTweetSamples !== false;
  const name = direction.name || "this topic";
  const description = String(direction.description || "");
  const refs = (direction.references || []).join(" ");
  const refTerms = refs ? analyzeTerms([refs], name).terms.slice(0, 6).map(function(t) { return t.term; }) : [];
  const sampleTerms = useTweetVoice && profile.terms && profile.terms.terms ? profile.terms.terms.slice(0, 3).map(function(t) { return t.term; }) : [];
  const termLine = refTerms.length ? " Key context: " + refTerms.slice(0, 3).join(", ") + "." : "";
  const voiceLine = sampleTerms.length ? " Voice context: " + sampleTerms.join(", ") + "." : "";
  const angles = ["core claim", "contrarian angle", "implementation", "common mistake", "first principle", "specific insight"];
  const drafts = [
    "On " + name + ": " + (description || "the depth is in the specifics, not the framework.") + termLine,
    "The most common mistake with " + name + ": treating it as a tactic. It works as a system — all the inputs and feedback loops matter.",
    "If you are serious about " + name + ": start with the constraint. What is the one thing you can change this week, not next quarter?" + termLine,
    name + " done well looks boring. Clear principles, consistent execution, slow iteration. No shortcut survives long enough to matter.",
    "The diagnostic step on " + name + " most teams skip: understand what is actually broken before optimizing anything.",
    "The specific thing about " + name + " nobody talks about: " + (refTerms.length ? refTerms[0] + " as a leading signal, not a lagging one." : "the feedback loop is slower than it looks.")
  ];
  if (useTweetVoice && profileSnapshot && (profileSnapshot.profile.samples || []).length) {
    drafts.push("Something I keep returning to on " + name + ": " + (description ? description.slice(0, 80) : "the distance between knowing and doing is where most effort gets lost."));
  }
  return drafts.slice(0, Number(count) || 5).map(function(text, index) {
    const trimmed = compact && text.length > 230 ? text.slice(0, 227).replace(/\s+\S*$/, "") + "..." : text;
    return {
      topic: name,
      angle: angles[index % angles.length],
      score: Math.max(72, 88 - index * 2),
      text: trimmed,
      notes: "Topic: " + name + (description ? " — " + description.slice(0, 100) : "") + (refTerms.length ? ". Key terms: " + refTerms.join(", ") : "") + (useTweetVoice ? voiceLine : "") + ".",
      source: "xsquared-generator",
      generationSource: "topic",
      inspirationPosts: [],
      directionId: direction.id
    };
  });
}

function normalizePost(input) {
  const text = String(input.text || "").trim();
  if (!text) throw new Error("post text is required");
  return {
    id: input.id || makeId("post"),
    createdAt: input.createdAt || nowIso(),
    updatedAt: nowIso(),
    status: input.status || "draft",
    topic: input.topic || "",
    angle: input.angle || "",
    score: input.score === undefined || input.score === "" ? null : Number(input.score),
    text,
    notes: input.notes || "",
    source: input.source || "openclaw",
    generationSource: input.generationSource || input.source || "openclaw",
    inspirationPosts: input.inspirationPosts || [],
    sourceId: input.sourceId || null,
    directionId: input.directionId || null,
    postedAt: input.postedAt || null,
    postResult: input.postResult || null
  };
}

function savePost(input) {
  const store = readStore();
  const post = normalizePost(input);
  store.posts.unshift(post);
  writeStore(store);
  return post;
}

function findPost(store, postId) {
  const post = store.posts.find(function(item) {
    return item.id === postId;
  });
  if (!post) throw new Error("post not found: " + postId);
  return post;
}

function updatePost(postId, updates) {
  const store = readStore();
  const post = findPost(store, postId);
  for (const key of ["text", "status", "notes", "topic", "angle"]) {
    if (updates[key] !== undefined && updates[key] !== null && updates[key] !== "") post[key] = updates[key];
  }
  if (updates.score !== undefined && updates.score !== "") post.score = Number(updates.score);
  post.updatedAt = nowIso();
  writeStore(store);
  return post;
}

function deletePost(postId) {
  const store = readStore();
  const index = store.posts.findIndex(function(item) {
    return item.id === postId;
  });
  if (index === -1) throw new Error("post not found: " + postId);
  const deleted = store.posts.splice(index, 1)[0];
  writeStore(store);
  return { deleted: deleted.id };
}

function importJson(filePath) {
  const payload = JSON.parse(readFileSync(filePath, "utf8"));
  const rows = Array.isArray(payload) ? payload : payload.posts || [];
  if (!Array.isArray(rows)) throw new Error("expected an array or { posts: [] }");
  return rows.map(savePost);
}

function postToX(postId, account) {
  const store = readStore();
  const post = findPost(store, postId);
  const result = birdclaw(["--json", "compose", "post", "--account", account || DEFAULT_ACCOUNT, post.text]);
  const payload: any = result.stdout.trim() ? safeJson(result.stdout.trim()) : null;
  const transport = payload && typeof payload === "object" ? payload.transport : null;
  const liveOk = result.ok && (!transport || transport.ok !== false);
  post.updatedAt = nowIso();
  post.postResult = { at: nowIso(), account: account || DEFAULT_ACCOUNT, ok: liveOk, status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim(), error: result.error, transport };
  if (liveOk) {
    post.status = "posted";
    post.postedAt = nowIso();
  } else {
    post.status = "post_failed";
    if (transport && transport.output) post.postResult.error = transport.output;
  }
  writeStore(store);
  return post;
}

function addRewriteRequest(postId, instruction) {
  const store = readStore();
  const post = findPost(store, postId);
  const request = { id: makeId("rewrite"), postId, createdAt: nowIso(), status: "open", instruction: String(instruction || "").trim() || "Improve this post.", originalText: post.text };
  store.rewriteRequests.unshift(request);
  post.status = "rewrite_requested";
  post.updatedAt = nowIso();
  writeStore(store);
  return request;
}

function doctor(json) {
  const birdclawVersion = birdclaw(["--version"]);
  const birdclawAuth = birdclaw(["auth", "status", "--json"]);
  const birdVersion = bird(["--version"], 10000);
  const birdAuth = birdAuthStatus();
  const claudeVersion = run(CLAUDE_BIN, ["--version"], { timeout: 10000 });
  output({
    storePath: STORE_PATH,
    node: process.version,
    birdclaw: { installed: birdclawVersion.ok, version: birdclawVersion.stdout.trim(), authOk: birdclawAuth.ok, auth: birdclawAuth.stdout.trim() ? safeJson(birdclawAuth.stdout.trim()) : null, stderr: birdclawAuth.stderr.trim(), note: "Used for posting drafts via Birdclaw. Viral feed reads come via bird." },
    bird: { installed: birdVersion.ok, version: birdVersion.stdout.trim(), authOk: birdAuth.ok, handle: birdAuth.handle, status: birdAuth.message, note: birdAuth.ok ? null : "bird reads browser cookies. Log in to x.com in Chrome (or Firefox) so bird can authenticate." },
    claude: { installed: claudeVersion.ok, bin: CLAUDE_BIN, version: claudeVersion.stdout.trim(), model: CLAUDE_MODEL, error: claudeVersion.error || (claudeVersion.ok ? null : claudeVersion.stderr.trim()), note: claudeVersion.ok ? null : "claude CLI not found - LLM generation will fall back to templates. Set XSQUARED_DISABLE_LLM=1 to silence." }
  }, json);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, function(ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch];
  });
}

function html() {
  const CSS = ":root{color-scheme:light dark;--bg:#FAFAF7;--panel:#FFFFFF;--ink:#0A0A0A;--muted:#6B6B6B;--line:#E5E4DE;--accent:#B8542A;--accent-soft:#F2E3D9;--success:#15803D;--error:#B42318;--info:#1F4E8C;--r-sm:4px;--r-md:6px;--r-lg:8px;--shadow-1:0 1px 0 rgba(10,10,10,.03);--shadow-2:0 12px 30px rgba(10,10,10,.12);--font-ui:'Geist','Geist Sans',ui-sans-serif,system-ui,sans-serif;--font-display:'Fraunces',Georgia,serif;--font-mono:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace}@media (prefers-color-scheme:dark){:root{--bg:#0E0E0C;--panel:#161614;--ink:#F5F5F0;--muted:#A3A3A0;--line:#2A2A26;--accent:#C56A3F;--accent-soft:#2A1B14;--shadow-1:0 1px 0 rgba(0,0,0,.4);--shadow-2:0 12px 30px rgba(0,0,0,.5)}}*{box-sizing:border-box}body{margin:0;padding-bottom:96px;font-family:var(--font-ui);font-size:14px;line-height:1.5;background:var(--bg);color:var(--ink);font-feature-settings:'ss01','cv11';scroll-padding-bottom:96px}header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line)}.bar{max-width:1180px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:baseline;gap:10px;flex-shrink:0}h1{margin:0;font-family:var(--font-display);font-weight:600;font-size:22px;letter-spacing:-.01em;line-height:1}.brand-mark{color:var(--accent)}.brand-tag{font-family:var(--font-mono);font-size:11px;color:var(--muted);letter-spacing:.04em;text-transform:uppercase}.source-tabs{display:flex;gap:2px;overflow-x:auto;scroll-snap-type:x mandatory;flex:1;min-width:0;align-items:center;scrollbar-width:none;-ms-overflow-style:none}.source-tabs::-webkit-scrollbar{display:none}.tab-pill{appearance:none;background:transparent;border:none;color:var(--muted);font-family:var(--font-ui);font-weight:500;font-size:13px;padding:8px 12px;cursor:pointer;position:relative;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;scroll-snap-align:start;border-radius:0}.tab-pill:hover{color:var(--ink)}.tab-pill.active{color:var(--ink)}.tab-pill.active::after{content:'';position:absolute;left:8px;right:8px;bottom:-8px;height:2px;background:var(--accent)}.tab-pill .kind-pill{font-family:var(--font-mono);font-size:9px;text-transform:uppercase;letter-spacing:.06em;border:1px solid var(--line);border-radius:9999px;padding:1px 6px;color:var(--muted);background:var(--panel)}.tab-new{appearance:none;background:transparent;border:1px dashed var(--line);color:var(--muted);font-family:var(--font-ui);font-weight:500;font-size:12px;padding:6px 10px;cursor:pointer;border-radius:var(--r-sm);white-space:nowrap;flex-shrink:0}.tab-new:hover{color:var(--ink);border-color:var(--ink);border-style:solid}.tools{display:flex;gap:4px;align-items:center;flex-shrink:0}.tools .nav-link{appearance:none;background:transparent;border:none;color:var(--muted);font-size:12px;padding:6px 8px;cursor:pointer;font-family:var(--font-ui);font-weight:500;border-radius:var(--r-sm)}.tools .nav-link:hover{color:var(--ink)}.tools .nav-link.active{color:var(--ink)}main{max-width:1180px;margin:0 auto;padding:24px;display:block;overflow-x:clip}button,input,textarea,select{font:inherit}button{font-family:var(--font-ui);border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:var(--r-sm);padding:8px 12px;cursor:pointer;font-weight:500;transition:background 150ms ease-out,border-color 150ms ease-out,color 150ms ease-out,transform 80ms ease-out;display:inline-flex;align-items:center;justify-content:center;gap:6px}button:hover{border-color:var(--ink)}button:active{transform:translateY(1px)}button.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}button.primary:hover{background:#000;border-color:#000}button.accent{background:var(--accent);color:#fff;border-color:var(--accent)}button.accent:hover{background:#9F4823;border-color:#9F4823}button.danger-confirm{background:var(--accent);color:#fff;border-color:var(--accent)}button.ghost{background:transparent;border-color:transparent;color:var(--muted)}button.ghost:hover{color:var(--ink);background:var(--accent-soft);border-color:transparent}button:disabled{cursor:not-allowed;transform:none;background:var(--bg);color:var(--muted);border-color:var(--line)}button.accent:disabled,button.primary:disabled{background:var(--bg);color:var(--muted);border-color:var(--line);box-shadow:none}button.secondary{background:transparent;color:var(--ink);border-color:var(--line)}button.secondary:hover{border-color:var(--ink)}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,.tab-pill:focus-visible{outline:2px solid var(--accent);outline-offset:2px}input,textarea,select{width:100%;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:var(--r-sm);padding:10px 12px;font-family:var(--font-ui);transition:border-color 150ms ease-out}input:hover,textarea:hover,select:hover{border-color:#B5B5AE}input::placeholder,textarea::placeholder{color:var(--muted);opacity:.7}textarea{min-height:96px;resize:vertical;line-height:1.45}.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:20px;margin-bottom:16px;box-shadow:var(--shadow-1)}.panel-head{font-family:var(--font-display);font-weight:500;font-size:13px;letter-spacing:.03em;text-transform:uppercase;color:var(--muted);margin:0 0 14px;padding-bottom:8px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center}.field{display:grid;gap:6px;margin-bottom:12px}.field:last-child{margin-bottom:0}label{color:var(--muted);font-size:12px;font-weight:500;letter-spacing:.01em}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.posts{display:grid;gap:14px}.post,.profile-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:20px;display:grid;gap:12px;box-shadow:var(--shadow-1)}.post textarea{min-height:96px}.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}.metric{border:1px solid var(--line);border-radius:var(--r-sm);padding:12px;background:var(--bg);font-variant-numeric:tabular-nums}.metric b{display:block;font-family:var(--font-display);font-weight:500;font-size:24px;line-height:1.1;letter-spacing:-.01em}.metric span{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}.meta{color:var(--muted);font-size:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}.meta time,.meta .ts{font-family:var(--font-mono);font-size:11px}.pill{border:1px solid var(--line);border-radius:9999px;padding:2px 8px;background:var(--panel);font-size:11px;color:var(--muted);font-weight:500}.pill-source{border-color:var(--accent);color:var(--accent)}.pill-status{border-color:var(--ink);color:var(--ink);background:var(--bg);text-transform:lowercase;font-family:var(--font-mono);font-size:10px;letter-spacing:.04em;padding:2px 7px}.pill-status[data-status='posted']{border-color:var(--success);color:var(--success);background:transparent}.pill-status[data-status='failed']{border-color:var(--error);color:var(--error);background:transparent}.pill-status[data-status='rewrite_requested']{border-color:var(--info);color:var(--info);background:transparent}.score{color:var(--accent);font-variant-numeric:tabular-nums;font-weight:500}.posted{color:var(--success);font-size:12px}.failed{color:var(--error);white-space:pre-wrap;font-size:12px;padding:8px 10px;background:var(--bg);border-radius:var(--r-sm);border:1px solid var(--error)}.trend-list{display:grid;gap:0;font-size:13px;color:var(--ink)}.trend-list span{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid var(--line);padding:6px 0;font-variant-numeric:tabular-nums}.trend-list span:last-child{border-bottom:none}.trend-list b{font-weight:500}.trend-list em{font-style:normal;color:var(--muted);font-family:var(--font-mono);font-size:11px}.sample{white-space:pre-wrap;border-top:1px solid var(--line);padding-top:12px;margin-top:4px;color:var(--ink);line-height:1.55}.empty{color:var(--muted);padding:32px 24px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--panel);display:grid;gap:8px}.empty-title{font-family:var(--font-display);font-weight:500;font-size:18px;color:var(--ink);letter-spacing:-.01em}.empty-body{font-size:13px;line-height:1.5}.empty-hero{padding:48px 32px;text-align:left;display:grid;gap:14px;max-width:560px;margin:24px auto}.empty-hero h2{font-family:var(--font-display);font-weight:600;font-size:32px;letter-spacing:-.02em;margin:0;color:var(--ink)}.empty-hero p{margin:0;color:var(--muted);line-height:1.55}.empty-hero .row{margin-top:8px;gap:10px}.status-bar{font-family:var(--font-mono);font-size:11px;color:var(--muted);padding:8px 10px;background:var(--bg);border-radius:var(--r-sm);border:1px solid var(--line);min-height:32px;display:none;align-items:center;gap:8px}.status-bar.success{display:flex;color:var(--success);border-color:var(--success)}.status-bar.failed{display:flex;color:var(--error);border-color:var(--error);white-space:pre-wrap;align-items:flex-start;line-height:1.4}.status-bar.show{display:flex}.status-bar::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}.src-view{display:grid;grid-template-columns:320px 1fr;gap:24px;align-items:start}.src-side{position:sticky;top:80px;display:grid;gap:12px;align-self:start}.src-main{min-width:0;display:grid;gap:16px}.config-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);box-shadow:var(--shadow-1)}.config-card>summary{list-style:none;padding:14px 18px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-family:var(--font-display);font-weight:500;font-size:13px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)}.config-card>summary::-webkit-details-marker{display:none}.config-card>summary::after{content:'';width:8px;height:8px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:rotate(-45deg);margin-right:4px;transition:transform 150ms ease-out}.config-card[open]>summary::after{transform:rotate(45deg);margin-top:-4px}.config-body{padding:0 18px 18px}.cta-stack{display:grid;gap:10px}.cta-sub{font-family:var(--font-mono);font-size:10px;color:var(--muted);text-align:center;margin-top:-2px}.cta-hint{font-size:12px;color:var(--muted);line-height:1.45;padding:0 2px}.cta-hint b{color:var(--ink);font-weight:500}.spinner{width:12px;height:12px;border-radius:50%;border:1.5px solid currentColor;border-right-color:transparent;animation:spin .6s linear infinite;display:inline-block}@keyframes spin{to{transform:rotate(360deg)}}.research-meta{font-family:var(--font-mono);font-size:11px;color:var(--muted);display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}.research-section{border-top:1px solid var(--line);padding-top:10px;margin-top:10px}.research-section:first-of-type{border-top:0;padding-top:0;margin-top:0}.research-section>summary{cursor:pointer;font-weight:500;font-size:13px;color:var(--ink);padding:6px 0;list-style:none;display:flex;justify-content:space-between;align-items:center}.research-section>summary::-webkit-details-marker{display:none}.research-section>summary::after{content:'+';font-family:var(--font-mono);color:var(--muted);font-size:12px}.research-section[open]>summary::after{content:'\\2013'}.fact-list{margin:8px 0 0;padding-left:20px;display:grid;gap:6px;font-size:13px;line-height:1.5}.fact-cite{font-family:var(--font-mono);font-size:10px;color:var(--accent);vertical-align:super;margin-left:2px}.link-list{display:grid;gap:10px;margin-top:8px}.link-item{display:grid;gap:2px;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--bg)}.link-item a{color:var(--ink);text-decoration:none;font-weight:500;font-size:13px;line-height:1.35}.link-item a:hover{color:var(--accent)}.link-item .snippet{font-size:12px;color:var(--muted);line-height:1.4}.link-item .host{font-family:var(--font-mono);font-size:10px;color:var(--muted);text-transform:lowercase;letter-spacing:.04em}.summary-list{margin:8px 0 0;padding-left:20px;display:grid;gap:6px;font-size:13px;line-height:1.5}.divider{border:0;border-top:1px solid var(--line);margin:8px 0 0}.main-tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:16px;position:sticky;top:65px;background:var(--bg);z-index:1;padding-top:2px;transition:box-shadow 150ms ease-out}.main-tabs[data-stuck=\"true\"]{box-shadow:0 6px 12px -6px rgba(10,10,10,.12)}.main-tab{appearance:none;background:transparent;border:none;border-radius:0;color:var(--muted);font-family:var(--font-ui);font-weight:500;font-size:14px;padding:10px 14px;cursor:pointer;position:relative;display:inline-flex;align-items:center;gap:8px;white-space:nowrap}.main-tab:hover{color:var(--ink);border:none}.main-tab.active{color:var(--ink)}.main-tab.active::after{content:'';position:absolute;left:14px;right:14px;bottom:-1px;height:2px;background:var(--accent)}.main-tab .tab-count{font-family:var(--font-mono);font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:9999px;padding:1px 7px;min-width:18px;text-align:center}.main-tab.active .tab-count{color:var(--ink);border-color:var(--ink)}.main-tab .tab-badge{font-family:var(--font-mono);font-size:10px;background:var(--accent);color:#fff;border-radius:9999px;padding:1px 7px;min-width:16px;text-align:center}.sel-summary{font-size:12px;color:var(--muted);padding:0 2px;display:flex;align-items:baseline;gap:6px}.sel-summary-count{font-family:var(--font-display);font-weight:600;font-size:22px;color:var(--accent);line-height:1;letter-spacing:-.01em}.viral-tile-engagement{display:flex;gap:12px;font-family:var(--font-mono);font-size:11px;color:var(--muted);border-top:1px solid var(--line);padding-top:6px;margin-top:2px}.viral-tile-engagement span{display:inline-flex;align-items:center;gap:3px}.viral-tile{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:12px 14px;cursor:pointer;display:grid;gap:8px;transition:border-color 150ms ease-out}.viral-tile:hover{border-color:var(--muted)}.viral-tile.selected{border-color:var(--accent);border-width:2px;padding:11px 13px;background:var(--accent-soft)}.viral-tile-body{font-size:13px;line-height:1.5;white-space:pre-wrap}.viral-tile-meta{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--muted)}.viral-tile-meta a:hover{color:var(--accent)}.viral-tile-media{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:4px;border-radius:var(--r-sm);overflow:hidden}.viral-tile-media img{display:block;width:100%;height:100%;max-height:160px;object-fit:cover;border-radius:var(--r-sm);border:1px solid var(--line);background:var(--bg)}.viral-tile-cards{display:grid;gap:6px}.viral-card{display:grid;gap:2px;padding:8px 10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--bg);text-decoration:none;color:var(--ink);transition:border-color 150ms ease-out}.viral-card:hover{border-color:var(--ink)}.viral-card-title{font-size:12px;font-weight:500;line-height:1.35;color:var(--ink)}.viral-card-host{font-family:var(--font-mono);font-size:10px;color:var(--muted);text-transform:lowercase;letter-spacing:.04em}.viral-grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}.inspired-by{font-size:11px;color:var(--muted);font-family:var(--font-mono);margin-bottom:-4px}.note-block{font-size:12px;color:var(--muted);padding:8px 10px;background:var(--bg);border-radius:var(--r-sm);border:1px solid var(--line)}.section-head{font-family:var(--font-display);font-size:18px;font-weight:500;letter-spacing:-.01em;margin:0;color:var(--ink)}.section-row{display:flex;justify-content:space-between;align-items:baseline;gap:12px}.modal-overlay{position:fixed;inset:0;background:rgba(10,10,10,.42);display:none;align-items:center;justify-content:center;z-index:10;padding:16px}.modal-overlay.show{display:flex}.modal{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);box-shadow:var(--shadow-2);padding:24px;width:100%;max-width:420px;display:grid;gap:14px}.modal h3{margin:0;font-family:var(--font-display);font-size:20px;font-weight:600;letter-spacing:-.01em}.cost-bar{font-family:var(--font-mono);font-size:11px;color:var(--muted);padding:4px 10px;border-radius:var(--r-sm);display:none;align-items:center;gap:6px}.cost-bar.show{display:inline-flex}.chat-dock{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:5;width:min(760px,calc(100vw - 32px));background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);box-shadow:var(--shadow-2);padding:10px;display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center}.chat-dock-head{font-family:var(--font-display);font-weight:500;font-size:13px;letter-spacing:.03em;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:8px;white-space:nowrap}.chat-dock textarea{min-height:42px;height:42px;resize:none}.chat-dock .status-bar{grid-column:1/-1}.chat-log{display:none}@media(max-width:820px){body{padding-bottom:200px;scroll-padding-bottom:200px}main{padding:16px}.bar{padding:12px 16px;gap:10px;flex-wrap:wrap}.brand h1{font-size:18px}.src-view{grid-template-columns:1fr}.src-side{position:static}.viral-grid{grid-template-columns:1fr}.chat-dock{grid-template-columns:1fr}.chat-dock-head{justify-content:space-between}.chat-dock textarea{height:72px}.empty-hero{padding:24px 8px}.empty-hero h2{font-size:26px}}@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}";

  const HEADER = "<header><div class=\"bar\"><div class=\"brand\"><h1><span class=\"brand-mark\">x</span>squared</h1><span class=\"brand-tag\">drafts</span></div><div id=\"sourceTabs\" class=\"source-tabs\" role=\"tablist\" aria-label=\"Sources\"></div><div class=\"tools\"><span id=\"costBar\" class=\"cost-bar\" title=\"Latest LLM cost\"></span><button class=\"nav-link\" data-nav=\"profile\" data-route=\"/profile\">Profile</button><button id=\"doctor\" class=\"nav-link\">Doctor</button></div></div></header>";

  const MODAL_HTML = "<div id=\"newSourceModal\" class=\"modal-overlay\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"newSourceTitle\"><div class=\"modal\"><h3 id=\"newSourceTitle\">New source</h3><p style=\"margin:0;color:var(--muted);font-size:13px;line-height:1.5\">A source is a researched topic you want to post about. We'll pull links and facts on demand, then generate drafts in your voice.</p><div class=\"field\"><label for=\"newSourceName\">Name</label><input id=\"newSourceName\" placeholder=\"e.g. AI agents, Google Ads for SMBs\"></div><div class=\"row\" style=\"justify-content:flex-end\"><button id=\"cancelNewSource\" class=\"ghost\">Cancel</button><button id=\"confirmNewSource\" class=\"primary\">Create</button></div></div></div>";

  const CHAT_DOCK = "<div class=\"chat-dock\"><div class=\"chat-dock-head\">Eigen<span id=\"chatDot\" title=\"Checking session\" style=\"width:8px;height:8px;border-radius:9999px;background:var(--muted);display:inline-block\"></span></div><div id=\"chatLog\" class=\"chat-log\"></div><textarea id=\"chatInput\" placeholder=\"Ask Eigen about these drafts...\"></textarea><button id=\"chatSend\" class=\"primary\">Send</button><div id=\"status\" class=\"status-bar\">Ready.</div></div>";

  const JS = `const $=id=>document.getElementById(id);
const state={sources:[],activeId:null,view:'sources',posts:[],profileSnapshots:[],selectedFeedIds:new Set(),chatMessages:[],chatTarget:null,lastCost:null};
const pendingPost=new Map();
const pendingDelete=new Map();
const pendingDeleteSource=new Map();
const autosaveTimers=new Map();
function setStatus(t,c){const e=$('status');e.className='status-bar'+(c?' '+c:'')+((t&&t!=='Ready.')?' show':'');e.textContent=t}
function setCost(cost){const e=$('costBar');if(cost==null||isNaN(Number(cost))){e.className='cost-bar';e.textContent='';return}e.className='cost-bar show';e.textContent='$'+Number(cost).toFixed(2)}
async function api(p,o={}){const r=await fetch(p,{headers:{'content-type':'application/json'},...o});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||r.statusText);return b}
function esc(v){return String(v||'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
function fmtDate(d){if(!d)return '';const x=new Date(d);const diff=(Date.now()-x.getTime())/1000;if(diff<60)return 'just now';if(diff<3600)return Math.floor(diff/60)+'m ago';if(diff<86400)return Math.floor(diff/3600)+'h ago';if(diff<604800)return Math.floor(diff/86400)+'d ago';return x.toLocaleDateString(undefined,{month:'short',day:'numeric'})}
function host(u){try{return new URL(u).host.replace(/^www\\./,'')}catch(e){return ''}}
function spin(label){return '<span class="spinner"></span><span>'+esc(label)+'</span>'}
function renderPostCard(p){
  const st=p.status||'draft';
  const inspired=(p.inspirationPosts&&p.inspirationPosts[0])?p.inspirationPosts[0]:null;
  const inspLine=inspired?'<div class="inspired-by">inspired by @'+esc(String(inspired.author||'').replace(/^@/,''))+'</div>':'';
  return '<article class="post" data-id="'+esc(p.id)+'">'+inspLine+'<div class="meta"><span class="pill pill-status" data-status="'+esc(st)+'">'+esc(st)+'</span>'+(p.angle?'<span class="pill">'+esc(p.angle)+'</span>':'')+(p.score!=null?'<span class="score">'+esc(p.score)+'</span>':'')+'<span class="ts">'+fmtDate(p.updatedAt||p.createdAt)+'</span></div><textarea data-field="text">'+esc(p.text)+'</textarea>'+(p.notes?'<div class="note-block">'+esc(p.notes)+'</div>':'')+'<div class="field"><label>Instructions</label><input data-field="rewrite" placeholder="Optional: sharper, more specific, less hype..."></div><div class="row"><button data-action="save">Save</button><button data-action="rewrite">Request rewrite</button><button data-action="delete" class="ghost">Delete</button><button data-action="post" class="primary">Post to X</button></div>'+(p.postResult&&!p.postResult.ok?'<div class="failed">'+esc(p.postResult.stderr||p.postResult.error||'Post failed')+'</div>':'')+(p.postedAt?'<div class="posted">\\u2713 Posted '+fmtDate(p.postedAt)+'</div>':'')+'</article>';
}
function renderDraftsForSource(sourceId){
  const list=state.posts.filter(p=>p.sourceId===sourceId);
  if(!list.length) return '<div class="empty"><div class="empty-title">No drafts yet.</div><div class="empty-body">Use the actions in the sidebar to generate posts.</div></div>';
  const groups={draft:[],rewrite_requested:[],posted:[],other:[]};
  list.forEach(p=>{const s=p.status||'draft';if(groups[s])groups[s].push(p);else groups.other.push(p)});
  let html='';
  if(groups.draft.length) html+='<div class="posts">'+groups.draft.map(renderPostCard).join('')+'</div>';
  if(groups.rewrite_requested.length) html+='<details open class="config-card" style="margin-top:14px"><summary style="padding:12px 16px;font-size:12px">Rewrite requested ('+groups.rewrite_requested.length+')</summary><div style="padding:0 16px 16px"><div class="posts">'+groups.rewrite_requested.map(renderPostCard).join('')+'</div></div></details>';
  if(groups.other.length) html+='<div class="posts" style="margin-top:14px">'+groups.other.map(renderPostCard).join('')+'</div>';
  if(groups.posted.length) html+='<details class="config-card" style="margin-top:14px"><summary style="padding:12px 16px;font-size:12px">Posted ('+groups.posted.length+')</summary><div style="padding:0 16px 16px"><div class="posts">'+groups.posted.map(renderPostCard).join('')+'</div></div></details>';
  return html;
}
function configCollapsedKey(srcId){return 'xsq.config.collapsed.'+srcId}
function isConfigCollapsed(srcId,hasDrafts){const v=localStorage.getItem(configCollapsedKey(srcId));if(v==='1')return true;if(v==='0')return false;return hasDrafts}
function renderTabs(){
  const root=$('sourceTabs');
  const parts=state.sources.map(s=>{
    const active=s.id===state.activeId&&state.view==='source';
    return '<button class="tab-pill'+(active?' active':'')+'" data-src="'+esc(s.id)+'" role="tab"><span>'+esc(s.name)+'</span><span class="kind-pill">'+esc(s.kind)+'</span></button>';
  });
  parts.push('<button id="newSourceBtn" class="tab-new" type="button">+ New source</button>');
  root.innerHTML=parts.join('');
  document.querySelectorAll('.nav-link[data-nav]').forEach(b=>b.classList.toggle('active',state.view===b.dataset.nav));
}
function renderTopicView(src){
  const c=src.config||{};
  const hasDrafts=state.posts.some(p=>p.sourceId===src.id);
  const collapsed=isConfigCollapsed(src.id,hasDrafts);
  const genDisabled=!(src.research||(c.seedNotes&&c.seedNotes.trim()));
  const r=src.research;
  let researchInner;
  if(!r){researchInner='<div style="font-size:13px;color:var(--muted);line-height:1.5">No research yet. Click <b>Run research</b> to gather links + facts.</div>'}
  else{
    const factsHtml=(r.facts||[]).map(f=>{const html=esc(f).replace(/\\[(\\d+)\\]/g,'<a class="fact-cite" href="#src-link-'+src.id+'-$1">[$1]</a>');return '<li>'+html+'</li>'}).join('');
    const summariesHtml=(r.summaries||[]).map(s=>'<li>'+esc(s)+'</li>').join('');
    const linksHtml=(r.links||[]).map((l,i)=>'<div class="link-item" id="src-link-'+src.id+'-'+(i+1)+'"><a href="'+esc(l.url)+'" target="_blank" rel="noopener">'+esc(l.title||l.url)+'</a>'+(l.snippet?'<div class="snippet">'+esc(l.snippet)+'</div>':'')+'<span class="host">'+(l.url?esc(host(l.url)):'')+'</span></div>').join('');
    researchInner='<div class="research-meta"><span>Last run '+fmtDate(r.createdAt)+'</span><span>\\u00b7</span><span>$'+Number(r.costUsd||0).toFixed(2)+'</span><span>\\u00b7</span><span>'+(r.links||[]).length+' links</span><span>\\u00b7</span><span>'+(r.durationMs?Math.round(r.durationMs/1000)+'s':'')+'</span></div>'+'<details open class="research-section"><summary>Summaries ('+(r.summaries||[]).length+')</summary><ul class="summary-list">'+(summariesHtml||'<li style="color:var(--muted);list-style:none;margin-left:-20px">No summaries returned.</li>')+'</ul></details>'+'<details class="research-section"><summary>Facts ('+(r.facts||[]).length+')</summary><ol class="fact-list">'+(factsHtml||'<li style="color:var(--muted)">No facts returned.</li>')+'</ol></details>'+'<details class="research-section"><summary>Sources ('+(r.links||[]).length+')</summary><div class="link-list">'+(linksHtml||'<div style="color:var(--muted);font-size:12px">No links returned.</div>')+'</div></details>';
  }
  return '<div class="src-view"><aside class="src-side">'+
    '<details class="config-card" id="configCard" '+(collapsed?'':'open')+'><summary>Config</summary><div class="config-body">'+
    '<div class="field"><label for="cfgName">Name</label><input id="cfgName" value="'+esc(src.name)+'"></div>'+
    '<div class="field"><label for="cfgAngle">Angle / objective</label><input id="cfgAngle" value="'+esc(c.angle||'')+'" placeholder="What angle or claim?"></div>'+
    '<div class="field"><label for="cfgNotes">Seed notes</label><textarea id="cfgNotes" placeholder="Paste references, constraints, examples...">'+esc(c.seedNotes||'')+'</textarea></div>'+
    '<div class="field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="cfgVoice" '+(c.useTweetVoice!==false?'checked':'')+' style="width:auto"> Use tweet-sample voice</label></div>'+
    '<div class="row" style="margin-top:8px"><button id="saveCfgBtn" class="primary">Save</button><button id="deleteSrcBtn" class="ghost">Delete</button></div>'+
    '</div></details>'+
    '<div class="cta-stack">'+
      '<button id="runResearchBtn" class="primary" style="width:100%">Run research</button>'+
      '<div class="cta-sub">~30\\u201390s \\u00b7 ~$0.05\\u20130.25 each</div>'+
      '<button id="generateBtn" class="accent" style="width:100%;margin-top:8px"'+(genDisabled?' disabled title="Add research or seed notes first"':'')+'>Generate 5 posts</button>'+
      '<div class="cta-sub">~5\\u201315s</div>'+
    '</div>'+
  '</aside><div class="src-main">'+
    '<section class="panel"><div class="panel-head"><span>Research</span></div>'+researchInner+'</section>'+
    '<hr class="divider">'+
    '<div class="section-row"><h2 class="section-head">Drafts ('+state.posts.filter(p=>p.sourceId===src.id).length+')</h2></div>'+
    '<div id="draftsRoot">'+renderDraftsForSource(src.id)+'</div>'+
  '</div></div>';
}
function viralTabKey(srcId){return 'xsq.viral.tab.'+srcId}
function getViralTab(srcId,draftCount,feedCount){
  const stored=localStorage.getItem(viralTabKey(srcId));
  if(stored==='drafts'||stored==='feed')return stored;
  // Defaults: have drafts → drafts; otherwise feed (so user can pick + generate).
  if(draftCount>0)return 'drafts';
  if(feedCount>0)return 'feed';
  return 'feed';
}
function setViralTab(srcId,tab){localStorage.setItem(viralTabKey(srcId),tab)}
function renderViralView(src){
  const c=src.config||{};
  const draftCount=state.posts.filter(p=>p.sourceId===src.id).length;
  const hasDrafts=draftCount>0;
  const collapsed=isConfigCollapsed(src.id,hasDrafts);
  const snap=src.lastFeedSnapshot;
  const selN=state.selectedFeedIds.size;
  const totalN=snap&&snap.posts?snap.posts.length:0;
  const genDisabled=selN===0;
  const activeTab=getViralTab(src.id,draftCount,totalN);
  let feedInner;
  if(!snap||!snap.posts||!snap.posts.length){feedInner='<div class="empty"><div class="empty-title">No viral feed yet.</div><div class="empty-body">Click <b>Fetch viral feed</b> in the sidebar to pull recent posts.</div></div>'}
  else{
    const tiles=snap.posts.map(p=>{
      const sel=state.selectedFeedIds.has(p.id);
      const handle=esc(String(p.author||'?').replace(/^@/,''));
      const tweetHref=p.tweetUrl||p.url||'';
      const profileHref=p.profileUrl||'';
      const handleHtml=profileHref?'<a href="'+esc(profileHref)+'" target="_blank" rel="noopener" data-no-toggle style="color:var(--ink);text-decoration:none">@'+handle+'</a>':'<span>@'+handle+'</span>';
      const dateHtml=p.createdAt?(tweetHref?'<a href="'+esc(tweetHref)+'" target="_blank" rel="noopener" data-no-toggle class="ts" style="color:var(--muted);text-decoration:none">'+fmtDate(p.createdAt)+'</a>':'<span class="ts">'+fmtDate(p.createdAt)+'</span>'):'';
      const images=Array.isArray(p.images)?p.images.filter(im=>im&&im.url):[];
      const imgHtml=images.length?'<div class="viral-tile-media">'+images.slice(0,4).map(im=>'<a href="'+esc(tweetHref||im.url)+'" target="_blank" rel="noopener" data-no-toggle><img src="'+esc(im.thumbnailUrl||im.url)+'" alt="'+esc(im.altText||'')+'" loading="lazy"></a>').join('')+'</div>':'';
      const cards=Array.isArray(p.urlCards)?p.urlCards.filter(c=>c&&c.url):[];
      const cardHtml=cards.length?'<div class="viral-tile-cards">'+cards.slice(0,2).map(c=>{const host=(()=>{try{return new URL(c.url).hostname.replace(/^www\\./,'')}catch{return ''}})();return '<a href="'+esc(c.url)+'" target="_blank" rel="noopener" data-no-toggle class="viral-card">'+(c.title?'<span class="viral-card-title">'+esc(c.title)+'</span>':'')+'<span class="viral-card-host">'+esc(host||c.displayUrl||c.url)+'</span></a>'}).join('')+'</div>':'';
      const openHtml=tweetHref?'<a href="'+esc(tweetHref)+'" target="_blank" rel="noopener" data-no-toggle style="margin-left:auto;font-size:11px;color:var(--muted);text-decoration:none">open tweet \\u2197</a>':'';
      const engagement=(p.likeCount||p.retweetCount||p.replyCount)?'<div class="viral-tile-engagement"><span>\\u2764 '+(p.likeCount||0)+'</span><span>\\u21bb '+(p.retweetCount||0)+'</span><span>\\u{1F4AC} '+(p.replyCount||0)+'</span></div>':'';
      return '<div class="viral-tile'+(sel?' selected':'')+'" data-fid="'+esc(p.id)+'"><div class="viral-tile-meta">'+handleHtml+dateHtml+openHtml+'</div><div class="viral-tile-body">'+esc(p.text)+'</div>'+imgHtml+cardHtml+engagement+'</div>';
    }).join('');
    feedInner='<div class="research-meta"><span>'+selN+' of '+totalN+' selected</span><span>\\u00b7</span><span>click to toggle</span><span>\\u00b7</span><span>fetched '+fmtDate(snap.createdAt)+'</span></div><div class="viral-grid">'+tiles+'</div>';
  }
  return '<div class="src-view"><aside class="src-side">'+
    '<details class="config-card" id="configCard" '+(collapsed?'':'open')+'><summary>Config</summary><div class="config-body">'+
    '<div class="field"><label for="cfgName">Name</label><input id="cfgName" value="'+esc(src.name)+'"></div>'+
    '<div class="field"><label for="cfgFilter">Filter</label><input id="cfgFilter" value="'+esc(c.filter||'')+'" placeholder="e.g. AI agents"></div>'+
    '<div class="field"><label for="cfgResource">Resource</label><select id="cfgResource"><option value="home"'+(c.resource==='home'?' selected':'')+'>home</option><option value="following"'+(c.resource==='following'?' selected':'')+'>following</option><option value="for-you"'+(c.resource==='for-you'?' selected':'')+'>for-you</option></select></div>'+
    '<div class="field"><label for="cfgLimit">Limit</label><input id="cfgLimit" type="number" value="'+esc(c.limit||40)+'" min="1" max="200"></div>'+
    '<div class="row" style="margin-top:8px"><button id="saveCfgBtn" class="primary">Save</button><button id="deleteSrcBtn" class="ghost">Delete</button></div>'+
    '</div></details>'+
    (selN?'<div class="sel-summary"><span class="sel-summary-count">'+selN+'</span> selected</div>':'')+
    '<div class="cta-stack">'+
      '<button id="fetchFeedBtn" class="'+(snap?'secondary':'primary')+'" style="width:100%">'+(snap?'Refresh viral feed':'Fetch viral feed')+'</button>'+
      '<button id="generateBtn" class="accent" style="width:100%"'+(genDisabled?' disabled title="Select at least one viral post first"':'')+'>'+(selN?'Generate '+selN+' draft'+(selN===1?'':'s'):'Select posts to generate')+'</button>'+
      (genDisabled?'<div class="cta-hint">Switch to <b>Feed</b>, pick posts you want to rewrite.</div>':'<div class="cta-hint">Drafts will be written in your voice in ~5\\u201315s.</div>')+
    '</div>'+
  '</aside><div class="src-main">'+
    '<div class="main-tabs" role="tablist">'+
      '<button class="main-tab'+(activeTab==='drafts'?' active':'')+'" data-tab="drafts" role="tab">Drafts <span class="tab-count">'+draftCount+'</span></button>'+
      '<button class="main-tab'+(activeTab==='feed'?' active':'')+'" data-tab="feed" role="tab">Feed <span class="tab-count">'+totalN+'</span>'+(selN?' <span class="tab-badge">'+selN+'</span>':'')+'</button>'+
    '</div>'+
    (activeTab==='drafts'
      ? '<div id="draftsRoot">'+renderDraftsForSource(src.id)+'</div>'
      : '<section>'+feedInner+'</section>')+
  '</div></div>';
}
function renderEmpty(){
  return '<div class="empty-hero"><h2>Start with a topic.</h2><p>A source is a subject you want to post about — like <em>Google Ads for small business</em> or <em>AI agents</em>. We research the topic and draft posts in your voice. Your <b>Viral feed</b> tab is always available for inspiration from recent posts.</p><div class="row"><button class="primary" data-new-source>+ New source</button></div></div>';
}
function renderProfileView(){
  const root=document.createElement('div');root.id='profile';root.className='posts';
  const s=state.profileSnapshots[0];
  if(!s){root.innerHTML='<div class="empty"><div class="empty-title">No profile snapshot yet.</div><div class="empty-body">xsquared learns your profile automatically from Birdclaw when this tab loads.</div></div>';return root.outerHTML}
  const p=s.profile||{};const m=p.metrics||{};
  function metric(label,value){return '<div class="metric"><b>'+esc(value)+'</b><span>'+esc(label)+'</span></div>'}
  root.innerHTML='<article class="profile-card"><div class="meta"><span class="pill">'+esc(s.handle||'authored')+'</span><span class="ts">'+fmtDate(s.createdAt)+'</span><span>'+esc(p.sampleCount||0)+' tweets</span></div>'+(s.note?'<div class="failed">'+esc(s.note)+'</div>':'')+'<div class="metric-grid">'+metric('median chars',m.medianChars||0)+metric('median lines',m.medianLines||0)+metric('short posts',String(m.shortPostPct||0)+'%')+metric('links',String(m.linkPct||0)+'%')+metric('questions',String(m.questionPct||0)+'%')+metric('hashtags',String(m.hashtagPct||0)+'%')+'</div><div><b>Style guidance</b><div class="trend-list">'+(p.guidance||[]).map(x=>'<span>'+esc(x)+'</span>').join('')+'</div></div><div><b>Common terms</b><div class="trend-list">'+(((p.terms||{}).terms||[]).slice(0,12).map(t=>'<span><b>'+esc(t.term)+'</b><em>'+t.count+'</em></span>').join('')||'<span>None yet</span>')+'</div></div><div><b>Repeated phrases</b><div class="trend-list">'+((p.phrases||[]).slice(0,12).map(t=>'<span><b>'+esc(t.phrase)+'</b><em>'+t.count+'</em></span>').join('')||'<span>None yet</span>')+'</div></div><div><b>Sample posts</b>'+((p.samples||[]).map(x=>'<div class="sample">'+esc(x.text)+'</div>').join('')||'<div class="sample">No samples.</div>')+'</div></article>';
  return root.outerHTML;
}
function render(){
  renderTabs();
  const root=$('appRoot');
  if(state.view==='profile'){root.innerHTML=renderProfileView();return}
  if(!state.sources.length){root.innerHTML=renderEmpty();bindEmpty();return}
  const src=state.sources.find(s=>s.id===state.activeId);
  if(!src){root.innerHTML=renderEmpty();bindEmpty();return}
  root.innerHTML=src.kind==='topic'?renderTopicView(src):renderViralView(src);
  bindSourceView(src);
}
function bindEmpty(){
  document.querySelectorAll('[data-new-source]').forEach(b=>b.onclick=()=>openModal())
}
function bindSourceView(src){
  // config persistence
  const cc=$('configCard');
  if(cc){cc.addEventListener('toggle',()=>localStorage.setItem(configCollapsedKey(src.id),cc.open?'0':'1'))}
  $('saveCfgBtn').onclick=async()=>{
    const btn=$('saveCfgBtn');const orig=btn.textContent;
    try{
      btn.disabled=true;btn.innerHTML=spin('Saving');
      const name=$('cfgName').value.trim();
      let config;
      if(src.kind==='topic'){
        config={angle:$('cfgAngle').value,seedNotes:$('cfgNotes').value,useTweetVoice:$('cfgVoice').checked};
      }else{
        config={filter:$('cfgFilter').value,resource:$('cfgResource').value,limit:Number($('cfgLimit').value)||40};
      }
      const updated=await api('/api/sources/'+src.id,{method:'PATCH',body:JSON.stringify({name,config})});
      const idx=state.sources.findIndex(s=>s.id===src.id);
      if(idx>=0)state.sources[idx]=updated;
      setStatus('Saved.','success');
      render();
    }catch(e){setStatus(e.message,'failed');btn.disabled=false;btn.textContent=orig}
  };
  $('deleteSrcBtn').onclick=async()=>{
    const btn=$('deleteSrcBtn');
    if(!pendingDeleteSource.has(src.id)){
      const orig=btn.textContent;
      btn.classList.add('danger-confirm');btn.textContent='Click again to delete';
      const t=setTimeout(()=>{if(pendingDeleteSource.get(src.id)===t){pendingDeleteSource.delete(src.id);btn.classList.remove('danger-confirm');btn.textContent=orig}},6000);
      pendingDeleteSource.set(src.id,t);
      setStatus('Confirm: click again within 6s to delete this source.');return;
    }
    clearTimeout(pendingDeleteSource.get(src.id));pendingDeleteSource.delete(src.id);
    btn.innerHTML=spin('Deleting');btn.disabled=true;
    try{
      const r=await api('/api/sources/'+src.id,{method:'DELETE'});
      setStatus('Source deleted'+(r.orphanedPostCount?' \\u00b7 '+r.orphanedPostCount+' drafts kept':''),'success');
      await reloadSources();
      const next=state.sources[0];
      if(next)navigate('/sources/'+next.id);else navigate('/sources');
    }catch(e){setStatus(e.message,'failed');btn.disabled=false;btn.classList.remove('danger-confirm');btn.textContent='Delete'}
  };
  if(src.kind==='topic'){
    $('runResearchBtn').onclick=async()=>{
      const btn=$('runResearchBtn');
      try{
        btn.disabled=true;btn.innerHTML=spin('Researching...');
        setStatus('Running research \\u00b7 30\\u201390s typical');
        const artifact=await api('/api/sources/'+src.id+'/research',{method:'POST'});
        setCost(artifact.costUsd);
        setStatus('Research done \\u00b7 $'+Number(artifact.costUsd||0).toFixed(2)+' \\u00b7 '+(artifact.links||[]).length+' links','success');
        await reloadSources();render();
      }catch(e){setStatus(e.message,'failed');btn.disabled=false;btn.textContent='Run research'}
    };
    $('generateBtn').onclick=async()=>{
      const btn=$('generateBtn');
      try{
        btn.disabled=true;btn.innerHTML=spin('Generating...');
        setStatus('Generating posts...');
        const data=await api('/api/sources/'+src.id+'/generate',{method:'POST',body:JSON.stringify({count:5})});
        setCost(data.costUsd);
        await reloadAll();
        setStatus('Generated '+(data.posts||[]).length+' drafts \\u00b7 $'+Number(data.costUsd||0).toFixed(2),'success');
      }catch(e){setStatus(e.message,'failed');btn.disabled=false;btn.textContent='Generate 5 posts'}
    };
  }else{
    $('fetchFeedBtn').onclick=async()=>{
      const btn=$('fetchFeedBtn');
      try{
        btn.disabled=true;btn.innerHTML=spin('Fetching...');
        setStatus('Fetching viral feed via Birdclaw...');
        await api('/api/sources/'+src.id+'/viral-fetch',{method:'POST'});
        state.selectedFeedIds.clear();
        await reloadSources();
        setStatus('Fetched viral feed.','success');
        render();
      }catch(e){setStatus(e.message,'failed');btn.disabled=false;btn.textContent='Fetch viral feed'}
    };
    document.querySelectorAll('.main-tab').forEach(t=>{
      t.onclick=()=>{const tab=t.dataset.tab;setViralTab(src.id,tab);render()};
    });
    const tabs=document.querySelector('.main-tabs');
    if(tabs){const sentinel=document.createElement('div');sentinel.style.cssText='position:absolute;top:-1px;height:1px;width:1px;pointer-events:none';tabs.parentNode.insertBefore(sentinel,tabs);const io=new IntersectionObserver(([e])=>{tabs.dataset.stuck=(!e.isIntersecting).toString()},{threshold:0,rootMargin:'-66px 0px 0px 0px'});io.observe(sentinel);}
    document.querySelectorAll('.viral-tile').forEach(tile=>{
      tile.onclick=(ev)=>{
        if(ev.target.closest('[data-no-toggle]'))return;
        const fid=tile.dataset.fid;
        if(state.selectedFeedIds.has(fid))state.selectedFeedIds.delete(fid);else state.selectedFeedIds.add(fid);
        render();
      };
    });
    $('generateBtn').onclick=async()=>{
      const btn=$('generateBtn');
      if(!state.selectedFeedIds.size)return setStatus('Select at least one viral post first.','failed');
      try{
        btn.disabled=true;btn.innerHTML=spin('Generating...');
        setStatus('Generating drafts from selected viral posts...');
        const data=await api('/api/sources/'+src.id+'/generate',{method:'POST',body:JSON.stringify({selectedPostIds:[...state.selectedFeedIds]})});
        setCost(data.costUsd);
        state.selectedFeedIds.clear();
        setViralTab(src.id,'drafts');
        await reloadAll();
        setStatus('Generated '+(data.posts||[]).length+' drafts \\u00b7 $'+Number(data.costUsd||0).toFixed(2),'success');
      }catch(e){setStatus(e.message,'failed');btn.disabled=false;btn.textContent='Generate from selected ('+state.selectedFeedIds.size+')'}
    };
  }
  // post-card handlers (delegated)
  const dr=$('draftsRoot');
  if(dr){
    dr.addEventListener('click',handlePostClick);
    dr.addEventListener('input',handlePostInput);
  }
}
async function handlePostClick(ev){
  const b=ev.target.closest('button');if(!b)return;
  const c=ev.target.closest('.post');if(!c)return;
  const id=c.dataset.id;const action=b.dataset.action;
  try{
    if(action==='save'){await api('/api/posts/'+id,{method:'PATCH',body:JSON.stringify({text:c.querySelector('[data-field="text"]').value})});setStatus('Saved.','success')}
    if(action==='rewrite'){await api('/api/posts/'+id+'/rewrite-request',{method:'POST',body:JSON.stringify({instruction:c.querySelector('[data-field="rewrite"]').value})});setStatus('Rewrite request saved.','success')}
    if(action==='delete'){
      if(!pendingDelete.has(id)){const orig=b.textContent;b.classList.add('danger-confirm');b.textContent='Click again to delete';const t=setTimeout(()=>{if(pendingDelete.get(id)===t){pendingDelete.delete(id);b.classList.remove('danger-confirm');b.textContent=orig}},6000);pendingDelete.set(id,t);setStatus('Confirm: click again within 6s to delete.');return}
      clearTimeout(pendingDelete.get(id));pendingDelete.delete(id);b.classList.remove('danger-confirm');b.innerHTML=spin('Deleting');b.disabled=true;
      await api('/api/posts/'+id,{method:'DELETE'});setStatus('Draft deleted.','success');
    }
    if(action==='post'){
      if(!pendingPost.has(id)){const orig=b.textContent;b.classList.add('danger-confirm');b.textContent='Click again to post';const t=setTimeout(()=>{if(pendingPost.get(id)===t){pendingPost.delete(id);b.classList.remove('danger-confirm');b.textContent=orig}},6000);pendingPost.set(id,t);setStatus('Confirm: click again within 6s to post.');return}
      clearTimeout(pendingPost.get(id));pendingPost.delete(id);b.classList.remove('danger-confirm');b.innerHTML=spin('Posting');b.disabled=true;
      const posted=await api('/api/posts/'+id+'/post',{method:'POST'});
      if(posted.status==='posted')setStatus('Posted.','success');else setStatus('Post failed. Check card for result.','failed');
    }
    await reloadAll();
  }catch(e){setStatus(e.message,'failed');b.disabled=false;if(action==='post')b.textContent='Post to X';if(action==='delete')b.textContent='Delete';b.classList.remove('danger-confirm')}
}
function handlePostInput(ev){
  const t=ev.target;if(!t.matches||!t.matches('textarea[data-field="text"]'))return;
  const c=t.closest('.post');const id=c&&c.dataset.id;if(!id)return;
  const post=state.posts.find(p=>p.id===id);if(post)post.text=t.value;
  if(autosaveTimers.has(id))clearTimeout(autosaveTimers.get(id));
  setStatus('Editing... autosave pending.');
  autosaveTimers.set(id,setTimeout(async()=>{try{await api('/api/posts/'+id,{method:'PATCH',body:JSON.stringify({text:t.value})});autosaveTimers.delete(id);setStatus('Autosaved.','success')}catch(e){setStatus('Autosave failed: '+e.message,'failed')}},700));
}
/* ── Modal ── */
let modalBusy=false;
function openModal(){
  $('newSourceName').value='';
  $('newSourceModal').classList.add('show');
  setTimeout(()=>$('newSourceName').focus(),50);
}
function closeModal(){if(modalBusy)return;$('newSourceModal').classList.remove('show')}
function bindModal(){
  $('cancelNewSource').onclick=closeModal;
  $('newSourceModal').addEventListener('click',ev=>{if(ev.target===$('newSourceModal'))closeModal()});
  document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&$('newSourceModal').classList.contains('show'))closeModal()});
  $('newSourceName').addEventListener('keydown',ev=>{if(ev.key==='Enter'&&!modalBusy)$('confirmNewSource').click()});
  $('confirmNewSource').onclick=async()=>{
    const name=$('newSourceName').value.trim();
    if(!name){setStatus('Name is required.','failed');return}
    const btn=$('confirmNewSource');const orig=btn.textContent;
    try{
      modalBusy=true;btn.disabled=true;btn.innerHTML=spin('Creating');
      const src=await api('/api/sources',{method:'POST',body:JSON.stringify({kind:'topic',name,config:{angle:'',seedNotes:'',useTweetVoice:true}})});
      await reloadSources();
      $('newSourceModal').classList.remove('show');
      navigate('/sources/'+src.id);
      setStatus('Created source: '+src.name,'success');
    }catch(e){setStatus(e.message,'failed')}finally{modalBusy=false;btn.disabled=false;btn.textContent=orig}
  };
}
/* ── Routing ── */
function navigate(path,opts={}){
  if(!opts.skipHistory&&window.location.pathname!==path) history.pushState({},'',path);
  applyRoute(path);
}
function applyRoute(path){
  if(path==='/profile'){state.view='profile';render();return}
  if(path==='/'||path==='/posts'||path==='/generate'||path==='/sources'){
    state.view='source';
    const mru=[...state.sources].sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''))[0];
    if(mru){state.activeId=mru.id;if(window.location.pathname!=='/sources/'+mru.id)history.replaceState({},'','/sources/'+mru.id)}
    else{state.activeId=null}
    render();return;
  }
  const m=path.match(/^\\/sources\\/([^/]+)$/);
  if(m){state.view='source';state.activeId=m[1];render();return}
  state.view='source';render();
}
async function reloadSources(){const d=await api('/api/sources');state.sources=d.sources||[]}
async function reloadPosts(){const d=await api('/api/posts');state.posts=d.posts||[]}
async function reloadAll(){await Promise.all([reloadSources(),reloadPosts()]);render()}
async function loadChat(){try{const c=await api('/api/chat');state.chatMessages=c.messages||[];state.chatTarget=c.target||null;renderOperator()}catch(e){renderOperator()}}
function renderOperator(){const dot=$('chatDot');const connected=!!(state.chatTarget&&state.chatTarget.connected);dot.style.background=connected?'var(--success)':'var(--error)';dot.title=connected?'Connected':'Not connected'}
async function init(){
  try{
    await reloadSources();
    await reloadPosts();
    try{const p=await api('/api/profile');state.profileSnapshots=p.profileSnapshots||[]}catch(e){}
    await loadChat();
    bindModal();
    document.body.addEventListener('click',ev=>{const b=ev.target.closest('#newSourceBtn');if(b){openModal()}});
    document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>navigate(b.dataset.route));
    document.querySelectorAll('#sourceTabs').forEach(el=>el.addEventListener('click',ev=>{const t=ev.target.closest('.tab-pill');if(t)navigate('/sources/'+t.dataset.src)}));
    window.addEventListener('popstate',()=>applyRoute(window.location.pathname));
    applyRoute(window.location.pathname);
    setStatus('Ready.');
  }catch(e){setStatus(e.message,'failed')}
}
$('doctor').onclick=async()=>{try{setStatus('Checking system...');const d=await api('/api/doctor');const bc=d.birdclaw||{};const bi=d.bird||{};const c=d.claude||{};const ok=bc.installed&&bi.installed&&bi.authOk&&c.installed;setStatus(['Birdclaw '+(bc.installed?'\\u2713':'\\u2717'),'bird '+(bi.installed&&bi.authOk?(bi.handle?'@'+bi.handle:'')+' \\u2713':'\\u2717 ('+(bi.installed?'not logged in':'not installed')+')'),'Claude '+(c.installed?'\\u2713':'\\u2717')].join('  \\u00b7  '),ok?'success':'failed')}catch(e){setStatus(e.message,'failed')}};
$('chatSend').onclick=async()=>{const text=$('chatInput').value.trim();if(!text)return;const btn=$('chatSend');const orig=btn.textContent;try{btn.disabled=true;btn.innerHTML=spin('Sending');setStatus('Sending to OpenClaw session...');const data=await api('/api/chat',{method:'POST',body:JSON.stringify({message:text})});$('chatInput').value='';state.chatMessages=data.messages||[];state.chatTarget=data.target||state.chatTarget;renderOperator();setStatus('Eigen received the message.','success')}catch(e){setStatus(e.message,'failed');await loadChat().catch(()=>{})}finally{btn.disabled=false;btn.textContent=orig}};
$('chatInput').addEventListener('keydown',ev=>{if((ev.metaKey||ev.ctrlKey)&&ev.key==='Enter')$('chatSend').click()});
init();
`;

  return [
    "<!doctype html>",
    "<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>xsquared</title>",
    "<link rel=\"preconnect\" href=\"https://fonts.bunny.net\">",
    "<link href=\"https://fonts.bunny.net/css?family=geist:400,500,600|geist-mono:400,500|fraunces:500,600&display=swap\" rel=\"stylesheet\">",
    "<style>" + CSS + "</style></head><body>",
    HEADER,
    "<main><div id=\"appRoot\"></div></main>" + MODAL_HTML + CHAT_DOCK,
    "<script>" + JS + "</script></body></html>"
  ].join("\n");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function startDashboard(port, host) {
  ensureStore();
  const server = http.createServer(async function(req, res) {
    try {
      const url = new URL(req.url, "http://" + req.headers.host);
      const isSourceRoute = url.pathname === "/sources" || url.pathname.startsWith("/sources/");
      if (req.method === "GET" && (["/", "/posts", "/generate", "/profile"].includes(url.pathname) || isSourceRoute)) {
        if (url.pathname === "/") {
          res.writeHead(302, { location: "/sources" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/posts") {
        sendJson(res, 200, { posts: readStore().posts });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/strategy") {
        sendJson(res, 200, { strategy: readStore().strategy });
        return;
      }
      if (req.method === "PATCH" && url.pathname === "/api/strategy") {
        sendJson(res, 200, { strategy: setStrategy(await readBody(req)) });
        return;
      }
      if (url.pathname === "/api/generate" || url.pathname === "/api/generate/feed" || url.pathname === "/api/generate/direction") {
        sendJson(res, 410, { error: "moved to POST /api/sources/:id/generate" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/profile") {
        sendJson(res, 200, { profileSnapshots: getProfileSnapshotsWithAutoLearn(url.searchParams.get("refresh") === "1") });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/chat") {
        sendJson(res, 200, getChatState());
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/chat") {
        sendJson(res, 200, sendChatMessage(await readBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/profile/learn") {
        const body = await readBody(req);
        sendJson(res, 200, learnProfile({ values: { handle: body.handle || "", limit: body.limit || "200", query: body.query || "" } }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/posts") {
        sendJson(res, 200, savePost(await readBody(req)));
        return;
      }
      const postMatch = url.pathname.match(/^\/api\/posts\/([^/]+)$/);
      if (req.method === "PATCH" && postMatch) {
        sendJson(res, 200, updatePost(postMatch[1], await readBody(req)));
        return;
      }
      if (req.method === "DELETE" && postMatch) {
        sendJson(res, 200, deletePost(postMatch[1]));
        return;
      }
      const actionMatch = url.pathname.match(/^\/api\/posts\/([^/]+)\/(post|rewrite-request)$/);
      if (req.method === "POST" && actionMatch) {
        const body = await readBody(req);
        if (actionMatch[2] === "post") sendJson(res, 200, postToX(actionMatch[1], body.account || DEFAULT_ACCOUNT));
        else sendJson(res, 200, addRewriteRequest(actionMatch[1], body.instruction));
        return;
      }
      if (url.pathname === "/api/trends" || url.pathname === "/api/feed" || url.pathname === "/api/feed/latest" || url.pathname === "/api/directions" || url.pathname.match(/^\/api\/directions\//)) {
        sendJson(res, 410, { error: "moved to /api/sources" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/sources") {
        const kind = url.searchParams.get("kind");
        sendJson(res, 200, { sources: listSources(kind === "topic" || kind === "viral" ? kind : null) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/sources") {
        sendJson(res, 200, createSource(await readBody(req)));
        return;
      }
      const sourceMatch = url.pathname.match(/^\/api\/sources\/([^/]+)$/);
      if (req.method === "GET" && sourceMatch) {
        sendJson(res, 200, getSource(sourceMatch[1]));
        return;
      }
      if (req.method === "PATCH" && sourceMatch) {
        sendJson(res, 200, updateSource(sourceMatch[1], await readBody(req)));
        return;
      }
      if (req.method === "DELETE" && sourceMatch) {
        sendJson(res, 200, deleteSource(sourceMatch[1]));
        return;
      }
      const sourceActionMatch = url.pathname.match(/^\/api\/sources\/([^/]+)\/(research|viral-fetch|generate|posts)$/);
      if (sourceActionMatch) {
        const id = sourceActionMatch[1];
        const action = sourceActionMatch[2];
        if (req.method === "GET" && action === "posts") { sendJson(res, 200, { posts: getPostsForSource(id) }); return; }
        if (req.method === "POST" && action === "research") { sendJson(res, 200, runResearch(id)); return; }
        if (req.method === "POST" && action === "viral-fetch") { sendJson(res, 200, { lastFeedSnapshot: viralFetch(id) }); return; }
        if (req.method === "POST" && action === "generate") { sendJson(res, 200, generateForSource(id, await readBody(req))); return; }
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/doctor") {
        const birdclawVersion = birdclaw(["--version"]);
        const birdclawAuth = birdclaw(["auth", "status", "--json"]);
        const birdVersion = bird(["--version"], 10000);
        const birdAuth = birdAuthStatus();
        const claudeVersion = run(CLAUDE_BIN, ["--version"], { timeout: 10000 });
        sendJson(res, 200, {
          birdclaw: { installed: birdclawVersion.ok, version: birdclawVersion.stdout.trim(), authOk: birdclawAuth.ok, auth: safeJson(birdclawAuth.stdout.trim()), stderr: birdclawAuth.stderr.trim(), note: "Used for posting drafts via Birdclaw. Viral feed reads come via bird." },
          bird: { installed: birdVersion.ok, version: birdVersion.stdout.trim(), authOk: birdAuth.ok, handle: birdAuth.handle, status: birdAuth.message, note: birdAuth.ok ? null : "Log in to x.com in Chrome (or Firefox) — bird reads browser cookies." },
          claude: { installed: claudeVersion.ok, version: claudeVersion.stdout.trim(), error: claudeVersion.error || (claudeVersion.ok ? null : claudeVersion.stderr.trim()) }
        });
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 500, { error: err.message || String(err) });
    }
  });
  server.listen(Number(port), host, function() {
    process.stdout.write("xsquared dashboard: http://" + host + ":" + port + "\n");
  });
}

function requireArg(value, name) {
  if (!value) throw new Error(name + " is required");
  return value;
}

async function main() {
  const parts = process.argv.slice(2);
  const cmd = parts[0] || "help";
  const rest = parts.slice(1);
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    output("xsquared commands:\n  doctor [--json]\n  strategy [--json]\n  strategy-set --area <posting area> [--json]\n  trends [--topic <topic>] [--limit 40] [--resource home] [--json]\n  sources [--kind topic|viral] [--json]\n  source-new --kind <topic|viral> --name <name> [--angle <a>] [--notes <n>] [--filter <f>] [--resource home|following|for-you] [--limit 40] [--no-voice] [--json]\n  source-edit <source-id> [--name ...] [--angle ...] [--notes ...] [--filter ...] [--resource ...] [--limit N]\n  source-delete <source-id>\n  research <source-id> [--json]\n  viral-fetch <source-id> [--json]\n  generate <source-id> [--count 5] [--selected id,id,id] [--json]\n  profile-learn [--handle @you] [--limit 200] [--query <query>] [--json]\n  profile [--json]\n  save --text <text> [--topic <topic>] [--angle <angle>] [--score 80] [--notes <notes>]\n  import-json <file>\n  list [--source <source-id>] [--json]\n  update <post-id> [--text <text>] [--status <status>] [--notes <notes>] [--score <score>]\n  rewrite-request <post-id> [--instruction <text>]\n  rewrite-requests [--json]\n  post <post-id> [--account acct_primary]\n  dashboard [--port 3888] [--host 127.0.0.1]\n\nEnv:\n  XSQUARED_CLAUDE_MODEL (default: sonnet)\n  XSQUARED_RESEARCH_BUDGET_USD (default: 0.50)\n  XSQUARED_DISABLE_LLM=1 forces template fallback");
    return;
  }
  if (cmd === "doctor") {
    const opts = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
    doctor(Boolean(opts.values.json));
    return;
  }
  if (cmd === "strategy") {
    const opts = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
    output(readStore().strategy, Boolean(opts.values.json));
    return;
  }
  if (cmd === "strategy-set") {
    const opts = parseArgs({ args: rest, options: { area: { type: "string" }, json: { type: "boolean" } } });
    output(setStrategy({ area: opts.values.area || "" }), Boolean(opts.values.json));
    return;
  }
  if (cmd === "trends") {
    const opts = parseArgs({ args: rest, options: { topic: { type: "string" }, limit: { type: "string" }, resource: { type: "string" }, json: { type: "boolean" } } });
    output(runTrends(opts), Boolean(opts.values.json));
    return;
  }
  if (cmd === "sources") {
    const opts = parseArgs({ args: rest, options: { kind: { type: "string" }, json: { type: "boolean" } } });
    const kind = (opts.values.kind === "topic" || opts.values.kind === "viral") ? opts.values.kind : null;
    const sources = listSources(kind);
    if (opts.values.json) output(sources, true);
    else output(sources.map(function(s) { return s.id + " [" + s.kind + "] " + s.name; }).join("\n") || "No sources.");
    return;
  }
  if (cmd === "source-new") {
    const opts = parseArgs({ args: rest, options: { kind: { type: "string" }, name: { type: "string" }, angle: { type: "string" }, notes: { type: "string" }, filter: { type: "string" }, resource: { type: "string" }, limit: { type: "string" }, "no-voice": { type: "boolean" }, json: { type: "boolean" } } });
    const kind = opts.values.kind === "viral" ? "viral" : "topic";
    const config = kind === "topic"
      ? { angle: opts.values.angle || "", seedNotes: opts.values.notes || "", useTweetVoice: !opts.values["no-voice"] }
      : { filter: opts.values.filter || "", resource: opts.values.resource || "home", limit: Number(opts.values.limit || "40") };
    output(createSource({ kind, name: opts.values.name || "", config }), Boolean(opts.values.json));
    return;
  }
  if (cmd === "source-edit") {
    const id = requireArg(rest[0], "source-id");
    const opts = parseArgs({ args: rest.slice(1), options: { name: { type: "string" }, angle: { type: "string" }, notes: { type: "string" }, filter: { type: "string" }, resource: { type: "string" }, limit: { type: "string" }, "use-voice": { type: "boolean" }, "no-voice": { type: "boolean" }, archived: { type: "boolean" }, json: { type: "boolean" } } });
    const config: any = {};
    if (opts.values.angle !== undefined) config.angle = opts.values.angle;
    if (opts.values.notes !== undefined) config.seedNotes = opts.values.notes;
    if (opts.values["use-voice"]) config.useTweetVoice = true;
    if (opts.values["no-voice"]) config.useTweetVoice = false;
    if (opts.values.filter !== undefined) config.filter = opts.values.filter;
    if (opts.values.resource !== undefined) config.resource = opts.values.resource;
    if (opts.values.limit !== undefined) config.limit = Number(opts.values.limit);
    const updates: any = { config };
    if (opts.values.name !== undefined) updates.name = opts.values.name;
    if (opts.values.archived !== undefined) updates.archived = Boolean(opts.values.archived);
    output(updateSource(id, updates), Boolean(opts.values.json));
    return;
  }
  if (cmd === "source-delete") {
    const id = requireArg(rest[0], "source-id");
    output(deleteSource(id), true);
    return;
  }
  if (cmd === "research") {
    const id = requireArg(rest[0], "source-id");
    const opts = parseArgs({ args: rest.slice(1), options: { json: { type: "boolean" } } });
    output(runResearch(id), Boolean(opts.values.json));
    return;
  }
  if (cmd === "viral-fetch") {
    const id = requireArg(rest[0], "source-id");
    const opts = parseArgs({ args: rest.slice(1), options: { json: { type: "boolean" } } });
    output(viralFetch(id), Boolean(opts.values.json));
    return;
  }
  if (cmd === "generate") {
    let sourceId = rest[0] && !rest[0].startsWith("-") ? rest[0] : null;
    const argTail = sourceId ? rest.slice(1) : rest;
    const opts = parseArgs({ args: argTail, options: { count: { type: "string" }, selected: { type: "string" }, "source-id": { type: "string" }, json: { type: "boolean" } } });
    if (!sourceId && opts.values["source-id"]) sourceId = opts.values["source-id"];
    if (!sourceId) {
      const topicSources = listSources("topic");
      if (topicSources.length === 1) {
        process.stderr.write("xsquared generate: --source-id not provided; using single topic source " + topicSources[0].id + " (deprecation: pass <source-id> explicitly)\n");
        sourceId = topicSources[0].id;
      } else {
        throw new Error("generate requires a <source-id> argument. Run 'xsquared sources' to list them.");
      }
    }
    const selected = opts.values.selected ? String(opts.values.selected).split(",").map(function(s) { return s.trim(); }).filter(Boolean) : [];
    output(generateForSource(sourceId, { count: opts.values.count ? Number(opts.values.count) : 5, selectedPostIds: selected }), Boolean(opts.values.json));
    return;
  }
  if (cmd === "profile-learn") {
    const opts = parseArgs({ args: rest, options: { handle: { type: "string" }, limit: { type: "string" }, query: { type: "string" }, json: { type: "boolean" } } });
    output(learnProfile(opts), Boolean(opts.values.json));
    return;
  }
  if (cmd === "profile") {
    const opts = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
    const snapshots = readStore().profileSnapshots;
    if (opts.values.json) output(snapshots, true);
    else output(snapshots.map(function(snapshot) { return snapshot.id + " " + (snapshot.handle || "authored") + ": " + snapshot.profile.sampleCount + " tweets, median " + snapshot.profile.metrics.medianChars + " chars"; }).join("\n") || "No profile snapshots.");
    return;
  }
  if (cmd === "save") {
    const opts = parseArgs({ args: rest, options: { text: { type: "string" }, topic: { type: "string" }, angle: { type: "string" }, score: { type: "string" }, notes: { type: "string" }, source: { type: "string" }, json: { type: "boolean" } } });
    output(savePost(opts.values), Boolean(opts.values.json));
    return;
  }
  if (cmd === "import-json") {
    output({ imported: importJson(requireArg(rest[0], "file")) }, true);
    return;
  }
  if (cmd === "list") {
    const opts = parseArgs({ args: rest, options: { source: { type: "string" }, json: { type: "boolean" } } });
    let posts = readStore().posts;
    if (opts.values.source) posts = posts.filter(function(p) { return p.sourceId === opts.values.source; });
    if (opts.values.json) output(posts, true);
    else output(posts.map(function(p) { return p.id + " [" + p.status + "] " + (p.topic || "untitled") + ": " + p.text.slice(0, 120); }).join("\n") || "No posts.");
    return;
  }
  if (cmd === "update") {
    const postId = requireArg(rest[0], "post-id");
    const opts = parseArgs({ args: rest.slice(1), options: { text: { type: "string" }, status: { type: "string" }, notes: { type: "string" }, score: { type: "string" }, topic: { type: "string" }, angle: { type: "string" }, json: { type: "boolean" } } });
    output(updatePost(postId, opts.values), Boolean(opts.values.json));
    return;
  }
  if (cmd === "rewrite-request") {
    const postId = requireArg(rest[0], "post-id");
    const opts = parseArgs({ args: rest.slice(1), options: { instruction: { type: "string" }, json: { type: "boolean" } } });
    output(addRewriteRequest(postId, opts.values.instruction), Boolean(opts.values.json));
    return;
  }
  if (cmd === "rewrite-requests") {
    const opts = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
    const requests = readStore().rewriteRequests;
    if (opts.values.json) output(requests, true);
    else output(requests.map(function(r) { return r.id + " [" + r.status + "] " + r.postId + ": " + r.instruction; }).join("\n") || "No rewrite requests.");
    return;
  }
  if (cmd === "post") {
    const postId = requireArg(rest[0], "post-id");
    const opts = parseArgs({ args: rest.slice(1), options: { account: { type: "string" }, json: { type: "boolean" } } });
    output(postToX(postId, opts.values.account || DEFAULT_ACCOUNT), Boolean(opts.values.json));
    return;
  }
  if (cmd === "dashboard") {
    const opts = parseArgs({ args: rest, options: { port: { type: "string" }, host: { type: "string" } } });
    startDashboard(opts.values.port || "3888", opts.values.host || "127.0.0.1");
    return;
  }
  throw new Error("unknown command: " + cmd);
}

main().catch(function(err) {
  process.stderr.write((err.message || String(err)) + "\n");
  process.exit(1);
});
