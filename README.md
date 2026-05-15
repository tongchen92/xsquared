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

Then open the dashboard URL printed by the command. Dashboard tabs are routable:

    http://127.0.0.1:3888/posts
    http://127.0.0.1:3888/generate
    http://127.0.0.1:3888/profile

OpenClaw workflow:

- Generate 5 X posts about AI agents using xsquared.
- Set my xsquared posting area to Google Ads for small business.
- Rewrite the newest xsquared draft.
- Open the xsquared dashboard.

CLI:

    npm run build
    node dist/xsquared.js doctor
    node dist/xsquared.js strategy-set --area "Google Ads for small business"
    node dist/xsquared.js trends --topic "AI agents" --limit 40
    node dist/xsquared.js generate --area "Google Ads for small business" --count 5
    node dist/xsquared.js profile-learn --handle "@therealtongchen" --limit 200
    node dist/xsquared.js profile --json
    node dist/xsquared.js save --topic "AI agents" --angle "operator leverage" --text "..."
    node dist/xsquared.js list
    node dist/xsquared.js dashboard --port 3888
    node dist/xsquared.js post <post-id>

The dashboard splits generation and review into two sources:

- Topic: define one or many topics, add angle/reference material, and generate posts for the selected topic.
- Trending: fetch viral or relevant feed posts, select the ones worth adapting, and generate your versions.

The Posts tab groups drafts by Topic and Trending. It supports editing drafts, recording rewrite requests for OpenClaw, inspecting what xsquared has learned about your writing style, and posting approved drafts through birdclaw compose post.

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
