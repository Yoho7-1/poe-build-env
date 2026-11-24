---
name: poe-build-design
description: Design a new PoE 1 3.30 Softcore build using the local data, mechanics cards and PoB engine; use for choosing an architecture and planning progression, not just looking up an item.
---

Run `node poe-db/scripts/agent.mjs bootstrap` from the project root. Unknown user preferences remain unknown. Ask only for constraints that affect the pending choice; independent research can continue.

Read [the design procedure](../../../poe-db/docs/BUILDING.md) when constructing a candidate. Retrieve individual mechanics with `agent.mjs mechanic get <id> --related`, then query only relevant entities. Consult `availability` before making an item mandatory. For a required rare item, check crafting feasibility with `agent.mjs craftsim` (start with `coverage`); unpublished odds need an explicit `assume`, and a simulated success rate is not acquisition proof.

Build a causal explanation: skill behaviour → applicable scaling → resource supply → defensive layers → equipment and passive-point costs. Record competing hypotheses and why a candidate is selected or rejected. Evaluate realistic intermediate stages before calling the endgame plan viable: `agent.mjs analyze progression <xml> --md f.md` checks every tree/item/skill set against enemies of its area level (resist penalty, requirements, sustain); `analyze report` covers maps and bosses. When the user reports in-game results, store them with `agent.mjs observe add <build-id>` and compare with predictions via `observe compare`.

Keep research state in the ledger, not in chat: before a test record the hypothesis and its prediction (`agent.mjs lab add --type hypothesis ...`, `lab predict <id> --metric dps --direction decrease --magnitude N`), after it `lab resolve` with the actual number and `lab evidence`; store analysis outputs with `lab import ablation`. Never edit a prediction after its outcome. Promote principles only through `lab status` gates (two builds and stated conditions for `generalized`); record rejected candidates as `failure` with the reason. Before judging which parts of a reference build are essential, run `analyze ablate <xml>`.

Use the pinned PoB adapter for numerical comparisons. Preserve engine warnings, unsupported modifiers, conditions and scenario differences. Synthetic controls and old references are teaching evidence, not ready player builds.

Persist accepted decisions with evidence and update `builds/<id>/build.json` through the CLI revision guard. Store calculations with `build calculate`. Read the current revision immediately before mutation. Keep the handoff compact: decisions, open questions and next concrete test.
