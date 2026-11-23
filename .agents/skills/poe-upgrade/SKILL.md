---
name: poe-upgrade
description: Compare concrete upgrades to an existing PoE 1 3.30 build using the same PoB baseline and scenario, including resource, defense, availability and cost tradeoffs.
---

Load the current build revision and baseline. Read [the comparison procedure](../../../poe-db/docs/BUILDING.md) when preparing alternatives. Represent one change at a time in a JSON changes file: configuration, explicit item replacements, gem levels/quality or an added support.

Run the same input with and without the change, preserving the engine version, baseline hash and scenario. `pob compare` rejects mismatched baselines. Inspect applied supports and engine warnings, not only the damage delta.

Compare relevant damage, resources, max hit, recovery, requirements, buttons and dependency costs. If one upgrade forces other changes, evaluate that complete package separately. Data lookups and custom-mod experiments do not establish item craftability or acquisition.

Use dated local price observations only when their league, platform and variant match. Missing prices remain missing. A stored craft plan checks identifiers; it does not establish legal steps, probabilities or expected cost. To check whether a rare upgrade is craftable and at what currency spend, use `agent.mjs craftsim` (tiers, pool odds, step/replay, train for policies); report its rule confidences (`approximations_used`) and treat results as a model, not a game test. Export the crafted item (`craftsim export`) and verify it with `pob run --changes replace_items` before calling it an upgrade.

Record the selected/rejected upgrade, reason, calculation IDs and remaining uncertainty with the revision guard. Expand full data only when the compact result leaves a material question unresolved.
