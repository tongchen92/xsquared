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
    writeFileSync(STORE_PATH, JSON.stringify({ version: 1, strategy: { contentArea: "", updatedAt: null }, posts: [], trendSnapshots: [], profileSnapshots: [], generationSnapshots: [], rewriteRequests: [], feedSnapshots: [], directions: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  const store = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  store.strategy ||= { contentArea: "", updatedAt: null };
  store.posts ||= [];
  store.trendSnapshots ||= [];
  store.profileSnapshots ||= [];
  store.generationSnapshots ||= [];
  store.rewriteRequests ||= [];
  store.feedSnapshots ||= [];
  store.directions ||= [];
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

function generatePosts(opts) {
  const store = readStore();
  const area = String(opts.values.area || store.strategy.contentArea || opts.values.topic || "").trim();
  if (!area) throw new Error("posting area is required");
  const count = Number(opts.values.count || 5);
  if (opts.values.saveArea !== false) {
    store.strategy = { ...(store.strategy || {}), contentArea: area, updatedAt: nowIso() };
    writeStore(store);
  }
  const trendSnapshot = runTrends({ values: { topic: area, limit: String(opts.values.limit || 40), resource: opts.values.resource || "home" } });
  const latestProfile = readStore().profileSnapshots[0] || null;
  const drafts = makeGeneratedTexts(area, trendSnapshot, latestProfile, count).map(savePost);
  const generation = {
    id: makeId("generation"),
    createdAt: nowIso(),
    area,
    count: drafts.length,
    trendSnapshotId: trendSnapshot.id,
    profileSnapshotId: latestProfile ? latestProfile.id : null,
    postIds: drafts.map(function(post) { return post.id; }),
    note: "Generated local draft candidates. Ask OpenClaw to rewrite/improve for final voice before posting."
  };
  const fresh = readStore();
  fresh.generationSnapshots.unshift(generation);
  fresh.generationSnapshots = fresh.generationSnapshots.slice(0, 50);
  writeStore(fresh);
  return { generation, trendSnapshot, posts: drafts };
}

function fetchFeedSnapshot(opts) {
  const topic = opts.topic || "";
  const limit = opts.limit || "40";
  const resource = opts.resource || "home";
  const args = ["--json", "search", "tweets", "--resource", resource, "--hide-low-quality", "--originals-only", "--limit", String(limit)];
  if (topic) args.push(topic);
  const result = birdclaw(args);
  if (!result.ok && !result.stdout.trim()) {
    throw new Error("Birdclaw feed fetch failed: " + (result.stderr.trim() || result.error || "command failed"));
  }
  const rawItems = parseJsonLinesOrArray(result.stdout);
  const posts = rawItems.map(function(item) {
    return {
      id: item.id || item.tweetId || item.tweet_id || item.url || makeId("fp"),
      author: tweetAuthor(item),
      text: tweetText(item),
      createdAt: item.createdAt || item.created_at || item.date || null,
      url: item.url || item.permalink || null
    };
  }).filter(function(item) { return item.text; });
  const snapshot = {
    id: makeId("feed"),
    createdAt: nowIso(),
    topic,
    resource,
    limit: Number(limit),
    birdclaw: { ok: result.ok, status: result.status, error: result.error, stderr: result.stderr.trim() },
    sampleCount: posts.length,
    posts: posts.slice(0, 60)
  };
  const store = readStore();
  store.feedSnapshots.unshift(snapshot);
  store.feedSnapshots = store.feedSnapshots.slice(0, 20);
  writeStore(store);
  return snapshot;
}

function saveDirection(input) {
  if (!String(input.name || "").trim()) throw new Error("topic name is required");
  const store = readStore();
  const direction = {
    id: makeId("dir"),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    name: String(input.name).trim(),
    description: String(input.description || "").trim(),
    references: Array.isArray(input.references) ? input.references.filter(Boolean) : (input.references ? [String(input.references)] : []),
    useTweetSamples: Boolean(input.useTweetSamples)
  };
  store.directions.unshift(direction);
  writeStore(store);
  return direction;
}

function updateDirection(id, updates) {
  const store = readStore();
  const direction = store.directions.find(function(d) { return d.id === id; });
  if (!direction) throw new Error("topic not found: " + id);
  if (updates.name !== undefined && String(updates.name).trim()) direction.name = String(updates.name).trim();
  if (updates.description !== undefined) direction.description = String(updates.description).trim();
  if (updates.references !== undefined) direction.references = Array.isArray(updates.references) ? updates.references.filter(Boolean) : (updates.references ? [String(updates.references)] : []);
  if (updates.useTweetSamples !== undefined) direction.useTweetSamples = Boolean(updates.useTweetSamples);
  direction.updatedAt = nowIso();
  writeStore(store);
  return direction;
}

function deleteDirection(id) {
  const store = readStore();
  const idx = store.directions.findIndex(function(d) { return d.id === id; });
  if (idx === -1) throw new Error("topic not found: " + id);
  store.directions.splice(idx, 1);
  writeStore(store);
  return { deleted: id };
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
  const name = direction.name || "this topic";
  const description = String(direction.description || "");
  const refs = (direction.references || []).join(" ");
  const refTerms = refs ? analyzeTerms([refs], name).terms.slice(0, 6).map(function(t) { return t.term; }) : [];
  const termLine = refTerms.length ? " Key context: " + refTerms.slice(0, 3).join(", ") + "." : "";
  const angles = ["core claim", "contrarian angle", "implementation", "common mistake", "first principle", "specific insight"];
  const drafts = [
    "On " + name + ": " + (description || "the depth is in the specifics, not the framework.") + termLine,
    "The most common mistake with " + name + ": treating it as a tactic. It works as a system — all the inputs and feedback loops matter.",
    "If you are serious about " + name + ": start with the constraint. What is the one thing you can change this week, not next quarter?" + termLine,
    name + " done well looks boring. Clear principles, consistent execution, slow iteration. No shortcut survives long enough to matter.",
    "The diagnostic step on " + name + " most teams skip: understand what is actually broken before optimizing anything.",
    "The specific thing about " + name + " nobody talks about: " + (refTerms.length ? refTerms[0] + " as a leading signal, not a lagging one." : "the feedback loop is slower than it looks.")
  ];
  if (direction.useTweetSamples && profileSnapshot && (profileSnapshot.profile.samples || []).length) {
    drafts.push("Something I keep returning to on " + name + ": " + (description ? description.slice(0, 80) : "the distance between knowing and doing is where most effort gets lost."));
  }
  return drafts.slice(0, Number(count) || 5).map(function(text, index) {
    const trimmed = compact && text.length > 230 ? text.slice(0, 227).replace(/\s+\S*$/, "") + "..." : text;
    return {
      topic: name,
      angle: angles[index % angles.length],
      score: Math.max(72, 88 - index * 2),
      text: trimmed,
      notes: "Topic: " + name + (description ? " — " + description.slice(0, 100) : "") + (refTerms.length ? ". Key terms: " + refTerms.join(", ") : "") + ".",
      source: "xsquared-generator",
      generationSource: "topic",
      inspirationPosts: [],
      directionId: direction.id
    };
  });
}

function generateFromFeed(body) {
  const store = readStore();
  const area = String(body.area || store.strategy.contentArea || "").trim();
  if (!area) throw new Error("posting area is required");
  const feedSnapshotId = body.feedSnapshotId;
  const feedSnapshot = feedSnapshotId
    ? store.feedSnapshots.find(function(s) { return s.id === feedSnapshotId; })
    : store.feedSnapshots[0];
  if (!feedSnapshot) throw new Error("no trending posts found; fetch trending first");
  const selectedIds = Array.isArray(body.selectedPostIds) ? body.selectedPostIds : [];
  const selectedPosts = selectedIds.length
    ? feedSnapshot.posts.filter(function(p) { return selectedIds.includes(p.id); })
    : feedSnapshot.posts.slice(0, 5);
  if (!selectedPosts.length) throw new Error("no posts selected");
  const count = Number(body.count || selectedPosts.length || 5);
  const latestProfile = store.profileSnapshots[0] || null;
  const drafts = makeFeedInspiredTexts(selectedPosts, area, latestProfile, count).map(function(input) {
    const post = normalizePost(input);
    store.posts.unshift(post);
    return post;
  });
  const generation = {
    id: makeId("generation"),
    createdAt: nowIso(),
    area,
    count: drafts.length,
    trendSnapshotId: feedSnapshot.id,
    profileSnapshotId: latestProfile ? latestProfile.id : null,
    postIds: drafts.map(function(post) { return post.id; }),
    note: "Trending-source generation. Source: " + feedSnapshot.id + ". Ask OpenClaw to rewrite with your voice."
  };
  store.generationSnapshots.unshift(generation);
  store.generationSnapshots = store.generationSnapshots.slice(0, 50);
  writeStore(store);
  return { generation, feedSnapshot, posts: drafts };
}

function generateFromDirection(body) {
  const store = readStore();
  const directionId = body.directionId;
  const direction = directionId
    ? store.directions.find(function(d) { return d.id === directionId; })
    : store.directions[0];
  if (!direction) throw new Error("topic not found; create a topic first");
  const count = Number(body.count || 5);
  const latestProfile = store.profileSnapshots[0] || null;
  const drafts = makeDirectionTexts(direction, latestProfile, count).map(function(input) {
    const post = normalizePost(input);
    store.posts.unshift(post);
    return post;
  });
  const generation = {
    id: makeId("generation"),
    createdAt: nowIso(),
    area: direction.name,
    count: drafts.length,
    trendSnapshotId: null,
    profileSnapshotId: latestProfile ? latestProfile.id : null,
    postIds: drafts.map(function(post) { return post.id; }),
    note: "Topic-source generation: " + direction.name + ". Ask OpenClaw to rewrite with your voice."
  };
  store.generationSnapshots.unshift(generation);
  store.generationSnapshots = store.generationSnapshots.slice(0, 50);
  writeStore(store);
  return { generation, direction, posts: drafts };
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

function importJson(filePath) {
  const payload = JSON.parse(readFileSync(filePath, "utf8"));
  const rows = Array.isArray(payload) ? payload : payload.posts || [];
  if (!Array.isArray(rows)) throw new Error("expected an array or { posts: [] }");
  return rows.map(savePost);
}

function postToX(postId, account) {
  const store = readStore();
  const post = findPost(store, postId);
  const result = birdclaw(["compose", "post", "--account", account || DEFAULT_ACCOUNT, post.text]);
  post.updatedAt = nowIso();
  post.postResult = { at: nowIso(), account: account || DEFAULT_ACCOUNT, ok: result.ok, status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim(), error: result.error };
  if (result.ok) {
    post.status = "posted";
    post.postedAt = nowIso();
  } else {
    post.status = "post_failed";
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
  const birdVersion = birdclaw(["--version"]);
  const auth = birdclaw(["auth", "status", "--json"]);
  output({ storePath: STORE_PATH, node: process.version, birdclaw: { installed: birdVersion.ok, version: birdVersion.stdout.trim(), authOk: auth.ok, auth: auth.stdout.trim() ? safeJson(auth.stdout.trim()) : null, stderr: auth.stderr.trim() } }, json);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, function(ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch];
  });
}

function html() {
  const CSS = ":root{color-scheme:light dark;--bg:#FAFAF7;--panel:#FFFFFF;--ink:#0A0A0A;--muted:#6B6B6B;--line:#E5E4DE;--accent:#B8542A;--accent-soft:#F2E3D9;--success:#15803D;--error:#B42318;--info:#1F4E8C;--r-sm:4px;--r-md:6px;--r-lg:8px;--shadow-1:0 1px 0 rgba(10,10,10,.03);--font-ui:'Geist','Geist Sans',ui-sans-serif,system-ui,sans-serif;--font-display:'Fraunces',Georgia,serif;--font-mono:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace}@media (prefers-color-scheme:dark){:root{--bg:#0E0E0C;--panel:#161614;--ink:#F5F5F0;--muted:#A3A3A0;--line:#2A2A26;--accent:#C56A3F;--accent-soft:#2A1B14;--shadow-1:0 1px 0 rgba(0,0,0,.4)}}*{box-sizing:border-box}body{margin:0;font-family:var(--font-ui);font-size:14px;line-height:1.5;background:var(--bg);color:var(--ink);font-feature-settings:'ss01','cv11'}header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line)}.bar{max-width:1180px;margin:0 auto;padding:18px 24px;display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{display:flex;align-items:baseline;gap:12px}h1{margin:0;font-family:var(--font-display);font-weight:600;font-size:26px;letter-spacing:-.01em;line-height:1}.brand-mark{color:var(--accent)}.brand-tag{font-family:var(--font-mono);font-size:11px;color:var(--muted);letter-spacing:.04em;text-transform:uppercase}.nav-tabs{display:flex;gap:4px}.nav-tab{appearance:none;background:transparent;border:none;border-radius:var(--r-sm);color:var(--muted);font-family:var(--font-ui);font-weight:500;font-size:14px;padding:6px 12px;cursor:pointer;position:relative}.nav-tab:hover{color:var(--ink)}.nav-tab.active{color:var(--ink)}.nav-tab.active::after{content:'';position:absolute;left:12px;right:12px;bottom:-18px;height:2px;background:var(--accent);border-radius:2px}.tools{display:flex;gap:8px}main{max-width:1180px;margin:0 auto;padding:24px;display:grid;grid-template-columns:320px 1fr;gap:24px}button,input,textarea,select{font:inherit}button{font-family:var(--font-ui);border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:var(--r-sm);padding:8px 12px;cursor:pointer;font-weight:500;transition:background 150ms ease-out,border-color 150ms ease-out,color 150ms ease-out,transform 80ms ease-out}button:hover{border-color:var(--ink)}button:active{transform:translateY(1px)}button.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}button.primary:hover{background:#000;border-color:#000}button.accent{background:var(--accent);color:#fff;border-color:var(--accent)}button.accent:hover{background:#9F4823;border-color:#9F4823}button.danger-confirm{background:var(--accent);color:#fff;border-color:var(--accent)}button.ghost{background:transparent;border-color:transparent;color:var(--muted)}button.ghost:hover{color:var(--ink);background:var(--accent-soft);border-color:transparent}button:disabled{opacity:.5;cursor:not-allowed;transform:none}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,.nav-tab:focus-visible{outline:2px solid var(--accent);outline-offset:2px}input,textarea,select{width:100%;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:var(--r-sm);padding:10px 12px;font-family:var(--font-ui);transition:border-color 150ms ease-out}input:hover,textarea:hover,select:hover{border-color:#B5B5AE}input::placeholder,textarea::placeholder{color:var(--muted);opacity:.7}textarea{min-height:128px;resize:vertical;line-height:1.45}.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:20px;box-shadow:var(--shadow-1)}.panel-head{font-family:var(--font-display);font-weight:500;font-size:13px;letter-spacing:.03em;text-transform:uppercase;color:var(--muted);margin:0 0 14px;padding-bottom:8px;border-bottom:1px solid var(--line)}.side{display:grid;gap:16px;align-self:start;position:sticky;top:84px}.field{display:grid;gap:6px;margin-bottom:12px}.field:last-child{margin-bottom:0}label{color:var(--muted);font-size:12px;font-weight:500;letter-spacing:.01em}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.posts{display:grid;gap:14px}.post,.profile-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:20px;display:grid;gap:12px;box-shadow:var(--shadow-1)}.post textarea{min-height:96px}.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}.metric{border:1px solid var(--line);border-radius:var(--r-sm);padding:12px;background:var(--bg);font-variant-numeric:tabular-nums}.metric b{display:block;font-family:var(--font-display);font-weight:500;font-size:24px;line-height:1.1;letter-spacing:-.01em}.metric span{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}.meta{color:var(--muted);font-size:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}.meta time,.meta .ts{font-family:var(--font-mono);font-size:11px}.pill{border:1px solid var(--line);border-radius:9999px;padding:2px 8px;background:var(--panel);font-size:11px;color:var(--muted);font-weight:500}.pill-source{border-color:var(--accent);color:var(--accent)}.pill-status{border-color:var(--ink);color:var(--ink);background:var(--bg);text-transform:lowercase;font-family:var(--font-mono);font-size:10px;letter-spacing:.04em;padding:2px 7px}.pill-status[data-status='posted']{border-color:var(--success);color:var(--success);background:transparent}.pill-status[data-status='failed']{border-color:var(--error);color:var(--error);background:transparent}.score{color:var(--accent);font-variant-numeric:tabular-nums;font-weight:500}.posted{color:var(--success);font-size:12px}.failed{color:var(--error);white-space:pre-wrap;font-size:12px;padding:8px 10px;background:var(--bg);border-radius:var(--r-sm);border:1px solid var(--error)}.trend-list{display:grid;gap:0;font-size:13px;color:var(--ink)}.trend-list span{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid var(--line);padding:6px 0;font-variant-numeric:tabular-nums}.trend-list span:last-child{border-bottom:none}.trend-list b{font-weight:500}.trend-list em{font-style:normal;color:var(--muted);font-family:var(--font-mono);font-size:11px}.sample{white-space:pre-wrap;border-top:1px solid var(--line);padding-top:12px;margin-top:4px;color:var(--ink);line-height:1.55}.empty{color:var(--muted);padding:32px 24px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--panel);display:grid;gap:8px}.empty-title{font-family:var(--font-display);font-weight:500;font-size:18px;color:var(--ink);letter-spacing:-.01em}.empty-body{font-size:13px;line-height:1.5}.status-bar{font-family:var(--font-mono);font-size:11px;color:var(--muted);padding:10px 12px;background:var(--bg);border-radius:var(--r-sm);border:1px solid var(--line);min-height:38px;display:flex;align-items:center;gap:8px}.status-bar.success{color:var(--success);border-color:var(--success)}.status-bar.failed{color:var(--error);border-color:var(--error);white-space:pre-wrap;align-items:flex-start;line-height:1.4}.status-bar::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-family:var(--font-mono);font-size:11px}.kv dt{color:var(--muted)}.kv dd{margin:0;color:var(--ink)}.source-tabs{display:flex;gap:4px;margin-bottom:12px}.source-tab{flex:1;text-align:center;font-size:12px;padding:6px 8px;border-radius:var(--r-sm);cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--muted);font-weight:500;transition:background 150ms ease-out,color 150ms ease-out,border-color 150ms ease-out}.source-tab:hover{color:var(--ink);border-color:var(--muted)}.source-tab.active{background:var(--ink);color:var(--bg);border-color:var(--ink)}.feed-post{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:14px 16px;cursor:pointer;box-shadow:var(--shadow-1);transition:border-color 150ms ease-out}.feed-post:hover{border-color:var(--muted)}.feed-post.selected{border-color:var(--accent);background:var(--accent-soft)}.feed-post-body{font-size:13px;line-height:1.55;white-space:pre-wrap;margin:6px 0 0}.feed-post-meta{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--muted)}.dir-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);padding:14px 16px;cursor:pointer;box-shadow:var(--shadow-1);transition:border-color 150ms ease-out}.dir-card:hover{border-color:var(--muted)}.dir-card.active-dir{border-color:var(--accent)}.dir-name{font-weight:500;font-size:14px}.dir-desc{font-size:12px;color:var(--muted);line-height:1.4;margin-top:4px}.dir-meta-row{font-size:11px;color:var(--muted);margin-top:6px;font-family:var(--font-mono)}.sel-bar{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);margin-bottom:12px}.sel-count{font-size:13px;font-weight:500}.feed-grid,.dir-grid{display:grid;gap:10px}.note-block{font-size:12px;color:var(--muted);padding:8px 10px;background:var(--bg);border-radius:var(--r-sm);border:1px solid var(--line)}@media(max-width:820px){main{grid-template-columns:1fr;padding:16px;gap:16px}.side{position:static;top:auto}.bar{padding:14px 16px;gap:12px;flex-wrap:wrap}.nav-tab.active::after{bottom:-14px}}@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}";

  const HEADER = "<header><div class=\"bar\"><div class=\"brand\"><h1><span class=\"brand-mark\">x</span>squared</h1><span class=\"brand-tag\">drafts</span></div><nav class=\"nav-tabs\" aria-label=\"Primary\"><button class=\"nav-tab active\" data-tab=\"posts\">Posts</button><button class=\"nav-tab\" data-tab=\"generate\">Generate</button><button class=\"nav-tab\" data-tab=\"profile\">Profile</button></nav><div class=\"tools\"><button id=\"doctor\" class=\"ghost\">Doctor</button><button id=\"refresh\" class=\"ghost\">Refresh</button></div></div></header>";

  const SIDEBAR_POSTS = "";

  const SIDEBAR_GEN = "<div id=\"gen-side\" style=\"display:none\"><section class=\"panel\"><h2 class=\"panel-head\">Source</h2><div class=\"source-tabs\"><button class=\"source-tab active\" data-source=\"direction\">Topic</button><button class=\"source-tab\" data-source=\"feed\">Trending</button></div><div id=\"direction-side\"><button id=\"newDirBtn\" class=\"primary\" style=\"width:100%;margin-bottom:10px\">+ New topic</button><div id=\"dirSideMeta\" style=\"font-size:12px;color:var(--muted);margin-bottom:8px\">Select a topic to generate from it.</div><div id=\"dirGenerateSide\" style=\"display:none\"><button id=\"genFromDirBtn\" class=\"accent\" style=\"width:100%\">Generate topic posts</button></div></div><div id=\"feed-side\" style=\"display:none\"><div class=\"field\"><label>Trending filter</label><input id=\"feedTopic\" placeholder=\"Optional: Google Ads, AI agents...\"></div><div class=\"row\" style=\"margin-bottom:12px\"><button id=\"fetchFeedBtn\" class=\"primary\">Fetch trending posts</button></div><div id=\"feedSideMeta\" style=\"font-size:12px;color:var(--muted)\"></div><div id=\"feedGenerateSide\" style=\"display:none;margin-top:12px\"><div class=\"field\"><label>Your angle / topic</label><input id=\"feedArea\" placeholder=\"Google Ads for small business\"></div><button id=\"genFromFeedBtn\" class=\"accent\" style=\"width:100%\">Generate my versions</button></div></div></section></div>";

  const SIDEBAR_SYS = "<section class=\"panel\"><h2 class=\"panel-head\">System</h2><div id=\"status\" class=\"status-bar\">Ready.</div></section>";

  const CONTENT_GEN = "<div id=\"generate\" style=\"display:none\"><div id=\"gen-dir-view\"><div id=\"dir-editor-card\" class=\"post\" style=\"display:none;margin-bottom:14px\"><div class=\"meta\"><span id=\"dirEditLabel\" class=\"pill\">New topic</span></div><div class=\"field\"><label>Topic name</label><input id=\"dirName\" placeholder=\"Google Ads for small business\"></div><div class=\"field\"><label>Angle / objective</label><textarea id=\"dirDesc\" style=\"min-height:80px\" placeholder=\"What specific angle or claim do you want posts about?\"></textarea></div><div class=\"field\"><label>Reference material</label><textarea id=\"dirRefs\" style=\"min-height:180px\" placeholder=\"Paste notes, research, examples, constraints... Separate multiple references with a line containing only ---\"></textarea></div><div class=\"field\"><label style=\"display:flex;align-items:center;gap:8px;cursor:pointer\"><input type=\"checkbox\" id=\"dirUseTweets\" style=\"width:auto\"> Use my tweet samples for voice context</label></div><div class=\"row\"><button id=\"saveDirBtn\" class=\"primary\">Save topic</button><button id=\"cancelDirBtn\" class=\"ghost\">Cancel</button><button id=\"deleteDirBtn\" class=\"danger-confirm\" style=\"display:none\">Delete</button></div></div><div id=\"dir-grid\" class=\"dir-grid\"></div><div id=\"dir-empty\" class=\"empty\" style=\"display:none\"><div class=\"empty-title\">No topics yet.</div><div class=\"empty-body\">Click <b>+ New topic</b> to define one or many areas you want to post about, then generate drafts for the selected topic.</div></div></div><div id=\"gen-feed-view\" style=\"display:none\"><div id=\"feed-sel-bar\" class=\"sel-bar\" style=\"display:none\"><span class=\"sel-count\" id=\"feedSelCount\">0 selected</span><span style=\"font-size:12px;color:var(--muted)\">Click viral/relevant posts to select · drafts go to Posts tab</span></div><div id=\"feed-posts-grid\" class=\"feed-grid\"></div><div id=\"feed-empty\" class=\"empty\"><div class=\"empty-title\">No trending posts yet.</div><div class=\"empty-body\">Fetch viral or relevant feed posts, select the ones worth recreating, then generate your versions.</div></div></div></div>";

  const JS = `const $=id=>document.getElementById(id);
let posts=[],profileSnapshots=[],feedSnapshot=null,selectedFeedIds=new Set(),directions=[],activeDirId=null,editingDirId=null;
const pendingPost=new Map();
function setStatus(t,c){const e=$('status');e.className='status-bar'+(c?' '+c:'');e.textContent=t}
async function api(p,o={}){const r=await fetch(p,{headers:{'content-type':'application/json'},...o});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||r.statusText);return b}
function esc(v){return String(v||'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
function fmtDate(d){if(!d)return '';const x=new Date(d);const diff=(Date.now()-x.getTime())/1000;if(diff<60)return 'just now';if(diff<3600)return Math.floor(diff/60)+'m ago';if(diff<86400)return Math.floor(diff/3600)+'h ago';if(diff<604800)return Math.floor(diff/86400)+'d ago';return x.toLocaleDateString(undefined,{month:'short',day:'numeric'})}
function renderPosts(){
  const root=$('posts');
  if(!posts.length){root.innerHTML='<div class="empty"><div class="empty-title">No drafts yet.</div><div class="empty-body">Use the <b>Generate</b> tab, then choose <b>Topic</b> or <b>Trending</b>.</div></div>';return}
  const sl=s=>s||'draft';
  function postSource(p){const s=p.generationSource||p.source||'';return (s==='trending'||s==='feed-inspired')?'trending':'topic'}
  function card(p){
    const st=sl(p.status);
    const srcPill=(p.generationSource&&p.generationSource!=='openclaw'&&p.generationSource!=='dashboard')?'<span class="pill pill-source">'+esc(p.generationSource)+'</span>':'';
    return '<article class="post" data-id="'+esc(p.id)+'"><div class="meta"><span class="pill pill-status" data-status="'+esc(st)+'">'+esc(st)+'</span>'+(p.topic?'<span class="pill">'+esc(p.topic)+'</span>':'')+(p.angle?'<span class="pill">'+esc(p.angle)+'</span>':'')+srcPill+(p.score!=null?'<span class="score">'+esc(p.score)+'</span>':'')+'<span class="ts">'+fmtDate(p.updatedAt||p.createdAt)+'</span></div><textarea data-field="text">'+esc(p.text)+'</textarea>'+(p.notes?'<div class="note-block">'+esc(p.notes)+'</div>':'')+'<div class="field"><label>Rewrite request</label><input data-field="rewrite" placeholder="Sharper, more specific, less hype..."></div><div class="row"><button data-action="save">Save</button><button data-action="rewrite">Ask OpenClaw</button><button data-action="post" class="primary">Post to X</button></div>'+(p.postResult&&!p.postResult.ok?'<div class="failed">'+esc(p.postResult.stderr||p.postResult.error||'Post failed')+'</div>':'')+(p.postedAt?'<div class="posted">✓ Posted '+fmtDate(p.postedAt)+'</div>':'')+'</article>';
  }
  function section(title,items,empty){return '<section class="posts"><div class="meta" style="justify-content:space-between;margin:2px 0 4px"><span class="pill pill-source">'+title+'</span><span>'+items.length+' drafts</span></div>'+(items.length?items.map(card).join(''):'<div class="empty"><div class="empty-title">'+empty+'</div></div>')+'</section>'}
  const topicPosts=posts.filter(p=>postSource(p)==='topic');
  const trendingPosts=posts.filter(p=>postSource(p)==='trending');
  root.innerHTML=section('Topic',topicPosts,'No topic drafts yet.')+section('Trending',trendingPosts,'No trending drafts yet.')}
function metric(label,value){return '<div class="metric"><b>'+esc(value)+'</b><span>'+esc(label)+'</span></div>'}
function renderProfile(){
  const root=$('profile');const s=profileSnapshots[0];
  if(!s){root.innerHTML='<div class="empty"><div class="empty-title">No profile snapshot yet.</div><div class="empty-body">xsquared learns your profile automatically from Birdclaw when this tab loads.</div></div>';return}
  const p=s.profile||{};const m=p.metrics||{};
  root.innerHTML='<article class="profile-card"><div class="meta"><span class="pill">'+esc(s.handle||'authored')+'</span><span class="ts">'+fmtDate(s.createdAt)+'</span><span>'+esc(p.sampleCount||0)+' tweets</span></div>'+(s.note?'<div class="failed">'+esc(s.note)+'</div>':'')+'<div class="metric-grid">'+metric('median chars',m.medianChars||0)+metric('median lines',m.medianLines||0)+metric('short posts',String(m.shortPostPct||0)+'%')+metric('links',String(m.linkPct||0)+'%')+metric('questions',String(m.questionPct||0)+'%')+metric('hashtags',String(m.hashtagPct||0)+'%')+'</div><div><b>Style guidance</b><div class="trend-list">'+(p.guidance||[]).map(x=>'<span>'+esc(x)+'</span>').join('')+'</div></div><div><b>Common terms</b><div class="trend-list">'+(((p.terms||{}).terms||[]).slice(0,12).map(t=>'<span><b>'+esc(t.term)+'</b><em>'+t.count+'</em></span>').join('')||'<span>None yet</span>')+'</div></div><div><b>Repeated phrases</b><div class="trend-list">'+((p.phrases||[]).slice(0,12).map(t=>'<span><b>'+esc(t.phrase)+'</b><em>'+t.count+'</em></span>').join('')||'<span>None yet</span>')+'</div></div><div><b>Sample posts</b>'+((p.samples||[]).map(x=>'<div class="sample">'+esc(x.text)+'</div>').join('')||'<div class="sample">No samples.</div>')+'</div></article>'}
async function load(){const d=await api('/api/posts');posts=d.posts;renderPosts();const p=await api('/api/profile');profileSnapshots=p.profileSnapshots;renderProfile()}
const SIDE_PANELS=[];
function showTab(name){
  document.querySelectorAll('.nav-tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));
  $('posts').style.display=name==='posts'?'grid':'none';
  $('profile').style.display=name==='profile'?'grid':'none';
  $('generate').style.display=name==='generate'?'':'none';
  $('gen-side').style.display=name==='generate'?'':'none';
  SIDE_PANELS.forEach(id=>{const el=$(id);if(el)el.style.display=name==='generate'?'none':''});
  if(name==='generate') loadDirections().catch(()=>{});
}
document.querySelectorAll('.nav-tab').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));
$('refresh').onclick=()=>load().catch(e=>setStatus(e.message,'failed'));
$('doctor').onclick=async()=>{try{setStatus('Checking Birdclaw...');const d=await api('/api/doctor');const b=d.birdclaw||{};const ok=b.installed&&b.authOk;setStatus([b.installed?'Birdclaw '+(b.version||'?')+' ✓':'Birdclaw ✗',b.authOk?'auth ok ✓':'auth ✗'].join('  ·  '),ok?'success':'failed')}catch(e){setStatus(e.message,'failed')}};
$('posts').onclick=async ev=>{const b=ev.target.closest('button');if(!b)return;const c=ev.target.closest('.post');const id=c.dataset.id;const action=b.dataset.action;try{if(action==='save'){await api('/api/posts/'+id,{method:'PATCH',body:JSON.stringify({text:c.querySelector('[data-field="text"]').value})});setStatus('Saved.','success')}if(action==='rewrite'){await api('/api/posts/'+id+'/rewrite-request',{method:'POST',body:JSON.stringify({instruction:c.querySelector('[data-field="rewrite"]').value})});setStatus('Rewrite request saved.','success')}if(action==='post'){if(!pendingPost.has(id)){const orig=b.textContent;b.classList.add('danger-confirm');b.textContent='Click again to post';const t=setTimeout(()=>{if(pendingPost.get(id)===t){pendingPost.delete(id);b.classList.remove('danger-confirm');b.textContent=orig}},6000);pendingPost.set(id,t);setStatus('Confirm: click again within 6s to post.');return}clearTimeout(pendingPost.get(id));pendingPost.delete(id);b.classList.remove('danger-confirm');b.textContent='Posting...';b.disabled=true;await api('/api/posts/'+id+'/post',{method:'POST'});setStatus('Posted. Check card for result.','success')}await load()}catch(e){setStatus(e.message,'failed');b.disabled=false;b.textContent='Post to X';b.classList.remove('danger-confirm')}};
load().catch(e=>setStatus(e.message,'failed'));

/* ── GENERATE TAB: Source switching ── */
document.querySelectorAll('.source-tab').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.source-tab').forEach(t=>t.classList.remove('active'));
  b.classList.add('active');
  const src=b.dataset.source;
  $('feed-side').style.display=src==='feed'?'':'none';
  $('direction-side').style.display=src==='direction'?'':'none';
  $('gen-feed-view').style.display=src==='feed'?'':'none';
  $('gen-dir-view').style.display=src==='direction'?'':'none';
});

/* ── FEED SOURCE ── */
function renderFeedPosts(){
  const grid=$('feed-posts-grid');const empty=$('feed-empty');const bar=$('feed-sel-bar');
  if(!feedSnapshot||!feedSnapshot.posts||!feedSnapshot.posts.length){grid.innerHTML='';empty.style.display='';bar.style.display='none';return}
  empty.style.display='none';bar.style.display='';
  $('feedSelCount').textContent=selectedFeedIds.size+' of '+feedSnapshot.posts.length+' selected';
  grid.innerHTML=feedSnapshot.posts.map(p=>{
    const sel=selectedFeedIds.has(p.id);
    return '<div class="feed-post'+(sel?' selected':'')+'" data-fid="'+esc(p.id)+'">'+'<div class="feed-post-meta">'+(p.author?'<span>@'+esc(String(p.author).replace(/^@/,''))+'</span>':'')+(p.createdAt?'<span class="ts">'+fmtDate(p.createdAt)+'</span>':'')+(sel?'<span style="color:var(--accent);margin-left:auto">✓ selected</span>':'')+'</div>'+'<div class="feed-post-body">'+esc(p.text)+'</div>'+(p.url?'<a href="'+esc(p.url)+'" target="_blank" rel="noopener" style="font-size:11px;color:var(--muted);word-break:break-all;margin-top:6px;display:block">'+esc(p.url.slice(0,70)+(p.url.length>70?'...':''))+'</a>':'')+'</div>';
  }).join('')}
$('fetchFeedBtn').onclick=async()=>{
  try{
    setStatus('Fetching trending posts...');
    const topic=$('feedTopic').value.trim();
    const data=await api('/api/feed'+(topic?'?topic='+encodeURIComponent(topic):''));
    feedSnapshot=data;selectedFeedIds.clear();
    renderFeedPosts();
    $('feedGenerateSide').style.display='';
    $('feedSideMeta').textContent=data.sampleCount+' trending posts fetched'+(topic?' for "'+topic+'"':' from home timeline');
    setStatus('Fetched '+data.sampleCount+' trending posts.','success');
  }catch(e){setStatus(e.message,'failed')}};
$('feed-posts-grid').addEventListener('click',ev=>{
  const card=ev.target.closest('.feed-post');if(!card)return;
  const fid=card.dataset.fid;
  if(selectedFeedIds.has(fid))selectedFeedIds.delete(fid);else selectedFeedIds.add(fid);
  renderFeedPosts()});
$('genFromFeedBtn').onclick=async()=>{
  try{
    const area=$('feedArea').value.trim()||$('feedTopic').value.trim();
    if(!area)return setStatus('Enter your angle/topic for these trending posts first.','failed');
    if(!feedSnapshot)return setStatus('Fetch trending posts first.','failed');
    const btn=$('genFromFeedBtn');const orig=btn.textContent;btn.disabled=true;btn.textContent='Generating...';
    setStatus('Generating your versions of selected trending posts...');
    const selIds=selectedFeedIds.size>0?[...selectedFeedIds]:[];
    const data=await api('/api/generate/feed',{method:'POST',body:JSON.stringify({area,feedSnapshotId:feedSnapshot.id,selectedPostIds:selIds,count:Math.max(selIds.length||5,1)})});
    await load();showTab('posts');
    setStatus('Generated '+data.posts.length+' trending drafts.','success');
    btn.disabled=false;btn.textContent=orig;
  }catch(e){setStatus(e.message,'failed');$('genFromFeedBtn').disabled=false;$('genFromFeedBtn').textContent='Generate my versions'}};

/* ── DIRECTION SOURCE ── */
async function loadDirections(){
  const data=await api('/api/directions');directions=data.directions;renderDirList();updateDirSideMeta()}
function renderDirList(){
  const grid=$('dir-grid');const empty=$('dir-empty');
  if(!directions.length){grid.innerHTML='';empty.style.display='';return}
  empty.style.display='none';
  grid.innerHTML=directions.map(d=>'<div class="dir-card'+(d.id===activeDirId?' active-dir':'')+'" data-did="'+esc(d.id)+'"><div class="dir-name">'+esc(d.name)+'</div>'+(d.description?'<div class="dir-desc">'+esc(d.description)+'</div>':'')+'<div class="dir-meta-row">'+(d.references&&d.references.length?d.references.length+' reference'+(d.references.length>1?'s':''):''+(d.useTweetSamples?' · uses tweet samples':''))+'</div></div>').join('')}
function updateDirSideMeta(){
  const meta=$('dirSideMeta');const genSide=$('dirGenerateSide');
  if(activeDirId){const dir=directions.find(d=>d.id===activeDirId);meta.textContent=dir?'Active: '+dir.name:'';genSide.style.display=''}
  else{meta.textContent='Select a topic from the list to generate.';genSide.style.display='none'}}
$('dir-grid').addEventListener('click',ev=>{
  const card=ev.target.closest('.dir-card');if(!card)return;
  const did=card.dataset.did;
  if(activeDirId===did){showDirEditor(did)}
  else{activeDirId=did;renderDirList();updateDirSideMeta();showDirEditor(did)}});
function showDirEditor(id){
  const dir=id?directions.find(d=>d.id===id):null;
  editingDirId=id||null;
  $('dirEditLabel').textContent=dir?'Editing: '+dir.name:'New topic';
  $('dirName').value=dir?dir.name:'';
  $('dirDesc').value=dir?(dir.description||''):'';
  $('dirRefs').value=dir?(dir.references||[]).join('\\n---\\n'):'';
  $('dirUseTweets').checked=dir?Boolean(dir.useTweetSamples):false;
  $('deleteDirBtn').style.display=dir?'':'none';
  $('dir-editor-card').style.display=''}
$('newDirBtn').onclick=()=>{editingDirId=null;activeDirId=null;showDirEditor(null);renderDirList();updateDirSideMeta()};
$('cancelDirBtn').onclick=()=>{$('dir-editor-card').style.display='none';editingDirId=null};
$('saveDirBtn').onclick=async()=>{
  try{
    const name=$('dirName').value.trim();if(!name)return setStatus('Topic name is required.','failed');
    const description=$('dirDesc').value.trim();
    const refsRaw=$('dirRefs').value.trim();
    const references=refsRaw?refsRaw.split(/\\n---\\n/).map(r=>r.trim()).filter(Boolean):[];
    const useTweetSamples=$('dirUseTweets').checked;
    let dir;
    if(editingDirId){dir=await api('/api/directions/'+editingDirId,{method:'PATCH',body:JSON.stringify({name,description,references,useTweetSamples})})}
    else{dir=await api('/api/directions',{method:'POST',body:JSON.stringify({name,description,references,useTweetSamples})})}
    activeDirId=dir.id;await loadDirections();$('dir-editor-card').style.display='none';editingDirId=null;
    setStatus('Topic saved: '+dir.name,'success');
  }catch(e){setStatus(e.message,'failed')}};
$('deleteDirBtn').onclick=async()=>{
  if(!editingDirId)return;
  try{
    await api('/api/directions/'+editingDirId,{method:'DELETE'});
    if(activeDirId===editingDirId)activeDirId=null;
    editingDirId=null;$('dir-editor-card').style.display='none';
    await loadDirections();setStatus('Topic deleted.','success');
  }catch(e){setStatus(e.message,'failed')}};
$('genFromDirBtn').onclick=async()=>{
  if(!activeDirId)return setStatus('Select a topic first.','failed');
  try{
    const btn=$('genFromDirBtn');const orig=btn.textContent;btn.disabled=true;btn.textContent='Generating...';
    setStatus('Generating posts for selected topic...');
    const data=await api('/api/generate/direction',{method:'POST',body:JSON.stringify({directionId:activeDirId,count:5})});
    await load();showTab('posts');
    setStatus('Generated '+data.posts.length+' topic drafts.','success');
    btn.disabled=false;btn.textContent=orig;
  }catch(e){setStatus(e.message,'failed');$('genFromDirBtn').disabled=false;$('genFromDirBtn').textContent='Generate topic posts'}};`;

  return [
    "<!doctype html>",
    "<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>xsquared</title>",
    "<link rel=\"preconnect\" href=\"https://fonts.bunny.net\">",
    "<link href=\"https://fonts.bunny.net/css?family=geist:400,500,600|geist-mono:400,500|fraunces:500,600&display=swap\" rel=\"stylesheet\">",
    "<style>" + CSS + "</style></head><body>",
    HEADER,
    "<main><aside class=\"side\">" + SIDEBAR_POSTS + SIDEBAR_GEN + SIDEBAR_SYS + "</aside>",
    "<section><div id=\"posts\" class=\"posts\"></div><div id=\"profile\" class=\"posts\" style=\"display:none\"></div>" + CONTENT_GEN + "</section></main>",
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
      if (req.method === "GET" && url.pathname === "/") {
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
      if (req.method === "POST" && url.pathname === "/api/generate") {
        const body = await readBody(req);
        sendJson(res, 200, generatePosts({ values: { area: body.area || "", count: body.count || "5", limit: body.limit || "40", resource: body.resource || "home" } }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/profile") {
        sendJson(res, 200, { profileSnapshots: getProfileSnapshotsWithAutoLearn(url.searchParams.get("refresh") === "1") });
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
      const actionMatch = url.pathname.match(/^\/api\/posts\/([^/]+)\/(post|rewrite-request)$/);
      if (req.method === "POST" && actionMatch) {
        const body = await readBody(req);
        if (actionMatch[2] === "post") sendJson(res, 200, postToX(actionMatch[1], body.account || DEFAULT_ACCOUNT));
        else sendJson(res, 200, addRewriteRequest(actionMatch[1], body.instruction));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/trends") {
        sendJson(res, 200, runTrends({ values: { topic: url.searchParams.get("topic") || "", limit: url.searchParams.get("limit") || "40", resource: "home" } }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/feed") {
        sendJson(res, 200, fetchFeedSnapshot({ topic: url.searchParams.get("topic") || "", limit: url.searchParams.get("limit") || "40", resource: url.searchParams.get("resource") || "home" }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/feed/latest") {
        sendJson(res, 200, { feedSnapshot: readStore().feedSnapshots[0] || null });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/directions") {
        sendJson(res, 200, { directions: readStore().directions });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/directions") {
        sendJson(res, 200, saveDirection(await readBody(req)));
        return;
      }
      const dirMatch = url.pathname.match(/^\/api\/directions\/([^/]+)$/);
      if (req.method === "PATCH" && dirMatch) {
        sendJson(res, 200, updateDirection(dirMatch[1], await readBody(req)));
        return;
      }
      if (req.method === "DELETE" && dirMatch) {
        sendJson(res, 200, deleteDirection(dirMatch[1]));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/generate/feed") {
        sendJson(res, 200, generateFromFeed(await readBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/generate/direction") {
        sendJson(res, 200, generateFromDirection(await readBody(req)));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/doctor") {
        const birdVersion = birdclaw(["--version"]);
        const auth = birdclaw(["auth", "status", "--json"]);
        sendJson(res, 200, { birdclaw: { installed: birdVersion.ok, version: birdVersion.stdout.trim(), authOk: auth.ok, auth: safeJson(auth.stdout.trim()), stderr: auth.stderr.trim() } });
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
    output("xsquared commands:\n  doctor [--json]\n  strategy [--json]\n  strategy-set --area <posting area> [--json]\n  trends [--topic <topic>] [--limit 40] [--resource home] [--json]\n  generate [--area <posting area>] [--count 5] [--limit 40] [--json]\n  profile-learn [--handle @you] [--limit 200] [--query <query>] [--json]\n  profile [--json]\n  save --text <text> [--topic <topic>] [--angle <angle>] [--score 80] [--notes <notes>]\n  import-json <file>\n  list [--json]\n  update <post-id> [--text <text>] [--status <status>] [--notes <notes>] [--score <score>]\n  rewrite-request <post-id> [--instruction <text>]\n  rewrite-requests [--json]\n  post <post-id> [--account acct_primary]\n  dashboard [--port 3888] [--host 127.0.0.1]");
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
  if (cmd === "generate") {
    const opts = parseArgs({ args: rest, options: { area: { type: "string" }, count: { type: "string" }, limit: { type: "string" }, resource: { type: "string" }, json: { type: "boolean" } } });
    output(generatePosts(opts), Boolean(opts.values.json));
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
    const opts = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
    const posts = readStore().posts;
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
