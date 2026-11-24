// Build deconstruction by single-component ablation: remove one component at a time against one baseline
// (one calculation contract) and classify how much the build depends on it. Every removal is a PoB operation:
//   supports  - each enabled support gem of the main socket group (skills.groups remove_gems)
//   skills    - each other enabled, user-editable socket group: auras, curses, buffs, golems (enabled:false)
//   items     - each equipped item stripped to a plain normal base of the same base type (replace_items):
//               measures what the item's modifiers (implicit, explicit, unique mods) contribute; the base stays
//   tree      - each allocated keystone, notable (incl. ascendancy notables) and mastery through PoB's own node
//               comparison (misc calculator removeNodes, as the passive tree tooltip): the node alone, tree unchanged;
//               for nodes other nodes depend on, a second run with node.depends gives the "with dependents" loss
//   config    - each configuration assumption that differs from a new build's default (enemy chilled, charges,
//               cast recently, pantheon...) reset to the default: sensitivity to uptime and combat conditions
// Single removals are not additive: interactions (thresholds, conversion, more multipliers) make the sum of
// losses differ from removing several components together. Numbers are a PoB experiment, not a game test.
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, flags, readJson } from './workspace.mjs';
import { runPob, newPob } from './pob.mjs';
import { runBatch, batchRunner, runVariants, variantRunner, defaultConcurrency } from './analysis-engine.mjs';
import { evaluateCandidates, AnalysisCache, effectiveDps } from './analysis-core.mjs';
import { readBuild, pobGems } from './analysis-candidates.mjs';
import { loadTree } from './tree-graph.mjs';

export const ablationKinds = ['supports', 'skills', 'items', 'tree', 'config'];
// Keys that describe the encounter, not a build assumption; they are set by scenarios and encounter analysis.
const encounterKeys = /^(enemy|preset|resistancePenalty$|ChanceToIgnoreEnemy|repeatMode$|resourceGainMode$)/;
export const defaultThresholds = { core: 25, major: 10, minor: 2 };
const metricsWanted = ['dps', 'fulldps', 'ehp', 'maxhit', 'life', 'es', 'mana_sustain'];
const finite = v => typeof v === 'number' && Number.isFinite(v);
const skipBases = /Cluster Jewel$|^Timeless Jewel$/;
const attributes = ['Str', 'Dex', 'Int'];
export const isSupportGem = gems => gem => !!gems.get(gem.skill_id)?.tags?.support || /^Support/.test(gem.skill_id ?? '');

// ---------- component plan (pure; inputs injected for tests) ----------
// build: readBuild() shape; equipped: baseline.equipped_items; tree: loadTree() shape (nodes Map by numeric id);
// isSupport(gem) -> boolean.
// supportGroup: group whose supports are probed (default: main socket group; analyze candidates uses other groups).
export function planAblation({ build, equipped = [], tree = null, isSupport, kinds = ablationKinds, base = {}, config = null, defaults = null, supportGroup = null }) {
  const components = [], skipped = [];
  const want = new Set(kinds);
  const mainIndex = build.main_socket_group;
  const supportIndex = supportGroup ?? mainIndex;
  const main = build.groups[supportIndex - 1];
  const withBase = extra => mergeChanges(base, extra);
  if (want.has('supports')) {
    if (!main) skipped.push({ id: 'supports', reason: 'main_socket_group_missing' });
    else if (main.source) skipped.push({ id: 'supports', reason: 'main_group_granted_by_item_or_mod' });
    else for (const gem of main.gems) {
      if (!gem.enabled || !isSupport(gem)) continue;
      components.push({ id: `support:${supportIndex}:${gem.index}`, kind: 'supports', label: gem.name, target: { group: supportIndex, gem: gem.index },
        changes: withBase({ skills: { groups: [{ group: supportIndex, remove_gems: [gem.index] }] } }) });
    }
  }
  if (want.has('skills')) for (const g of build.groups) {
    if (g.index === mainIndex) continue;
    const id = `skill:${g.index}`;
    if (!g.enabled) { skipped.push({ id, reason: 'already_disabled', label: groupLabel(g) }); continue; }
    if (g.source) { skipped.push({ id, reason: 'item_granted_group_not_editable', label: groupLabel(g) }); continue; }
    if (!g.gems.some(x => x.enabled)) { skipped.push({ id, reason: 'no_enabled_gems', label: groupLabel(g) }); continue; }
    components.push({ id, kind: 'skills', label: groupLabel(g), target: { group: g.index, slot: g.slot },
      changes: withBase({ skills: { groups: [{ group: g.index, enabled: false }] } }) });
  }
  if (want.has('items')) for (const item of [...equipped].sort((a, b) => String(a.slot).localeCompare(String(b.slot), 'en', { numeric: true }))) {
    const id = `item:${item.slot}`;
    const label = item.name && item.name !== item.base ? `${item.name} (${item.base})` : item.base;
    if (/Swap/.test(item.slot ?? '')) { skipped.push({ id, reason: 'weapon_swap', label }); continue; }
    if (/^Flask/.test(item.slot ?? '') && item.active === false) { skipped.push({ id, reason: 'flask_not_active_in_config', label }); continue; }
    if (!item.base) { skipped.push({ id, reason: 'base_type_unknown', label }); continue; }
    if (skipBases.test(item.base)) { skipped.push({ id, reason: 'jewel_with_structure (cluster/timeless): stripping changes the tree', label }); continue; }
    if (String(item.rarity).toUpperCase() === 'NORMAL') { skipped.push({ id, reason: 'normal_rarity: nothing to strip; effects of the base itself need item removal (not supported)', label }); continue; }
    components.push({ id, kind: 'items', label, target: { slot: item.slot, rarity: item.rarity, base: item.base },
      changes: withBase({ replace_items: [{ slot: item.slot, text: `Rarity: NORMAL\n${item.base}` }] }) });
  }
  if (want.has('tree')) {
    if (!tree) skipped.push({ id: 'tree', reason: 'tree_unavailable' });
    else if (base.tree || base.jewels || base.sets || base.remove_nodes) skipped.push({ id: 'tree', reason: 'base changes edit the tree; node removal is a calculation override of the saved tree' });
    else for (const raw of [...build.allocated].sort((a, b) => Number(a) - Number(b))) {
      const node = tree.nodes.get(Number(raw));
      if (!node || !['keystone', 'notable', 'mastery'].includes(node.type)) continue;
      const kindLabel = node.ascendancy ? `ascendancy ${node.type}` : node.type;
      components.push({ id: `node:${node.id}`, kind: 'tree', label: `${node.name} (${kindLabel})`, target: { node: node.id, type: node.type, ascendancy: node.ascendancy ?? null },
        changes: withBase({ remove_nodes: [{ node: node.id }] }) });
    }
  }
  if (want.has('config')) {
    if (!config || !defaults) skipped.push({ id: 'config', reason: 'baseline/default configuration unavailable' });
    else for (const plan of planConfigAblation(config, defaults)) components.push({ ...plan, changes: withBase({ config: { [plan.target.key]: plan.target.reset } }) });
  }
  return { components, skipped };
}
// Configuration assumptions: a value that is "on" (true, non-zero number, non-default string) and differs from the
// default of a new build. Reset to the default; without a default, booleans become false and numbers 0.
export function planConfigAblation(config, defaults) {
  const out = [];
  for (const key of Object.keys(config).sort()) {
    const value = config[key], def = defaults[key];
    if (encounterKeys.test(key) || value === def) continue;
    let reset;
    if (typeof value === 'boolean') { if (!value) continue; reset = typeof def === 'boolean' ? def : false; }
    else if (typeof value === 'number') { if (value === 0 && def == null) continue; reset = typeof def === 'number' ? def : 0; }
    else if (typeof value === 'string') { if (typeof def !== 'string') continue; reset = def; }
    else continue;
    if (reset === value) continue;
    out.push({ id: `config:${key}`, kind: 'config', label: `${key} = ${value} (default ${reset})`, target: { key, value, reset } });
  }
  return out;
}
const groupLabel = g => {
  const names = g.gems.filter(x => x.enabled).map(x => x.name);
  return `${g.label ? `${g.label}: ` : ''}${names.join(' + ')}${g.slot ? ` [${g.slot}]` : ''}`;
};
// Base changes (scenario tweaks) merged with the ablation; skills/config/remove_nodes/replace_items blocks combine.
export function mergeChanges(base, extra) {
  const out = { ...base, ...extra };
  if (base.skills && extra.skills) {
    // Entries for the same group are combined (gem indices refer to the state before the skills block).
    const groups = [];
    for (const g of [...(base.skills.groups ?? []), ...(extra.skills.groups ?? [])]) {
      const same = groups.find(x => x.group === g.group);
      if (!same) { groups.push(structuredClone(g)); continue; }
      for (const [k, v] of Object.entries(g)) if (k === 'remove_gems') same.remove_gems = [...new Set([...(same.remove_gems ?? []), ...v])].sort((a, b) => b - a); else if (k !== 'group') same[k] = v;
    }
    out.skills = { ...base.skills, ...extra.skills, groups };
  }
  if (base.custom_mods && extra.custom_mods) out.custom_mods = `${base.custom_mods}\n${extra.custom_mods}`;
  if (base.remove_nodes && extra.remove_nodes) out.remove_nodes = [...base.remove_nodes, ...extra.remove_nodes.filter(e => !base.remove_nodes.some(b => b.node === e.node))];
  if (base.config && extra.config) out.config = { ...base.config, ...extra.config };
  if (base.replace_items && extra.replace_items) out.replace_items = [...base.replace_items.filter(r => !extra.replace_items.some(e => e.slot === r.slot)), ...extra.replace_items];
  return out;
}

// ---------- classification (pure) ----------
// loss = -pct (positive = the build gets worse without the component). Offense: worst of main-skill dps and FullDPS.
// Defense: worst of ehp/maxhit/life/es. Tier by the largest loss; removal_improves when nothing is lost >= minor
// and something improves >= minor. Mana sustain turning negative is a hard break (at least "major").
export function classifyRow(row, thresholds = defaultThresholds) {
  if (row.error) return { tier: 'error', reasons: [row.error] };
  const d = row.deltas ?? {};
  const loss = m => finite(d[m]?.pct) ? -d[m].pct : null;
  const offenseParts = [loss('dps'), loss('fulldps')].filter(finite);
  const offense = offenseParts.length ? Math.max(...offenseParts) : null;
  const defense = ['ehp', 'maxhit', 'life', 'es'].map(loss).filter(finite);
  const defenseLoss = defense.length ? Math.max(...defense) : null;
  const gains = [offense, ...defense].filter(finite).map(v => -v);
  const largest = Math.max(...[offense, defenseLoss].filter(finite), -Infinity);
  const reasons = [];
  let tier;
  const dpsZero = finite(d.dps?.before) && d.dps.before > 0 && finite(d.dps?.after) && d.dps.after <= 0;
  if (row.skill_disabled_reason || dpsZero) { tier = 'core'; reasons.push(row.skill_disabled_reason ? `main skill disabled: ${row.skill_disabled_reason}` : 'main skill DPS drops to 0'); }
  else if (largest >= thresholds.core) tier = 'core';
  else if (largest >= thresholds.major) tier = 'major';
  else if (largest >= thresholds.minor) tier = 'minor';
  else if (gains.some(g => g >= thresholds.minor)) tier = 'removal_improves';
  else tier = 'negligible';
  const ms = d.mana_sustain;
  const manaBreak = finite(ms?.before) && finite(ms?.after) && ms.before >= 0 && ms.after < 0;
  if (manaBreak) { reasons.push('mana sustain becomes negative'); if (['minor', 'negligible', 'removal_improves'].includes(tier)) tier = 'major'; }
  if (finite(offense) && offense >= thresholds.minor) reasons.push(`DPS -${round(offense)}%`);
  if (finite(defenseLoss) && defenseLoss >= thresholds.minor) reasons.push(`defense -${round(defenseLoss)}% (worst of EHP/max hit/life/ES)`);
  if (tier === 'removal_improves') reasons.push('removal improves a measured metric: the component may pay for something unmeasured (requirements, utility, resist cap) or be a candidate to replace');
  if (tier === 'negligible') reasons.push('no measured effect: utility outside the metrics (movement, ailment immunity, requirements, flask uptime, clear) is not captured');
  return { tier, offense_loss_pct: round(offense), defense_loss_pct: round(defenseLoss), mana_sustain_broken: manaBreak, reasons };
}
const round = v => finite(v) ? Math.round(v * 100) / 100 : null;

// Requirement/resist side effects from the full engine output (extract hook of evaluateCandidates).
export function extractSideEffects(result) {
  const o = result.output ?? {};
  const unmet = attributes.filter(a => finite(o[`Req${a}`]) && finite(o[a]) && o[a] < o[`Req${a}`]).map(a => ({ attribute: a, have: o[a], required: o[`Req${a}`] }));
  const res = Object.fromEntries(['FireResist', 'ColdResist', 'LightningResist', 'ChaosResist'].filter(k => finite(o[k])).map(k => [k, o[k]]));
  const removed = result.removed_nodes?.nodes;
  return { unmet_requirements: unmet, resists: res, movement: finite(o.EffectiveMovementSpeedMod) ? o.EffectiveMovementSpeedMod : null,
    removed_nodes: removed ? removed.map(n => ({ id: n.id, name: n.name ?? null, type: n.type ?? null, requested: !!n.requested, dependents: n.dependents ?? null })) : undefined,
    applied_supports: (result.applied_supports ?? []).map(s => s.name) };
}

// "With dependents" result of a tree node (PoB node.depends): points that would be freed and the loss of all of them.
export function attachDependents(row, depRow, thresholds = defaultThresholds) {
  if (!depRow || depRow.error) return { ...row, with_dependents: { error: depRow?.error ?? 'not run' } };
  const c = classifyRow(depRow, thresholds);
  const nodes = depRow.extra?.removed_nodes ?? [];
  const others = nodes.filter(n => !n.requested);
  const out = { ...row, with_dependents: { points: nodes.length, dependents: others.map(n => n.name ?? n.id), tier: c.tier, offense_loss_pct: c.offense_loss_pct, defense_loss_pct: c.defense_loss_pct,
    dps_loss_per_point: finite(c.offense_loss_pct) && nodes.length ? round(c.offense_loss_pct / nodes.length) : null,
    other_key_nodes: others.filter(n => /^(notable|keystone|mastery)$/i.test(n.type ?? '')).map(n => n.name ?? n.id) } };
  if (out.with_dependents.other_key_nodes.length) out.reasons = [...row.reasons, `bridge: removing its path also drops ${out.with_dependents.other_key_nodes.join(', ')} (-${c.offense_loss_pct ?? 0}% DPS together)`];
  return out;
}

// ---------- engine-backed ----------
export function analyzeAblation({ file, scenario = 'sustained', kinds = ablationKinds, base = {}, limit = null, thresholds = defaultThresholds, concurrency = defaultConcurrency, plan = false, only = null } = {}) {
  const started = Date.now();
  const input = fs.readFileSync(file);
  const baseline = runPob({ input, scenario, changes: base, full: true });
  const build = readBuild(file);
  const isSupport = isSupportGem(pobGems());
  let tree = null;
  try { tree = loadTree(); } catch { tree = null; }
  // Defaults of a new build of the same class: what PoB assumes when the user set nothing.
  let defaults = null;
  if (kinds.includes('config')) { try { defaults = newPob({ className: build.class }).config ?? null; } catch { defaults = null; } }
  const planned = planAblation({ build, equipped: baseline.equipped_items ?? [], tree, isSupport, kinds, base, config: baseline.config ?? null, defaults });
  let components = planned.components;
  // only: component ids (benchmark scoring); unknown ids are an error, not silently dropped.
  if (only) { const ids = new Set(components.map(c => c.id)); const missing = only.filter(id => !ids.has(id)); if (missing.length) throw new Error(`Unknown ablation components: ${missing.join(', ')}`); components = components.filter(c => only.includes(c.id)); }
  const truncated = limit != null && components.length > limit ? components.length - limit : 0;
  if (truncated) components = components.slice(0, limit);
  const header = { analysis: 'ablation', game: 'poe1', patch: '3.30', file, scenario, kinds, thresholds,
    method: 'One component removed at a time against one baseline and one calculation contract. supports: removed from the main group; skills: group disabled; items: stripped to a plain normal base of the same type (all modifiers incl. implicits removed, base defences kept); tree: PoB node comparison (misc calculator removeNodes) for the node alone, plus node.depends for nodes others depend on; config: assumption reset to the new-build default.',
    verification_level: 'simulator (PoB 2.68.1 numbers); not a game test' };
  if (plan) return { ...header, plan: true, components: components.map(({ changes, ...c }) => ({ ...c, changes })), skipped: planned.skipped, truncated, engine_runs_needed: components.length };
  const cache = new AnalysisCache();
  // Tree nodes: PoB comparison variants (alone and with node.depends) in a few processes; other kinds: one run each.
  const treeComps = components.filter(c => c.kind === 'tree'), otherComps = components.filter(c => c.kind !== 'tree');
  const vr = treeComps.length ? runVariants({ file, scenario, base, concurrency, variants: treeComps.flatMap(c => [
    { id: `rm:${c.target.node}`, remove_nodes: [{ node: c.target.node }] }, { id: `deps:${c.target.node}`, remove_nodes: [{ node: c.target.node, with_dependents: true }] }]) }) : null;
  const batch = otherComps.length ? runBatch({ file, scenario, changesList: otherComps.map(c => c.changes), concurrency, full: true }) : { runs: 0, elapsed_ms: 0, concurrency, results: new Map() };
  const evaluatedOther = evaluateCandidates({ baseline, candidates: otherComps.map(c => ({ id: c.id, label: c.label, changes: c.changes, meta: { kind: c.kind, target: c.target } })),
    runner: batchRunner(batch), metricsWanted, cache, kind: 'ablation-v2', extract: extractSideEffects });
  const evaluatedTree = vr ? evaluateCandidates({ baseline, candidates: treeComps.map(c => ({ id: c.id, label: c.label, changes: { variant: `rm:${c.target.node}`, base }, meta: { kind: c.kind, target: c.target } })),
    runner: variantRunner(vr), metricsWanted, cache, kind: 'ablation-tree-v3', extract: extractSideEffects }) : { rows: [] };
  const evaluated = { ...evaluatedOther, rows: [...evaluatedOther.rows, ...evaluatedTree.rows] };
  const baseSide = extractSideEffects(baseline);
  let rows = evaluated.rows.map(r => {
    const c = classifyRow(r, thresholds);
    const out = { id: r.id, kind: r.meta.kind, label: r.label, target: r.meta.target, ...c };
    if (r.error) return { ...out, error: r.error };
    out.deltas = Object.fromEntries(Object.entries(r.deltas).map(([m, v]) => [m, { before: round(v.before), after: round(v.after), pct: round(v.pct) }]));
    const side = r.extra ?? {};
    const newUnmet = (side.unmet_requirements ?? []).filter(u => !baseSide.unmet_requirements.some(b => b.attribute === u.attribute));
    if (newUnmet.length) { out.unmet_requirements = newUnmet; out.reasons.push(`attribute requirements fail without it: ${newUnmet.map(u => `${u.attribute} ${u.have}/${u.required}`).join(', ')}`); }
    const resDrop = Object.entries(side.resists ?? {}).filter(([k, v]) => finite(baseSide.resists[k]) && v < baseSide.resists[k] - 0.5).map(([k, v]) => `${k} ${baseSide.resists[k]}->${v}`);
    if (resDrop.length) out.resist_changes = resDrop;
    if (finite(side.movement) && finite(baseSide.movement) && Math.abs(side.movement - baseSide.movement) > 1e-6) out.movement_speed_mod = { before: baseSide.movement, after: side.movement };
    if (r.meta.kind === 'tree') out.dependents = side.removed_nodes?.find(n => n.requested)?.dependents ?? 0;
    if (r.engine_warnings?.length) out.engine_warnings = r.engine_warnings;
    return out;
  });
  // Nodes that others depend on: the same node removed with node.depends (PoB tooltip "and dependents").
  const bridges = rows.filter(r => r.kind === 'tree' && !r.error && r.dependents > 0);
  if (bridges.length) {
    const ev = evaluateCandidates({ baseline, candidates: bridges.map(r => ({ id: r.id, label: r.label, changes: { variant: `deps:${r.target.node}`, base } })), runner: variantRunner(vr),
      metricsWanted, cache, kind: 'ablation-dependents-v2', extract: extractSideEffects });
    const depRows = new Map(ev.rows.map(x => [x.id, x]));
    rows = rows.map(r => depRows.has(r.id) ? attachDependents(r, depRows.get(r.id), thresholds) : r);
  }
  const order = ['core', 'major', 'minor', 'removal_improves', 'negligible', 'error'];
  rows.sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier) || (b.offense_loss_pct ?? -1e9) + (b.defense_loss_pct ?? 0) - (a.offense_loss_pct ?? -1e9) - (a.defense_loss_pct ?? 0));
  const summary = Object.fromEntries(order.map(t => [t, rows.filter(r => r.tier === t).map(r => r.label)]));
  return { ...header, contract: evaluated.contract, baseline: { values: Object.fromEntries(Object.entries(evaluated.baseline_values).map(([k, v]) => [k, round(v)])), dps_basis: effectiveDps(baseline.output).basis,
      main_socket_group: build.main_socket_group, unmet_requirements: baseSide.unmet_requirements, engine_warnings: baseline.engine_warnings ?? [] },
    summary, rows, skipped: planned.skipped, truncated,
    interpretation: [
      'core: removing it costs >= core% of DPS or defense, or disables the main skill. These carry the architecture.',
      'major/minor: implementation choices; compare replacements with analyze candidates/upgrades before changing.',
      'negligible/removal_improves: candidates to replace, but check unmodelled utility (requirements, movement, ailments, flask uptime, clear speed).',
      'Tree tiers are the node alone (PoB removeNodes); with_dependents is the cost of losing its whole branch.',
      'Single removals are not additive; confirm a package change with one combined pob run.'
    ],
    engine: { runs: batch.runs, elapsed_ms: batch.elapsed_ms, concurrency: batch.concurrency, cache: evaluated.cache, tree_variants: vr ? { runs: vr.runs, elapsed_ms: vr.elapsed_ms, variants: vr.variants } : null }, timing: { total_ms: Date.now() - started } };
}

// ---------- report ----------
const tierRu = { core: 'ядро', major: 'важное', minor: 'малое', removal_improves: 'удаление улучшает', negligible: 'без измеримого эффекта', error: 'ошибка' };
const pct = v => finite(v) ? `${v > 0 ? '-' : '+'}${Math.abs(v).toFixed(1)}%` : '—';
export function ablationMarkdown(r) {
  const lines = [`# Абляционный разбор билда`, '', `Файл: \`${path.basename(r.file)}\` · сценарий \`${r.scenario}\` · PoE 3.30 · PoB 2.68.1`, '',
    `Метод: ${r.method}`, '', `Уровень проверки: числа PoB, не игровой тест. Удаления по одному не складываются.`, '',
    `Базовые значения: DPS ${r.baseline.values.dps ?? '—'} (${r.baseline.dps_basis}), EHP ${r.baseline.values.ehp ?? '—'}, max hit ${r.baseline.values.maxhit ?? '—'}, life ${r.baseline.values.life ?? '—'}, ES ${r.baseline.values.es ?? '—'}, mana sustain ${r.baseline.values.mana_sustain ?? '—'}/s.`, '',
    '| Компонент | Тип | Класс | DPS | Защита | Примечания |', '|---|---|---|---|---|---|'];
  for (const row of r.rows) {
    const w = row.with_dependents;
    const notes = [...(row.reasons ?? []).filter(x => !/^DPS -|^defense -|no measured effect|removal improves|^bridge:/.test(x)), ...(row.resist_changes ? [`res: ${row.resist_changes.join(', ')}`] : []),
      ...(w && !w.error ? [`с зависимыми (${w.points} оч.): ${pct(w.offense_loss_pct)} DPS / ${pct(w.defense_loss_pct)} защиты${w.other_key_nodes?.length ? `, вкл. ${w.other_key_nodes.join(', ')}` : ''}`] : [])].join('; ');
    lines.push(`| ${row.label.replace(/\|/g, '/')} | ${row.kind} | ${tierRu[row.tier] ?? row.tier} | ${pct(row.offense_loss_pct)} | ${pct(row.defense_loss_pct)} | ${notes.replace(/\|/g, '/')} |`);
  }
  if (r.skipped?.length) lines.push('', '## Пропущено', '', ...r.skipped.map(s => `- ${s.label ?? s.id}: ${s.reason}`));
  lines.push('', '## Как читать', '', '- «ядро» — удаление стоит ≥ порога core или отключает основной скилл: на этом держится архитектура.',
    '- «важное»/«малое» — реализационные решения; замены сравнивать через `analyze candidates`/`upgrades`.',
    '- Узлы дерева оцениваются штатным сравнением PoB (как подсказка дерева): сам узел, дерево не меняется; «с зависимыми» — потеря всей ветки за узлом.',
    '- «без измеримого эффекта»/«удаление улучшает» — кандидаты на замену, но проверить неизмеряемую пользу: требования, скорость передвижения, иммунитеты, флаконы, зачистку.', '');
  return lines.join('\n');
}

// ---------- CLI ----------
export function ablateCommand(args) {
  const { positional, options } = flags(args, ['kinds', 'scenario', 'changes', 'limit', 'concurrency', 'out', 'md', 'core', 'major', 'minor'], ['plan']);
  if (!positional[0]) throw new Error('Build file required: analyze ablate <build.xml>');
  const kinds = options.kinds ? options.kinds.split(',').map(s => s.trim()).filter(Boolean) : ablationKinds;
  for (const k of kinds) if (!ablationKinds.includes(k)) throw new Error(`--kinds accepts ${ablationKinds.join(',')}`);
  const num = (v, name, min, max) => { if (v == null) return null; const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be ${min}-${max}`); return n; };
  const thresholds = { core: num(options.core, 'core', 0, 100) ?? defaultThresholds.core, major: num(options.major, 'major', 0, 100) ?? defaultThresholds.major, minor: num(options.minor, 'minor', 0, 100) ?? defaultThresholds.minor };
  if (!(thresholds.core >= thresholds.major && thresholds.major >= thresholds.minor)) throw new Error('Thresholds must satisfy core >= major >= minor');
  const result = analyzeAblation({ file: path.resolve(positional[0]), scenario: options.scenario ?? 'sustained', kinds, base: options.changes ? readJson(path.resolve(options.changes)) : {},
    limit: num(options.limit, 'limit', 1, 1000), thresholds, concurrency: num(options.concurrency, 'concurrency', 1, 16) ?? defaultConcurrency, plan: !!options.plan });
  if (options.out) atomicJson(path.resolve(options.out), result);
  if (options.md && !result.plan) { fs.mkdirSync(path.dirname(path.resolve(options.md)), { recursive: true }); fs.writeFileSync(path.resolve(options.md), ablationMarkdown(result), 'utf8'); result.markdown_file = path.resolve(options.md); }
  return result;
}
export const ablationHelp = {
  'analyze ablate <xml> [--kinds supports,skills,items,tree,config] [--plan] [--limit N] [--scenario S] [--changes base.json] [--core 25 --major 10 --minor 2] [--md f.md] [--out f.json]':
    'Build deconstruction: remove one support/skill group/item mods/passive node (PoB removeNodes, alone and with dependents)/config assumption at a time; classify core/major/minor/negligible/removal_improves (PoB experiment, not additive, not a game test)'
};
