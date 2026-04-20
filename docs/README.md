# Cassidy — Documentation Index

Cassidy is both a Microsoft Agent Framework Teams bot and an autonomous CorpGen-style digital employee. The top-level [README.md](../README.md) is the entry point; the documents below go deeper on individual surfaces.

| Document | What it covers |
|---|---|
| [../README.md](../README.md) | Project overview, architecture, environment, deployment, API endpoints, troubleshooting. |
| [../CHANGELOG.md](../CHANGELOG.md) | Dated release notes for every deploy. |
| [CORPGEN.md](CORPGEN.md) | Deep dive on Cassidy's CorpGen implementation — paper-concept mapping, workday lifecycle, multi-day / organisation runs, HTTP and LLM-tool surfaces, faithful-vs-extension status, operator runbook. |
| [../TESTING_CORPGEN.md](../TESTING_CORPGEN.md) | Local + post-deploy regression matrix for the CorpGen runtime (build, lint, vitest, health, feature smokes). |
| [../TESTING_CORPGEN_LIVE.md](../TESTING_CORPGEN_LIVE.md) | Live operator handoff — single, multi-day, organisation, and async-jobbed smoke procedures against the running webapp. |
| [../TESTING.md](../TESTING.md) | End-user / Teams scenario walkthroughs for the broader Cassidy bot (calendar, planner, ops report, etc.). |
| [../SKILL.md](../SKILL.md) | End-to-end deployment skill for Microsoft Agent 365 — Entra registration, `a365 setup`, `a365 deploy`, `a365 publish`, error catalogue. |

The CorpGen module also has internal docs at [../cassidy/src/corpgen/README.md](../cassidy/src/corpgen/README.md). Those describe the module's own files and ablation knobs and are intended for contributors editing the runtime itself.
