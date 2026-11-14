# Provenance: ui-ux-pro-max (trimmed, script-free variant)

- Installed: 2026-11-14 (by an agent, after manual vetting)
- Source: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill (`.claude/skills/ui-ux-pro-max`), package version 2.15.0
- Commit: nextlevelbuilder/ui-ux-pro-max-skill @ 6ae86f61f520d6ca229d2f40e070410638c908c5 (2026-11-10)
- License: MIT, Copyright (c) 2024 Next Level Builder (see `LICENSE`)
- Copied verbatim: `references/pro-rules.md`, `references/quick-reference.md`, `data/ux-guidelines.csv`, `data/app-interface.csv`, `data/colors.csv`, `data/styles.csv`, `data/ui-reasoning.csv`, `data/motion.csv`, `data/icons.csv`
- Modified: `SKILL.md` rewritten. The upstream workflow runs `python .../scripts/search.py` (Python CLI). Scripts were deliberately NOT installed (policy: no executables from downloads) so the workflow was replaced by direct Grep/Read lookups of the CSV files. The Design Dials, `--persist`, stack and RTL sections were dropped with the script.
- NOT installed: `scripts/` (search.py, core.py, design_system.py, validate_data.py, tests), `data/typography.csv` (every row imports Google Fonts from fonts.googleapis.com), `data/google-fonts.csv`, `data/google-font-licenses.json`, `data/phosphor-icons-upstream.json`, `data/landing.csv`, `data/products.csv`, `data/charts.csv`, `data/react-performance.csv`, `data/stacks/*.csv`, `data/data-provenance.json`. Reasons: network/CDN dependency, irrelevant stacks, or size.
- Vetting: no instructions to exfiltrate, no pipe-to-shell, no prompt-override text, no invisible/bidi Unicode in SKILL.md, references or the CSVs kept. The upstream SKILL.md itself states it "does not install packages, modify the operating system" and treats results as recommendations only.
- Offline caveats in kept data: `icons.csv` has an `Import Code` column (npm icon-package imports) and `motion.csv` has a `GSAP Snippet` column (GSAP via npm/CDN). Use the names and the Do/Don't text; inline SVG and CSS transitions instead.
