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

## Standard Workflow

1. Check setup:

    npm run check

2. Choose the source:

- Topic: the user defines one or many topics and reviews drafts created for that topic.
- Trending: xsquared pulls viral/relevant feed posts and creates the user's version of selected posts.

3. Save or inspect the user's posting area when they provide one:

    npm run build
    node dist/xsquared.js strategy-set --area "<area>" --json
    node dist/xsquared.js strategy --json

For example: Google Ads for small business.

4. Gather trend/context signal. If the user gave a topic, include it:

    node dist/xsquared.js trends --topic "<topic>" --limit 40 --json

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

Posting uses birdclaw compose post with the selected post text. Default Birdclaw account is acct_primary.
