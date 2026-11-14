# Provenance: visual-design-foundations

- Installed: 2026-11-14 (by an agent, after manual vetting)
- Source: https://github.com/wshobson/agents/tree/main/plugins/ui-design/skills/visual-design-foundations
- Commit: wshobson/agents @ 9c61ab243def98f72da12abd41cfcf5bcd91af9d (2026-11-08)
- License: MIT, Copyright (c) 2024 Seth Hobson (see `LICENSE`)
- Modifications: one "Project note" blockquote added to `SKILL.md` (offline / vanilla / Korean-first). `references/*.md` are verbatim.
- Vetting: text only, no scripts. One scanner hit was a false positive (`RegExp.exec()` inside a contrast-checker code sample). No pipe-to-shell, exfiltration wording, prompt-override text or invisible Unicode.
- Offline caveats: examples use Inter (`/fonts/Inter.woff2`, `font-display: swap`), Tailwind config, React/TSX and an SVG-sprite build script. Inter and webfont loading are not used in this project; the SVG `<symbol>` sprite idea is (inline in index.html).
