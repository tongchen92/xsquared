# xsquared — Sources Refactor Plan

**Audience:** the engineer implementing this tomorrow.
**Scope:** reorganize `src/xsquared.ts` (single file) around `sources`. Replace the template-based generator with real LLM calls via `claude -p`. Keep CLI, dashboard, store on disk, and one-file architecture.
**Out of scope:** splitting the file; rewriting the Eigen chat dock; changing the Birdclaw or profile-learning pipelines.

Read order in the existing file:
- Store + helpers: lines 26–141
- Birdclaw/trends/profile: 143–388
- Eigen chat: 390–464 (DO NOT TOUCH — `/api/chat` is sacred)
- Strategy + generation (templates): 466–779
- Post CRUD + posting: 781–878 (preserve uncommitted `deletePost` + `postToX --json` changes)
- HTML/CSS/JS: 892–1094
- HTTP server: 1107–1227
- CLI entry: 1234–1331

---

## 0. Pre-flight: tools verified

| Tool | Path | Used for |
|---|---|---|
| `claude` | `/Users/tongchen/.local/bin/claude` | research + generation LLM calls (non-interactive `-p`) |
| `openclaw` | `/opt/homebrew/bin/openclaw` | Eigen chat (existing) — **not** used for the new pipeline |
| `birdclaw` | `/opt/homebrew/bin/birdclaw` | viral feed pulls + posting (existing) |

`claude -p --output-format json` returns a JSON envelope:
```json
{ "type":"result","is_error":false,"result":"<assistant text>","total_cost_usd":0.06,"duration_ms":1678 }
```
We always parse `.result` (a string — may contain fenced JSON we then need to extract).

**Cost reality check we must surface in the UI:**
A trivial `claude -p` call with default (Opus, full harness) costs ~$0.29. With `--model sonnet` it drops to ~$0.06 / 1.7s. A research run with WebSearch will be 5–15 cents and 30–90s. The implementer must default to **Sonnet** and surface `total_cost_usd` from every LLM call back to the dashboard. See §2 and §8.

---

## 1. Data model

### 1.1 New `sources` collection (replaces `directions` and `feedSnapshots`)

```ts
type SourceKind = "topic" | "viral";

type Source = {
  id: string;                  // src_topic_..., src_viral_...
  kind: SourceKind;
  name: string;                // user-facing tab label
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
  config: TopicConfig | ViralConfig;
  research?: ResearchArtifact | null;   // topic sources only
  lastFeedSnapshotId?: string | null;   // viral sources only
};

type TopicConfig = {
  angle: string;               // "What angle/objective" — was direction.description
  seedNotes: string;           // free-form user paste — was direction.references joined
  useTweetVoice: boolean;      // was direction.useTweetSamples
};

type ViralConfig = {
  filter: string;              // e.g. "AI agents" — empty = home timeline
  resource: "home" | "following" | "for-you";   // pass-through to birdclaw
  limit: number;               // default 40
};

type ResearchArtifact = {
  id: string;                  // res_...
  createdAt: string;
  query: string;               // the synthesized search query the LLM used
  links: Array<{ url: string; title: string; snippet: string }>;
  summaries: string[];         // 2–5 bullet-style takeaways
  facts: string[];             // short extracted claims, each with a [n] citation index
  raw: string;                 // the full LLM JSON reply, for debugging
  costUsd: number;
  durationMs: number;
};
```

`feedSnapshots` becomes per-source and is stored *inside* the viral source (only the latest is kept; we don't need history):

```ts
// in the store, for a viral source:
source.lastFeedSnapshot = {
  id, createdAt, posts: [{ id, author, text, createdAt, url }], sampleCount, birdclaw: {...}
}
```

### 1.2 Posts stay top-level with `sourceId` FK

```ts
type Post = {
  id, createdAt, updatedAt, status, topic, angle, score, text, notes,
  source: "openclaw"|"xsquared-generator",
  generationSource: "topic"|"viral"|"openclaw",
  inspirationPosts: Array<{ id, author, text, url }>,
  sourceId: string | null,           // NEW — replaces directionId
  directionId?: string | null,       // KEEP for backward read compat during migration
  postedAt, postResult
};
```

**Why posts stay top-level:** (1) `/api/posts` and `xsquared list` are user-facing CLI surface and shouldn't get re-shaped, (2) "all drafts" is still a useful mental view (we render them grouped by source in the UI), (3) deleting a source shouldn't cascade-delete drafts the user spent time editing — orphan drafts go into an "unassigned" bucket.

**Why one-per-filter viral sources (not singleton):** user vision says tabs map 1:1 to sources, and the user explicitly wants multiple themed feeds ("AI agents" + "marketing" + a generic "home"). A singleton would force one filter at a time. Cost of plurality is zero: it's just `kind: "viral"` rows.

### 1.3 New `store.json` shape

```json
{
  "version": 2,
  "strategy": { "contentArea": "", "updatedAt": null },
  "posts": [ /* Post[] */ ],
  "sources": [ /* Source[] */ ],
  "profileSnapshots": [...],
  "generationSnapshots": [...],
  "rewriteRequests": [...],
  "chatMessages": [...],
  "chatConfig": {},
  "trendSnapshots": [...]
}
```

Drop `directions` and `feedSnapshots` from the canonical schema, **but** keep `readStore()` migrating them forward (see §1.4). Old store versions in the wild should auto-upgrade on first read.

### 1.4 Migration (one-shot, in `readStore()`)

```ts
function readStore() {
  ensureStore();
  const s = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  s.version ||= 1;
  // ...defaulting unchanged collections...
  s.sources ||= [];

  if (s.version < 2) {
    // Migrate directions -> topic sources
    for (const d of s.directions || []) {
      s.sources.push({
        id: d.id.replace(/^dir_/, "src_topic_"),
        kind: "topic",
        name: d.name,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt || d.createdAt,
        config: {
          angle: d.description || "",
          seedNotes: (d.references || []).join("\n---\n"),
          useTweetVoice: d.useTweetSamples !== false
        },
        research: null
      });
    }
    // Backfill posts.sourceId from posts.directionId
    for (const p of s.posts || []) {
      if (p.directionId && !p.sourceId) {
        p.sourceId = p.directionId.replace(/^dir_/, "src_topic_");
      }
    }
    // We do NOT migrate feedSnapshots — they were ephemeral, not user-owned.
    // We keep s.directions and s.feedSnapshots in the file for now (read-only),
    // so a user can roll back. They become inert.
    s.version = 2;
    writeStore(s);
  }
  return s;
}
```

Field defaults for collections must stay defensive (`||= []`) so a hand-edited store doesn't crash.

---

## 2. AI research pipeline (topic sources only)

### 2.1 Decision: shell out to `claude -p` (option b)

| Option | Verdict |
|---|---|
| (a) `openclaw agent` | Rejected. Already in use for the Eigen chat dock; couples research latency to whatever Telegram-routing config the user has. Wrong tool. |
| **(b) `claude -p` with WebSearch+WebFetch** | **Chosen.** One CLI we know works headless (verified with `claude -p --output-format json "say hi"` round trip ~2s; with WebSearch enabled, expect 30–90s and $0.05–0.15/run). Returns structured JSON we can parse. User is already logged in via Claude Code OAuth. |
| (c) Hand-roll search API + scrape + raw Anthropic SDK | Rejected. Three new dependencies (search provider key, HTML→text lib, Anthropic SDK), three new failure surfaces, and no clear win over (b). |

### 2.2 The actual invocation

```ts
// in xsquared.ts
const CLAUDE_BIN = process.env.XSQUARED_CLAUDE_BIN || "claude";
const CLAUDE_MODEL = process.env.XSQUARED_CLAUDE_MODEL || "sonnet";
const RESEARCH_BUDGET_USD = process.env.XSQUARED_RESEARCH_BUDGET_USD || "0.50";

function callClaude(prompt: string, opts: { allowTools?: string[]; budgetUsd?: string; timeoutMs?: number } = {}) {
  const args = [
    "-p",
    "--output-format", "json",
    "--model", CLAUDE_MODEL,
    "--permission-mode", "bypassPermissions",
    "--max-budget-usd", opts.budgetUsd || "0.25"
  ];
  if (opts.allowTools && opts.allowTools.length) {
    args.push("--allowedTools", opts.allowTools.join(","));
  } else {
    args.push("--tools", ""); // disable all tools for pure-text generation
  }
  args.push(prompt);
  return run(CLAUDE_BIN, args, { timeout: opts.timeoutMs || 180_000 });
}
```

### 2.3 The research prompt

```ts
function buildResearchPrompt(source: Source): string {
  const c = source.config as TopicConfig;
  return [
    "You are doing background research for an X (Twitter) post about a specific topic.",
    "Use the WebSearch and WebFetch tools to find 6–10 high-signal recent sources.",
    "",
    "Topic: " + source.name,
    "Angle / objective: " + (c.angle || "(none specified)"),
    "User's seed notes (treat as constraints, not as conclusions):",
    c.seedNotes ? c.seedNotes : "(none)",
    "",
    "Return a single JSON object inside a ```json fenced block, matching this shape exactly:",
    "{",
    '  "query": "<the search query you used>",',
    '  "links": [{"url":"...","title":"...","snippet":"<one-sentence summary>"}],',
    '  "summaries": ["<2–5 short bullet-style takeaways from the research>"],',
    '  "facts": ["<short concrete claim with [n] citation index referring to links[n-1]>"]',
    "}",
    "",
    "Rules:",
    "- Prefer primary sources (docs, official posts, named researchers) over content farms.",
    "- Each fact must end with a [n] index pointing to links[n-1].",
    "- No hedging, no 'as an AI'. Output the JSON and nothing else."
  ].join("\n");
}
```

### 2.4 Calling it

```ts
function runResearch(sourceId: string) {
  const store = readStore();
  const source = store.sources.find(s => s.id === sourceId);
  if (!source || source.kind !== "topic") throw new Error("topic source not found: " + sourceId);

  const t0 = Date.now();
  const r = callClaude(buildResearchPrompt(source), {
    allowTools: ["WebSearch", "WebFetch"],
    budgetUsd: RESEARCH_BUDGET_USD,
    timeoutMs: 240_000
  });
  if (!r.ok) throw new Error("claude failed: " + (r.stderr.trim() || r.error || "unknown"));

  const envelope = safeJson(r.stdout.trim()) as any;
  if (envelope && envelope.is_error) throw new Error("claude error: " + (envelope.result || "unknown"));

  const raw = String(envelope?.result || "");
  const parsed = extractFencedJson(raw);  // see helper below
  const artifact: ResearchArtifact = {
    id: makeId("res"),
    createdAt: nowIso(),
    query: String(parsed.query || source.name),
    links: Array.isArray(parsed.links) ? parsed.links.slice(0, 12) : [],
    summaries: Array.isArray(parsed.summaries) ? parsed.summaries.slice(0, 8) : [],
    facts: Array.isArray(parsed.facts) ? parsed.facts.slice(0, 20) : [],
    raw,
    costUsd: Number(envelope?.total_cost_usd || 0),
    durationMs: Date.now() - t0
  };
  const s2 = readStore();
  const src = s2.sources.find(x => x.id === sourceId);
  src.research = artifact;
  src.updatedAt = nowIso();
  writeStore(s2);
  return artifact;
}

function extractFencedJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  try { return JSON.parse(body); } catch { return {}; }
}
```

### 2.5 Sync vs async

**Synchronous (the call blocks the HTTP request).** xsquared is single-user, localhost. 30–90s with a "Researching…" spinner is fine. A job queue would add 100 lines of code for no UX win. The frontend disables the Run-research button + shows a spinner with `setStatus()` while the POST is in flight.

If a user complains, the future migration path is: `POST /api/sources/:id/research` returns `{ jobId }`, store includes `researchJobs[]`, frontend polls `GET /api/research-jobs/:id`. Not now.

---

## 3. Generation pipeline (new)

### 3.1 Decision: same `claude -p` path, no web tools, fall back to templates

When the user hits **Generate**:
1. If the source is a **topic source with research**, prompt Claude with `(source.config + research.summaries + research.facts + profile voice metrics)` → 5 drafts.
2. If the source is a **topic source without research**, prompt Claude with `(source.config + profile voice)` → 5 drafts.
3. If the source is a **viral source**, the user has already picked N viral posts; prompt Claude with `(viral post text + profile voice)` for each → 1 draft per selection.
4. **Fallback:** if `claude` is not on PATH (or `XSQUARED_DISABLE_LLM=1`), call the existing `makeDirectionTexts` / `makeFeedInspiredTexts` template functions. Keep them; they're our offline mode.

### 3.2 Prompt

```ts
function buildTopicGenPrompt(source: Source, profile: any, count: number): string {
  const c = source.config as TopicConfig;
  const res = source.research;
  const voice = profile ? summarizeProfileForPrompt(profile) : "(no learned voice — use a direct, builder-to-builder tone, ~140–200 chars per post)";
  return [
    "You are drafting " + count + " candidate X (Twitter) posts. Output JSON only.",
    "",
    "Topic: " + source.name,
    "Angle: " + (c.angle || "(none)"),
    "User seed notes: " + (c.seedNotes || "(none)"),
    "",
    res ? "Research findings (use these — do not invent stats):" : "No research yet — write from the angle + seed notes only.",
    res ? "Summaries:\n- " + res.summaries.join("\n- ") : "",
    res ? "Facts:\n- " + res.facts.join("\n- ") : "",
    res && res.links.length ? "Source URLs available if you cite, but you usually shouldn't link in a post." : "",
    "",
    "Voice profile:",
    voice,
    "",
    "Return a single JSON object inside a ```json fence:",
    '{ "posts": [ { "text": "<the post>", "angle": "<3–5 word label>", "score": <60–95>, "notes": "<why this one might land>" } ] }',
    "",
    "Rules:",
    "- " + count + " posts. Each <= 280 chars.",
    "- No hashtags unless the voice profile says they're used >15% of the time.",
    "- No emojis unless the voice profile shows them.",
    "- No 'thread 🧵' framing unless asked.",
    "- Each post stands alone."
  ].filter(Boolean).join("\n");
}

function buildViralGenPrompt(sourceName: string, inspiration: Array<{author:string,text:string,url?:string}>, profile: any, count: number): string {
  const voice = profile ? summarizeProfileForPrompt(profile) : "(direct, no hype, ~140–200 chars)";
  return [
    "Draft " + count + " original X posts inspired by these recently-viral posts.",
    "Each draft should respond to ONE inspiration post with the user's own angle — NOT a quote-tweet reply, but a standalone post that takes a position.",
    "",
    "Topic context: " + sourceName,
    "",
    "Inspiration posts:",
    ...inspiration.map((p, i) => `[${i+1}] @${p.author||"?"}: ${p.text.replace(/\n+/g, " ")}`),
    "",
    "Voice profile:",
    voice,
    "",
    "Return JSON: " + '{ "posts": [ { "text": "...", "angle": "...", "score": 60-95, "notes": "...", "inspirationIndex": <1..N> } ] }',
    "",
    "Rules: same as before — <=280 chars, voice-matched, no hype."
  ].join("\n");
}

function summarizeProfileForPrompt(snapshot: any): string {
  const p = snapshot.profile || {};
  const m = p.metrics || {};
  const terms = ((p.terms && p.terms.terms) || []).slice(0, 8).map((t:any)=>t.term).join(", ");
  return [
    `- median chars: ${m.medianChars || "?"}, median lines: ${m.medianLines || "?"}`,
    `- short posts (<=140 chars): ${m.shortPostPct || 0}%; long posts (>240): ${m.longPostPct || 0}%`,
    `- uses links: ${m.linkPct || 0}%; hashtags: ${m.hashtagPct || 0}%; questions: ${m.questionPct || 0}%`,
    `- recurring terms: ${terms || "(none)"}`,
    `- guidance: ${(p.guidance || []).join(" | ") || "(none)"}`
  ].join("\n");
}
```

### 3.3 Wiring

```ts
function generateForSource(sourceId: string, opts: { count?: number; selectedPostIds?: string[] } = {}) {
  const store = readStore();
  const source = store.sources.find(s => s.id === sourceId);
  if (!source) throw new Error("source not found: " + sourceId);
  const profile = store.profileSnapshots[0] || null;
  const count = Number(opts.count || 5);

  let inputs: any[];
  if (source.kind === "topic") {
    inputs = callLlmForDrafts(buildTopicGenPrompt(source, profile, count), count)
      || makeDirectionTexts(adaptTopicToDirection(source), profile, count); // fallback
    inputs.forEach(p => { p.sourceId = source.id; p.generationSource = "topic"; });
  } else {
    const snap = source.lastFeedSnapshot;
    if (!snap || !snap.posts || !snap.posts.length) throw new Error("fetch the viral feed first");
    const selected = (opts.selectedPostIds && opts.selectedPostIds.length)
      ? snap.posts.filter(p => opts.selectedPostIds.includes(p.id))
      : snap.posts.slice(0, count);
    inputs = callLlmForDrafts(buildViralGenPrompt(source.name, selected, profile, selected.length), selected.length)
      || makeFeedInspiredTexts(selected, source.name, profile, selected.length); // fallback
    inputs.forEach((p, i) => {
      p.sourceId = source.id;
      p.generationSource = "viral";
      const inspIdx = (p.inspirationIndex || (i + 1)) - 1;
      const insp = selected[inspIdx] || selected[i];
      p.inspirationPosts = insp ? [{ id: insp.id, author: insp.author, text: String(insp.text||"").slice(0,200), url: insp.url }] : [];
    });
  }
  // save and emit generation snapshot (reuse existing pattern)
  const drafts = inputs.map(normalizePost);
  const s2 = readStore();
  drafts.forEach(d => s2.posts.unshift(d));
  s2.generationSnapshots.unshift({
    id: makeId("generation"),
    createdAt: nowIso(),
    sourceId: source.id,
    sourceKind: source.kind,
    profileSnapshotId: profile ? profile.id : null,
    postIds: drafts.map(d => d.id),
    count: drafts.length
  });
  s2.generationSnapshots = s2.generationSnapshots.slice(0, 50);
  writeStore(s2);
  return { source, posts: drafts };
}

function callLlmForDrafts(prompt: string, count: number): any[] | null {
  if (process.env.XSQUARED_DISABLE_LLM === "1") return null;
  const r = callClaude(prompt, { budgetUsd: "0.15", timeoutMs: 120_000 });
  if (!r.ok) return null;
  const env = safeJson(r.stdout.trim()) as any;
  if (!env || env.is_error) return null;
  const parsed = extractFencedJson(String(env.result || ""));
  const posts = Array.isArray(parsed.posts) ? parsed.posts : [];
  if (!posts.length) return null;
  return posts.slice(0, count).map((p: any) => ({
    text: String(p.text || "").trim(),
    angle: String(p.angle || ""),
    score: Number(p.score) || 75,
    notes: String(p.notes || ""),
    source: "xsquared-generator",
    inspirationIndex: p.inspirationIndex
  })).filter(p => p.text);
}

// Adapter so the template fallback keeps working without changes to its function body.
function adaptTopicToDirection(s: Source) {
  const c = s.config as TopicConfig;
  return { id: s.id, name: s.name, description: c.angle, references: c.seedNotes ? c.seedNotes.split(/\n---\n/) : [], useTweetSamples: c.useTweetVoice };
}
```

---

## 4. Endpoint contracts

### 4.1 Kept as-is (CLI relies on them)
- `GET /api/posts` → `{ posts: Post[] }`
- `GET /api/profile?refresh=1` → `{ profileSnapshots: [...] }`
- `POST /api/profile/learn`
- `POST /api/posts`, `PATCH /api/posts/:id`, **`DELETE /api/posts/:id`** (uncommitted, keep)
- `POST /api/posts/:id/post` (uncommitted `--json`/transport handling, keep)
- `POST /api/posts/:id/rewrite-request`
- `GET /api/doctor`
- `GET /api/chat`, `POST /api/chat` (Eigen — do not touch)
- `GET /api/strategy`, `PATCH /api/strategy` (still used internally; can hide from UI)

### 4.2 New endpoints

```
GET    /api/sources                        -> { sources: Source[] }
POST   /api/sources                        body: { kind, name, config }  -> Source
GET    /api/sources/:id                    -> Source
PATCH  /api/sources/:id                    body: partial { name?, config?, archived? } -> Source
DELETE /api/sources/:id                    -> { deleted: id, orphanedPostCount: number }
POST   /api/sources/:id/research           -> ResearchArtifact          (blocks ~60s)
POST   /api/sources/:id/viral-fetch        -> { lastFeedSnapshot: {...} } (viral sources only)
POST   /api/sources/:id/generate           body: { count?, selectedPostIds? } -> { source, posts }
GET    /api/sources/:id/posts              -> { posts: Post[] }         (filter posts by sourceId)
```

Validation rules:
- `POST /api/sources` requires `kind in ["topic","viral"]` + non-empty `name`.
- `research` only valid for topic sources.
- `viral-fetch` only valid for viral sources.
- `DELETE` does **not** delete posts; it nulls their `sourceId` so they show up as "Unassigned".

### 4.3 Removed endpoints

```
GET  /api/feed              -> use POST /api/sources/:id/viral-fetch
GET  /api/feed/latest       -> source.lastFeedSnapshot is in GET /api/sources/:id
GET  /api/directions        -> /api/sources?kind=topic (we'll honor the kind filter)
POST /api/directions        -> POST /api/sources
PATCH /api/directions/:id   -> PATCH /api/sources/:id
DELETE /api/directions/:id  -> DELETE /api/sources/:id
POST /api/generate/feed     -> POST /api/sources/:id/generate
POST /api/generate/direction -> POST /api/sources/:id/generate
POST /api/generate          -> kept as a thin no-op alias that maps `{area}` to a one-off topic source? **No.** Remove. Update CLI `xsquared generate` to require `--source-id` (see §5).
GET  /api/trends            -> Remove. (No UI surface; CLI `trends` still works because it calls runTrends() directly.)
```

For one release we can leave the removed endpoints returning 410 Gone with a body explaining the rename, to help any external script.

---

## 5. CLI commands

### 5.1 Updated commands

```
xsquared sources [--kind topic|viral] [--json]
xsquared source-new --kind <topic|viral> --name <name> [--angle <a>] [--notes <n>] [--filter <f>] [--use-voice]
xsquared source-edit <source-id> [--name ...] [--angle ...] [--notes ...]
xsquared source-delete <source-id>
xsquared research <source-id> [--json]
xsquared viral-fetch <source-id> [--json]
xsquared generate <source-id> [--count 5] [--selected <id,id,id>] [--json]
xsquared list [--source <source-id>] [--json]                # source filter is new
xsquared post <post-id> [--account acct_primary]             # unchanged
xsquared profile-learn / profile / save / update / rewrite-request / rewrite-requests / doctor / dashboard / strategy / strategy-set / trends
```

### 5.2 Compatibility

- `xsquared generate` (no source) → print "deprecated: pass --source-id" + auto-pick the most recently-updated topic source if exactly one exists. Otherwise error.
- `xsquared list` without `--source` continues to return all posts (current behavior).
- The README `--help` text needs the new section.

---

## 6. UI structure

### 6.1 Top nav (replaces today's Posts / Generate / Profile)

```
┌─ xsquared · drafts ─────────────────────────────────────────┐
│  Tab strip: [⛯ Google Ads SMB] [⛯ AI agents]  [⚡ AI feed] [⚡ Marketing feed]  [+ New source]   │ Profile · Doctor
└─────────────────────────────────────────────────────────────┘
```

- Topic-source tabs prefixed with `⛯` (or no icon — typography wins). Viral-source tabs prefixed with `⚡`. Use small letter prefixes (`T` / `V`) inside a pill if we avoid lucide icons per DESIGN.md.
- `+ New source` opens a modal with `kind` picker.
- `Profile` and `Doctor` move to the right side of the bar as text links — secondary surfaces. Profile route stays `/profile`.
- Routes: `/sources/:id` (and legacy `/posts`, `/generate` redirect to the most-recent source or to `/profile` if none).
- Empty state (no sources): full-bleed empty card "Create your first source. Topic source for researched takes. Viral source for feed-inspired posts." with two primary buttons.

### 6.2 Source view (single content area, two-column 320px + main per DESIGN.md)

Sticky sidebar = the source's config form (collapsible). Main column = research/feed artifact + drafts list.

**Topic source view:**

```
┌─ SIDE (sticky 320px) ──────┬─ MAIN ────────────────────────────────┐
│ Config (▼ collapse)        │ Research                              │
│  Name                      │  ⌛ Last run: 2h ago · $0.07 · 12 links │
│  Angle                     │  [▼] Summaries (5 bullets)            │
│  Seed notes                │  [▼] Facts (8 bullets w/ [n] refs)    │
│  ☑ Use tweet-sample voice  │  [▼] Sources (12 links)               │
│  [Save]  [Delete]          │  ────────────────────────────────────  │
│                            │ Drafts (8)                            │
│ [Run research] (primary)   │  ┌ post card ─────────────────────┐   │
│ [Generate 5 posts] (accent)│  │ ...                            │   │
│                            │  └────────────────────────────────┘   │
└────────────────────────────┴───────────────────────────────────────┘
```

**Viral source view:**

```
┌─ SIDE ─────────────────────┬─ MAIN ────────────────────────────────┐
│ Config                     │ Viral feed (latest)                   │
│  Name                      │  X of N selected · click to toggle    │
│  Filter (e.g. "AI agents") │  ┌ feed-post tile ────────┐ (selected)│
│  Resource: home ▾          │  └────────────────────────┘            │
│  Limit: 40                 │  ... more tiles ...                    │
│  [Save]  [Delete]          │  ────────────────────────────────────  │
│                            │ Drafts (4)                            │
│ [Fetch viral feed] (prim)  │  ... post cards ...                   │
│ [Generate from selected]   │                                       │
│   (accent) — needs 1+ sel  │                                       │
└────────────────────────────┴───────────────────────────────────────┘
```

The Eigen chat dock stays exactly where it is (bottom-fixed, full-width). No change.

### 6.3 HTML/JS strings to delete vs. keep

In `html()` (line 892+):

| String | Action |
|---|---|
| `CSS` | **Keep**; add ~30 lines for source-tab strip + research panels + collapsible config card. No new colors. |
| `HEADER` | **Rewrite**. Source tabs are dynamic now, rendered by JS into a `<div id="source-tabs">` slot inside the header. |
| `SIDEBAR_POSTS` | Already empty — delete. |
| `SIDEBAR_GEN` | **Delete**. Replaced by `SIDEBAR_SOURCE` (rendered dynamically per active source). |
| `CONTENT_GEN` | **Delete**. Replaced by `CONTENT_SOURCE` template strings: `TOPIC_VIEW_HTML` + `VIRAL_VIEW_HTML`. |
| `CHAT_DOCK` | **Keep, untouched.** |
| `JS` | **Substantial rewrite**: state shape `{ sources, activeSourceId, posts, profileSnapshots, chat… }`. Routing on `/sources/:id`. Functions: `loadSources`, `renderTabs`, `renderActiveSource`, `renderTopicView`, `renderViralView`, `runResearch`, `viralFetch`, `generate`. Keep `renderPosts` but it now filters by `activeSourceId` and renders inside the source view (not on a top-level posts page). |
| The `gen-side`, `gen-dir-view`, `gen-feed-view` IDs | **Removed.** |

`/profile` route stays a dedicated page, rendered by the existing `renderProfile()` — light edits to read sources from the new model. No top-level "Posts" page; if a user has zero sources, the empty state covers it.

### 6.4 New UI behaviors worth calling out

- **Config form is collapsible**, collapsed by default once a source has at least one draft. State stored in `localStorage` keyed by `source.id`.
- **"Run research" button** shows `Researching… (45s typical)` and disables. On completion, the research panel expands automatically and `setStatus("Research done · $X · Yms","success")` posts the cost+latency to the status bar.
- **"Generate" button** is disabled until: topic source has either research OR seed notes; viral source has at least one selected feed post.
- **Drafts** within a source view group by status: `draft` (top) → `rewrite_requested` → `posted` (collapsed by default).
- **Cost transparency** — every LLM call's `costUsd` is shown in the status bar in mono font. Sum across the session shown next to the brand mark? No — that's polish; cut. Per-call is enough.

---

## 7. Implementation order

Do this in the order below to keep `npm run dev` working at every step.

1. **Migration + types** (touch: `readStore`, lines 26–47; add new type-shaped objects). Add `s.sources`, run forward migration. Confirm `xsquared list` still works.
2. **New helper functions**, added between `analyzeWritingProfile` (line 324) and `learnProfile` (326):
   - `callClaude`, `extractFencedJson`, `summarizeProfileForPrompt`, `buildResearchPrompt`, `buildTopicGenPrompt`, `buildViralGenPrompt`, `callLlmForDrafts`, `runResearch`, `generateForSource`, `adaptTopicToDirection`, `viralFetch`.
3. **Source CRUD functions**, replacing `saveDirection`/`updateDirection`/`deleteDirection` (lines 591–628):
   - `createSource`, `updateSource`, `deleteSource`, `getSource`, `listSources`. Old `direction*` functions can stay during transition as thin wrappers that proxy to source equivalents with `kind:"topic"`; remove once UI is fully migrated.
4. **HTTP routes** (lines 1107–1219):
   - Add the new `/api/sources*` block.
   - Map `/api/directions*` and `/api/generate/*` to 410 Gone responses with `{ error: "moved to /api/sources/:id/..." }`.
   - Add `/sources/:id` to the HTML route list so the SPA serves index for deep links.
5. **CLI** (lines 1234–1325):
   - Add `sources`, `source-new`, `source-edit`, `source-delete`, `research`, `viral-fetch` commands.
   - Update `generate` to require `--source-id` (with deprecation fallback).
   - Update help text.
6. **Frontend (HTML/CSS/JS)** in `html()`:
   - Add CSS for source tabs, collapsible config, research panel, link list.
   - Replace `HEADER`, delete `SIDEBAR_GEN`/`CONTENT_GEN`, add `TOPIC_VIEW_HTML`, `VIRAL_VIEW_HTML`, `SOURCE_EMPTY_HTML`, `NEW_SOURCE_MODAL_HTML`.
   - Rewrite the JS state machine. Keep `renderPosts` logic for the per-source drafts list. Keep all chat/profile JS as-is.
7. **DELETE the removed code**:
   - `saveDirection`, `updateDirection`, `deleteDirection` (591–628) once migration step (3) wrappers are gone.
   - `generatePosts`, `generateFromFeed`, `generateFromDirection` (525–779) — replaced by `generateForSource`. **However:** keep `makeDirectionTexts` and `makeFeedInspiredTexts` (the template generators) as the LLM fallback.
   - `fetchFeedSnapshot` (554) — superseded by `viralFetch` (which is just it under a new name, attaching the result to a source).
8. **Preserve the in-flight changes** that are currently dirty in `src/xsquared.ts`:
   - `deletePost` (lines 831–840) — keep verbatim.
   - `postToX` `--json`/`transport.ok` logic (lines 849–867) — keep verbatim.
   The implementer must `git stash list` / `git diff` first and rebase on top of those edits, not overwrite them.
9. **Smoke test checklist** (manually run after each step):
   - `npm run dev`, hit `http://127.0.0.1:3888/sources/<id>` for a migrated topic.
   - `xsquared sources --json` lists migrated rows.
   - Create a fresh topic source, click Run research, see research panel populate (~60s).
   - Click Generate → 5 drafts appear in the source view, with cost shown in status bar.
   - Click Post on a draft → existing posting flow still works.
   - With `XSQUARED_DISABLE_LLM=1`, Generate still works (template fallback).
   - Eigen chat dock still sends/receives.
10. **README + docs**: append "Sources" section + a one-liner about the `XSQUARED_CLAUDE_MODEL` / `XSQUARED_RESEARCH_BUDGET_USD` env vars.

---

## 8. Open questions — decisions made

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Default model — Opus or Sonnet? | **Sonnet.** | Opus is $0.29/call even for a 3-token reply because of the full Claude Code system prompt. Sonnet is $0.06. Quality is fine for tweet drafts. Override via `XSQUARED_CLAUDE_MODEL`. |
| 2 | Should research run automatically on source create? | **No.** | Costs money. User must click. We do auto-suggest "Run research" with a callout above the Generate button if no research exists. |
| 3 | Should the Eigen chat dock be replaced with a per-source chat? | **No** (this pass). | Out of scope. Eigen routes to a configured OpenClaw session; replacing it would mean wiring `claude -p` chat history per source, plus a much bigger UI change. File a separate plan. |
| 4 | What about `strategy.contentArea`? | **Deprecate in UI, keep in store.** | The "posting area" is now per-source. Strategy stays read/writeable via CLI (`xsquared strategy-set`) but the dashboard stops showing it. |
| 5 | Posts grouped by source or flat list? | **Per-source view only.** | The point of the refactor is sources-as-tabs. Flat "all drafts" is a future power-user feature; for now `xsquared list` covers it from the CLI. |
| 6 | What if user has zero sources after migration? | **Show empty state with "Create source" CTA.** | Migration auto-creates topic sources from `directions`, so existing users won't see this. Fresh installs do. |
| 7 | What if `claude` is missing at runtime? | **Graceful fallback to templates + status-bar warning.** | `XSQUARED_DISABLE_LLM=1` env override gives the same path explicitly. `doctor` reports `claude` presence/version. |
| 8 | Research artifact retention — do we keep history? | **Only the latest research per source.** | Re-running overwrites `source.research`. If the user wants history, they can copy the JSON out before re-running. (Open follow-up: archive prior research in a `source.researchHistory[]` capped at 3, if desired later.) |
| 9 | Orphan drafts after source delete | **Keep drafts, null the `sourceId`.** | Drafts represent user labor. Surfacing them in a future "Unassigned" tab is trivial. |
| 10 | Tab overflow when user has 8+ sources | **Horizontal scroll on the tab strip.** | DESIGN.md says minimal — no dropdown chrome, no tab-overflow menu. Add `overflow-x:auto; scroll-snap-type: x mandatory` on the tab row. |
| 11 | Do we cache cache-creation tokens by reusing one Claude session? | **Not now.** | `--no-session-persistence` keeps things stateless. Reusing a session id would chop cost ~50% but adds complexity. Track in a follow-up. |

---

## 9. Risks the implementer should know

- **Latency.** Research is 30–90s. Generation is 3–10s. The dashboard must show "in flight" state at the button, not in the page status bar alone (per CLAUDE.md UX rules — feedback at the point of interaction).
- **Cost.** Each LLM call is logged to console + returned in the response body. If we ever expose this to a non-trusted environment, throw a hard `XSQUARED_DAILY_BUDGET_USD` ceiling. For now: caveat in README.
- **Claude OAuth dependency.** The user's `claude` CLI is OAuth-authenticated. If the token expires the call fails. `doctor` should call `claude -p --output-format json "ok"` with a 10s timeout and report ok/cost so the user sees the breakage immediately, not at generation time. Add this check.
- **Prompt injection from viral posts.** A viral tweet could contain `IGNORE PREVIOUS INSTRUCTIONS…`. We wrap inspiration posts in `[N] @author: …` tags and put rules *after* the inspirations in the prompt to reduce, but not eliminate, the risk. Don't ship without review.
- **Store size growth.** Research artifacts include raw LLM output (~10kb each) plus links. Cap `raw` at 20kb on write to avoid runaway store.json.
- **The migration is one-way.** Once `version: 2` is written, rolling back to old code means restoring `store.json` from backup. Add a `store.backup.json` write inside the migration block before mutating.
