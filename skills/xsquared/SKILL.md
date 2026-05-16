---
name: xsquared
description: Create, rewrite, review, and publish X posts through xsquared using Birdclaw trend/context analysis and a local dashboard. Use when the user asks for X/Twitter content, tweet drafts, trend-based posts, rewrite/improve xsquared drafts, or posting through Birdclaw.
---

# xsquared

Use xsquared to create X content from either user-defined topics or trending/feed posts that are relevant enough to adapt.

## Guardrails

- Do not publish to X without explicit user approval or a direct user click in the dashboard.
- Treat node dist/xsquared.js post <id> as an external publishing action.
- Drafting, listing, rewriting, and opening the local dashboard are safe internal work.
- If Birdclaw auth is missing, keep drafting and report that posting is blocked by Birdclaw auth.

## Paths

From this skill file, the plugin root is ../..

Core script:

    npm run build
    node dist/xsquared.js

Draft/profile store:

    .xsquared/store.json

The dashboard routes are:

    /posts
    /generate
    /profile

Generated drafts, topics, feed/source snapshots, rewrite requests, and learned profile snapshots persist in `.xsquared/store.json` unless `XSQUARED_HOME` is set. Bird/Birdclaw source history lives in the local Birdclaw/Bird setup, including `~/.birdclaw`.

The dashboard sidebar has an Eigen chat panel. It auto-detects a recent OpenClaw Telegram topic session and uses `openclaw agent --session-id` so the user can chat from the local UI. The local UI transcript is stored in `.xsquared/store.json`.

## Standard Workflow

1. Check setup:

    npm run check

2. Choose the source:

- Topic: the user defines one or many topics and reviews drafts created for that topic.
- Trending: xsquared pulls viral/relevant feed posts and creates the user's version of selected posts.

Topic sources use learned tweet samples for voice by default. Only turn that off when the user explicitly wants generic or off-profile drafts.

3. Save or inspect the user's posting area when they provide one:

    npm run build
    node dist/xsquared.js strategy-set --area "<area>" --json
    node dist/xsquared.js strategy --json

For example: Google Ads for small business.

4. Gather trend/context signal. If the user gave a topic, include it:

    node dist/xsquared.js trends --topic "<topic>" --limit 40 --json

For automated viral-feed drafting:

    node dist/xsquared.js auto-draft [source-id] --max-drafts 3 --min-score 75 --json

This fetches the viral feed, ranks relevance/newsworthiness, dedupes source posts already used as inspiration, and creates local drafts only. It does not post to X.

Auto-draft production gates:

- Viral source must have a filter or relevance focus.
- DeepSeek ranking must succeed; local heuristic ranker output is not trusted for auto-drafting unless \`XSQUARED_ALLOW_LOCAL_RANK_AUTODRAFT=1\`.
- Generated drafts must pass grounding validation before storage.

Generated viral drafts are validated before storage:

    node dist/xsquared.js validate-draft <source-id> --text "<draft>" --json
    npm run validate:grounding

Reject unsupported product/workflow claims such as "can now", launch claims, "ready-to-post", "content plan", or automation claims unless grounded in the source post or explicit source context.

5. Learn the user's writing style. The dashboard does this automatically; run manually only when you need to force-refresh:

    node dist/xsquared.js profile-learn --handle "@therealtongchen" --limit 200 --json

xsquared first checks Birdclaw's local authored-tweet store, then falls back to Bird's profile timeline fetch when authored tweets are empty.

6. Generate 3-8 strong X post candidates:

    node dist/xsquared.js generate --area "<area>" --count 5 --json

Prefer:

- One clear idea per post.
- Concrete claim or useful insight.
- No generic AI hype.
- No fake statistics or invented external facts.
- Native X style: short first line, specific angle, optional crisp punchline.
- Avoid hashtags unless the topic strongly benefits.
- Match the latest profile snapshot's length, line-break, hashtag, link, and hook patterns when available.

7. Save manually generated candidates:

    node dist/xsquared.js save --topic "<topic>" --angle "<angle>" --score <1-100> --text "<post text>"

For batches, write JSON to a temp file and import:

    node dist/xsquared.js import-json /tmp/xsquared-posts.json

The JSON can be either an array of posts or { "posts": [...] } where each post has text, and optional topic, angle, score, notes, and source.

8. Show the dashboard when useful:

    npm run dashboard

## Rewrite Workflow

When the user asks to rewrite or improve:

1. Find the target post with:

    node dist/xsquared.js list --json

2. Rewrite the selected post in OpenClaw.
3. Update it:

    node dist/xsquared.js update <post-id> --text "<new text>" --notes "<what changed>"

4. If dashboard rewrite requests exist, inspect them:

    node dist/xsquared.js rewrite-requests --json

## Posting

Only post after explicit approval:

    node dist/xsquared.js post <post-id>

The dashboard posting button opens X's web composer intent URL with the selected post text prefilled. It does not publish server-side. If a draft has required media, the user must attach the generated/original image in X before posting. The CLI `post` command returns the same intent URL metadata.
