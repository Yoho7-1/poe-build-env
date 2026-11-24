// WP8 part 2: reverse theorycrafting. A goal ("cannot be frozen", "penetrates cold resistance", "leeched as mana")
// -> every independent way to get it from local data, grouped by source, each with its cost:
//   tree notables/keystones/masteries (passive points from the build's current tree, PoB-rule BFS), anoints (oils),
//   uniques (stored price floor in divine, availability flag), item mods (prefix/suffix, level, slots by spawn tags),
//   bench crafts, tattoos, viscera, Pantheon souls, Foulborn mods, support gems.
// Search and costs only: whether a path is worth it is measured by PoB (analyze nodes|candidates|upgrades). Text
// matching over source texts; a regex is the goal language (case-insensitive).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbRoot, flags } from './workspace.mjs';
import { loadTree, rootsFor, distances } from './tree-graph.mjs';
import { readBuild } from './analysis-candidates.mjs';
import { defaultUniqueLookup } from './design-seed.mjs';

const lines = s => String(s ?? '').replace(/\r/g, '').split('\n').map(x => x.trim()).filter(Boolean);
const arr = v => v == null ? [] : Array.isArray(v) ? v : typeof v === 'object' ? Object.values(v).flat(Infinity) : [v];
const matchLines = (re, texts) => arr(texts).flatMap(x => lines(typeof x === 'string' ? x : JSON.stringify(x))).filter(l => re.test(l));

export function reverseSearch({ pattern, xml = null, top = 8, prices = true } = {}) {
  if (!pattern) throw new Error('goal pattern required');
  const re = new RegExp(pattern, 'i');
  const out = {};
  const add = (kind, row) => (out[kind] ??= []).push(row);
  // --- tree: notables, keystones, normal nodes, mastery effects; cost from the build's tree when given ---
  const t = loadTree();
  let dist = null, build = null;
  if (xml) {
    build = readBuild(xml);
    const cls = t.classes.find(c => c.name === build.class);
    const allocated = new Set([...build.allocated].map(Number));
    if (cls) dist = distances(t, rootsFor(t, cls, allocated, null), allocated);
  }
  for (const n of t.nodes.values()) {
    if (n.eligibility !== 'tree_defined' || n.proxy) continue;
    if (n.ascendancy && build && n.ascendancy !== build.ascendancy) continue;
    if (['notable', 'keystone', 'normal'].includes(n.type)) {
      const hit = matchLines(re, n.stats ?? []);
      if (hit.length) add('tree', { name: n.name, node: n.id, type: n.type, ascendancy: n.ascendancy ?? undefined, match: hit.slice(0, 2), allocated: build ? build.allocated.has(String(n.id)) : undefined, points: dist?.get(n.id) ?? null });
    }
    if (n.type === 'mastery') for (const e of n.mastery_effects ?? []) {
      const hit = matchLines(re, e.stats ?? []);
      if (hit.length) add('mastery', { name: n.name, node: n.id, effect: e.effect, match: hit.slice(0, 2), points: dist ? (dist.get(n.id) ?? null) : null });
    }
  }
  // --- knowledge DB sources ---
  const db = new DatabaseSync(path.join(dbRoot, 'data/knowledge-3.30.sqlite'), { readOnly: true });
  try {
    const each = (category, fn) => { for (const r of db.prepare('SELECT id,name,summary,eligibility,payload_json FROM records WHERE category=?').iterate(category)) fn(r, JSON.parse(r.payload_json)); };
    each('anointments', (r, p) => { const hit = matchLines(re, p.stats ?? []); if (hit.length) add('anoint', { name: r.name, oils: p.oils, match: hit.slice(0, 2) }); });
    each('mods', (r, p) => {
      if (!['item', 'flask'].includes(p.domain) || !['prefix', 'suffix'].includes(p.generation_type)) return;
      const weights = (p.spawn_weights ?? []).filter(w => w.weight > 0).map(w => w.tag);
      if (!weights.length) return;
      const hit = matchLines(re, [r.summary]).filter(l => l !== r.id && l !== p.name);
      if (hit.length) add(p.domain === 'flask' ? 'flask_mod' : 'item_mod', { name: p.name, mod: r.id, generation: p.generation_type, level: p.required_level, slots: weights.slice(0, 6), match: hit.slice(0, 1) });
    });
    each('bench_crafts', (r) => { const hit = matchLines(re, [r.name]); if (hit.length) add('bench_craft', { name: r.name, slots: lines(r.summary).slice(1, 6).filter(l => !l.startsWith('{')) }); });
    each('tattoo_nodes', (r) => { const hit = matchLines(re, lines(r.summary).slice(1)); if (hit.length) add('tattoo', { name: r.name, match: hit.slice(0, 2) }); });
    each('viscera', (r) => { const hit = matchLines(re, lines(r.summary).slice(1)); if (hit.length) add('viscera', { name: r.name, match: hit.slice(0, 2) }); });
    each('pantheon', (r, p) => { for (const s of p.souls ?? []) { const hit = matchLines(re, (s.mods ?? []).map(m => m.line)); if (hit.length) add('pantheon', { god: r.name, soul: s.name, major: !!p.isMajorGod, match: hit.slice(0, 2) }); } });
    each('foulborn_mods', (r, p) => { const hit = matchLines(re, [p['1'] ?? '', ...arr(p.tradeHashes)]); if (hit.length) add('foulborn', { mod: r.id, match: hit.slice(0, 1) }); });
    each('gems', (r, p) => { if (!p.is_support) return; const hit = matchLines(re, [p.active_skill?.description ?? '', ...arr(p.static?.stat_text)]); if (hit.length) add('support_gem', { name: r.name, match: hit.slice(0, 1) }); });
  } finally { db.close(); }
  // --- uniques (fixed explicit/implicit text) with price floor ---
  const priceOf = prices ? defaultUniqueLookup() : () => null;
  const uniquesFile = path.join(dbRoot, 'data/uniques-3.30.jsonl');
  if (fs.existsSync(uniquesFile)) for (const l of fs.readFileSync(uniquesFile, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const u = JSON.parse(l);
    const hit = matchLines(re, [u.effects?.implicit, u.effects?.explicit_fixed]);
    if (!hit.length) continue;
    add('unique', { name: u.name, base: u.base_type, item_class: u.item_class, availability: u.availability?.status ?? null, level: u.requirements?.level ?? null, match: hit.slice(0, 2), divine_floor: prices ? priceOf(u.name) : null });
  }
  // Ranking inside a kind: cheapest first (tree points / price / level), unknown cost last.
  const costOf = { tree: r => r.allocated ? -1 : r.points ?? 999, mastery: r => r.points ?? 999, unique: r => r.divine_floor ?? 9999, item_mod: r => r.level ?? 99 };
  const result = {};
  for (const [kind, rows] of Object.entries(out)) {
    const c = costOf[kind];
    const sorted = c ? [...rows].sort((a, b) => c(a) - c(b)) : rows;
    result[kind] = { count: rows.length, top: sorted.slice(0, top) };
  }
  return { goal: pattern, build: xml ? path.basename(xml) : null, kinds: Object.keys(result).length, paths: result,
    cost_units: { tree: 'passive points from the current tree (PoB traversal rules; null = no build or unreachable)', unique: 'divine floor: cheapest stored variant (poe.ninja divineValue, reference market PC)', item_mod: 'required item level of the mod tier', anoint: 'oils' },
    note: 'Text matches over local data; ranges, conditions and availability need checking. Value each path with PoB (analyze nodes for tree, analyze candidates|upgrades for items/anoints) before choosing.' };
}

export function reverseCommand(args) {
  const { positional, options } = flags(args, ['xml', 'top'], ['no-prices']);
  if (positional[0] !== 'reverse' || !positional[1]) throw new Error('Use design reverse "<goal regex>" [--xml build.xml] [--top 8] [--no-prices]');
  return reverseSearch({ pattern: positional[1], xml: options.xml ? path.resolve(options.xml) : null, top: Number(options.top ?? 8), prices: !options['no-prices'] });
}
export const reverseHelp = {
  'design reverse "<goal regex>" [--xml build.xml] [--top 8] [--no-prices]': 'Reverse theorycrafting: every source of a goal (tree nodes and masteries with point cost from the build, anoints with oils, uniques with price floor, item mods by level and slot tags, bench crafts, tattoos, viscera, Pantheon, Foulborn, support gems); costs only, value with PoB afterwards'
};
