# xsquared

OpenClaw plugin for creating high-quality X posts from current Birdclaw context and user-defined topics.

xsquared is local-first:

- Birdclaw is used for X/Twitter local context and final posting.
- Drafts, trend snapshots, and rewrite requests live under .xsquared/ in the plugin repo unless XSQUARED_HOME is set.
- Posting to X happens only when the user clicks the dashboard post button or runs the explicit post command.

Quick start:

    npm install
    npm run check
    npm run dashboard

Then open the dashboard URL printed by the command.

OpenClaw workflow:

- Generate 5 X posts about AI agents using xsquared.
- Rewrite the newest xsquared draft.
- Open the xsquared dashboard.

CLI:

    node scripts/xsquared.mjs doctor
    node scripts/xsquared.mjs trends --topic "AI agents" --limit 40
    node scripts/xsquared.mjs save --topic "AI agents" --angle "operator leverage" --text "..."
    node scripts/xsquared.mjs list
    node scripts/xsquared.mjs dashboard --port 3888
    node scripts/xsquared.mjs post <post-id>

The dashboard supports viewing generated posts, editing drafts, recording rewrite requests for OpenClaw, and posting approved drafts through birdclaw compose post.

Privacy: xsquared stores generated content locally in .xsquared/store.json by default. It does not send data to X unless a post action is explicitly triggered.

Terms: Use at your own risk. Review content before publishing.
