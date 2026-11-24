---
name: poe-discovery
description: "Run a time-boxed PoE 1 3.30 research session: pick an open question from the ledger, predict, let local code and the pinned PoB engine compute, record the result. Use for autonomous theorycrafting, mechanic research or calibration, not for answering a single lookup."
---

Division of labour: local code, the databases and PoB do every enumeration, calculation, comparison and storage step. The model chooses the question, states hypotheses and predictions, and interprets results the tools cannot classify. Never compute damage, defenses or tree paths by hand, never re-derive what a command returns, never keep findings only in chat.

1. Start: `node poe-db/scripts/agent.mjs bootstrap` (block `lab`), then `lab stats` and `lab bench stats`. Pick one question: an open hypothesis, a principle to re-verify, a failed benchmark pattern, or a gap from `poe-db/docs/ROADMAP.md`. Budget the session (for example 60 min, a few hundred engine runs) and stop at the budget.
2. Before any calculation write the hypothesis and a falsifiable prediction: `lab add --type hypothesis --title ... --test-plan ...`, `lab predict <id> --metric dps --direction decrease --magnitude N`. For calibration on a build you have not analysed use `lab bench new <xml>` and `lab bench predict` before `lab bench score`.

Learning from ready builds: add builds with `corpus add-url|add-list|add --code` (links the user chose; never crawl Maxroll, YouTube, forums or the poe.ninja builds API), run `corpus ablate-all` and `corpus learn`, read `corpus insights` before forming hypotheses about what carries a build, and test them on held-out builds.

3. Compute with existing tools only: `analyze ablate` (core vs replaceable; passive nodes through PoB's own removeNodes comparison), `analyze interactions` (synergy/overlap), `analyze candidates|upgrades --auto`, `analyze nodes|stats`, `analyze encounter|report`, `build card`. Read `--help` of the group instead of guessing options. If a needed operation is missing, prefer a PoB function (calculator overrides, item/skill/tree tabs) over a new local model; a new model must be labelled `approximation` and kept apart from PoB numbers.
4. Record: `lab import ablation|interactions <json>`, `lab resolve` with the actual number (do not edit the prediction), `lab evidence`, `lab status` through the gates. Store failed ideas as `failure` with the reason; a negative result is a result.
5. Promote nothing because it looks plausible or popular: `generalized` needs two builds and stated conditions; `game_verified` needs an `observe` entry from the user.
6. End: update `poe-db/docs/HANDOFF.md` with one short item (question, records created, outcome, next question). Keep the ledger the source of truth; the handoff only points to it.
