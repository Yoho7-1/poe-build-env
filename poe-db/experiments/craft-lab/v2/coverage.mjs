import { currencyActions } from './actions.mjs';
import { rules } from './rules.mjs';

// What is modelled, at what confidence, and what is deliberately refused. Never flip complete to true without game validation.
export const coverage = Object.freeze({
  release: 'craft-lab-v2', patch: '3.30 (notes 3.30.0 .. 3.30.0d)', complete: false, game_validated: false,
  implemented: [
    { family: 'ordinary_currency', items: 'Transmutation, Alteration, Augmentation, Regal, Alchemy, Chaos, Exalted, Annulment, Scouring, Divine, Blessed, Fracturing, Binding, Chance (explicit odds)' },
    { family: 'tiers_and_pools', items: 'Ordered spawn/generation weights, family exclusion, item level, tier numbering per base, influence pools, cluster skill tags, implicit capacity changes' },
    { family: 'metamods_3_30', items: 'Full locks (3.30 costs by class), counted 1/2 prefix/suffix locks, Attack/Caster filters, multimod; 3.30 Annulment ignores tag filters; bench reroll fix' },
    { family: 'bench', items: 'All 782 option kinds: explicit mods, removal, enchant/removal, socket count/links/non-white/white (Vaal surcharge on corrupted), rarity reroll (explicit odds), reroll 1/3 mods' },
    { family: 'essences', items: 'All essences incl. Desolation and Trickery; Rune Dagger/Warstaff mapping; rare reforge by tier; level caps; fractured clash' },
    { family: 'fossils', items: 'All 25 fossils incl. Opulent, Sanctified (level factor + lucky), Faceted, Hollow, Glyphic, Tangled (420 outcomes), Fractured, Bloodstained, Gilded, Corroded hybrid bypass; Chaotic/Alchemical resonators; jewels' },
    { family: 'harvest', items: 'Tagged reforges (16 tags), more/less likely, influence reforge, add/remove augments, resistance and damage swaps (3.30 cost structure)' },
    { family: 'bestiary', items: 'Magic imprint/restore, Talisman imprint and fracture, side swaps with beast level, Bristle Matron metamod, aspects 20/30, influence beasts, Black Morrigan sockets/links; 3.30 yellow beast removal' },
    { family: 'influence_eldritch', items: 'Six influenced Exalted Orbs, Awakener\'s Orb (inventory donor), Orb of Dominance with derived Elevated map, Embers/Ichors, Eldritch Chaos/Exalted/Annulment, Orb of Conflict' },
    { family: 'veiled', items: 'Veiled Exalted, Veiled Chaos (3.30.0b rule), unveil offers and explicit choice' },
    { family: 'memory_strands', items: 'Tier cut, spend tables, Foulborn Augmentation/Regal/Exalted, Orb of Remembrance, Orb of Unravelling' },
    { family: 'corruption', items: 'Vaal Orb (equipment/jewel outcomes), 3.30 Altar of Corruption twice-corruption with destroy outcome, corrupted implicit replacement, Tainted Chaos/Exalted/Divine Teardrop/Jeweller/Fusing/Chromatic/Whetstone/Scrap/Catalyst' },
    { family: 'sockets_quality', items: 'Jeweller (weights, ilvl gates), Fusing (fitted), Chromatic (fitted, attribute weights), Omens of the Jeweller/Connections/Trichromatism, Whetstone/Scrap, 12 Catalysts with catalysed targets' },
    { family: 'multi_item', items: 'Recombinator (3.30 item level rule), Awakener\'s Orb, Mirror of Kalandra copies' },
    { family: 'hinekora', items: 'Lock with deterministic preview == result per currency; non-currency crafts remove foresight; 3.30 mirror/imprint keep it' },
    { family: 'agent_loop', items: 'Replayable sessions, budgets, start cost, targets (stats/tiers/sockets/quality/influences), policies, Monte Carlo training, PoB ASCII export, rule ids per step' },
  ],
  gaps: [
    { family: 'unique_items', reason: 'Chance/Vaal unique outcomes end the episode; unique identities, Divine/Blessed on uniques and Foulborn uniques are not modelled' },
    { family: 'gwennen_rog_tujen', reason: '3.30 Gwennen "Take a Chance" option pairs and Rog deal tables are not published' },
    { family: 'djinn_lapidary_gems', reason: 'Djinn-Touched Vaal Orb outcomes and gem corruption (Lapidary Lens) are not modelled' },
    { family: 'synthesis_and_fog', reason: 'Synthesised implicits, Reflecting Mist and Refracting Fog lack outcome data' },
    { family: 'enchant_systems', reason: 'Tailoring/Tempering, labyrinth, Harvest enchants and anointing are not modelled (bench flask enchants are)' },
    { family: 'base_defences_sacred', reason: 'Base defence percentiles and Sacred Orb are not part of the item state' },
    { family: 'odds_unpublished', reason: 'Orb of Chance / rarity reroll odds (3.30 increased unique chance), Tainted branch odds, counted-lock selection, 3.30 recombinator 1-3 mod reduction are explicit assumptions' },
    { family: 'allflame_ducat_threads', reason: 'Allflame crafting, Merrick\'s Ducat and Thread mechanics are not modelled' },
  ],
  currencies: currencyActions,
  rules_by_confidence: Object.entries(rules).reduce((acc, [, row]) => ({ ...acc, [row.conf]: (acc[row.conf] ?? 0) + 1 }), {}),
});
