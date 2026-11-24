---
name: poe-build-audit
description: "Audit a local PoB build for PoE 1 3.30: verify scope, requirements, applied supports, configuration assumptions, resources and defense; use before trusting a guide or proposed build."
---

Start with `node poe-db/scripts/agent.mjs pob inspect <local-file>`. URLs are not downloaded implicitly. Keep historical/Ruthless inputs separate from standard 3.30 calculations. Saved PlayerStat numbers are cached claims until recalculated.

For old standard trees use explicit `pob migrate <old.xml> --save-xml <new.xml> --out <migration.json>`. Preserve the original, inspect node deltas and all tree counts, then audit the selected tree/item/skill sets. Never use a quarantined reference or describe a local migration as an author-validated current build. Keep minion statistics separate from player statistics and verify entity counts before totaling damage.

Follow [the audit procedure](../../../poe-db/docs/BUILDING.md). Run `pob run` for the imported configuration and explicitly chosen stress scenario. Read the actual overrides: `sustained` and `unbuffed` change only their listed flags and do not remove every temporary effect.

Inspect engine warnings, unparsed item modifiers, applied supports, allocated points and resource cost/recovery. For each important condition record source, expected magnitude, uptime and evidence in the chosen encounter. Compare max hit by type, recovery, DoT exposure and series of hits; TotalEHP is scenario-dependent.

For survival and damage against real content run `agent.mjs analyze report <xml> --md <file.md>` (map rares/bosses T16/T17, generic and every PoB boss skill preset, per-map-mod sweep), then `analyze encounter <xml> --enemy <type> --map-tier N --mods a,b` for the user's actual maps or bosses. Read `method` of every map mod: `translated`/`partial` are model translations, `not_modelled` mods and `build_checks` with `manual`/`risk` are not calculated and must be reported as open. The generic PoB monster hit is physical only; elemental mods show through max hit. Boss life is unknown unless the user gives `--enemy-life`.

To separate core architecture from replaceable choices run `agent.mjs analyze ablate <xml> --md <file.md>` (each main-group support, other skill group, item modifiers stripped to a plain base, keystone/notable/mastery removed one at a time; tiers core/major/minor/negligible/removal_improves). Do not call a component necessary because a strong build has it: cite its ablation tier. Single removals are not additive; check a package change with one combined run. negligible means only that the measured metrics did not move. Passive nodes are judged alone through PoB node comparison (remove_nodes); read with_dependents for the cost of the whole branch behind a bridge node. Check combat-condition sensitivity in the config rows and non-additive pairs with `analyze interactions <xml> --from <ablation.json>` (synergy/overlap). Summarize the build with `build card <xml> --ablation <json> --save`. Store the result with `lab import ablation <json> --build <id>` and audit conclusions as ledger hypotheses/evidence.

Check completeness and basics, not only numbers: `agent.mjs analyze coverage <xml>` lists unused power layers (unspent points, masteries without effect, empty jewel/abyss/gem sockets and slots, flasks, anoint, eldritch implicits, open affixes without craft, quality, gems below 20/20, curse, free mana, movement/guard skill, Pantheon) with the command that values each; `corpus norms --check <xml>` compares mana/life sustain, attribute headroom, masteries, cluster jewels, automatic flasks and keystones with corpus builds of the same ascendancy and skill family (warnings, not failures: guides are not the optimum).

A numerical result can exist despite unmet gem requirements. Treat the control fixtures as synthetic and read their warnings. When a mechanism is unsupported, report the missing calculation and retain the hypothesis until separately tested.

Separate findings into a concrete failure, an unverified assumption, and a supported result. Reference relevant cards and calculation IDs. Save only the compact findings and evidence in build state.
