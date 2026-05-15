---
name: xsquared
description: Create, rewrite, review, and publish X posts through xsquared using Birdclaw trend/context analysis and a local dashboard. Use when the user asks for X/Twitter content, tweet drafts, trend-based posts, rewrite/improve xsquared drafts, or posting through Birdclaw.
---

# xsquared

Use xsquared to create X content from Birdclaw context plus the user's topic or objective.

## Guardrails

- Do not publish to X without explicit user approval or a direct user click in the dashboard.
- Treat node scripts/xsquared.mjs post <id> as an external publishing action.
- Drafting, listing, rewriting, and opening the local dashboard are safe internal work.
- If Birdclaw auth is missing, keep drafting and report that posting is blocked by Birdclaw auth.

## Paths

From this skill file, the plugin root is ../..

Core script:

    node scripts/xsquared.mjs

Draft store:

    .xsquared/store.json

## Standard Workflow

1. Check setup:

    node scripts/xsquared.mjs doctor

2. Gather trend/context signal. If the user gave a topic, include it:

    node scripts/xsquared.mjs trends --topic "<topic>" --limit 40 --json

3. Generate 3-8 strong X post candidates. Prefer:

- One clear idea per post.
- Concrete claim or useful insight.
- No generic AI hype.
- No fake statistics or invented external facts.
- Native X style: short first line, specific angle, optional crisp punchline.
- Avoid hashtags unless the topic strongly benefits.

4. Save candidates:

    node scripts/xsquared.mjs save --topic "<topic>" --angle "<angle>" --score <1-100> --text "<post text>"

For batches, write JSON to a temp file and import:

    node scripts/xsquared.mjs import-json /tmp/xsquared-posts.json

The JSON can be either an array of posts or { "posts": [...] } where each post has text, and optional topic, angle, score, notes, and source.

5. Show the dashboard when useful:

    node scripts/xsquared.mjs dashboard

## Rewrite Workflow

When the user asks to rewrite or improve:

1. Find the target post with:

    node scripts/xsquared.mjs list --json

2. Rewrite the selected post in OpenClaw.
3. Update it:

    node scripts/xsquared.mjs update <post-id> --text "<new text>" --notes "<what changed>"

4. If dashboard rewrite requests exist, inspect them:

    node scripts/xsquared.mjs rewrite-requests --json

## Posting

Only post after explicit approval:

    node scripts/xsquared.mjs post <post-id>

Posting uses birdclaw compose post with the selected post text. Default Birdclaw account is acct_primary.
