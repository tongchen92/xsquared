# xsquared

OpenClaw plugin for creating high-quality X posts from current Birdclaw context and user-defined topics.

xsquared is local-first:

- Birdclaw is used for X/Twitter local context and final posting.
- The CLI is written in TypeScript under src/ and compiled to dist/.
- Drafts, trend snapshots, writing-profile snapshots, and rewrite requests live under .xsquared/ in the plugin repo unless XSQUARED_HOME is set.
- Posting to X happens only when the user clicks the dashboard post button or runs the explicit post command.

Quick start:

    npm install
    npm run build
    npm run check
    npm run dashboard

Then open the dashboard URL printed by the command. Each source has its own routable tab:

    http://127.0.0.1:3888/sources           (most-recent source or empty state)
    http://127.0.0.1:3888/sources/<id>      (a specific topic or viral source)
    http://127.0.0.1:3888/profile

OpenClaw workflow:

- Create a new topic source for AI agents and run research.
- Generate 5 posts from the AI agents source.
- Rewrite the newest xsquared draft.
- Open the xsquared dashboard.

Sources, the new content model:

- A **topic source** has an angle + seed notes. Run `research` to call `claude -p` with WebSearch/WebFetch and produce a research artifact (summaries + facts + links + cost). Then `generate` produces 5 LLM-drafted posts grounded in the research.
- A **viral source** has a filter (e.g. "AI agents"), a Birdclaw resource (home / following / for-you), and a limit. Run `viral-fetch` to pull the current feed; select 1 or more posts; then `generate` produces one LLM-drafted reply-style post per selection.
- Both flows fall back to local template generation when the `claude` CLI is missing or `XSQUARED_DISABLE_LLM=1` is set.

CLI:

    npm run build
    node dist/xsquared.js doctor                                       # checks birdclaw + claude
    node dist/xsquared.js sources                                      # list sources
    node dist/xsquared.js source-new --kind topic --name "AI agents" --angle "..." --notes "..."
    node dist/xsquared.js source-new --kind viral --name "AI feed" --filter "AI agents"
    node dist/xsquared.js research <source-id>                         # LLM research, ~30-90s
    node dist/xsquared.js viral-fetch <source-id>                      # pull viral feed
    node dist/xsquared.js generate <source-id> --count 5               # 5 LLM drafts
    node dist/xsquared.js generate <source-id> --selected id1,id2      # viral: only these
    node dist/xsquared.js list [--source <source-id>] [--json]
    node dist/xsquared.js post <post-id>
    node dist/xsquared.js profile-learn --handle "@therealtongchen"
    node dist/xsquared.js dashboard --port 3888

Env vars for the LLM pipeline:

- `XSQUARED_CLAUDE_MODEL` (default `sonnet`) — model alias passed to `claude -p`.
- `XSQUARED_RESEARCH_BUDGET_USD` (default `0.50`) — max budget per research call.
- `XSQUARED_GENERATE_BUDGET_USD` (default `0.50`) — max budget per generation call.
- `XSQUARED_DISABLE_LLM=1` — force the template fallback (offline / cost-free).
- `XSQUARED_CLAUDE_BIN` — override the `claude` binary path.

The Posts tab groups drafts by Topic and Trending. It supports editing drafts, recording rewrite requests for OpenClaw, inspecting what xsquared has learned about your writing style, and posting approved drafts through birdclaw compose post.

The sidebar includes an Eigen chat panel. It auto-detects the latest OpenClaw Telegram topic session and sends messages back into that session with `openclaw agent --session-id`; the UI stores its local transcript in `.xsquared/store.json`.

The automatic content loop is intentionally simple for the first version:

1. Use Topic when you already know what you want to post about, such as "Google Ads for small business".
2. Use Trending when you want xsquared to pull relevant feed posts and help recreate your version of what is working.
3. xsquared combines the selected source with the latest writing-profile snapshot.
   Topic generation uses learned tweet samples for voice by default unless that source is explicitly turned off.
4. It saves draft posts locally for review and rewrite.

Profile learning runs automatically when the dashboard loads profile data. xsquared first checks Birdclaw's local authored-tweet store, then falls back to Bird's profile timeline fetch for `@therealtongchen` when local authored tweets are empty.

Persistence: xsquared stores generated drafts, topics, source snapshots, rewrite requests, and learned profile snapshots locally in `.xsquared/store.json` by default. Set `XSQUARED_HOME` to move that app-data directory. Bird/Birdclaw source history is read from the local Birdclaw/Bird setup, including `~/.birdclaw`.

Privacy: xsquared does not send data to X unless a post action is explicitly triggered.

Terms: Use at your own risk. Review content before publishing.
