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

const readResults = list => list.split(',').map(f => f.trim()).filter(Boolean).flatMap(f => {
  const full = path.resolve(f);
  if (fs.statSync(full).isDirectory()) return fs.readdirSync(full).filter(n => n.endsWith('.json')).map(n => readJson(path.join(full, n)));
  return [readJson(full)];
});

export function analyze(args) {
  const { positional, options } = flags(args, ['boss', 'tier', 'results', 'changes', 'out-dir', 'out', 'candidates', 'metric', 'scenario', 'radius', 'probes', 'top', 'include', 'concurrency'], ['plan', 'full']);
  const [operation, ...rest] = positional;
  const tier = options.tier ?? 'uber';
  const write = value => { if (options.out) atomicJson(path.resolve(options.out), value); return value; };
  const baseChanges = () => options.changes ? readJson(path.resolve(options.changes)) : {};
  const conc = () => { const n = Number(options.concurrency ?? defaultConcurrency); if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error('--concurrency 1-16'); return n; };
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
    if (!options.candidates) throw new Error('--candidates file.json required');
    const candidates = expandCandidates(readJson(path.resolve(options.candidates)));
    if (options.plan || !rest[0]) return { candidates: candidates.map(c => ({ id: c.id, type: c.meta.type, changes: c.changes, price: c.price, cost: c.cost })) };
    return write(analyzeUpgrades({ file: path.resolve(rest[0]), scenario: options.scenario ?? 'sustained', metric: options.metric ?? 'dps', candidates, base: baseChanges(), top: Number(options.top ?? 20), concurrency: conc() }));
  }
  if (operation === 'nodes') {
    if (!rest[0]) throw new Error('Build file required');
    if (options.include && !['notable', 'all'].includes(options.include)) throw new Error('--include notable|all');
    return write(analyzeNodes({ file: path.resolve(rest[0]), scenario: options.scenario ?? 'sustained', metric: options.metric ?? 'dps', radius: Number(options.radius ?? 3), top: Number(options.top ?? 10), include: options.include ?? 'notable', base: baseChanges(), concurrency: conc() }));
  }
  throw new Error('Use analyze bosses [build] | boss <name> [--tier pinnacle|uber] | boss-changes <name> [--out-dir d] | survive [xml] --boss X [--tier] [--results files] | stats [xml] [--plan] | upgrades [xml] --candidates f.json [--plan] | nodes <xml>');
}

export const analysisHelp = {
  'analyze bosses [build]':'Boss survival scenarios from pinned PoB boss data; "build" regenerates scenarios/bosses.json',
  'analyze boss <name> [--tier pinnacle|uber]':'Boss skill damage, penetration, flags and the PoB config that reproduces them',
  'analyze boss-changes <name> [--tier] [--changes base.json] [--out-dir dir]':'One --changes file per boss skill for pob run',
  'analyze survive [xml] --boss X [--tier uber] [--results files|dir] [--out f]':'Max hit per damage type against boss skills and what kills first; numeric estimate, not a game test',
  'analyze stats [xml] [--probes a,b] [--plan]':'Stat weights for +1 unit via custom_mods (synthetic experiment)',
  'analyze upgrades [xml] --candidates file.json [--plan]':'Single and package upgrade ranking with dated prices (no totals across currency conflicts)',
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
