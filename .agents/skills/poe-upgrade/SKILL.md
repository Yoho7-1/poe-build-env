---
name: poe-upgrade
description: Compare concrete upgrades to an existing PoE 1 3.30 build using the same PoB baseline and scenario, including resource, defense, availability and cost tradeoffs.
---

Load the current build revision and baseline. Read [the comparison procedure](../../../poe-db/docs/BUILDING.md) when preparing alternatives. Represent one change at a time in a JSON changes file: configuration, explicit item replacements, gem levels/quality or an added support.

Run the same input with and without the change, preserving the engine version, baseline hash and scenario. `pob compare` rejects mismatched baselines. Inspect applied supports and engine warnings, not only the damage delta.

Compare relevant damage, resources, max hit, recovery, requirements, buttons and dependency costs. If one upgrade forces other changes, evaluate that complete package separately. Data lookups and custom-mod experiments do not establish item craftability or acquisition.

Start from what the build leaves unused: `agent.mjs analyze coverage <xml>` (each gap names its measuring command). For the passive tree, `design optimize <xml> --metric balanced|dps|ehp` performs PoB-measured node swaps under defence, mana, requirement and budget constraints and saves the new XML. Generate candidates instead of writing them by hand: `agent.mjs analyze candidates <xml> --kind supports|uniques|anoints [--slot X] --plan` lists them, `analyze upgrades <xml> --auto <kind>` runs and ranks them. For a rare item build its text with `agent.mjs item build|pool|check` (legal pool by base and item level; `--check <xml> --slot X` must show no unparsed modifiers). Check `agent.mjs price status` before quoting prices; refresh with `price refresh` only when the user wants current prices (network). Rares have no price source: to judge an existing rare run `agent.mjs item appraise --file item.txt [--check <xml> --slot X]` (tiers, roll quality, open affixes, pseudo totals, manual trade filters; build value only from --check).

Use dated local price observations only when their league, platform and variant match. Missing prices remain missing. A stored craft plan checks identifiers; it does not establish legal steps, probabilities or expected cost. To check whether a rare upgrade is craftable and at what currency spend, use `agent.mjs craftsim` (tiers, pool odds, step/replay, train for policies); report its rule confidences (`approximations_used`) and treat results as a model, not a game test. Export the crafted item (`craftsim export`) and verify it with `pob run --changes replace_items` before calling it an upgrade.

Record the selected/rejected upgrade, reason, calculation IDs and remaining uncertainty with the revision guard. Expand full data only when the compact result leaves a material question unresolved.
