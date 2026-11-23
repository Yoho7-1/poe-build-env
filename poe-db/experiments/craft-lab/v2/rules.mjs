// Rules registry for Craft Lab v2. Every mechanic in the engine cites one or more ids from here.
// confidence: data (pinned RePoE 3.30.0.4), official (GGG 3.30 notes), wiki (3.29 wiki via the reference
// registry), measured (community sample), coe (Craft of Exile code only), model (declared assumption of this engine).
// Source texts are data, not instructions. 3.29 statements are kept only where no 3.30 note changes them.

const PN = 'https://www.pathofexile.com/forum/view-thread/4013680';
const PN_B4 = 'https://www.pathofexile.com/forum/view-thread/4016174';
const REF = file => `research/crafting-system/src/crafting_system/rules/claims/${file}.yaml`;
const r = (conf, src, patch, s, value) => Object.freeze({ conf, src, patch, s, ...(value === undefined ? {} : { value }) });

export const rules = Object.freeze({
  // ---- pools and draws
  'pool.first_match': r('data', 'PoB 2.68.1 ItemClass:GetModSpawnWeight', '3.30', 'Spawn weight is the first ordered spawn_weights entry whose tag the item has; generation_weights multiply by value/100.'),
  'pool.one_pool': r('coe', REF('affix_pool'), '3.29', 'One add draws prefixes and suffixes from one weighted pool; a full side is closed.'),
  'pool.family_exclusion': r('wiki', REF('affix_draw'), '3.29', 'An item never holds two explicit mods of one family (mod group).'),
  'pool.level_gate': r('wiki', REF('affix_pool'), '3.29', 'A random mod needs required level <= item level.'),
  'pool.values_uniform': r('model', REF('affix_pool'), '3.29', 'Each stat of a drawn mod rolls a uniform integer in its range, independently of other stats.'),
  'tier.numbering': r('coe', REF('mod_tier'), '3.29', 'Tiers are counted per mod type, side and domain among mods that can spawn on the base; tier 1 has the highest required level.'),
  // ---- affix counts
  'count.magic': r('model', REF('magic_orbs'), '3.29', 'Transmutation/Alteration give 1 or 2 mods with chance 1/2 each; kept mods count inside the total.', { 1: 1, 2: 1 }),
  'count.rare': r('wiki', 'https://www.poewiki.net/wiki/Chaos_Orb#Mechanics', '3.29', 'Chaos/Alchemy-type reforges give 4, 5 or 6 mods at 8:3:1; kept and forced mods count inside the total.', { 4: 8, 5: 3, 6: 1 }),
  'count.jewel': r('coe', REF('jewel'), '3.29', 'Rare jewels reroll to 3 or 4 mods at 65:35; capacity 2 prefixes and 2 suffixes.', { 3: 65, 4: 35 }),
  'count.dry_pool': r('coe', REF('chaos_orb'), '3.29', 'A reroll whose pool runs dry stops and keeps fewer mods.'),
  // ---- ordinary currency
  'orb.transmutation': r('wiki', REF('magic_orbs'), '3.29', 'Normal -> magic with 1-2 random mods.'),
  'orb.alteration': r('wiki', REF('magic_orbs'), '3.29', 'Rerolls a magic item; fractured mods stay; crafted mods are removed.'),
  'orb.augmentation': r('wiki', REF('magic_orbs'), '3.29', 'Adds one mod to a magic item with an open side.'),
  'orb.regal': r('wiki', REF('magic_orbs'), '3.29', 'Magic -> rare keeping every mod and adding one.'),
  'orb.alchemy': r('wiki', REF('alchemy'), '3.29', 'Normal -> rare with 4-6 mods (8:3:1).'),
  'orb.chaos': r('wiki', REF('chaos_orb'), '3.29', 'Rerolls a rare item; fractured and locked mods stay.'),
  'orb.exalted': r('wiki', REF('exalted_orb'), '3.29', 'Adds one random mod to a rare item.'),
  'orb.annulment': r('model', REF('annulment_orb'), '3.29', 'Removes one removable explicit mod uniformly; rarity never changes.'),
  'orb.annulment_330_tag_filters': r('official', PN, '3.30.0', 'Cannot roll Attack/Caster Modifiers no longer stop Annulment-like removal of those mods.'),
  'orb.scouring': r('wiki', REF('scouring'), '3.29', 'Removes unprotected explicit mods; rarity becomes normal (0), magic (1) or rare (2+ mods left). Influence stays.'),
  'orb.divine': r('wiki', REF('divine_orb'), '3.29', 'Rerolls numeric values of unprotected explicit mods, crafted included; locked sides and fractured mods keep values.'),
  'orb.blessed': r('wiki', REF('blessed_orb'), '3.29', 'Rerolls values of implicits inside their ranges.'),
  'orb.fracturing': r('model', REF('fracturing_orb'), '3.29', 'Rare with >= 4 mods, not influenced/fractured/synthesised: fractures one explicit mod chosen uniformly.'),
  'orb.chance': r('official', PN, '3.30.0', 'Normal -> magic, rare or unique; 3.30 significantly increased the unique chance but published no number. The engine requires an explicit outcome assumption.'),
  'orb.mirror': r('wiki', 'https://www.poewiki.net/wiki/Mirror_of_Kalandra', '3.29', 'Creates a mirrored copy; mirrored items cannot be modified. 3.30: mirroring is no longer a modification.'),
  'orb.eternal': r('official', PN, '3.30.0', 'Imprinting/mirroring no longer count as modifying the item and do not remove Hinekora foresight.'),
  // ---- metamods
  'meta.full_lock': r('wiki', REF('metamods'), '3.29', 'Prefixes/Suffixes Cannot Be Changed protect existing mods of that side from rerolls, removal and Divine; open slots can still be filled.'),
  'meta.full_lock_cost_330': r('official', PN, '3.30.0', 'Full locks cost 4 Divine + 1 Sacred (weapons), 4 Divine + 4 Blessed (armour/quivers), 4 Divine + 8 Exalted (jewellery).'),
  'meta.counted_lock_330': r('official', PN, '3.30.0', 'New crafts: 1 or 2 Prefix/Suffix Modifiers cannot be changed (1 or 2 Divine).'),
  'meta.counted_lock_selection': r('model', 'engine assumption', '3.30', 'Which mods a counted lock protects is chosen uniformly among unprotected mods of the side for each action (no published rule, no preview).'),
  'meta.tag_filters': r('wiki', REF('metamods'), '3.29', 'Cannot roll Attack/Caster remove mods with that implicit tag from additions; a reroll is filtered only if the metamod survives it.'),
  'meta.blocks_essence_fossil': r('wiki', REF('metamods'), '3.29', 'Essences and Chaotic resonators are refused on items with lock or tag-filter metamods; multimod does not block.'),
  'meta.multimod': r('wiki', REF('metamods'), '3.29', 'Can have up to 3 Crafted Modifiers raises the crafted limit to 3 including itself.'),
  'meta.recipes_330': r('official', PN, '3.30.0', 'Meta-crafting recipes are found in Nightmare Maps (no longer in Unique Maps).'),
  // ---- bench
  'bench.fixed_mod': r('data', 'crafting_bench_options.json', '3.30', 'A bench option adds its named crafted mod; class list, cost and family/slot rules apply; no item-level gate.'),
  'bench.one_crafted': r('wiki', REF('bench_craft'), '3.29', 'One crafted mod by default (metamods included).'),
  'bench.remove_crafted': r('wiki', REF('bench_craft'), '3.29', 'Remove Crafted Mods removes every crafted mod.'),
  'bench.reroll_rare_mods': r('model', 'crafting_bench_options.json reroll_rare_mods + 3.30 bug fix', '3.30', 'Reroll N random modifiers: removes N removable mods (respecting locks and tag filters, fixed in 3.30) and adds as many new random mods.'),
  'bench.reroll_rarity': r('model', 'crafting_bench_options.json reroll_rarity', '3.30', 'Rerolls rarity like an Orb of Chance on a normal item; requires an explicit outcome assumption.'),
  'bench.chance_cost_conflict': r('official', PN, '3.30.0', 'Notes say bench options costing Orbs of Chance now cost Orbs of Alteration; pinned 3.30.0.4 data still lists Orb of Chance for reroll_rarity. Data cost is used and the conflict is reported.'),
  'bench.white_sockets_330': r('official', PN, '3.30.0', 'New bench option: set all sockets white for an Orb of Scouring (+ Vaal Orb on corrupted).'),
  'bench.sockets': r('wiki', REF('sockets'), '3.29', 'Bench sets socket count (1/3/10/70/350 Jeweller), links (1/3/5/150/1500 Fusing), >=2/3/4 non-white (5/20/75 Chromatic); added sockets are white. Corrupted: + same number of Vaal Orbs.'),
  // ---- essences
  'essence.class_mod': r('data', 'essences.json', '3.30', 'Forced mod is the essence entry of the item class; Rune Dagger uses Dagger and Warstaff uses Staff.', { 'Rune Dagger': 'Dagger', Warstaff: 'Staff' }),
  'essence.normal_alch_rare_chaos': r('wiki', REF('essence'), '3.29', 'On normal: Alchemy-like with forced mod; tier >= 5 and corruption-only essences also reforge rares like Chaos.'),
  'essence.level_cap': r('wiki', REF('essence'), '3.29', 'Whispering..Wailing cap random mods at item_level_restriction; the forced mod ignores item level.'),
  'essence.fractured_clash': r('wiki', REF('essence'), '3.29', 'Refused when the forced mod shares a family with a fractured mod.'),
  'essence.desolation_330': r('official', PN, '3.30.0', 'Essence of Desolation and the new Essence of Trickery are tradeable/stashable in 3.30.'),
  // ---- fossils
  'fossil.stacking': r('wiki', REF('fossils'), '3.29', 'Positive factors add (once per matching tag), negative factors multiply, a zero blocks; factor = weight/100 on implicit_tags.'),
  'fossil.corroded_bypass': r('coe', REF('fossils'), '3.29', 'Hybrid bleed/poison boost suppresses other boosts on the tags it covers.', { bleed: ['physical', 'ailment'], poison: ['chaos', 'ailment'] }),
  'fossil.opulent': r('coe', REF('fossils'), '3.29', 'Opulent removes tagless mods.'),
  'fossil.sanctified': r('coe', REF('fossils'), '3.29', 'Sanctified multiplies weight by 1 + (required level - 40)/100 and rolls values lucky.', 40),
  'fossil.faceted': r('wiki', REF('fossils'), '3.29', 'Faceted adds its added_mods to the pool; fossil factors apply to them.'),
  'fossil.forced': r('wiki', REF('fossils'), '3.29', 'Hollow/Glyphic forced mods count in the total and ignore item level.'),
  'fossil.glyphic': r('coe', REF('fossils'), '3.29', 'Glyphic guarantees one corrupted-essence mod for the class, base weight 1000 times fossil factors.', 1000),
  'fossil.tangled': r('coe', REF('fossils'), '3.29', 'Tangled applies one of its outcome records uniformly; adds no mods.'),
  'fossil.fractured': r('wiki', REF('fossils'), '3.29', 'Fractured Fossil fractures one uniformly chosen explicit mod after the reroll; refused on fractured/influenced items.'),
  'fossil.bloodstained': r('wiki', REF('fossils'), '3.29', 'Bloodstained corrupts the item and replaces one random implicit (all with Gilded) by a corrupted implicit.'),
  'fossil.gilded': r('wiki', REF('fossils'), '3.29', 'Gilded adds its sell-price implicit only.'),
  'fossil.resonator': r('wiki', REF('fossils'), '3.29', 'Chaotic resonator rerolls a rare like Chaos; Alchemical resonator makes a normal item rare; sockets must equal fossil count; no duplicates.'),
  // ---- harvest
  'harvest.tagged_reforge': r('wiki', REF('harvest_reforge'), '3.29', 'Reforge a rare with a guaranteed mod of the tag (drawn first), rest like Chaos.'),
  'harvest.tagged_cost': r('wiki', REF('harvest_reforge'), '3.29', 'Lifeforce costs of tagged reforges.', {
    lightning: { 'Primal Crystallised Lifeforce': 50 }, fire: { 'Wild Crystallised Lifeforce': 50 }, cold: { 'Vivid Crystallised Lifeforce': 50 }, physical: { 'Vivid Crystallised Lifeforce': 50 },
    life: { 'Wild Crystallised Lifeforce': 75 }, defences: { 'Primal Crystallised Lifeforce': 75 }, chaos: { 'Vivid Crystallised Lifeforce': 100 }, attack: { 'Wild Crystallised Lifeforce': 75 },
    caster: { 'Primal Crystallised Lifeforce': 75 }, speed: { 'Vivid Crystallised Lifeforce': 150 }, critical: { 'Primal Crystallised Lifeforce': 150 },
    minion: { 'Primal Crystallised Lifeforce': 200, 'Crystallised Rancour': 3 }, elemental: { 'Wild Crystallised Lifeforce': 200, 'Crystallised Rancour': 1 },
    attribute: { 'Vivid Crystallised Lifeforce': 200, 'Crystallised Rancour': 2 }, mana: { 'Primal Crystallised Lifeforce': 200, 'Crystallised Rancour': 2 }, drop: { 'Vivid Crystallised Lifeforce': 200, 'Crystallised Rancour': 1 } }),
  'harvest.meta_first_mod': r('coe', REF('metamods'), '3.29', 'Attack/Caster metamods filter only the first (guaranteed) mod of a Harvest reforge.'),
  'harvest.likelihood': r('wiki', REF('harvest_reforge'), '3.29', 'More/less likely reforge multiplies/divides weights of families already on the item by 10; draws at least max(4, current count); 200 Wild.', { factor: 10, floor: 4, cost: { 'Wild Crystallised Lifeforce': 200 } }),
  'harvest.influence_reforge': r('wiki', REF('harvest_reforge'), '3.29', 'Reforge an influenced rare with a guaranteed influence mod; 5000 Primal + 1 Sacred.', { 'Primal Crystallised Lifeforce': 5000, 'Sacred Crystallised Lifeforce': 1 }),
  'harvest.augment': r('wiki', REF('harvest_augment'), '3.29', 'Add a mod of a tag then remove another random mod; non-influenced items only; removal ignores tag filters.', {
    fire: { 'Wild Crystallised Lifeforce': 15000 }, cold: { 'Vivid Crystallised Lifeforce': 15000 }, lightning: { 'Primal Crystallised Lifeforce': 15000 }, physical: { 'Vivid Crystallised Lifeforce': 15000 },
    life: { 'Wild Crystallised Lifeforce': 17500 }, defences: { 'Primal Crystallised Lifeforce': 17500 }, chaos: { 'Vivid Crystallised Lifeforce': 17500 }, attack: { 'Wild Crystallised Lifeforce': 17500 },
    caster: { 'Primal Crystallised Lifeforce': 17500 }, speed: { 'Vivid Crystallised Lifeforce': 20000 }, critical: { 'Primal Crystallised Lifeforce': 20000 } }),
  'harvest.swap': r('wiki', REF('harvest_swap'), '3.29', 'Change a fire/cold/lightning resistance or damage mod into another element at the same tier; uniform among eligible sources; fractured/crafted/locked mods are not sources.'),
  'harvest.swap_cost_330': r('official', PN, '3.30.0', 'Swaps cost 300 Lifeforce of two different types (+1 Rancour for damage); the notes do not name the two types, so the caller states the cost.'),
  'harvest.no_strands': r('measured', REF('memory_strands'), '3.29', 'Harvest and fossils neither spend nor benefit from Memory Strands.'),
  // ---- beasts
  'beast.no_yellow_330': r('official', PN, '3.30.0', 'Yellow beasts are no longer required by any recipe; flask recipes need any red beast. Remaining beast counts are not listed, so the named beast is charged and extra rare-beast requirements are dropped.'),
  'beast.imprint': r('wiki', REF('imprint'), '3.29', 'Craicic Croaker imprints a magic item (Fenumal Plagued Arachnid a rare Talisman); restoring is refused on fractured, split or derived items.'),
  'beast.side_swap': r('coe', REF('beastcraft'), '3.29', 'Farric Wolf Alpha adds a prefix and removes a suffix (Lynx Alpha the reverse); added mod drawn with the beast level; removal uniform among unfractured mods of the other side; a lock on the losing side means add-only.', { default_beast_level: 83 }),
  'beast.metamod': r('model', REF('beastcraft'), '3.29', 'Wild Bristle Matron adds one allowed metamod uniformly.'),
  'beast.aspect': r('wiki', REF('beastcraft'), '3.29', 'Aspect recipes add a GrantedSkill suffix (level 20, 30 with The Black Morrigan); not crafted.'),
  'beast.talisman_fracture': r('model', REF('beastcraft'), '3.29', 'Fracture 1 mod (>=4 mods) or 2 mods (>=6 mods) of a rare Talisman, uniform.'),
  'beast.influence': r('wiki', REF('influence_beast'), '3.29', 'Influence beast adds a mod of the item\'s influence exactly like that influence\'s Exalted Orb.'),
  'beast.black_morrigan': r('wiki', REF('sockets'), '3.29', 'Black Morrigan recipes give the class maximum sockets or all sockets linked.'),
  // ---- influence / eldritch
  'influence.exalt': r('wiki', REF('influence'), '3.29', 'Influenced Exalted adds its influence and one mod of that influence to an uninfluenced, unfractured, non-eldritch rare with ilvl >= 68.'),
  'influence.awakener': r('coe', REF('awakener'), '3.29', 'Awakener: same class, one different influence each, keep one influenced mod of each (receiver wins on group clash), rest rerolled like Chaos; donor destroyed.'),
  'influence.dominance': r('model', REF('dominance'), '3.29', 'Orb of Dominance (magic/rare armour with >= 2 influenced mods): removes one influenced mod uniformly and upgrades another uniformly; top tier becomes Elevated.'),
  'influence.elevated_map': r('model', 'engine derivation', '3.30', 'Elevated version = the Elevated mod of the same group with the same stat ids; ambiguous or missing links are refused.'),
  'eldritch.implicits': r('wiki', REF('eldritch'), '3.29', 'Embers/Ichors (Lesser..Exceptional = tier 1..4) replace the implicits except the other side; armour pieces only; not on influenced items.'),
  'eldritch.dominance': r('wiki', REF('eldritch'), '3.29', 'Higher tier side dominates: Exarch -> prefixes, Eater -> suffixes; equal tiers: none.'),
  'eldritch.orbs': r('wiki', REF('eldritch'), '3.29', 'Eldritch Chaos rerolls the dominant side (Chaos count minus kept), ignores side locks; Exalted adds; Annulment removes from the dominant side.'),
  'eldritch.conflict': r('measured', REF('eldritch'), '3.29', 'Orb of Conflict raises one implicit tier and lowers the other; higher one raised with p = 1/(1+exp(-(0.10-0.52d))).', { intercept: 0.10, slope: 0.52 }),
  // ---- veiled
  'veiled.exalted': r('wiki', REF('veiled'), '3.29', 'Veiled Exalted removes one random unprotected mod then adds a veiled placeholder (side 1/2 when both open).'),
  'veiled.chaos': r('wiki', REF('veiled'), '3.29', 'Veiled Chaos rerolls like Chaos with one veiled mod inside the total.'),
  'veiled.chaos_330b': r('official', PN_B4, '3.30.0b', 'Veiled Chaos can be used on items with a veiled mod if that mod is not protected by fracturing or metamods.'),
  'veiled.unveil': r('coe', REF('unveil'), '3.29', 'Unveil offers up to three weighted mods without replacement by family; families already on the item are excluded; choice is explicit.'),
  // ---- corruption and tainted
  'corrupt.vaal': r('wiki', REF('corruption'), '3.29', 'Vaal Orb on equipment: implicit, socket colour, rare reroll with 6 affixes, nothing; 1/4 each.', { implicit: 1, socket: 1, brick: 1, nothing: 1 }),
  'corrupt.vaal_jewel': r('wiki', REF('corruption'), '3.29', 'Vaal Orb on a jewel: implicit, rare reroll (4 mods), corruption-unique (terminal) or nothing; 1/4 each.'),
  'corrupt.implicit_330': r('official', PN, '3.30.0', 'A corrupted implicit replaces an existing corrupted implicit if the item already has 2 Vaal implicits.'),
  'corrupt.altar_330': r('official', PN, '3.30.0', 'Altar of Corruption corrupts a second time (Twice Corrupted); the influenced-rare outcome now destroys the item.', { two_implicits: 1, sockets: 1, destroyed: 2 }),
  'corrupt.altar_two_implicit_share': r('measured', REF('corruption'), '3.29', 'Two-implicit share was observed between 8.8% and 26.5%; the engine uses 1/4 (reference decision).'),
  'corrupt.modifiable': r('wiki', REF('corruption'), '3.29', 'Corrupted items accept only socket bench crafts (with Vaal surcharge), Tainted currency and Tainted Catalysts.'),
  'tainted.model': r('model', REF('tainted'), '3.29', 'Tainted Chaos reforges or clears, Tainted Exalted adds or removes (1/2 each, unpublished); Tainted Divine Teardrop moves each non-crafted mod tier by -1/0/+1 (1/3 each); Tainted Jeweller/Fusing +-1 socket/link 1/2.'),
  // ---- sockets and quality
  'sockets.max': r('wiki', REF('sockets'), '3.29', 'Class maximum: one-hand/shield 3, gloves/boots/helmet 4, body and two-hand 6; ilvl gates 25/35/50 for 4/5/6.', { min_level: [1, 1, 2, 25, 35, 50] }),
  'sockets.jeweller': r('wiki', REF('sockets'), '3.29', 'Jeweller rerolls socket count to a different number by weights 50,120,100,30,5,1 (four-socket classes 100,90,80,30); new sockets white.', { six: [50, 120, 100, 30, 5, 1], four: [100, 90, 80, 30] }),
  'sockets.fusing': r('measured', REF('sockets'), '3.29', 'Fusing draws sequential link group sizes with fitted weights (20% quality) until a different link layout appears.', [17818, 34818, 26766, 19672, 826, 100]),
  'sockets.chromatic': r('measured', REF('sockets'), '3.29', 'Chromatic: each socket non-white with p = 0.00375*max(ilvl-14,1)*(1+min(q,30)/100), colour by attribute weights; at least one non-white; result differs from current colours.'),
  'sockets.omens': r('wiki', REF('sockets'), '3.29', 'Omen of the Jeweller: maximum sockets; Omen of Connections: all linked; Omen of Trichromatism: at least one R, G and B.'),
  'quality.gain': r('wiki', REF('catalyst'), '3.29', 'Whetstone/Scrap/Catalyst add f = max(1, min(30*exp(-ilvl/30) - 0.3, 20)) points, the fraction rounded at random; cap 20%.'),
  'quality.catalyst': r('wiki', REF('catalyst'), '3.29', 'Catalysts (rings, amulets, belts): one quality type; another type resets quality; matching mods scaled by (100+q)/100 floored.', {
    abrasive: ['attack'], accelerating: ['speed'], fertile: ['resource'], imbued: ['caster'], intrinsic: ['attribute'], noxious: ['physical_damage', 'chaos_damage'],
    prismatic: ['resistance'], tempering: ['defences'], turbulent: ['elemental_damage'], unstable: ['critical'], sinistral: ['prefix'], dextral: ['suffix'] }),
  // ---- memory strands
  'strands.cut': r('measured', REF('memory_strands'), '3.29', 'With s >= 1 strands a cutting craft sees only the K = floor(100/(2.5s+147.5)*(T-1))+1 highest tiers of each mod type; kept tiers weigh *T/K.'),
  'strands.spend': r('measured', REF('memory_strands'), '3.29', 'Cutting crafts spend uniform 0..ceiling strands after the draw.', { transmutation: 8, alteration: 8, augmentation: 8, regal: 16, alchemy: 50, chaos: 50, chance: 50, essence: 80, eldritch_chaos: 60, tainted_chaos: 60, veiled_chaos: 80, awakener: 100, exalted_by_mods: [16, 22, 26, 32, 34, 38], foulborn_augmentation: 32, foulborn_regal: 48, foulborn_exalted_by_mods: [46, 52, 56, 60, 62, 66] }),
  'strands.foulborn': r('measured', REF('foulborn'), '3.29', 'Foulborn Augmentation/Regal/Exalted act as plain orbs with the tier cut of denominator 2.5s+147.5+75 (175 at 0 strands). 3.30.0d: in the core drop pool.'),
  'strands.remembrance': r('measured', REF('memory_strands'), '3.29', 'Orb of Remembrance on normal equipment sets strands to round(N(35,25)) accepted in [10,100].'),
  'strands.unravelling': r('model', REF('memory_strands'), '3.29', 'Orb of Unravelling spends all strands; each natural unfractured explicit mod is raised with chance min(1, s*W_up/(2*W_side)) to a higher tier weighted cumulatively; ignores side locks.'),
  // ---- multi-item and other
  'recomb.model': r('measured', REF('recombinator'), '3.26', 'Recombinator: base 1/2, sides pooled per input, kept count by pooled count table; one exclusive mod; weighted without replacement by family.', {
    1: { 0: 41, 1: 59 }, 2: { 1: 67, 2: 33 }, 3: { 1: 39, 2: 52, 3: 10 }, 4: { 1: 11, 2: 59, 3: 31 }, 5: { 2: 43, 3: 57 }, 6: { 3: 100 } }),
  'recomb.330': r('official', PN, '3.30.0', 'Output item level is the selected base\'s; 1-3 pooled mods give fewer on average (unpublished); mods that cannot appear on the new base are not counted; corrupted items always refused.'),
  'lock.hinekora': r('wiki', REF('hinekora_lock'), '3.29', 'Hinekora\'s Lock makes the next currency outcome fixed and previewable per currency type; any modification removes foresight; bench/harvest/beasts/recombinator are not previewed.'),
});

export function rule(id) {
  const value = rules[id];
  if (!value) throw new Error(`Unknown rule id: ${id}`);
  return value;
}
export const ruleValue = id => rule(id).value;
