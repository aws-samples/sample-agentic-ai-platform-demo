# Platform Skill Library

Platform-curated **Agent Skills** following the [agentskills.io](https://agentskills.io)
open standard (the format used by Claude Code / the Claude Agent SDK). Each skill is a
directory with a `SKILL.md`:

```
platform-skills/
├── it-troubleshooting/SKILL.md
├── customer-support/SKILL.md
├── hr-policy/SKILL.md
└── data-analysis/SKILL.md
```

`SKILL.md` = YAML frontmatter (`name` + `description` that says both *what* the skill
does and *when* to use it) + a markdown body with the actual procedure.

## How they reach an agent

Skills use **progressive disclosure** — the opposite of stuffing everything into the
system prompt:

1. At startup only each skill's name + description is injected into the system prompt.
2. The agent activates a skill via the `skills` tool when the task matches, loading
   the full body on demand.

The wiring is the Strands `AgentSkills` vended plugin (`strands.vended_plugins.skills`).
The chat blueprint auto-discovers any `skills/<name>/SKILL.md` in its runtime directory;
the self-service console copies the SKILL.md directories a domain team selects into the
generated project. So the catalog entry, this library, and the deployed agent stay one
and the same artifact.

These are demo-grade skill bodies. The point they demonstrate: skills are **versioned,
platform-owned, reusable capability modules** — not prose pasted into each team's
system prompt.
