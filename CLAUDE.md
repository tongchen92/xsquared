## gstack (REQUIRED — global install)

**Before doing ANY work, verify gstack is installed:**

```bash
test -d ~/.claude/skills/gstack/bin && echo "GSTACK_OK" || echo "GSTACK_MISSING"
```

If GSTACK_MISSING: STOP. Do not proceed. Tell the user:

> gstack is required for all AI-assisted work in this repo.
> Install it:
> ```bash
> git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
> cd ~/.claude/skills/gstack && ./setup --team
> ```
> Then restart your AI coding tool.

Do not skip skills, ignore gstack errors, or work around missing gstack.

Using gstack skills: After install, skills like /qa, /ship, /review, /investigate,
and /browse are available. Use /browse for all web browsing.
Use ~/.claude/skills/gstack/... for gstack file paths (the global path).

## Engineering Execution Standard

**Surgical, verified, minimum-change engineering.** Make the smallest scoped change that solves the real problem, verify it, and do not disturb anything else.

- **Understand before changing.** Inspect the relevant code, current state, and failure mode before editing.
- **State material assumptions.** If ambiguity changes the implementation, risk, or user-visible behavior, clarify before acting.
- **Prefer the smallest correct change.** No speculative features, premature abstractions, or unrelated "while I'm here" refactors.
- **Scope cleanup tightly.** Match existing style. Clean up only mess introduced by the change. Mention unrelated issues; do not silently fix them.
- **Make success verifiable.** For bugs, reproduce when practical. For features, define expected behavior. Run the narrowest meaningful validation, then broader checks if risk warrants.
- **Protect high-risk boundaries.** Before destructive, public, production, billing, credential, or communication side effects: verify actor, target, scope, approval, blast radius, and resulting state.
- **Leave the system easier to operate.** If the workflow recurs or the bug pattern is reusable, encode it as a test, guardrail, skill, or automation.

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.
