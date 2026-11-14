# Provenance: make-interfaces-feel-better

- Installed: 2026-11-14 (by an agent, after manual vetting)
- Source: https://github.com/jakubkrehel/make-interfaces-feel-better/tree/main/skills/make-interfaces-feel-better
- Commit: jakubkrehel/make-interfaces-feel-better @ 35545ea1512ad59fa463e6b1f95ca9c052981fe6 (2026-08-29)
- License: MIT, Copyright (c) 2026 Jakub Krehel (see `LICENSE`)
- Modifications: one "Project note" blockquote added to `SKILL.md`. The five reference files (animations, icons, performance, surfaces, typography) are verbatim. `agents/openai.yaml` (OpenAI display metadata) was not copied.
- Vetting: documentation-only skill, no scripts; no pipe-to-shell, exfiltration wording, prompt-override text or invisible Unicode. The only install commands mentioned are the upstream `npx skills add` line in the README (not copied).
- Caveats: examples use Tailwind and `motion`/`framer-motion` (npm); use the plain CSS variants. `oklch()` values need Android WebView 111+; the project brief uses hex.
