# Design System — xsquared

## Product Context
- **What this is:** OpenClaw plugin for creating, reviewing, and publishing high-quality X posts from local Birdclaw context.
- **Who it's for:** Indie hackers, founders, and operators who post on X as part of their work.
- **Space/industry:** Local-first builder tools / social composition.
- **Project type:** TypeScript CLI + local web dashboard (the dashboard is the primary surface).

## Memorable Thing
A serious tool that respects the operator's time. Reads like a well-typeset notebook, not a SaaS dashboard. Every design decision should serve this.

## Aesthetic Direction
- **Direction:** Brutally Minimal + light editorial touch.
- **Decoration level:** minimal — typography does the work.
- **Mood:** Warm paper, deep ink, hairline rules, generous whitespace. Builder magazine, not enterprise dashboard.
- **No:** gradients, rounded-everything, decorative blobs, stock-photo heroes, purple accents, 3-column icon grids.

## Typography
- **Display/Hero:** **Fraunces** 500–600 (variable serif) — editorial character; signals thought, not "shipped fast."
- **Body / UI / Labels:** **Geist Sans** 400 / 500 — builder-grade grotesque.
- **Data / Tables:** Geist Sans with `font-feature-settings: "tnum"` for aligned metric grids.
- **Code / Mono:** **Geist Mono** — timestamps, post IDs, JSON dumps.
- **Loading:**
  - Geist Sans + Geist Mono: `https://vercel.com/font` (self-hosted via `@vercel/fonts`) or Google Fonts.
  - Fraunces: Google Fonts variable axis `wght@400..700,SOFT@0..100,WONK@0..1`.
- **Scale (modular ~1.2):** 12 / 14 / 16 / 20 / 24 / 32 / 44 px.
  - body: 14
  - panel headings: 16
  - section headings (Fraunces): 20–24
  - page H1 (Fraunces): 32–44
  - meta / pill / label: 12

## Color
- **Approach:** Restrained — single accent + warm neutrals; color is rare and meaningful.

| Token       | Hex       | Use                                                |
|-------------|-----------|----------------------------------------------------|
| `--bg`      | `#FAFAF7` | Page background (warm paper)                       |
| `--panel`   | `#FFFFFF` | Cards, inputs, post tiles                          |
| `--ink`     | `#0A0A0A` | Primary text, primary button background            |
| `--muted`   | `#6B6B6B` | Secondary text, labels, meta                       |
| `--line`    | `#E5E4DE` | Borders, dividers                                  |
| `--accent`  | `#B8542A` | Single action color — links, focus rings, key CTAs |
| `--success` | `#15803d` | Posted state                                       |
| `--error`   | `#B42318` | Failure state                                      |
| `--info`    | `#1F4E8C` | Neutral info banner (rare)                         |
| `--warning` | `#8A5A00` | Soft warning (rare)                                |

- **Dark mode:** invert surfaces, do not just flip colors.
  - `--bg: #0E0E0C`, `--panel: #161614`, `--ink: #F5F5F0`, `--muted: #A3A3A0`, `--line: #2A2A26`.
  - Reduce accent saturation ~15%: `--accent: #A8542F`.

## Spacing
- **Base unit:** 4px.
- **Density:** comfortable.
- **Scale:** `2 / 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`.
- **Defaults:**
  - panel padding: 20 (was 14)
  - sidebar gap: 16
  - main grid gap: 24
  - post-card gap: 12

## Layout
- **Approach:** grid-disciplined.
- **Grid:** two-column dashboard — sticky 320px sidebar + flexible main column.
- **Max content width:** 1180px.
- **Border radius scale:** `sm: 4 / md: 6 / lg: 8 / pill: 9999`. Use the scale; do not flatten everything to one radius.
  - inputs / buttons: `sm` (4)
  - cards / panels: `md` (6)
  - pills / chips: `pill`
- **Breakpoint:** collapse to single column at `820px`.

## Motion
- **Approach:** minimal-functional. No entrance choreography. The drafts list does NOT animate in.
- **Easing:** `ease-out` (hover, enter), `ease-in` (exit), `ease-in-out` (move).
- **Duration:** micro 80ms (button press), short 150ms (hover/state), medium 220ms (modal/drawer). Nothing slower than 250ms.

## Iconography
- Stroke-based, 1.5px stroke at 16/20/24 px.
- No filled-color icons. No icons inside colored circles.
- Lucide or Phosphor (regular weight). Use sparingly — text labels win.

## Tone of Voice (UI copy)
- Builder-to-builder. Direct. Concrete nouns, active voice.
- No "Crafted for X" / "Designed for Y" patterns.
- Error messages say what broke and what to do, in that order. Two sentences max.

## Component Notes
- **Primary button:** `--ink` background, white text, radius `sm`, no shadow. Hover: subtle ink lighten.
- **Secondary button:** transparent, 1px `--line` border, ink text.
- **Inputs:** white panel, 1px `--line`, radius `sm`, focus ring `--accent` 2px outset (no glow).
- **Cards:** white panel, 1px `--line`, radius `md`, 20px padding.
- **Pills:** `--line` border, panel background, radius `pill`, 12px text.
- **Tables / metrics:** Geist Sans `tnum`; right-align numbers; row dividers in `--line`.

## Decisions Log
| Date       | Decision                                       | Rationale                                                                 |
|------------|------------------------------------------------|---------------------------------------------------------------------------|
| 2026-05-15 | Initial design system created                  | `/design-consultation` based on dashboard context, indie-builder audience |
| 2026-05-15 | Fraunces for display headings (RISK accepted)  | Differentiate from every other AI-app's all-grotesque stack               |
| 2026-05-15 | Terracotta `#B8542A` as accent (RISK accepted) | Printerly / magazine signal vs. SaaS-default Linear-blue                  |
| 2026-05-15 | 4px base spacing, 6px default card radius      | Tighter newspaper feel vs. current 7–8px everywhere                       |
