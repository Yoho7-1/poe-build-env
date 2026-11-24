// Build foundations (WP5/WP7): the "basics" every finished build solves - how mana and life are sustained, how much
// attribute headroom is carried over the requirement, which free power layers are used (masteries, eldritch implicits,
// cluster jewels, anoint, automatic flasks) and which keystones. Numbers come from the PoB output (ManaLeechGainRate,
// ManaRegenRecovery, Str/ReqStr, ...) and the PoB XML (mastery effects, item text); nothing is recomputed here.
// foundationOf is pure: build (readBuild), output and equipped items (a PoB result), the loaded tree, keystones.
import { flaskButtons } from './build-card.mjs';

export const FOUNDATION_SCHEMA = 'foundation/1';
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const r1 = v => num(v) == null ? null : Math.round(v * 10) / 10;
const GEAR = ['Helmet', 'Body Armour', 'Gloves', 'Boots'];
const lines = text => String(text ?? '').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);

// Primary source = the largest recovery per second; leech/regen/on-hit are PoB numbers for the main skill.
export function manaProfile(o, { keystones = [], scope = 'player' } = {}) {
  const ks = new Set(keystones);
  const cost = num(o.ManaPerSecondCost) ?? 0, lifeCost = num(o.LifePerSecondCost) ?? 0, esCost = num(o.ESPerSecondCost) ?? 0;
  const rates = { leech: num(o.ManaLeechGainRate) ?? 0, regen: num(o.ManaRegenRecovery) ?? num(o.ManaRegen) ?? 0, on_hit: num(o.ManaOnHitRate) ?? 0 };
  const sources = Object.entries(rates).filter(([, v]) => v > 0).map(([k]) => k);
  if ((num(o.ManaRecoup) ?? 0) > 0) sources.push('recoup');
  if (ks.has('Eldritch Battery')) sources.push('eldritch_battery');
  let primary;
  if (ks.has('Eldritch Battery')) primary = 'eldritch_battery';
  else if (cost <= 0 && lifeCost > 0) primary = 'life_cost';
  else if (cost <= 0 && esCost > 0) primary = 'es_cost';
  else if (cost <= 0) primary = 'no_cost';
  else primary = Object.entries(rates).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(rates).sort((a, b) => b[1] - a[1])[0][0] : 'none';
  const sustain = rates.regen + rates.leech - cost;
  return { applies: scope !== 'minion' && cost > 0, primary, sources, cost_per_s: r1(cost), leech_per_s: r1(rates.leech), regen_per_s: r1(rates.regen), on_hit_per_s: r1(rates.on_hit),
    life_cost_per_s: r1(lifeCost), sustain_per_s: r1(sustain), leech_share: cost > 0 ? r1(rates.leech / cost) : null, regen_share: cost > 0 ? r1(rates.regen / cost) : null,
    unreserved: num(o.ManaUnreserved), reserved_pct: r1(o.ManaReservedPercent) };
}

export function lifeProfile(o) {
  const life = num(o.Life) ?? 0;
  const rates = { leech: num(o.LifeLeechGainRate) ?? 0, regen: num(o.LifeRegenRecovery) ?? 0, es_leech: num(o.EnergyShieldLeechGainRate) ?? 0 };
  const sources = Object.entries(rates).filter(([, v]) => v > 0).map(([k]) => k);
  if ((num(o.LifeRecoup) ?? 0) > 0) sources.push('recoup');
  if ((num(o.EnergyShieldRecharge) ?? 0) > 0 && (num(o.EnergyShield) ?? 0) > life * 0.5) sources.push('es_recharge');
  const top = Object.entries(rates).sort((a, b) => b[1] - a[1])[0];
  return { sources, primary: top[1] > 0 ? top[0] : (num(o.LifeRecoup) ?? 0) > 0 ? 'recoup' : 'none', leech_per_s: r1(rates.leech), regen_per_s: r1(rates.regen),
    regen_pct: life > 0 ? r1(rates.regen / life * 100) : null, leech_pct: life > 0 ? r1(rates.leech / life * 100) : null, recoup_pct: r1(o.LifeRecoup) };
}

// Headroom over the highest requirement (PoB ReqStr/ReqDex/ReqInt; Omniscience uses ReqOmni/Omni).
export function attributeProfile(o) {
  const out = {};
  if (num(o.ReqOmni) != null) {
    const v = num(o.Omni) ?? null, req = num(o.ReqOmni);
    return { omniscience: true, omni: { value: v, req, slack: v != null ? v - req : null }, slack_total: v != null ? Math.max(0, v - req) : null, max_slack: v != null ? v - req : null, unmet: v != null && v < req ? ['omni'] : [], requirements_known: true };
  }
  const known = ['Str', 'Dex', 'Int'].some(k => num(o['Req' + k]) != null);
  for (const k of ['Str', 'Dex', 'Int']) {
    const v = num(o[k]), req = num(o['Req' + k]) ?? (known ? 0 : null);
    out[k.toLowerCase()] = { value: v, req, slack: v != null && req != null ? v - req : null };
  }
  const slacks = Object.values(out).map(a => a.slack).filter(s => s != null);
  return { omniscience: false, ...out, slack_total: slacks.length ? slacks.filter(s => s > 0).reduce((a, b) => a + b, 0) : null, max_slack: slacks.length ? Math.max(...slacks) : null,
    unmet: Object.entries(out).filter(([, a]) => a.slack != null && a.slack < 0).map(([k]) => k), requirements_known: known };
}

const masteryOf = (tree, m) => {
  const n = tree?.nodes.get(m.node);
  const e = n?.mastery_effects?.find(x => x.effect === m.effect);
  return { mastery: n?.name ?? null, effect: m.effect, text: e ? e.stats.join(' / ') : null };
};
export function eldritchOf(slots) {
  const items = [];
  for (const slot of GEAR) {
    const ls = lines(slots?.get?.(slot));
    const exarch = ls.filter(l => /\{exarch\}/.test(l)).length, eater = ls.filter(l => /\{eater\}/.test(l)).length;
    if (exarch || eater) items.push({ slot, exarch, eater });
  }
  return { items: items.length, slots: items.map(i => i.slot), exarch: items.reduce((a, i) => a + i.exarch, 0), eater: items.reduce((a, i) => a + i.eater, 0) };
}
export function clustersOf(equipped = []) {
  const c = { large: 0, medium: 0, small: 0 };
  for (const i of equipped) { const m = /^(Large|Medium|Small) Cluster Jewel$/.exec(i.base ?? ''); if (m && !/Swap/.test(i.slot ?? '')) c[m[1].toLowerCase()]++; }
  return { ...c, total: c.large + c.medium + c.small };
}
export function anointOf(slots) {
  const l = lines(slots?.get?.('Amulet')).find(x => /^(\{[^}]*\})*Allocates /.test(x));
  return l ? l.replace(/^(\{[^}]*\})*Allocates /, '') : null;
}

// Foundation check (WP5b): deviations of one build from corpus norms (corpus-norms.mjs normsOf) as warnings, never as
// hard failures - norms describe popular guides, not the optimum. Each warning carries the build value and the norm.
// A layer counts as "expected" when at least `expect` of the norm group uses it.
export function foundationCheck(f, norms, { expect = 0.5 } = {}) {
  if (!f || !norms?.builds) return { status: 'no_norms', warnings: [], note: 'No corpus norms for this group (run corpus norms --backfill).' };
  const w = [];
  const add = (code, detail, evidence, severity = 'warn') => w.push({ code, severity, detail, evidence });
  const m = f.mana, nm = norms.mana;
  if (m?.applies) {
    if ((m.sustain_per_s ?? 0) < 0) add('mana_sustain_deficit', `mana recovery ${m.regen_per_s + m.leech_per_s + m.on_hit_per_s}/s < cost ${m.cost_per_s}/s (${m.sustain_per_s}/s)`,
      `corpus: ${pct(nm.sustain_deficit)} of builds with a mana cost show a deficit in PoB`, (nm.sustain_deficit ?? 0) >= expect ? 'info' : 'warn');
    if (m.primary === 'regen' && !((m.leech_per_s ?? 0) > 0) && (nm.uses_leech ?? 0) >= 0.3)
      add('mana_regen_without_leech', `mana is sustained by regeneration only (${m.regen_per_s}/s, no leech)`, `corpus: ${pct(nm.uses_leech)} use mana leech; regen-only ${pct(nm.regen_primary_without_leech)}`);
  }
  const a = f.attributes, na = norms.attributes;
  if (a?.unmet?.length) add('attribute_unmet', `unmet requirement: ${a.unmet.join(', ')}`, 'gems/items with unmet requirements are disabled in game', 'fail');
  if (a?.requirements_known && na?.slack_total && a.slack_total != null && a.slack_total > na.slack_total.p90)
    add('attribute_surplus', `+${a.slack_total} attributes over requirements (largest ${a.max_slack})`, `corpus slack_total median ${na.slack_total.median}, p90 ${na.slack_total.p90}`);
  const nmas = norms.masteries?.count;
  if (nmas && (f.masteries?.count ?? 0) < Math.min(nmas.p10, nmas.median)) add('masteries_low', `${f.masteries?.count ?? 0} masteries`, `corpus median ${nmas.median}, p10 ${nmas.p10}`);
  const layer = (code, used, share, detail) => { if (!used && (share ?? 0) >= expect) add(code, detail, `corpus: ${pct(share)} of builds use it`); };
  layer('no_eldritch_implicits', (f.eldritch?.items ?? 0) > 0, norms.eldritch?.uses, 'no eldritch implicits on helmet/body/gloves/boots');
  layer('no_cluster_jewels', (f.clusters?.total ?? 0) > 0, norms.clusters?.uses, 'no cluster jewels');
  layer('no_auto_flasks', (f.flasks?.auto ?? 0) > 0, norms.flasks?.uses_auto, `no automatic flasks (${f.flasks?.manual ?? 0} pressed manually)`);
  layer('no_anoint', !!f.anoint, norms.anoint?.uses, 'amulet without anoint');
  const ksShare = new Map((norms.keystones?.top ?? []).map(k => [k.value, k.share]));
  const rare = (f.keystones ?? []).filter(k => !ksShare.has(k));
  if (rare.length && norms.builds >= 8) add('keystone_unusual', `keystones not seen in the norm group: ${rare.join(', ')}`, `group of ${norms.builds} builds; check the keystone serves the archetype`, 'info');
  const level = w.some(x => x.severity === 'fail') ? 'fail' : w.some(x => x.severity === 'warn') ? 'warn' : 'ok';
  return { status: level, warnings: w, counts: { fail: w.filter(x => x.severity === 'fail').length, warn: w.filter(x => x.severity === 'warn').length, info: w.filter(x => x.severity === 'info').length } };
}
const pct = v => v == null ? '?' : `${Math.round(v * 100)}%`;

export function foundationOf({ build, output = {}, equipped = [], tree = null, keystones = [], scope = 'player', uniques = [] }) {
  const flasks = equipped.filter(i => /^Flask \d/.test(i.slot ?? '')).sort((a, b) => a.slot.localeCompare(b.slot))
    .map(i => ({ slot: i.slot, name: i.name, base: i.base, rarity: i.rarity, text: build?.slots?.get?.(i.slot) ?? '' }));
  const fb = flaskButtons(flasks, { mageblood: uniques.includes('Mageblood') });
  const masteries = (build?.masteries ?? []).map(m => masteryOf(tree, m));
  return {
    schema: FOUNDATION_SCHEMA, scope,
    mana: manaProfile(output, { keystones, scope }), life: lifeProfile(output), attributes: attributeProfile(output),
    masteries: { count: masteries.length, effects: masteries },
    eldritch: eldritchOf(build?.slots), clusters: clustersOf(equipped), anoint: anointOf(build?.slots),
    flasks: { count: flasks.length, auto: fb.auto.length, manual: fb.manual.length, reactive: fb.reactive.length },
    keystones: [...keystones].sort()
  };
}
