// WP11 stage 1: layer decisions and mana repair for design prototypes (used by design-generate.mjs).
//  probeKitLayers      : eldritch implicits, automatic flasks, amulet anoint - each probed by PoB against the same kit
//                        without it; a layer that does not pay off is removed.
//  repairManaFromCorpus: mana deficit repair from the components the corpus norm group of the skill family uses more
//                        often in PoB-sustained builds than in deficit builds, plus the kit mana affix of the family's
//                        main mana source (leech or regen share of the norms); every candidate is a PoB probe.
// Engine helpers (batch, runPob wrapper, prototypeChanges ...) are injected by the generator through `ctx`.
import fs from 'node:fs';
import { runPob } from './pob.mjs';
import { itemKit, ELDRITCH_SLOTS } from './design-kit.mjs';
import { anointOptions, withAnoint, supportCompatible } from './analysis-candidates.mjs';
import { sustainComponents, chooseNormGroup } from './corpus-norms.mjs';
import { connectOne } from './tree-graph.mjs';
import { metrics as coreMetrics } from './analysis-core.mjs';
import { damageOf } from './analysis-encounter.mjs';
import * as B from './design-blueprint.mjs';

const round = (v, d = 0) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
export const bestDps = r => r && !r.error ? damageOf(r.output ?? {}, null, r.minion_output).best_dps ?? 0 : 0;
export const unmetAttrs = r => [...new Set((r?.engine_warnings ?? []).map(w => /do not meet the (Strength|Dexterity|Intelligence) requirement/i.exec(w)?.[1]).filter(Boolean))].map(a => a.slice(0, 3).toLowerCase());
export const sustainOf = r => coreMetrics.mana_sustain.read(r?.output ?? {});
export const cannotPay = r => { const o = r?.output ?? {}; return o.ManaUnreserved != null && o.ManaCost != null && o.ManaUnreserved < o.ManaCost; };

// ---------- layer value ----------
// value = % DPS + % EHP (+ % movement speed for flasks) of the variant over its alternative on the same resource.
export const valueOf = r => ({ dps: bestDps(r), ehp: r?.output?.TotalEHP ?? 0, ms: r?.output?.EffectiveMovementSpeedMod ?? 1, sustain: sustainOf(r) ?? 0, unmet: unmetAttrs(r).length });
export function layerGain(a, b, { ms = false } = {}) {
  const pct = (x, y) => y > 0 ? (x / y - 1) * 100 : 0;
  const dps = pct(a.dps, b.dps), ehp = pct(a.ehp, b.ehp), mv = ms ? pct(a.ms, b.ms) : 0;
  return { dps_pct: round(dps, 1), ehp_pct: round(ehp, 1), ...(ms ? { ms_pct: round(mv, 1) } : {}), total: round(dps + ehp + mv, 2) };
}
// A layer whose removal breaks mana sustain or attribute requirements is kept.
export function layerGuard(withV, without) {
  if (withV.sustain >= 0 && without.sustain < 0) return 'removing it leaves mana unsustained';
  if (without.unmet > withV.unmet) return 'removing it leaves attribute requirements unmet';
  return null;
}
export function decideLayer(withV, without, opts = {}) {
  const gain = layerGain(withV, without, opts), guard = layerGuard(withV, without);
  return { taken: gain.total > 0 || !!guard, gain, guard };
}
// decided_by says what settled the layer, so a reader (and the basics check) never has to parse the prose reason:
//   pob_probe          - compared with the alternative by PoB probes;
//   no_option          - nothing to compare (no eldritch line, no socket in reach, the norm reserves no points);
//   budget             - not probed for want of calculation budget: nothing was compared;
//   alternative_failed - the alternative itself errored in PoB;
//   author_build       - a corpus seed: the layer is the author's, not re-probed.
export const DECIDED_BY = ['pob_probe', 'no_option', 'budget', 'alternative_failed', 'author_build'];
export function layerRecord(layer, taken, gain, alternative, reason, extra = {}) {
  const { decided_by = 'pob_probe', ...rest } = extra;
  return { layer, taken, gain_vs_alternative: gain, alternative, reason, decided_by, ...rest };
}

export const slotItem = (c, slot) => (c.replace_items ?? []).find(i => i.slot === slot);
// map: slot -> item (replace) or null (remove the slot's item).
export const withItems = (c, map) => ({ ...c, replace_items: (c.replace_items ?? []).flatMap(i => i.slot in map ? (map[i.slot] ? [map[i.slot]] : []) : [i]) });
const sign = g => g ? `${g.total >= 0 ? '+' : ''}${g.total}%` : '-';

// ---------- kit layers ----------
export function probeKitLayers({ ctx, file, final, finalChanges, proto, row, budget, normAnoints = [], anointTaken = null }) {
  const { batch } = ctx;
  const layers = [];
  let c = finalChanges, r = final;
  const run1 = changes => { budget.take(1); return runPob({ input: fs.readFileSync(file), scenario: 'sustained', changes }); };
  // eldritch implicits: each armour slot with vs without (the same item text otherwise)
  const noEld = itemKit({ ...proto.kitArgs, axes: null });
  const eldSlots = ELDRITCH_SLOTS.filter(s => slotItem(c, s) && slotItem(noEld, s) && slotItem(c, s).text !== slotItem(noEld, s).text);
  if (!eldSlots.length) layers.push(layerRecord('eldritch', false, null, 'kit without eldritch implicits', 'no eldritch implicit on the kit (no axis line for this skill)', { decided_by: 'no_option' }));
  else {
    const off = slots => withItems(c, Object.fromEntries(slots.map(s => [s, slotItem(noEld, s)])));
    const variants = [off(eldSlots), ...eldSlots.map(s => off([s]))];
    const res = batch(file, variants, budget);
    const v1 = valueOf(r), all = res.get?.(variants[0]);
    if (!all || all.error) layers.push(layerRecord('eldritch', true, null, 'kit without eldritch implicits', 'not probed (calculation budget): kept as generated', { decided_by: 'budget' }));
    else {
      const per = eldSlots.map((s, i) => { const x = res.get(variants[i + 1]); return x && !x.error ? { slot: s, ...decideLayer(v1, valueOf(x)) } : { slot: s, taken: true, gain: null, guard: 'not probed' }; });
      const drop = per.filter(p => !p.taken).map(p => p.slot);
      if (drop.length) {
        const c2 = off(drop);
        const r2 = drop.length === eldSlots.length ? all : budget.left() > 0 ? run1(c2) : null;
        if (r2 && !r2.error) { c = c2; r = r2; } else drop.length = 0;
      }
      layers.push(layerRecord('eldritch', drop.length < eldSlots.length, layerGain(v1, valueOf(all)), 'same kit without eldritch implicits',
        `${eldSlots.length - drop.length}/${eldSlots.length} slots kept: ${per.map(p => `${p.slot} ${drop.includes(p.slot) ? 'dropped' : 'kept'} (${sign(p.gain)}${p.guard ? `; ${p.guard}` : ''})`).join(', ')}`,
        { slots: per.map(p => ({ slot: p.slot, taken: !drop.includes(p.slot), gain: p.gain, guard: p.guard })) }));
    }
  }
  // automatic utility flasks: each one against the empty slot
  const auto = (c.replace_items ?? []).filter(i => /^Flask \d/.test(i.slot) && i.active);
  if (!auto.length) layers.push(layerRecord('flasks', false, null, 'no utility flask', 'kit has no automatic flask', { decided_by: 'no_option' }));
  else {
    const variants = auto.map(f => withItems(c, { [f.slot]: null }));
    const res = batch(file, variants, budget);
    const v1 = valueOf(r);
    const per = auto.map((f, i) => {
      const x = res.get?.(variants[i]), flask = /\n([^\n]+ Flask)\n/.exec(f.text)?.[1] ?? f.slot;
      return x && !x.error ? { slot: f.slot, flask, ...decideLayer(v1, valueOf(x), { ms: true }) } : { slot: f.slot, flask, taken: true, gain: null, guard: 'not probed' };
    });
    const drop = per.filter(p => !p.taken).map(p => p.slot);
    if (drop.length) {
      const c2 = withItems(c, Object.fromEntries(drop.map(s => [s, null])));
      const r2 = budget.left() > 0 ? run1(c2) : null;
      if (r2 && !r2.error) { c = c2; r = r2; } else drop.length = 0;
    }
    layers.push(layerRecord('flasks', drop.length < auto.length, null, 'the same flask slot empty (each flask probed alone)',
      `${auto.length - drop.length}/${auto.length} automatic flasks kept: ${per.map(p => `${p.flask} ${drop.includes(p.slot) ? 'dropped' : 'kept'} (${sign(p.gain)}${p.guard ? `; ${p.guard}` : ''})`).join(', ')}; charge sustain not modelled`,
      { flasks: per.map(p => ({ slot: p.slot, flask: p.flask, taken: !drop.includes(p.slot), gain: p.gain, guard: p.guard })) }));
  }
  // anoint: options not on the tree, ranked by axis value (top 12) + the norm group's frequent anoints
  const amulet = slotItem(c, 'Amulet');
  if (anointTaken) layers.push(layerRecord('anoint', true, anointTaken.gain ?? null, 'amulet without anoint', `taken by the mana repair: ${anointTaken.name}`));
  else if (!amulet || !withAnoint(amulet.text, 'X')) layers.push(layerRecord('anoint', false, null, 'amulet without anoint', 'kit amulet text has no implicit header', { decided_by: 'no_option' }));
  else {
    const allocated = new Set((c.tree?.allocate ?? []).map(String));
    const { options } = anointOptions({ amulet: amulet.text, allocated });
    const scored = options.map(a => ({ a, v: B.nodeValue(a.stats ?? [], proto.tree.axes, { family: row.family }).value, norm: normAnoints.includes(a.name) }));
    const pick = [...scored.filter(x => x.v > 0).sort((p, q) => q.v - p.v || p.a.name.localeCompare(q.a.name)).slice(0, 12), ...scored.filter(x => x.norm)];
    const uniq = [...new Map(pick.map(x => [x.a.name, x])).values()];
    if (!uniq.length) layers.push(layerRecord('anoint', false, null, 'amulet without anoint', 'no anoint option matches the scaling axes or the corpus norm', { decided_by: 'no_option' }));
    else {
      const mk = name => withItems(c, { Amulet: { ...amulet, text: withAnoint(amulet.text, name) } });
      const res = batch(file, uniq.map(x => mk(x.a.name)), budget);
      const v0 = valueOf(r);
      const rows = uniq.map(x => { const y = res.get?.(mk(x.a.name)); return y && !y.error ? { name: x.a.name, r: y, gain: layerGain(valueOf(y), v0), guard: layerGuard(v0, valueOf(y)), norm: x.norm } : null; })
        .filter(Boolean).sort((p, q) => q.gain.total - p.gain.total);
      const best = rows.find(x => x.gain.total > 0 && !x.guard) ?? null;
      if (best) { c = mk(best.name); r = best.r; }
      layers.push(layerRecord('anoint', !!best, best?.gain ?? rows[0]?.gain ?? null, 'amulet without anoint',
        best ? `${best.name}: best of ${rows.length} probed${best.norm ? ' (corpus norm anoint)' : ''}` : rows.length ? `best of ${rows.length} probed (${rows[0].name}) gives no gain` : 'not probed (calculation budget)',
        { decided_by: rows.length ? 'pob_probe' : 'budget', top: rows.slice(0, 5).map(x => `${x.name} ${sign(x.gain)}`) }));
    }
  }
  return { finalChanges: c, final: r, layers };
}

// ---------- mana repair ----------
export function manaFamily(g) { const t = new Set(g?.types ?? []); return t.has('Minion') || t.has('CreatesMinion') ? 'minion' : t.has('Attack') ? 'attack' : 'spell'; }

// Probes a single repair round may spend: the remaining share split over the rounds still to come, so three rounds
// always fit into the share instead of the first one eating it (WP11 stage 1). Candidates are taken by corpus lift.
export function probeCap(left, roundsLeft) { return Math.max(1, Math.floor(Math.max(0, left) / Math.max(1, roundsLeft))); }
// An unresolved mana deficit is an explicit condition on the prototype, not a silent warning: the DPS PoB reports is
// not paid for by mana recovery in the sustained scenario.
export function manaCondition(sustain, rounds = 0) {
  if (sustain == null || !(sustain < 0)) return null;
  const how = rounds > 0 ? `after ${rounds} repair round(s)` : 'no generator repair was run';
  return { code: 'mana_deficit_unresolved', detail: `mana deficit ${round(sustain, 1)}/s (${how}): the reported DPS is not sustained by mana (PoB sustained scenario, no mana flask); it holds in bursts only, or with a mana flask` };
}

export function repairManaFromCorpus({ ctx, file, row, request, t, gems, budget, state, cards = null, rounds = 3 }) {
  const { batch, prototypeChanges, gemSpec, withGroup, CLUSTER_RESERVE } = ctx;
  let { final, finalChanges, proto } = state;
  const steps = [], applied = new Set();
  let anoint = null;
  const family = manaFamily(proto.gem);
  let comps, manaNorm = null;
  // Mana is solved by skill family (attacks: leech, spells: regen in the corpus), so the family group is used.
  try { comps = sustainComponents({ cards: cards ?? undefined, family }); manaNorm = chooseNormGroup({ cards: cards ?? undefined, family }).norms.mana; }
  catch (e) { return { steps: [{ step: 'mana_corpus', error: e.message.slice(0, 200) }], state: { final, finalChanges }, anoint, rounds_run: 0 }; }
  const cls = t.classes.find(c => c.name === row.class);
  const cl = proto.cluster?.chosen;
  const regrow = (force, extra = []) => {
    const ms = [...(finalChanges.tree?.masteries ?? []), ...extra];
    const p = prototypeChanges(row, request, t, gems, { reserve: ms.length + (cl ? CLUSTER_RESERVE : 0), force: [...(proto.force ?? []), ...force], mana: proto.mana ?? {} });
    const groups = new Set(p.changes.tree.allocate.map(id => t.nodes.get(Number(id))?.group));
    const keep = ms.filter(m => groups.has(t.nodes.get(Number(m.node))?.group));
    return { p, c: { ...finalChanges, tree: { ...p.changes.tree, allocate: [...p.changes.tree.allocate, ...(cl ? [cl.socket] : [])], ...(keep.length ? { masteries: keep } : {}) } } };
  };
  const gemByName = (n, support) => [...gems.values()].find(x => x.name === n && x.is_support === support && x.pob_known);
  const variantsFor = () => {
    const out = [];
    const main = finalChanges.skills.add_groups[0];
    const types = new Set([...proto.gem.types, ...proto.gem.minion_types]);
    // Kit mana affixes of the family's main mana source; only the changed slots (rings, weapon) are replaced.
    const kitMana = [];
    if ((manaNorm?.uses_leech ?? 0) >= 0.3 && !proto.mana?.leech) kitMana.push(['leech', manaNorm.uses_leech]);
    if ((manaNorm?.regen_primary_without_leech ?? 0) >= 0.3 && !proto.mana?.regen && !proto.kitArgs?.manaRegen) kitMana.push(['regen', manaNorm.regen_primary_without_leech]);
    for (const [kind, share] of kitMana) {
      const key = `kit:${kind}`;
      if (applied.has(key)) continue;
      const mana = { ...(proto.mana ?? {}), [kind]: true };
      const p = prototypeChanges(row, request, t, gems, { needAttrs: proto.kitArgs?.needAttrs ?? [], mana });
      const items = p.changes.replace_items.filter(i => i.slot !== 'Amulet' && !/^Flask/.test(i.slot) && slotItem(finalChanges, i.slot) && slotItem(finalChanges, i.slot).text !== i.text);
      if (!items.length) continue;
      out.push({ key, lift: share, label: `kit mana ${kind} affixes (${items.map(i => i.slot).join(', ')}; norm share ${share})`,
        c: withItems(finalChanges, Object.fromEntries(items.map(i => [i.slot, i]))), after: () => { proto.mana = mana; proto.kitArgs = p.kitArgs; } });
    }
    for (const x of comps.candidates) {
      const key = `${x.kind}:${x.key}`;
      if (applied.has(key)) continue;
      if (x.kind === 'support') {
        const s = gemByName(x.name, true);
        if (!s || main.gems.some(g => g.name === x.name) || !supportCompatible(s, types, { fromGem: true }).ok) continue;
        const gems2 = main.gems.length > 2 ? [...main.gems.slice(0, -1), gemSpec(s)] : [...main.gems, gemSpec(s)];
        out.push({ key, lift: x.lift, check: x.name, label: `support ${x.name}${main.gems.length > 2 ? ` replaces ${main.gems.at(-1).name}` : ''}`,
          c: { ...finalChanges, skills: { add_groups: [{ ...main, gems: gems2 }, ...finalChanges.skills.add_groups.slice(1)] } } });
      } else if (x.kind === 'active') {
        const g = gemByName(x.name, false);
        if (!g || finalChanges.skills.add_groups.some(gr => gr.gems.some(y => y.name === x.name))) continue;
        out.push({ key, lift: x.lift, label: `${x.name} as an extra group`, c: withGroup(finalChanges, { label: 'Sustain', slot: 'Helmet', gems: [gemSpec(g)] }) });
        for (const label of ['Aura 2', 'Aura']) {
          const gr = finalChanges.skills.add_groups.find(y => y.label === label);
          if (gr) out.push({ key, lift: x.lift, label: `${x.name} replaces ${gr.gems[0].name}`, c: { ...finalChanges, skills: { add_groups: finalChanges.skills.add_groups.map(y => y === gr ? { ...y, gems: [gemSpec(g)] } : y) } } });
        }
      } else if (x.kind === 'anoint') {
        const am = slotItem(finalChanges, 'Amulet');
        if (anoint || !am || !withAnoint(am.text, x.name)) continue;
        out.push({ key, lift: x.lift, label: `anoint ${x.name}`, c: withItems(finalChanges, { Amulet: { ...am, text: withAnoint(am.text, x.name) } }), after: () => { anoint = { name: x.name }; } });
      } else if (x.kind === 'keystone') {
        const n = [...t.nodes.values()].find(y => y.type === 'keystone' && y.name === x.name && !y.ascendancy && y.eligibility === 'tree_defined');
        if (!n || (finalChanges.tree?.allocate ?? []).map(Number).includes(n.id)) continue;
        const g = regrow([n.id]);
        out.push({ key, lift: x.lift, label: `keystone ${x.name} (tree regrown around it)`, c: g.c, after: () => { proto.force = [...(proto.force ?? []), n.id]; proto.tree = g.p.tree; } });
      } else if (x.kind === 'mastery') {
        const nodes = [...t.nodes.values()].filter(y => y.type === 'mastery' && y.name === x.mastery && !y.ascendancy && (y.mastery_effects ?? []).some(e => e.effect === x.effect));
        if (!nodes.length || (finalChanges.tree?.masteries ?? []).some(m => m.effect === x.effect)) continue;
        // Nearest member of a group carrying that mastery, by path cost from the class start.
        const starts = new Set([cls.start]);
        const best = nodes.flatMap(m => [...t.nodes.values()].filter(y => y.group === m.group && ['normal', 'notable'].includes(y.type)).map(y => ({ m, y, step: connectOne(t, cls, starts, y.id, null) })))
          .filter(z => z.step).sort((a, b) => a.step.cost - b.step.cost || a.y.id - b.y.id)[0];
        if (!best) continue;
        const g = regrow([best.y.id], [{ node: best.m.id, effect: x.effect }]);
        out.push({ key, lift: x.lift, label: `mastery ${x.mastery}: ${x.text} (tree regrown to reach it)`, c: g.c, after: () => { proto.force = [...(proto.force ?? []), best.y.id]; proto.tree = g.p.tree; } });
      }
    }
    return out.sort((a, b) => b.lift - a.lift || a.key.localeCompare(b.key));
  };
  let roundsRun = 0;
  for (let i = 0; i < rounds && (sustainOf(final) ?? 0) < 0 && budget.left() > 0; i++) {
    const s0 = sustainOf(final), v0 = valueOf(final);
    const vars = variantsFor();
    if (!vars.length) break;
    // The round probes only as many of the best candidates (by corpus lift) as its slice of the share allows.
    const cap = probeCap(budget.left(), rounds - i);
    const take = vars.slice(0, cap);
    roundsRun = i + 1;
    const res = batch(file, take.map(v => v.c), budget);
    const rows = take.map(v => ({ ...v, r: res.get?.(v.c) })).filter(v => v.r && !v.r.error && (!v.check || (v.r.applied_supports ?? []).some(a => a.name === v.check)))
      .map(v => ({ ...v, s: sustainOf(v.r) ?? s0, gain: layerGain(valueOf(v.r), v0) }));
    const fixed = rows.filter(v => v.s >= 0 && !cannotPay(v.r)).sort((a, b) => b.gain.total - a.gain.total);
    const score = v => (v.s - s0) / Math.abs(s0) * 100 + v.gain.total;
    const pick = fixed[0] ?? rows.filter(v => v.s > s0 + 1 && !cannotPay(v.r)).sort((a, b) => score(b) - score(a))[0];
    const spend = { probes: rows.length, probed: take.length, probe_cap: cap, candidates: vars.length };
    if (!pick) { steps.push({ step: 'mana_corpus', round: i + 1, ...spend, result: 'no candidate improved mana sustain', sustain: round(s0, 1) }); break; }
    finalChanges = pick.c; final = pick.r; applied.add(pick.key); pick.after?.();
    if (anoint && pick.key.startsWith('anoint:') && !anoint.gain) anoint.gain = pick.gain;
    steps.push({ step: 'mana_corpus', round: i + 1, candidate: pick.key, change: pick.label, corpus_lift: pick.lift, ...spend, sustain_before: round(s0, 1), sustain_after: round(pick.s, 1), gain_pct: pick.gain });
  }
  if (steps.length) steps.unshift({ step: 'mana_corpus_source', family, group: comps.group, candidates: comps.candidates.length, rounds_allowed: rounds, rule: comps.rule });
  return { steps, state: { final, finalChanges }, anoint, rounds_run: roundsRun };
}
