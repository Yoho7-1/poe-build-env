import { currencyActions } from './operations.mjs';

export const coverage = Object.freeze({
  release: 'expanded-v1', complete: false, game_validated: false,
  implemented: [
    { family: 'ordinary_currency', scope: 'Normal/magic/rare cycle, rerolls, add/remove, stat rolls, fracture', confidence: 'reference_model' },
    { family: 'base_domains', scope: 'Released equipment, flasks, jewels, Abyss/Cluster jewels, tinctures, maps, contracts, charts and trinkets with explicit domain/capacity rules', confidence: 'source_model', special_cases_verified: false },
    { family: 'bench', scope: 'Single explicit mod, removal, enchantment, links; source costs, class, unlock, crafted limits and groups', confidence: 'source_model' },
    { family: 'metamods', scope: 'Full locks, counted 3.30 locks, attack/caster generation filters, multimod; Annulment ignores tag filters in 3.30', confidence: 'counted_lock_selection_unverified' },
    { family: 'essences', scope: 'Source class mappings, guaranteed mod, tier rarity restrictions and item-level cap', confidence: 'source_model' },
    { family: 'fossils', scope: 'One-to-four ordinary weight fossils, resonator size/rarity, tag restrictions, forced mods', confidence: 'reference_model' },
    { family: 'harvest', scope: 'Tagged reforge and augment; explicit lifeforce cost required', confidence: 'reference_model' },
    { family: 'bestiary', scope: 'Magic imprint and restoration; explicit beast cost required', confidence: 'reference_model' },
    { family: 'influenced_exalted', scope: 'Six influence orbs and influenced pools', confidence: 'source_model' },
    { family: 'eldritch', scope: 'Eight Ember/Ichor currencies and dominance-based add/remove/reforge', confidence: 'source_model' },
    { family: 'veiled', scope: 'Veiled Exalted, offers and explicit choice', confidence: 'offer_law_unverified' },
    { family: 'agent_training', scope: 'Adaptive declarative policies, targets, budgets, costs of failed/censored attempts, replay and contract checks', confidence: 'software_tested' },
    { family: 'pob_export', scope: 'ASCII item text with safe stat translation; unsupported handlers/quality/topology cause an error', confidence: 'requires_pob_roundtrip' },
  ],
  gaps: [
    { family: 'unique_items_and_acquisition', reason: 'Fixed/random unique variants and obtaining the initial item are not modeled' },
    { family: '3.30_rare_only_metadata', reason: 'Pinned mods export lacks an explicit rare-only flag; all eligibility exceptions have not been independently verified' },
    { family: 'special_fossils', reason: 'Sanctified/Foulborn tier preference and special outcome laws are not fully established by the local definitions' },
    { family: 'foulborn_and_memory_strands', reason: 'Tier culling, weight redistribution and strand spending have conflicting or incomplete sources' },
    { family: 'advanced_harvest_and_beasts', reason: 'Conversions, synthesis, influence changes, beast-level add/remove and splitting need dedicated rules' },
    { family: 'awakener_and_dominance', reason: 'Donor consumption, conflicting influence groups and elevated-tier mapping need verified multi-item transitions' },
    { family: 'recombinator_and_genesis', reason: '3.30 outcomes and restrictions cannot be inferred from old recombination implementations' },
    { family: 'corruption_tainted_and_reflection', reason: 'Vaal/double corruption, Tainted currency, reflecting mist and synthesis outcome laws are incomplete' },
    { family: 'quality_catalysts_sockets', reason: 'Quality/Catalyst effects and random socket count/colour/link distributions require separate source-backed models' },
    { family: 'special_enchantments_vendor_and_lock', reason: 'Tailoring/Tempering, vendor recipes, Hinekora forecast/consumption and legacy methods are not complete' },
  ],
  currencies: currencyActions,
  rule_sources: [
    'Pinned RePoE 3.30.0.4 source definitions and local PoB 2.68.1 ordered-weight implementation',
    'https://beta.craftofexile.com/changelog?game=poe1 (3.30 Annulment/meta changes, checked 2026-11-23)',
    'https://github.com/doomeer/kalandralang/blob/5a6d1fbead0fa20b239febcc69b75bc79e622466/src/item.ml (reference count model, not 3.30 verification)',
  ],
});
