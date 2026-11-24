// BuildCard: a compact, deterministic structured snapshot of one PoB build (Build Knowledge Engine, 3A.2).
// Everything is extracted by local code from one pinned-engine calculation; no LLM. Fields that cannot be derived
// stay null. Optional ablation JSON adds the core / implementation / replaceable split (3A.3). The `signature` is a
// hash of structural features (class, skill, damage form, defense model, keystones, uniques) for deduplication and
// later novelty comparison; `features` are the same facts as a flat map.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectRoot, dbRoot, readJson, atomicJson, flags } from './workspace.mjs';
import { runPob, newPob } from './pob.mjs';
import { readBuild, pobGems } from './analysis-candidates.mjs';
import { effectiveDps, canonicalJson, metrics } from './analysis-core.mjs';
import { loadTree } from './tree-graph.mjs';
import { planConfigAblation, isSupportGem } from './analysis-ablation.mjs';
import { foundationOf } from './build-foundation.mjs';

export const cardDirectory = () => path.join(projectRoot, 'research/lab/cards');
const damageTypes = ['Physical', 'Fire', 'Cold', 'Lightning', 'Chaos'];
const finite = v => typeof v === 'number' && Number.isFinite(v);
const r0 = v => finite(v) ? Math.round(v) : null;
const r1 = v => finite(v) ? Math.round(v * 10) / 10 : null;
const share = (part, total) => finite(part) && total > 0 ? Math.round(part / total * 1000) / 1000 : 0;

// ---------- pure derivations (tested with plain output objects) ----------
// Damage form: share of hit vs damage over time (skill DoT and ailments) in effective DPS.
export function damageProfile(o) {
  const eff = effectiveDps(o);
  const ailments = { ignite: o.TotalIgniteDPS ?? o.IgniteDPS ?? 0, poison: o.TotalPoisonDPS ?? o.PoisonDPS ?? 0, bleed: o.BleedDPS ?? 0, decay: o.DecayDPS ?? 0 };
  const ailmentTotal = Object.values(ailments).filter(finite).reduce((a, b) => a + b, 0);
  const dot = finite(o.TotalDotDPS) ? o.TotalDotDPS : 0;
  const skillDot = Math.max(0, (finite(o.TotalDot) ? o.TotalDot : dot - ailmentTotal));
  const hit = eff.basis === 'TotalDotDPS+hit' ? eff.hit_dps : Math.max(0, (eff.value ?? 0) - dot);
  const total = (hit ?? 0) + skillDot + ailmentTotal;
  const parts = { hit: share(hit, total), skill_dot: share(skillDot, total), ...Object.fromEntries(Object.entries(ailments).map(([k, v]) => [k, share(v, total)])) };
  const form = total <= 0 ? null : Object.entries(parts).sort((a, b) => b[1] - a[1])[0];
  // Spells: <Type>HitAverage / <Type>Dot at top level; attacks: per hand (MainHand:<Type>HitAverage, OffHand:...).
  const num0 = k => finite(o[k]) ? o[k] : 0;
  const typeValue = t => Math.max(num0(`${t}HitAverage`), num0(`MainHand:${t}HitAverage`) + num0(`OffHand:${t}HitAverage`), num0(`${t}Dot`));
  const typeTotal = damageTypes.reduce((s, t) => s + typeValue(t), 0);
  const types = Object.fromEntries(damageTypes.map(t => [t, share(typeValue(t), typeTotal)]).filter(([, v]) => v > 0));
  return { effective_dps: r0(eff.value), dps_basis: eff.basis, full_dps: r0(o.FullDPS), parts, primary_form: form && form[1] >= 0.5 ? form[0] : form ? 'mixed' : null,
    types, primary_type: Object.entries(types).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null, note: 'Type shares compare average hit and DoT per type; a rough split, not a conversion trace.' };
}

// Defense model and present layers with simple, stated thresholds.
export function defenseProfile(o, keystones = []) {
  const ks = new Set(keystones);
  const life = o.Life ?? 0, es = o.EnergyShield ?? 0, ward = o.Ward ?? 0;
  const pool = ks.has('Chaos Inoculation') ? 'ci_es' : life > 0 && es >= life * 0.75 ? 'hybrid' : es > life ? 'es' : 'life';
  const layers = [];
  const add = (cond, name) => { if (cond) layers.push(name); };
  add((o.Armour ?? 0) >= 15000, 'armour');
  add((o.Evasion ?? 0) >= 15000, 'evasion');
  add((o.BlockChance ?? 0) >= 40, 'attack_block');
  add((o.SpellBlockChance ?? 0) >= 40, 'spell_block');
  add((o.EffectiveSpellSuppressionChance ?? o.SpellSuppressionChance ?? 0) >= 80, 'spell_suppression');
  add(ks.has('Mind Over Matter'), 'mind_over_matter');
  add(ks.has('Eldritch Battery'), 'eldritch_battery');
  add(es > 0 && pool !== 'life', 'energy_shield');
  add(ward > 0, 'ward');
  add((o.LifeRecoup ?? 0) > 0, 'life_recoup');
  add((o.LifeLeechGainRate ?? 0) > 0, 'life_leech');
  add((o.LifeRegenRecovery ?? 0) >= life * 0.05 && life > 0, 'life_regen');
  add((o.AvoidPhysicalDamageChance ?? 0) >= 10 || (o.AvoidAllDamageFromHitsChance ?? 0) > 0, 'damage_avoidance');
  add((o.FreezeAvoidChance ?? 0) >= 100, 'freeze_immunity');
  add((o.ChaosResist ?? -60) >= 0, 'chaos_res_positive');
  const maxHit = Object.fromEntries(damageTypes.map(t => [t, r0(o[`${t}MaximumHitTaken`])]));
  const weakest = Object.entries(maxHit).filter(([, v]) => finite(v)).sort((a, b) => a[1] - b[1])[0]?.[0] ?? null;
  return { pool, life: r0(life), energy_shield: r0(es), ward: r0(ward), ehp: r0(o.TotalEHP), max_hit: maxHit, weakest_type: weakest, layers,
    resists: Object.fromEntries(['Fire', 'Cold', 'Lightning', 'Chaos'].map(t => [t, r0(o[`${t}Resist`])])),
    recovery: { life_regen: r1(o.LifeRegenRecovery), life_leech: r1(o.LifeLeechGainRate), life_recoup_pct: r1(o.LifeRecoup), es_recharge: r1(o.EnergyShieldRecharge) },
    thresholds: 'armour/evasion >= 15000, block >= 40, suppression >= 80, regen >= 5% life/s' };
}

export function resourceProfile(o) {
  const sustain = metrics.mana_sustain.read(o);
  return { mana: r0(o.Mana), mana_unreserved: r0(o.ManaUnreserved), mana_reserved_pct: r1(o.ManaReservedPercent), life_reserved_pct: r1(o.LifeReservedPercent),
    mana_cost_per_second: r1(o.ManaPerSecondCost), mana_sustain_per_second: r1(sustain), sustained: sustain == null ? null : sustain >= 0 };
}

// Ablation report -> core / implementation / replaceable split (tree nodes judged alone, PoB removeNodes).
export function architectureSplit(report) {
  if (!report || report.analysis !== 'ablation' || report.plan) return null;
  const rows = report.rows.filter(r => !r.error);
  const parts = rows.filter(r => r.kind !== 'config');
  const pick = tiers => parts.filter(r => tiers.includes(r.tier)).map(r => r.label);
  return { core: pick(['core']), implementation: pick(['major', 'minor']), replaceable: pick(['negligible', 'removal_improves']),
    assumption_sensitivity: rows.filter(r => r.kind === 'config').map(r => ({ assumption: r.label, tier: r.tier, dps_loss_pct: r.offense_loss_pct, defense_loss_pct: r.defense_loss_pct })),
    note: 'replaceable = no measured PoB effect; unmodelled utility (recoup, explosions, movement, ailments) is not captured.',
    bridges: rows.filter(r => r.with_dependents?.other_key_nodes?.length).map(r => ({ node: r.label, branch_dps_loss_pct: r.with_dependents.offense_loss_pct, points: r.with_dependents.points })), source: { file: path.basename(report.file ?? ''), input_sha256: report.contract?.input_sha256 ?? null } };
}

export function signatureOf(f) {
  const core = { class: f.class, ascendancy: f.ascendancy, main_skill: f.main_skill, damage_scope: f.damage_scope ?? 'player', primary_form: f.primary_form, primary_type: f.primary_type, defense_pool: f.defense_pool,
    layers: [...f.defense_layers].sort(), keystones: [...f.keystones].sort(), uniques: [...f.uniques].sort() };
  return createHash('sha256').update(canonicalJson(core)).digest('hex').slice(0, 16);
}

// ---------- buttons (WP1): how many keys the player presses ----------
// Rule (stated, approximate): every distinct enabled active skill PoB lists for the player counts as a pressed key unless
// PoB marks it automatic: triggered (trigger supports/items, InbuiltTrigger), aura/herald/reservation (persistent once on),
// persistent minions (reserving, golems). Totems, traps, mines and brands count: the player places them. Movement, guard,
// warcry, vaal, mark and cooldown buffs count as utility keys. Flasks: "Used when ..." mods and Mageblood-held magic
// utility flasks are automatic; other utility flasks count (often bound to one key or a macro); life/mana/hybrid flasks are
// reactive and enter only the upper bound. Not modelled: key binds, flask macros, skills cast once per map (spectres),
// item-granted skills PoB does not list, players who skip vaal/guard skills.
const lifeManaFlask = /\b(Life|Mana|Hybrid) Flask\b/;
export function flaskButtons(flasks = [], { mageblood = false } = {}) {
  const manual = [], auto = [], reactive = [];
  for (const fl of flasks) {
    const text = fl.text ?? '';
    const name = fl.name ?? fl.base ?? fl.slot;
    const isLifeMana = lifeManaFlask.test(fl.base ?? '') || lifeManaFlask.test(name ?? '');
    const rarity = String(fl.rarity ?? (/Rarity:\s*(\w+)/i.exec(text)?.[1] ?? '')).toUpperCase();
    if (/\bUsed when\b/i.test(text)) auto.push({ name, slot: fl.slot ?? null, reason: 'used_when_mod' });
    else if (mageblood && !isLifeMana && rarity === 'MAGIC') auto.push({ name, slot: fl.slot ?? null, reason: 'mageblood_assumed' });
    else if (isLifeMana) reactive.push({ name, slot: fl.slot ?? null, reason: 'life_mana_reactive' });
    else manual.push({ name, slot: fl.slot ?? null, reason: 'manual_utility' });
  }
  return { manual, auto, reactive };
}
export function classifySkill(s) {
  if (s.disabled) return { kind: 'ignored', reason: 'disabled_by_pob' };
  if (s.owner_cannot_use) return { kind: 'ignored', reason: 'owner_cannot_use' };
  if (s.triggered) return { kind: 'auto', reason: 'triggered' };
  if (s.aura || s.herald || (s.reserves && !s.minion)) return { kind: 'auto', reason: s.aura ? 'aura' : s.herald ? 'herald' : 'reservation' };
  if (s.minion && (s.reserves || s.golem)) return { kind: 'auto', reason: 'persistent_minion' };
  if (s.minion && !s.main) return { kind: 'uncertain', reason: 'minion_summon_recast_unknown' };
  if (s.main || s.totem || s.trap || s.mine || s.brand || s.channel)
    return { kind: 'pressed', reason: s.main ? 'main_skill' : s.totem ? 'totem_placement' : s.trap ? 'trap' : s.mine ? 'mine' : s.brand ? 'brand' : 'channel' };
  // A cooldown alone (Cold Snap, Frost Bomb) is a damage key; buffs without damage tags (Blood Rage) are utility.
  const utility = ['movement', 'guard', 'warcry', 'vaal', 'mark', 'banner', 'link', 'stance'].find(k => s[k]) ?? (s.buff ? 'buff' : null);
  if (utility) return { kind: 'utility', reason: utility };
  return { kind: 'pressed', reason: 'active_skill' };
}
const kindOrder = { pressed: 4, utility: 3, uncertain: 2, auto: 1, ignored: 0 };
export function buttonEstimate(activeSkills, flasks = [], { mageblood = false } = {}) {
  if (!Array.isArray(activeSkills)) return { estimate: null, minimum: null, maximum: null, source: null, reason: 'PoB active skill flags unavailable for this calculation' };
  const seen = new Map();
  for (const s of activeSkills) {
    if (!s?.name) continue;
    const c = classifySkill(s);
    const prev = seen.get(s.name);
    if (!prev || kindOrder[c.kind] > kindOrder[prev.kind]) seen.set(s.name, { name: s.name, group: s.group ?? null, ...c });
  }
  const skills = [...seen.values()];
  const by = k => skills.filter(x => x.kind === k).map(({ name, group, reason }) => ({ name, group, reason }));
  const fl = flaskButtons(flasks, { mageblood });
  const pressed = by('pressed'), utility = by('utility'), uncertain = by('uncertain');
  const estimate = pressed.length + utility.length + fl.manual.length;
  const uncertainty = [];
  if (fl.manual.length > 1) uncertainty.push('manual utility flasks are often bound to one key or a macro');
  if (uncertain.length) uncertainty.push('minion summons may be cast once per map or recast in combat');
  if (fl.reactive.length) uncertainty.push('life/mana flasks are pressed only when needed');
  if (fl.auto.some(x => x.reason === 'mageblood_assumed')) uncertainty.push('Mageblood variant (number of held flasks) is not checked');
  if (utility.some(x => x.reason === 'vaal')) uncertainty.push('vaal skills are pressed rarely');
  return { estimate, minimum: pressed.length, maximum: estimate + uncertain.length + fl.reactive.length,
    skills: { pressed, utility, uncertain, auto: by('auto'), ignored: by('ignored') }, flasks: fl, source: 'pob_active_skill_flags',
    rule: 'estimate = pressed + utility skills + manual utility flasks; minimum = pressed skills only; maximum adds uncertain summons and life/mana flasks. Distinct skill names; see comment in build-card.mjs.',
    uncertainty };
}

// ---------- conversion (WP1): PoB's own conversion table, not recomputed ----------
const convTypes = ['Physical', 'Lightning', 'Cold', 'Fire', 'Chaos'];
const asMap = v => v && !Array.isArray(v) && typeof v === 'object' ? v : {};
export function conversionLinks(table) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return null;
  const links = [], unconverted = {};
  for (const from of convTypes) {
    const row = table[from];
    if (!row) continue;
    if (finite(row.mult) && row.mult < 1) unconverted[from] = Math.round(row.mult * 1000) / 1000;
    for (const [to, v] of Object.entries(asMap(row.conversion))) if (finite(v) && v > 0) links.push({ from, to, kind: 'convert', pct: Math.round(v * 1000) / 10 });
    for (const [to, v] of Object.entries(asMap(row.gain))) if (finite(v) && v > 0) links.push({ from, to, kind: 'gain_as', pct: Math.round(v * 1000) / 10 });
  }
  links.sort((a, b) => convTypes.indexOf(a.from) - convTypes.indexOf(b.from) || convTypes.indexOf(a.to) - convTypes.indexOf(b.to) || a.kind.localeCompare(b.kind));
  // Chains follow PoB's type order (Physical > Lightning > Cold > Fire > Chaos) from types nothing converts into; no arithmetic.
  const chains = [];
  const walk = (type, trail) => {
    const next = [...new Set(links.filter(l => l.from === type && !trail.includes(l.to)).map(l => l.to))];
    if (!next.length) { if (trail.length > 1) chains.push(trail.join(' > ')); return; }
    for (const to of next) walk(to, [...trail, to]);
  };
  const targets = new Set(links.map(l => l.to));
  for (const t of convTypes) if (!targets.has(t) && links.some(l => l.from === t)) walk(t, [t]);
  return { links, unconverted_share: unconverted, chains };
}
export function conversionProfile(conversion, scope = 'player') {
  if (!conversion || typeof conversion !== 'object') return { value: null, reason: 'PoB conversion table not exported for this calculation' };
  const pick = scope === 'minion' ? { minion: conversion.minion } : { skill: conversion.skill, main_hand: conversion.main_hand, off_hand: conversion.off_hand };
  const bases = Object.fromEntries(Object.entries(pick).map(([k, t]) => [k, conversionLinks(t)]).filter(([, v]) => v));
  if (!Object.keys(bases).length) return { value: null, reason: scope === 'minion' ? 'PoB gives no conversion table for the minion main skill' : 'PoB gives no conversion table for the main skill' };
  // Attacks use per-hand tables, others the skill table. Tables equal to the primary one are not repeated.
  const primary = scope === 'minion' ? 'minion' : ['main_hand', 'off_hand'].find(k => bases[k]) ?? 'skill';
  const main = bases[primary];
  const other = Object.entries(bases).filter(([k, v]) => k !== primary && canonicalJson(v.links) !== canonicalJson(main.links)).map(([k, v]) => ({ basis: k, ...v }));
  return { value: { source: 'pob_conversion_table', basis: primary, ...main, has_conversion: main.links.some(l => l.kind === 'convert'), has_gain_as: main.links.some(l => l.kind === 'gain_as'),
    other_bases: other, note: 'pct = PoB conversion / gain-as fraction of the source type after scaling (skill conversion first, total capped at 100%); final type shares: damage.types.' } };
}

// ---------- engine-backed ----------
export function chooseMainGroup({ file, input, scenario, build, isSupport, minDps = 1000 }) {
  const saved = runPob({ input, scenario, full: true });
  const dpsOf = res => Math.max(effectiveDps(res.output).value ?? 0, res.minion_output ? effectiveDps(res.minion_output).value ?? 0 : 0);
  if (dpsOf(saved) >= minDps) return { result: saved, saved: build.main_socket_group, chosen: build.main_socket_group, reason: 'saved' };
  const groups = build.groups.filter(g => g.enabled && g.index !== build.main_socket_group && g.gems.some(x => x.enabled && !isSupport(x))).slice(0, 12);
  let best = { result: saved, index: build.main_socket_group, dps: dpsOf(saved) };
  for (const g of groups) {
    let res; try { res = runPob({ input, scenario, full: true, changes: { selection: { main_socket_group: g.index } } }); } catch { continue; }
    const d = dpsOf(res);
    if (d > best.dps) best = { result: res, index: g.index, dps: d };
  }
  return { result: best.result, saved: build.main_socket_group, chosen: best.index, reason: best.index === build.main_socket_group ? 'no_damaging_group_found' : `saved group deals < ${minDps} DPS; strongest of ${groups.length} groups chosen by PoB` };
}

export function buildCard({ file, scenario = 'sustained', ablation = null, source = null, trust = null } = {}) {
  const input = fs.readFileSync(file);
  const build = readBuild(file);
  const gems = pobGems();
  // The saved main socket group can be an aura or utility skill (DPS ~0). Then PoB calculates every enabled group
  // with an active gem as the main skill and the card describes the strongest; the choice is reported.
  const selection = chooseMainGroup({ file, input, scenario, build, isSupport: isSupportGem(gems) });
  const r = selection.result;
  const o = r.output ?? {};
  if (selection.chosen !== build.main_socket_group) build.main_socket_group = selection.chosen;
  let tree = null; try { tree = loadTree(); } catch { tree = null; }
  const nodeOf = id => tree?.nodes.get(Number(id));
  const allocated = [...build.allocated].map(nodeOf).filter(Boolean);
  const keystones = allocated.filter(n => n.type === 'keystone').map(n => n.name).sort();
  const ascNotables = allocated.filter(n => n.ascendancy && n.type === 'notable').map(n => n.name).sort();
  const main = build.groups[build.main_socket_group - 1];
  const info = g => gems.get(g.skill_id) ?? null;
  const isSupport = isSupportGem(gems);
  // PoB's own main skill (mainSkill.activeEffect) decides; the group's gem with that name supplies level/quality.
  const mainActive = (r.main_skill?.name && main?.gems.find(g => g.enabled && g.name === r.main_skill.name)) || main?.gems.find(g => g.enabled && !isSupport(g)) || null;
  const mainName = r.main_skill?.name ?? mainActive?.name ?? null;
  const activeSkills = build.groups.filter(g => g.enabled).flatMap(g => g.gems.filter(x => x.enabled && !isSupport(x)).map(x => ({ name: x.name, group: g.index, slot: g.slot, item_granted: !!g.source,
    tags: Object.keys(info(x)?.tags ?? {}).filter(t => info(x).tags[t] === true).sort() })));
  const uniques = (r.equipped_items ?? []).filter(i => String(i.rarity).toUpperCase() === 'UNIQUE' && !/Swap/.test(i.slot)).map(i => i.base && i.name.endsWith(`, ${i.base}`) ? i.name.slice(0, -(i.base.length + 2)) : i.name).sort();
  let defaults = null; try { defaults = newPob({ className: build.class }).config ?? null; } catch { defaults = null; }
  const assumptions = defaults ? planConfigAblation(r.config ?? {}, defaults).map(p => ({ key: p.target.key, value: p.target.value, default: p.target.reset })) : null;
  // Minion builds: the player's main skill deals nothing itself; the profile comes from the minion output
  // (per minion; FullDPS of the player counts every included minion).
  const playerDamage = damageProfile(o);
  const minionDamage = !(playerDamage.effective_dps > 0) && r.minion_output ? damageProfile(r.minion_output) : null;
  const damage = minionDamage ? { ...minionDamage, scope: 'minion', full_dps: r0(o.FullDPS), note: `${minionDamage.note} Minion values are per minion; full_dps is the player FullDPS over all included skills/minions.` } : { ...playerDamage, scope: 'player' };
  const conversion = conversionProfile(r.conversion, damage.scope);
  damage.conversion = conversion.value;
  if (!conversion.value) damage.conversion_reason = conversion.reason + (r.card_export_error ? ` (PoB export error: ${r.card_export_error})` : '');
  const flasks = (r.equipped_items ?? []).filter(i => /^Flask \d/.test(i.slot)).sort((a, b) => a.slot.localeCompare(b.slot))
    .map(i => ({ slot: i.slot, name: i.name, base: i.base, rarity: i.rarity, text: build.slots?.get(i.slot) ?? '' }));
  const buttons = buttonEstimate(r.active_skills, flasks, { mageblood: uniques.includes('Mageblood') });
  if (r.card_export_error && buttons.estimate == null) buttons.reason += ` (PoB export error: ${r.card_export_error})`;
  const defense = defenseProfile(o, keystones);
  // features.buttons is informational; signatureOf ignores it, so v1 and v2 signatures of one build are equal.
  const features = { class: r.class ?? build.class, ascendancy: r.ascendancy ?? build.ascendancy ?? null, main_skill: mainName,
    damage_scope: damage.scope, primary_form: damage.primary_form, primary_type: damage.primary_type, defense_pool: defense.pool, defense_layers: defense.layers, keystones, uniques, buttons: buttons.estimate };
  const lock = readJson(path.join(dbRoot, 'environment.lock.json'));
  return {
    schema_version: 2, kind: 'build_card', signature: signatureOf(features), features,
    identity: { file: path.basename(file), pob_sha256: r.input_sha256, level: r.level, class: features.class, ascendancy: features.ascendancy, scenario,
      source: source ?? null, trust: trust ?? null, patch: lock.patch, versions: { pob: lock.versions.pob, repoe: lock.versions.repoe, ggg_tree: lock.versions.ggg_tree }, calculation_id: r.calculation_id },
    skills: { main_selection: { saved_group: selection.saved, chosen_group: selection.chosen, reason: selection.reason }, main: mainActive || mainName ? { name: mainName, minion: r.main_skill?.minion ?? null, level: mainActive?.level ?? null, quality: mainActive?.quality ?? null, supports: (main?.gems ?? []).filter(g => g.enabled && isSupport(g)).map(g => g.name),
      tags: mainActive ? Object.keys(info(mainActive)?.tags ?? {}).filter(t => info(mainActive).tags[t] === true).sort() : [] } : null,
      active: activeSkills, active_count: activeSkills.filter(s => !s.item_granted).length, applied_supports: (r.applied_supports ?? []).map(s => s.name) },
    damage, defense, resources: resourceProfile(o), buttons,
    // Build basics (WP5b): sustain sources, attribute headroom, masteries, eldritch, clusters, anoint, flasks. Additive field.
    foundation: foundationOf({ build, output: o, equipped: r.equipped_items ?? [], tree, keystones, scope: damage.scope, uniques }),
    tree: { points: r.allocated_points ?? null, keystones, ascendancy_notables: ascNotables, notables: allocated.filter(n => n.type === 'notable' && !n.ascendancy).length },
    items: { uniques, equipped: (r.equipped_items ?? []).filter(i => !/Swap/.test(i.slot)).map(i => ({ slot: i.slot, rarity: i.rarity, name: i.name, base: i.base })) },
    assumptions, architecture: ablation ? architectureSplit(ablation) : null,
    quality: { engine_warnings: r.engine_warnings ?? [], unparsed_item_modifiers: (r.unparsed_item_modifiers ?? []).length, skill_disabled_reason: null },
    comparability: 'Compare cards only at equal scenario, similar level and stated assumptions; numbers are PoB, not game tests.',
    created_at: new Date().toISOString()
  };
}

// ---------- store and CLI ----------
export function saveCard(card, directory = cardDirectory()) {
  const file = path.join(directory, `${card.identity.pob_sha256.slice(0, 16)}.json`);
  const duplicates = listCards(directory).filter(c => c.signature === card.signature && c.pob_sha256 !== card.identity.pob_sha256).map(c => c.file);
  atomicJson(file, card);
  return { saved: file, signature: card.signature, same_signature: duplicates };
}
export function listCards(directory = cardDirectory()) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(f => f.endsWith('.json')).sort().map(f => {
    const c = readJson(path.join(directory, f));
    return { file: f, signature: c.signature, pob_sha256: c.identity.pob_sha256, name: c.identity.file, class: c.features.class, ascendancy: c.features.ascendancy,
      main_skill: c.features.main_skill, schema_version: c.schema_version ?? 1, buttons: c.buttons?.estimate ?? null, form: c.features.primary_form, type: c.features.primary_type, pool: c.features.defense_pool, dps: c.damage.effective_dps, ehp: c.defense.ehp };
  });
}
// ---------- diff (WP1): structural difference of two cards; v1 cards read, missing v2 fields reported ----------
const setDiff = (a, b) => {
  const A = new Set(a ?? []), B = new Set(b ?? []);
  return { added: [...B].filter(x => !A.has(x)).sort(), removed: [...A].filter(x => !B.has(x)).sort() };
};
const nonEmpty = d => d.added.length || d.removed.length;
const numDelta = (a, b) => finite(a) && finite(b) ? { a, b, delta: Math.round((b - a) * 10) / 10, pct: a !== 0 ? Math.round((b - a) / Math.abs(a) * 1000) / 10 : null } : { a: a ?? null, b: b ?? null, delta: null, pct: null };
const linkKey = l => `${l.from}>${l.to}:${l.kind}`;
export function diffCards(a, b) {
  if (a?.kind !== 'build_card' || b?.kind !== 'build_card') throw new Error('diff expects two build_card JSON files (build card <xml> --out f.json or research/lab/cards/*.json)');
  const notes = [];
  const va = a.schema_version ?? 1, vb = b.schema_version ?? 1;
  if (va !== vb) notes.push(`schema_version differs (${va} vs ${vb}); fields absent in an older card are reported as not_in_card`);
  if (a.identity?.scenario !== b.identity?.scenario) notes.push(`scenario differs (${a.identity?.scenario} vs ${b.identity?.scenario}); numbers are not comparable`);
  if (finite(a.identity?.level) && finite(b.identity?.level) && Math.abs(a.identity.level - b.identity.level) > 5) notes.push(`level differs by ${Math.abs(a.identity.level - b.identity.level)}`);
  const ver = c => canonicalJson(c.identity?.versions ?? null);
  if (ver(a) !== ver(b)) notes.push('engine/data versions differ');
  const fa = a.features ?? {}, fb = b.features ?? {};
  const scalar = ['class', 'ascendancy', 'main_skill', 'damage_scope', 'primary_form', 'primary_type', 'defense_pool'];
  const features = Object.fromEntries(scalar.filter(k => (fa[k] ?? null) !== (fb[k] ?? null)).map(k => [k, { a: fa[k] ?? null, b: fb[k] ?? null }]));
  const sets = { defense_layers: setDiff(fa.defense_layers, fb.defense_layers), keystones: setDiff(fa.keystones, fb.keystones), uniques: setDiff(fa.uniques, fb.uniques),
    ascendancy_notables: setDiff(a.tree?.ascendancy_notables, b.tree?.ascendancy_notables), supports: setDiff(a.skills?.main?.supports, b.skills?.main?.supports),
    active_skills: setDiff((a.skills?.active ?? []).map(s => s.name), (b.skills?.active ?? []).map(s => s.name)) };
  const slotMap = c => new Map((c.items?.equipped ?? []).map(i => [i.slot, i.name]));
  const sa = slotMap(a), sb = slotMap(b);
  const items = [...new Set([...sa.keys(), ...sb.keys()])].sort().filter(s => sa.get(s) !== sb.get(s)).map(slot => ({ slot, a: sa.get(slot) ?? null, b: sb.get(slot) ?? null }));
  const parts = [...new Set([...Object.keys(a.damage?.parts ?? {}), ...Object.keys(b.damage?.parts ?? {})])];
  const types = [...new Set([...Object.keys(a.damage?.types ?? {}), ...Object.keys(b.damage?.types ?? {})])];
  const shareDelta = (x, y, keys) => Object.fromEntries(keys.map(k => [k, Math.round(((y?.[k] ?? 0) - (x?.[k] ?? 0)) * 1000) / 1000]).filter(([, v]) => v !== 0));
  const conv = c => (c.schema_version ?? 1) < 2 ? 'not_in_card' : c.damage?.conversion ?? null;
  const ca = conv(a), cb = conv(b);
  const conversion = ca === 'not_in_card' || cb === 'not_in_card' ? { status: 'not_in_card', a: ca === 'not_in_card' ? ca : 'present', b: cb === 'not_in_card' ? cb : 'present' }
    : (() => { const la = new Map((ca?.links ?? []).map(l => [linkKey(l), l])), lb = new Map((cb?.links ?? []).map(l => [linkKey(l), l]));
      return { status: !ca && !cb ? 'unavailable_both' : 'compared', added: [...lb.keys()].filter(k => !la.has(k)).map(k => lb.get(k)), removed: [...la.keys()].filter(k => !lb.has(k)).map(k => la.get(k)),
        changed: [...la.keys()].filter(k => lb.has(k) && la.get(k).pct !== lb.get(k).pct).map(k => ({ link: k, a: la.get(k).pct, b: lb.get(k).pct })),
        chains: setDiff(ca?.chains, cb?.chains), reason: !ca || !cb ? { a: a.damage?.conversion_reason ?? null, b: b.damage?.conversion_reason ?? null } : undefined }; })();
  const btn = c => (c.schema_version ?? 1) < 2 || !c.buttons ? null : c.buttons;
  const ba = btn(a), bb = btn(b);
  const pressedNames = x => [...(x?.skills?.pressed ?? []), ...(x?.skills?.utility ?? [])].map(s => s.name);
  const buttons = !ba || !bb ? { status: 'not_in_card', a: ba ? ba.estimate : 'not_in_card', b: bb ? bb.estimate : 'not_in_card' }
    : { status: 'compared', estimate: numDelta(ba.estimate, bb.estimate), range_a: [ba.minimum, ba.maximum], range_b: [bb.minimum, bb.maximum], skills: setDiff(pressedNames(ba), pressedNames(bb)),
      manual_flasks: setDiff((ba.flasks?.manual ?? []).map(f => f.name), (bb.flasks?.manual ?? []).map(f => f.name)) };
  const maxHit = Object.fromEntries(damageTypes.map(t => [t, numDelta(a.defense?.max_hit?.[t], b.defense?.max_hit?.[t])]).filter(([, v]) => v.delta));
  const resists = Object.fromEntries(['Fire', 'Cold', 'Lightning', 'Chaos'].map(t => [t, numDelta(a.defense?.resists?.[t], b.defense?.resists?.[t])]).filter(([, v]) => v.delta));
  const asm = c => new Map((c.assumptions ?? []).map(x => [x.key, x.value]));
  const aa = asm(a), ab = asm(b);
  const assumptions = [...new Set([...aa.keys(), ...ab.keys()])].sort().filter(k => canonicalJson(aa.get(k) ?? null) !== canonicalJson(ab.get(k) ?? null)).map(key => ({ key, a: aa.get(key) ?? null, b: ab.get(key) ?? null }));
  const same = a.signature === b.signature;
  return { analysis: 'card_diff', a: { file: a.identity?.file ?? null, signature: a.signature, schema_version: va }, b: { file: b.identity?.file ?? null, signature: b.signature, schema_version: vb },
    same_signature: same, structural_changes: Object.keys(features).length + Object.values(sets).filter(nonEmpty).length,
    features, sets: Object.fromEntries(Object.entries(sets).filter(([, d]) => nonEmpty(d))), items,
    damage: { effective_dps: numDelta(a.damage?.effective_dps, b.damage?.effective_dps), full_dps: numDelta(a.damage?.full_dps, b.damage?.full_dps), parts: shareDelta(a.damage?.parts, b.damage?.parts, parts), types: shareDelta(a.damage?.types, b.damage?.types, types), conversion },
    defense: { ehp: numDelta(a.defense?.ehp, b.defense?.ehp), life: numDelta(a.defense?.life, b.defense?.life), energy_shield: numDelta(a.defense?.energy_shield, b.defense?.energy_shield), weakest_type: { a: a.defense?.weakest_type ?? null, b: b.defense?.weakest_type ?? null }, max_hit: maxHit, resists },
    resources: { mana_sustain_per_second: numDelta(a.resources?.mana_sustain_per_second, b.resources?.mana_sustain_per_second), sustained: { a: a.resources?.sustained ?? null, b: b.resources?.sustained ?? null } },
    buttons, tree: { points: { a: a.tree?.points?.passive ?? null, b: b.tree?.points?.passive ?? null }, notables: numDelta(a.tree?.notables, b.tree?.notables) }, assumptions, notes,
    comparability: 'Structural facts are exact; numeric deltas are PoB estimates and comparable only at equal scenario and stated assumptions.' };
}
const readCardFile = (file, directory = cardDirectory()) => {
  let p = path.resolve(file);
  if (!fs.existsSync(p) && fs.existsSync(path.join(directory, file))) p = path.join(directory, file);
  if (/\.xml$/i.test(p)) throw new Error(`build card diff reads card JSON; make one first: build card "${file}" --out card.json`);
  return readJson(p);
};
export function cardCommand(args) {
  const { positional, options } = flags(args, ['scenario', 'ablation', 'source', 'trust', 'out', 'dir'], ['save', 'brief']);
  const directory = options.dir ? path.resolve(options.dir) : cardDirectory();
  if (positional[0] === 'list') return { directory, cards: listCards(directory) };
  if (positional[0] === 'diff') {
    if (positional.length !== 3) throw new Error('Use build card diff <a.json> <b.json> (card JSON or a file name in research/lab/cards)');
    const out = diffCards(readCardFile(positional[1], directory), readCardFile(positional[2], directory));
    if (options.out) atomicJson(path.resolve(options.out), out);
    return out;
  }
  if (!positional[0]) throw new Error('Use build card <xml> [--ablation ablate.json] [--save] | build card list');
  if (options.trust && !['own', 'author', 'community', 'generated', 'unknown'].includes(options.trust)) throw new Error('--trust must be own|author|community|generated|unknown');
  const card = buildCard({ file: path.resolve(positional[0]), scenario: options.scenario ?? 'sustained', ablation: options.ablation ? readJson(path.resolve(options.ablation)) : null,
    source: options.source ?? null, trust: options.trust ?? null });
  const out = options.save ? { ...card, store: saveCard(card, directory) } : card;
  if (options.out) atomicJson(path.resolve(options.out), out);
  return options.brief ? { signature: card.signature, features: card.features, damage: { effective_dps: card.damage.effective_dps, form: card.damage.primary_form, type: card.damage.primary_type },
    defense: { pool: card.defense.pool, ehp: card.defense.ehp, weakest: card.defense.weakest_type, layers: card.defense.layers },
    buttons: { estimate: card.buttons.estimate, minimum: card.buttons.minimum, maximum: card.buttons.maximum }, conversion: card.damage.conversion ? card.damage.conversion.chains : card.damage.conversion_reason, architecture: card.architecture, store: out.store } : out;
}
export const cardHelp = {
  'build card <xml> [--ablation ablate.json] [--scenario S] [--source text] [--trust own|author|community|generated|unknown] [--save] [--brief] [--out f.json] | build card list':
    'BuildCard v2: structured snapshot (skill, button estimate from PoB skill flags, PoB conversion chain, damage form/types, defense model and layers, resources, keystones, uniques, config assumptions, core/implementation/replaceable from ablation) with a structural signature; --save stores it locally (research/lab/cards)',
  'build card diff <a.json> <b.json> [--out f.json]': 'Structural difference of two cards: features, keystones/uniques/supports/skills, slots, damage/defense deltas, buttons, conversion links, assumptions; v1 cards are read, missing v2 fields reported as not_in_card'
};
