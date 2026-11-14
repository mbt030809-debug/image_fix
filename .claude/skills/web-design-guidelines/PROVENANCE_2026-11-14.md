# Provenance: web-design-guidelines

- Installed: 2026-11-14 (by an agent, after manual vetting)
- Skill source: https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines (skill version 1.0.0)
  - Commit: vercel-labs/agent-skills @ 1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62 (2026-10-27)
- Rules source (vendored): https://github.com/vercel-labs/web-interface-guidelines
  - Commit: vercel-labs/web-interface-guidelines @ 434b7f91364665f2f733b310ec54809bf8f37937 (2026-10-05)
  - `command.md` = upstream `command.md` (verbatim); `guidelines.md` = upstream `README.md` (verbatim).
- License: MIT. `LICENSE` is the web-interface-guidelines license (Copyright (c) 2025 Vercel Labs). The agent-skills README also states "MIT" (that repo has no LICENSE file).
- Modifications: `SKILL.md` rewritten. Upstream instructs the agent to WebFetch `https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md` on every review. That is a runtime network dependency (and the rules could change under us), so this copy reads the vendored local `command.md` instead. Everything else is verbatim.
- Vetting: text only, no scripts. The only network reference was the runtime fetch above (removed). Scanned for pipe-to-shell, base64/eval, exfiltration wording, prompt-override phrases and invisible/bidi Unicode: nothing found.
- Not applicable to this project: React/Next.js-specific rules (hydration, `<Link>`, nuqs, `suppressHydrationWarning`); advice to `preconnect` CDNs.
