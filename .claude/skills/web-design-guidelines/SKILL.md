---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
metadata:
  author: vercel
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

# Web Interface Guidelines

Review files for compliance with Web Interface Guidelines.

> **Offline adaptation (modified from upstream; see PROVENANCE_2026-11-14.md).** The upstream skill
> fetches its rules from `raw.githubusercontent.com` with WebFetch on every review. This project is a
> fully offline WebView app, so the rules are vendored next to this file instead. Do NOT use WebFetch.
> Some rules are React/Next.js-specific (hydration, `<Link>`, nuqs): skip those; this project is vanilla JS.

## How It Works

1. Read `command.md` in this skill directory: the checklist and the terse output format.
2. For rationale and extra detail on any rule, read `guidelines.md` (long-form guidelines).
3. Read the specified files (or ask the user for a file/pattern).
4. Check against all rules in `command.md`.
5. Output findings in the terse `file:line` format described in `command.md`.

## Local rule files

| File | Content |
|---|---|
| `command.md` | Review rules grouped by Accessibility, Focus, Forms, Animation, Typography, Touch & Interaction, Safe Areas, Dark Mode, i18n, plus an anti-pattern list and the output format |
| `guidelines.md` | Long-form version with rationale (touch target sizes, 16px input font, tooltip timing, layered shadows, nested radii, APCA, etc.) |
| `LICENSE` | MIT, Copyright (c) 2025 Vercel Labs |

## Usage

When a user provides a file or pattern argument:
1. Read `command.md` (local).
2. Read the specified files.
3. Apply all rules from `command.md`.
4. Output findings using the format specified in `command.md`.

If no files specified, ask the user which files to review.
