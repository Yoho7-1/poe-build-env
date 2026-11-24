// CLI for `agent.mjs analyze ...` and `agent.mjs eval ...`. Engine-backed batch runs are wired separately
// (they need the PoB runner and tree edit operations); planning and evaluation of ready results work offline.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, atomicJson, flags } from './workspace.mjs';
import { loadBossScenarios, writeBossScenarios, resolveBoss, bossChanges, evaluateSurvival, tiers } from './analysis-bosses.mjs';
import { statCandidates, statProbes } from './analysis-nodes.mjs';
import { expandCandidates } from './analysis-upgrades.mjs';
import { defaultConcurrency } from './analysis-engine.mjs';
import { analyzeNodes, analyzeStats, analyzeUpgrades, surviveFromFile } from './analysis-run.mjs';
import { loadCases, listCases, prompts, answerTemplate, scoreAnswers } from './analysis-eval.mjs';
import { writeEnemyDb, loadEnemyDb, listMapMods, resolveMapMod } from './enemy-db.mjs';
import { buildEncounter } from './encounter.mjs';
import { atlasCombatNodes } from './atlas-combat.mjs';
import { progressionCommand, progressionHelp } from './analysis-progression.mjs';
import { candidatesCommand, candidatesHelp, analyzeAutoUpgrades, autoUpgradeOptions } from './analysis-candidates.mjs';
import { analyzeEncounter, analyzeMapModSweep, analyzeReport, writeMarkdown } from './analysis-encounter.mjs';
import { foundationReport } from './corpus-norms.mjs';
import { coverageCommand } from './analysis-coverage.mjs';
import { ablateCommand, ablationHelp } from './analysis-ablation.mjs';
import { interactionsCommand, interactionsHelp } from './analysis-interactions.mjs';
import { parseBudget } from './design-variants.mjs';

const readResults = list => list.split(',').map(f => f.trim()).filter(Boolean).flatMap(f => {
  const full = path.resolve(f);
  if (fs.statSync(full).isDirectory()) return fs.readdirSync(full).filter(n => n.endsWith('.json')).map(n => readJson(path.join(full, n)));
  return [readJson(full)];
});

const intOption = (value, name, min, max) => {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer ${min}-${max}`);
  return n;
};

export function analyze(args) {
  // Sub-commands with their own option sets parse their arguments themselves.
  if (args[0] === 'progression') return progressionCommand(args.slice(1));
  if (args[0] === 'candidates') return candidatesCommand(args.slice(1));
  if (args[0] === 'ablate') return ablateCommand(args.slice(1));
  if (args[0] === 'interactions') return interactionsCommand(args.slice(1));
  if (args[0] === 'coverage') return coverageCommand(args.slice(1));
  const { positional, options } = flags(args, ['boss', 'tier', 'results', 'changes', 'out-dir', 'out', 'candidates', 'metric', 'scenario', 'radius', 'probes', 'top', 'include', 'concurrency',
    'enemy', 'map-tier', 'mods', 'map-mod-effect', 'delirium', 'level', 'enemy-life', 'boss-tier', 'md', 'search', 'band', 'method', 'sweep-tiers', 'damage-profile', 'pantheon-major', 'pantheon-minor', 'atlas', 'auto', 'slot', 'group', 'replace', 'limit', 'quality', 'budget'], ['plan', 'full', 'exclude-awakened']);
  const [operation, ...rest] = positional;
  const tier = options.tier ?? 'uber';
  const write = value => { if (options.out) atomicJson(path.resolve(options.out), value); if (options.md) value.markdown_file = writeMarkdown(options.md, value); return value; };
  const baseChanges = () => options.changes ? readJson(path.resolve(options.changes)) : {};
  const conc = () => { const n = Number(options.concurrency ?? defaultConcurrency); if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error('--concurrency 1-16'); return n; };
  const mapTier = () => intOption(options['map-tier'], 'map-tier', 1, 17) ?? 16;
  const bossTier = () => { const t = options['boss-tier'] ?? 'uber'; if (!tiers[t]) throw new Error('--boss-tier pinnacle|uber'); return t; };
  const encounterSpec = () => ({ enemy: options.enemy ?? 'rare', tier: mapTier(), mods: options.mods ? options.mods.split(',').map(s => s.trim()).filter(Boolean) : [],
    map_mod_effect: options['map-mod-effect'] != null ? Number(options['map-mod-effect']) : 0, delirium: intOption(options.delirium, 'delirium', 0, 100) ?? 0,
    level: intOption(options.level, 'level', 1, 100), enemy_life: intOption(options['enemy-life'], 'enemy-life', 1, 1e12), boss_tier: bossTier(),
    damage_profile: options['damage-profile'] ?? undefined, atlas: options.atlas ? options.atlas.split(',').map(x => x.trim()).filter(Boolean) : undefined, pantheon_major: options['pantheon-major'] ?? undefined, pantheon_minor: options['pantheon-minor'] ?? undefined });
  if (operation === 'enemies') {
    if (rest[0] === 'build') return writeEnemyDb();
    const db = loadEnemyDb();
    return { provenance: db.provenance, method: db.method, disclaimer: db.disclaimer, map_tiers: db.map_tiers,
      archetypes: Object.values(db.archetypes).map(a => ({ id: a.id, label: a.label, pob_enemy_is_boss: a.pob_enemy_is_boss, rarity: a.rarity, rarity_multipliers: a.rarity_multipliers })),
      bosses: Object.values(db.bosses).map(b => ({ id: b.id, name: b.name, skills: b.skills })), map_mods: Object.keys(db.map_mods).length, maps: db.maps.length,
      usage: 'analyze enemy <archetype|boss:Name[:Skill]> --map-tier N --mods a,b; analyze mapmods [--band red] [--search text]; analyze encounter|mapmod-sweep|report <xml>' };
  }
  if (operation === 'enemy') {
    const db = loadEnemyDb();
    const spec = { ...encounterSpec(), enemy: rest.join(' ') || options.enemy || 'rare' };
    const e = buildEncounter(db, loadBossScenarios(), spec);
    const row = db.levels[e.enemy.level] ?? null;
    return { ...e, level_baseline: row, archetype: db.archetypes[e.enemy.archetype] ?? null, usage: 'pob run <xml> --changes <file with .changes> --full, or analyze encounter <xml> with the same options' };
  }
  if (operation === 'mapmods') {
    const db = loadEnemyDb();
    if (options.band && !db.map_tiers[options.band]) throw new Error(`--band ${Object.keys(db.map_tiers).join('|')}`);
    const list = listMapMods(db, { band: options.band ?? null, search: options.search ?? null, method: options.method ?? null });
    return { total: list.length, bands: db.map_tiers, methods: { pob_map_affix: 'applied by PoB map affix', translated: 'PoB enemy mods / custom mods / enemy penetration', partial: 'numeric part modelled, rest not', not_modelled: 'mechanic outside the model (see danger_axes)', no_combat_effect: 'content/pack type only' }, map_mods: list };
  }
  if (operation === 'atlas') {
    const nodes = atlasCombatNodes({ search: options.search ?? (rest.join(' ') || null) });
    return { total: nodes.length, note: 'Atlas nodes that touch map combat. Status modelled = translated for --atlas (monster damage/life, explicit modifier effect); others are listed as not modelled.', nodes };
  }
  if (operation === 'mapmod') return resolveMapMod(loadEnemyDb(), rest.join(' ') || options.search);
  if (operation === 'encounter') {
    if (!rest[0]) throw new Error('Build file required: analyze encounter <xml> --enemy rare --map-tier 16 --mods savage,resistant');
    return write(analyzeEncounter({ file: path.resolve(rest[0]), scenario: options.scenario ?? 'sustained', spec: encounterSpec(), base: baseChanges(), concurrency: conc() }));
  }
  if (operation === 'mapmod-sweep') {
    if (!rest[0]) throw new Error('Build file required');
    if (options.include && !['combat', 'all'].includes(options.include)) throw new Error('--include combat|all');
    return write(analyzeMapModSweep({ file: path.resolve(rest[0]), scenario: options.scenario ?? 'sustained', tier: mapTier(), enemy: options.enemy ?? 'rare', base: baseChanges(), concurrency: conc(), include: options.include ?? 'combat' }));
  }
  if (operation === 'report') {
    if (!rest[0]) throw new Error('Build file required');
    const sweepTiers = (options['sweep-tiers'] ?? '16,17').split(',').filter(Boolean).map(t => intOption(t, 'sweep-tiers', 1, 17));
    const report = analyzeReport({ file: path.resolve(rest[0]), scenario: options.scenario ?? 'sustained', tier: mapTier(), bossTier: bossTier(), base: baseChanges(), concurrency: conc(), sweepTiers,
      enemyLife: intOption(options['enemy-life'], 'enemy-life', 1, 1e12), extra: Object.fromEntries([['pantheon_major', options['pantheon-major']], ['pantheon_minor', options['pantheon-minor']], ['atlas', options.atlas ? options.atlas.split(',').map(x => x.trim()).filter(Boolean) : null]].filter(([, v]) => v != null)) });
    // WP5b: build basics vs corpus norms of the ascendancy (warnings, not failures).
    try { report.foundation =foundationReport({ file: path.resolve(rest[0]), scenario: options.scenario ?? 'sustained' }); }
    catch (e) { report.foundation = { error: String(e.message ?? e).slice(0, 300) }; }
    return write(report);
  }
  if (operation === 'bosses') {
    if (rest[0] === 'build') return writeBossScenarios();
    const data = loadBossScenarios();
    return { provenance: data.provenance, method: data.method, disclaimer: data.disclaimer, tiers,
      bosses: Object.values(data.bosses).map(b => ({ id: b.id, name: b.name, coverage: b.skill_coverage, skills: b.tiers.uber.skills.map(s => s.skill) })) };
  }
  if (operation === 'boss') {
    const data = loadBossScenarios();
    const profile = resolveBoss(data, rest.join(' ') || options.boss);
    if (!tiers[tier]) throw new Error(`Unknown tier: ${tier}`);
    return { id: profile.id, name: profile.name, tier, coverage: profile.skill_coverage, enemy_defence: profile.enemy_defence, ...profile.tiers[tier], disclaimer: data.disclaimer };
  }
  if (operation === 'boss-changes') {
    const profile = resolveBoss(loadBossScenarios(), rest.join(' ') || options.boss);
    const list = bossChanges(profile, tier, options.changes ? readJson(path.resolve(options.changes)) : {});
    if (options['out-dir']) for (const entry of list) atomicJson(path.join(path.resolve(options['out-dir']), `${profile.id}-${tier}-${entry.skill.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.json`), entry.changes);
    return { boss: profile.id, tier, runs: list, usage: 'pob run <xml> --scenario sustained --changes <file> --full --out <result.json>; then analyze survive --boss X --tier T --results <dir|files>' };
  }
  if (operation === 'survive') {
    const profile = resolveBoss(loadBossScenarios(), options.boss);
    if (!tiers[tier]) throw new Error(`Unknown tier: ${tier}`);
    let results;
    if (options.results) results = readResults(options.results);
    else {
      if (!rest[0]) throw new Error('Pass a build file or --results <calculation.json,...>');
      return write(surviveFromFile({ file: path.resolve(rest[0]), scenario: options.scenario ?? 'sustained', profile, tier, base: baseChanges(), concurrency: conc() }));
    }
    return write(evaluateSurvival(profile, tier, results));
  }
  if (operation === 'stats') {
    const candidates = statCandidates(options.probes ? options.probes.split(',') : null, options.changes ? readJson(path.resolve(options.changes)) : {});
    if (options.plan || !rest[0]) return { experiment: 'custom_mods', probes: statProbes.length, candidates, note: 'Synthetic +1 unit bonuses through PoB custom modifiers; a numeric experiment, not an item or game test.' };
    return write(analyzeStats({ file: path.resolve(rest[0]), scenario: options.scenario ?? 'sustained', metric: options.metric ?? 'dps', candidates, base: baseChanges(), concurrency: conc() }));
  }
  if (operation === 'upgrades') {
    // --auto supports|uniques|anoints: candidates are generated from the build instead of a file.
    if (options.auto) { if (!rest[0]) throw new Error('Build file required'); return write(analyzeAutoUpgrades(autoUpgradeOptions(rest[0], options))); }
    if (!options.candidates) throw new Error('--candidates file.json required');
    const candidates = expandCandidates(readJson(path.resolve(options.candidates)));
    if (options.plan || !rest[0]) return { candidates: candidates.map(c => ({ id: c.id, type: c.meta.type, changes: c.changes, price: c.price, cost: c.cost })) };
    return write(analyzeUpgrades({ file: path.resolve(rest[0]), scenario: options.scenario ?? 'sustained', metric: options.metric ?? 'dps', candidates, base: baseChanges(), top: Number(options.top ?? 20), concurrency: conc(), budget: parseBudget(options.budget) }));
  }
  if (operation === 'nodes') {
    if (!rest[0]) throw new Error('Build file required');
    if (options.include && !['notable', 'all'].includes(options.include)) throw new Error('--include notable|all');
    return write(analyzeNodes({ file: path.resolve(rest[0]), scenario: options.scenario ?? 'sustained', metric: options.metric ?? 'dps', radius: Number(options.radius ?? 3), top: Number(options.top ?? 10), include: options.include ?? 'notable', base: baseChanges(), concurrency: conc() }));
  }
  throw new Error('Use analyze enemies [build] | enemy <type> | mapmods | mapmod <id> | encounter <xml> | mapmod-sweep <xml> | report <xml> | bosses [build] | boss <name> [--tier pinnacle|uber] | boss-changes <name> [--out-dir d] | survive [xml] --boss X [--tier] [--results files] | stats [xml] [--plan] | upgrades [xml] --candidates f.json [--plan] | nodes <xml>');
}

export const analysisHelp = {
  ...candidatesHelp,
  ...ablationHelp,
  ...interactionsHelp,
  ...Object.fromEntries(Object.entries(progressionHelp).map(([k, v]) => [`analyze ${k}`, v])),
  'analyze enemies [build]':'Enemy database: archetypes (normal..uber), map tiers, 111 map mods with engine coverage, boss skills; "build" regenerates scenarios/enemies.json',
  'analyze enemy <normal|magic|rare|unique|map_boss|pinnacle|uber|boss:Name[:Skill]> [--map-tier N] [--mods a,b] [--map-mod-effect P] [--delirium P] [--level L]':'Encounter definition and the exact PoB changes it produces (no engine run)',
  'analyze mapmods [--band white|yellow|red|t17] [--search text] [--method pob_map_affix|translated|partial|not_modelled]':'Map modifier catalogue and how each tier is modelled',
  'analyze atlas [--search text]':'Atlas nodes that affect map combat and whether --atlas can model them',
  'analyze encounter|report ... [--damage-profile physical|elemental|fire|cold|lightning|chaos|mixed] [--pantheon-major G] [--pantheon-minor G] [--atlas "Node,Node"]':'Monster hit type split, Pantheon gods (PoB config) and atlas nodes for an encounter',
  'analyze mapmod <id|name>':'One map modifier: RePoE text/stats per tier, PoB affix, translation, danger axes',
  'analyze encounter <xml> [--enemy rare] [--map-tier 16] [--mods a,b] [--enemy-life N] [--md f.md] [--out f.json]':'DPS/time-to-kill and hits-to-die/max hit/EHP against one encounter, compared with the same enemy without mods',
  'analyze mapmod-sweep <xml> [--map-tier 16] [--enemy rare] [--include combat|all] [--md f.md]':'Every map mod of the tier alone: avoid/caution/manual/ok with DPS, hits-to-die and EHP deltas',
  'analyze report <xml> [--map-tier 16] [--boss-tier uber] [--sweep-tiers 16,17] [--md f.md] [--out f.json]':'Full survival/damage report: map content, generic bosses, every boss skill preset, map mod sweeps; block foundation = build basics vs corpus norms of the ascendancy',
  'analyze coverage <xml> [--out f.json]':'Coverage audit: every power layer the build leaves unused (unspent points, masteries without effect, empty jewel/gem sockets and slots, flasks, anoint, eldritch implicits, open affixes without craft, quality, gems below 20/20, curse, free mana for auras, movement/guard skills, Pantheon) with the command that values each gap',
  'analyze bosses [build]':'Boss survival scenarios from pinned PoB boss data; "build" regenerates scenarios/bosses.json',
  'analyze boss <name> [--tier pinnacle|uber]':'Boss skill damage, penetration, flags and the PoB config that reproduces them',
  'analyze boss-changes <name> [--tier] [--changes base.json] [--out-dir dir]':'One --changes file per boss skill for pob run',
  'analyze survive [xml] --boss X [--tier uber] [--results files|dir] [--out f]':'Max hit per damage type against boss skills and what kills first; numeric estimate, not a game test',
  'analyze stats [xml] [--probes a,b] [--plan]':'Stat weights for +1 unit via custom_mods (synthetic experiment)',
  'analyze upgrades [xml] --candidates file.json [--plan] [--budget 5div|300c]':'Single and package upgrade ranking with dated prices (no totals across currency conflicts); variant_model with selection inside --budget',
  'analyze nodes <xml> [--metric dps|ehp|maxhit] [--radius N] [--top N]':'Node Power: gain per passive point for reachable nodes, one calculation contract',
  'eval list|show <id>|prompts|template|score --answers f':'Model evaluation cases: blind prompts, answer template, heuristic signals plus manual verdicts'
};

export function evaluate(args) {
  const { positional, options } = flags(args, ['category', 'answers', 'out', 'model', 'ids'], []);
  const [operation = 'list', id] = positional;
  const data = loadCases();
  const write = value => { if (options.out) atomicJson(path.resolve(options.out), value); return value; };
  if (operation === 'list') return { scope: data.scope, total: data.cases.length, cases: listCases(data, options.category ?? null) };
  if (operation === 'show') { const c = data.cases.find(x => x.id === id); if (!c) throw new Error(`Unknown case: ${id}`); return c; }
  if (operation === 'prompts') return write({ note: 'Blind requests only; give each to the evaluated model in a fresh session with bootstrap.', prompts: prompts(data, options.ids ? options.ids.split(',') : null) });
  if (operation === 'template') return write(answerTemplate(data, options.model ?? null));
  if (operation === 'score') { if (!options.answers) throw new Error('--answers answers.json required'); return write(scoreAnswers(data, readJson(path.resolve(options.answers)))); }
  throw new Error('Use eval list [--category c] | show <id> | prompts [--ids a,b] [--out f] | template [--model m] [--out f] | score --answers f [--out report.json]');
}
