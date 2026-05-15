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

Then open the dashboard URL printed by the command.

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
    node dist/xsquared.js profile-learn --handle "@tongchen92" --limit 200
    node dist/xsquared.js profile --json
    node dist/xsquared.js save --topic "AI agents" --angle "operator leverage" --text "..."
    node dist/xsquared.js list
    node dist/xsquared.js dashboard --port 3888
    node dist/xsquared.js post <post-id>

The dashboard supports setting a posting area, analyzing trends for that area, generating draft candidates, editing drafts, recording rewrite requests for OpenClaw, inspecting what xsquared has learned about your writing style, and posting approved drafts through birdclaw compose post.

The automatic content loop is intentionally simple for the first version:

1. Save a posting area, such as "Google Ads for small business".
2. xsquared asks Birdclaw for current local X trend/context around that area.
3. xsquared combines the trend terms with the latest writing-profile snapshot.
4. It saves draft posts locally for review and rewrite.

Profile learning uses Birdclaw's local authored-tweet store. If the Profile tab shows zero tweets, import your X archive into Birdclaw or run Birdclaw authored sync first, then click Learn Profile again.

Privacy: xsquared stores generated content locally in .xsquared/store.json by default. It does not send data to X unless a post action is explicitly triggered.

Terms: Use at your own risk. Review content before publishing.
