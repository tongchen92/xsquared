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
const BIRDCLAW_CANDIDATES = process.env.BIRDCLAW_BIN
  ? [process.env.BIRDCLAW_BIN]
  : [LOCAL_BIRDCLAW_BIN, LOCAL_BIRDCLAW_SCRIPT, "birdclaw"].filter(function(candidate, index, arr) {
      return arr.indexOf(candidate) === index && (candidate === "birdclaw" || existsSync(candidate));
    });

function ensureStore() {
  mkdirSync(APP_DIR, { recursive: true });
  if (!existsSync(STORE_PATH)) {
    writeFileSync(STORE_PATH, JSON.stringify({ version: 1, strategy: { contentArea: "", updatedAt: null }, posts: [], trendSnapshots: [], profileSnapshots: [], generationSnapshots: [], rewriteRequests: [] }, null, 2));
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

function run(cmd, args, options) {
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
    const result = run(candidate, args);
    result.binary = candidate;
    if (result.ok) return result;
    last = result;
  }
  return last || run("birdclaw", args);
}

function output(value, json) {
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
  const handle = opts.values.handle || process.env.XSQUARED_HANDLE || "";
  const limit = opts.values.limit || "200";
  const args = ["--json", "search", "tweets", "--resource", "authored", "--limit", String(limit)];
  if (opts.values.query) args.push(opts.values.query);
  const result = birdclaw(args);
  let tweets = extractTweets(result);
  if (handle) {
    const normalized = handle.replace(/^@/, "").toLowerCase();
    const authored = tweets.filter(function(tweet) {
      return String(tweet.author || "").replace(/^@/, "").toLowerCase() === normalized;
    });
    if (authored.length) tweets = authored;
  }
  const profile = analyzeWritingProfile(tweets, handle);
  const snapshot = {
    id: makeId("profile"),
    createdAt: nowIso(),
    handle: handle || null,
    limit: Number(limit),
    birdclaw: { ok: result.ok, status: result.status, error: result.error, stderr: result.stderr.trim() },
    profile,
    note: profile.sampleCount ? "" : "No authored tweets found in Birdclaw local data. Import your X archive or run Birdclaw authored sync, then learn again."
  };
  const store = readStore();
  store.profileSnapshots.unshift(snapshot);
  store.profileSnapshots = store.profileSnapshots.slice(0, 25);
  writeStore(store);
  return snapshot;
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
  return [
    "<!doctype html>",
    "<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>xsquared</title>",
    "<style>",
    ":root{color-scheme:light;--bg:#f7f7f4;--ink:#151515;--muted:#666;--line:#d8d7d2;--panel:#fff;--green:#15803d;--red:#b42318}*{box-sizing:border-box}body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:var(--bg);color:var(--ink)}header{position:sticky;top:0;z-index:2;background:rgba(247,247,244,.95);border-bottom:1px solid var(--line);backdrop-filter:blur(10px)}.bar{max-width:1180px;margin:0 auto;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:16px}h1{margin:0;font-size:20px;letter-spacing:0}main{max-width:1180px;margin:0 auto;padding:18px;display:grid;grid-template-columns:320px 1fr;gap:18px}button,input,textarea,select{font:inherit}button{border:1px solid #bbb8ae;background:#fff;color:#111;border-radius:7px;padding:8px 10px;cursor:pointer}button.primary,.tab.active{background:#111827;color:#fff;border-color:#111827}button:disabled{opacity:.55;cursor:not-allowed}input,textarea,select{width:100%;border:1px solid #c9c7bf;background:#fff;border-radius:7px;padding:9px 10px}textarea{min-height:132px;resize:vertical;line-height:1.35}.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}.side{display:grid;gap:14px;align-self:start;position:sticky;top:70px}.field{display:grid;gap:6px;margin-bottom:10px}label{color:var(--muted);font-size:12px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.posts{display:grid;gap:12px}.post,.profile-card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:14px;display:grid;gap:10px}.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}.metric{border:1px solid var(--line);border-radius:7px;padding:10px;background:#fafafa}.metric b{display:block;font-size:20px}.meta{color:var(--muted);font-size:12px;display:flex;gap:8px;flex-wrap:wrap}.pill{border:1px solid var(--line);border-radius:999px;padding:2px 7px;background:#fafafa}.score,.posted{color:var(--green)}.failed{color:var(--red);white-space:pre-wrap}.trend-list{display:grid;gap:6px;font-size:13px;color:#333}.trend-list span{display:inline-flex;justify-content:space-between;gap:8px;border-bottom:1px solid #eee;padding-bottom:4px}.sample{white-space:pre-wrap;border-top:1px solid #eee;padding-top:10px}.empty{color:var(--muted);padding:30px;text-align:center;border:1px dashed var(--line);border-radius:8px;background:#fff}@media(max-width:820px){main{grid-template-columns:1fr}.side{position:static}.bar{align-items:flex-start;flex-direction:column}}",
    "</style></head><body><header><div class=\"bar\"><h1>xsquared</h1><div class=\"row\"><button id=\"refresh\">Refresh</button><button id=\"doctor\">Doctor</button></div></div></header>",
    "<main><aside class=\"side\"><section class=\"panel\"><div class=\"row\"><button class=\"tab active\" data-tab=\"posts\">Posts</button><button class=\"tab\" data-tab=\"profile\">Profile</button></div></section><section class=\"panel\"><div class=\"field\"><label>Posting Area</label><textarea id=\"contentArea\" placeholder=\"Google Ads for small business\"></textarea></div><div class=\"row\"><button id=\"saveArea\">Save Area</button><button id=\"generateDrafts\" class=\"primary\">Generate Drafts</button></div></section><section class=\"panel\"><div class=\"field\"><label>Topic</label><input id=\"topic\" placeholder=\"AI agents, local business ops...\"></div><div class=\"row\"><button id=\"scan\" class=\"primary\">Analyze Trends</button></div><div id=\"trends\" class=\"trend-list\" style=\"margin-top:12px;\"></div></section>",
    "<section class=\"panel\"><div class=\"field\"><label>New Draft</label><textarea id=\"newText\" placeholder=\"Paste or write a draft...\"></textarea></div><div class=\"field\"><label>Angle</label><input id=\"angle\" placeholder=\"contrarian, tactical, founder lesson...\"></div><div class=\"row\"><button id=\"saveNew\" class=\"primary\">Save Draft</button></div></section><section class=\"panel\"><div class=\"field\"><label>X Handle</label><input id=\"handle\" placeholder=\"@tongchen92\"></div><div class=\"row\"><button id=\"learnProfile\">Learn Profile</button></div></section><section class=\"panel\"><div id=\"status\" class=\"meta\">Ready.</div></section></aside><section><div id=\"posts\" class=\"posts\"></div><div id=\"profile\" class=\"posts\" style=\"display:none\"></div></section></main>",
    "<script>",
    "const $=id=>document.getElementById(id);let posts=[],profileSnapshots=[];function setStatus(t,c){const e=$('status');e.className=c||'meta';e.textContent=t}async function api(p,o={}){const r=await fetch(p,{headers:{'content-type':'application/json'},...o});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||r.statusText);return b}function esc(v){return String(v||'').replace(/[&<>\"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[ch]))}function renderPosts(){const root=$('posts');if(!posts.length){root.innerHTML='<div class=\"empty\">No posts yet. Generate with OpenClaw or save a draft here.</div>';return}root.innerHTML=posts.map(function(p){return '<article class=\"post\" data-id=\"'+esc(p.id)+'\"><div class=\"meta\"><span class=\"pill\">'+esc(p.status||'draft')+'</span>'+(p.topic?'<span>'+esc(p.topic)+'</span>':'')+(p.angle?'<span>'+esc(p.angle)+'</span>':'')+(p.score!==null&&p.score!==undefined?'<span class=\"score\">score '+esc(p.score)+'</span>':'')+'<span>'+new Date(p.updatedAt||p.createdAt).toLocaleString()+'</span></div><textarea data-field=\"text\">'+esc(p.text)+'</textarea><div class=\"field\"><label>Rewrite request</label><input data-field=\"rewrite\" placeholder=\"Sharper, more specific, less hype...\"></div><div class=\"row\"><button data-action=\"save\">Save</button><button data-action=\"rewrite\">Ask OpenClaw</button><button data-action=\"post\" class=\"primary\">Post to X</button></div>'+(p.postResult&&!p.postResult.ok?'<div class=\"failed\">'+esc(p.postResult.stderr||p.postResult.error||'Post failed')+'</div>':'')+(p.postedAt?'<div class=\"posted\">Posted '+new Date(p.postedAt).toLocaleString()+'</div>':'')+'</article>'}).join('')}function metric(label,value){return '<div class=\"metric\"><b>'+esc(value)+'</b><span class=\"meta\">'+esc(label)+'</span></div>'}function renderProfile(){const root=$('profile');const s=profileSnapshots[0];if(!s){root.innerHTML='<div class=\"empty\">No profile snapshot yet. Click Learn Profile after Birdclaw has authored tweets imported or synced.</div>';return}const p=s.profile||{};const m=p.metrics||{};root.innerHTML='<article class=\"profile-card\"><div class=\"meta\"><span class=\"pill\">'+esc(s.handle||'authored')+'</span><span>'+new Date(s.createdAt).toLocaleString()+'</span><span>'+esc(p.sampleCount||0)+' tweets</span></div>'+(s.note?'<div class=\"failed\">'+esc(s.note)+'</div>':'')+'<div class=\"metric-grid\">'+metric('median chars',m.medianChars||0)+metric('median lines',m.medianLines||0)+metric('short posts',String(m.shortPostPct||0)+'%')+metric('links',String(m.linkPct||0)+'%')+metric('questions',String(m.questionPct||0)+'%')+metric('hashtags',String(m.hashtagPct||0)+'%')+'</div><div><b>Style guidance</b><div class=\"trend-list\">'+(p.guidance||[]).map(x=>'<span>'+esc(x)+'</span>').join('')+'</div></div><div><b>Common terms</b><div class=\"trend-list\">'+(((p.terms||{}).terms||[]).slice(0,12).map(t=>'<span><b>'+esc(t.term)+'</b><em>'+t.count+'</em></span>').join('')||'<span>None yet</span>')+'</div></div><div><b>Repeated phrases</b><div class=\"trend-list\">'+((p.phrases||[]).slice(0,12).map(t=>'<span><b>'+esc(t.phrase)+'</b><em>'+t.count+'</em></span>').join('')||'<span>None yet</span>')+'</div></div><div><b>Sample posts</b>'+((p.samples||[]).map(x=>'<div class=\"sample\">'+esc(x.text)+'</div>').join('')||'<div class=\"sample\">No samples found.</div>')+'</div></article>'}async function load(){const d=await api('/api/posts');posts=d.posts;renderPosts();const p=await api('/api/profile');profileSnapshots=p.profileSnapshots;renderProfile()}function showTab(name){document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));$('posts').style.display=name==='posts'?'grid':'none';$('profile').style.display=name==='profile'?'grid':'none'}document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));$('refresh').onclick=()=>load().catch(e=>setStatus(e.message,'failed'));$('doctor').onclick=async()=>{try{const d=await api('/api/doctor');setStatus(JSON.stringify(d.birdclaw))}catch(e){setStatus(e.message,'failed')}};$('scan').onclick=async()=>{try{setStatus('Analyzing Birdclaw context...');const d=await api('/api/trends?topic='+encodeURIComponent($('topic').value));$('trends').innerHTML=(d.analysis.terms||[]).slice(0,10).map(t=>'<span><b>'+esc(t.term)+'</b><em>'+t.count+'</em></span>').join('')||'No trend terms found.';setStatus('Analyzed '+d.sampleCount+' tweets.')}catch(e){setStatus(e.message,'failed')}};$('learnProfile').onclick=async()=>{try{setStatus('Learning from authored tweets...');const d=await api('/api/profile/learn',{method:'POST',body:JSON.stringify({handle:$('handle').value,limit:200})});profileSnapshots=[d].concat(profileSnapshots);renderProfile();showTab('profile');setStatus('Profile snapshot saved: '+(d.profile.sampleCount||0)+' tweets.')}catch(e){setStatus(e.message,'failed')}};$('saveNew').onclick=async()=>{try{const text=$('newText').value.trim();if(!text)return setStatus('Draft text is required.','failed');await api('/api/posts',{method:'POST',body:JSON.stringify({text,topic:$('topic').value,angle:$('angle').value,source:'dashboard'})});$('newText').value='';$('angle').value='';await load();setStatus('Draft saved.')}catch(e){setStatus(e.message,'failed')}};$('posts').onclick=async ev=>{const b=ev.target.closest('button');if(!b)return;const c=ev.target.closest('.post');const id=c.dataset.id;const action=b.dataset.action;try{if(action==='save'){await api('/api/posts/'+id,{method:'PATCH',body:JSON.stringify({text:c.querySelector('[data-field=\"text\"]').value})});setStatus('Saved.')}if(action==='rewrite'){await api('/api/posts/'+id+'/rewrite-request',{method:'POST',body:JSON.stringify({instruction:c.querySelector('[data-field=\"rewrite\"]').value})});setStatus('Rewrite request saved. Ask OpenClaw to process xsquared rewrite requests.')}if(action==='post'){if(!confirm('Post this draft to X through Birdclaw?'))return;b.disabled=true;await api('/api/posts/'+id+'/post',{method:'POST'});setStatus('Post attempted. Check status on the card.')}await load()}catch(e){setStatus(e.message,'failed');b.disabled=false}};load().catch(e=>setStatus(e.message,'failed'));",
    "async function loadStrategy(){const d=await api('/api/strategy');$('contentArea').value=(d.strategy&&d.strategy.contentArea)||''}async function saveArea(){const area=$('contentArea').value.trim();await api('/api/strategy',{method:'PATCH',body:JSON.stringify({contentArea:area})});setStatus('Posting area saved.')}async function scanArea(){const topic=($('topic').value||$('contentArea').value).trim();if(!topic)return setStatus('Enter a topic or posting area first.','failed');setStatus('Analyzing Birdclaw context...');const d=await api('/api/trends?topic='+encodeURIComponent(topic));$('trends').innerHTML=(d.analysis.terms||[]).slice(0,10).map(t=>'<span><b>'+esc(t.term)+'</b><em>'+t.count+'</em></span>').join('')||'No trend terms found.';setStatus('Analyzed '+d.sampleCount+' tweets for '+topic+'.')}async function generateDrafts(){const area=$('contentArea').value.trim()||$('topic').value.trim();if(!area)return setStatus('Enter a posting area first.','failed');setStatus('Analyzing trends and generating drafts...');const d=await api('/api/generate',{method:'POST',body:JSON.stringify({area,count:5,limit:40})});await load();showTab('posts');setStatus('Generated '+d.posts.length+' drafts for '+area+'.')}if($('saveArea'))$('saveArea').onclick=()=>saveArea().catch(e=>setStatus(e.message,'failed'));if($('generateDrafts'))$('generateDrafts').onclick=()=>generateDrafts().catch(e=>setStatus(e.message,'failed'));$('scan').onclick=()=>scanArea().catch(e=>setStatus(e.message,'failed'));loadStrategy().catch(e=>setStatus(e.message,'failed'));",
    "</script></body></html>"
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
        sendJson(res, 200, { profileSnapshots: readStore().profileSnapshots });
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
