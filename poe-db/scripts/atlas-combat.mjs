// Atlas passive nodes that change map combat. The knowledge DB stores only node stat text (no stat ids), so a small
// explicit set of generic sentences is translated; everything else touching monsters is listed as not modelled.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbRoot } from './workspace.mjs';

const knowledgeFile = path.join(dbRoot, 'data/knowledge-3.30.sqlite');
const clean = s => String(s).replace(/\[[^|\]]*\|([^\]]*)\]/g, '$1').replace(/\[([^\]]*)\]/g, '$1').replace(/\s+/g, ' ').trim();

// Sentence -> effect. `per_mod` scales with the number of explicit map modifiers in the encounter.
const rules = [
  { re: /^Monsters in your Maps deal (\d+)% (more|less) Damage$/, effect: m => ({ enemy_mods: [{ name: 'Damage', type: 'MORE', value: (m[2] === 'more' ? 1 : -1) * Number(m[1]) }] }) },
  { re: /^Monsters in your Maps have (\d+)% (more|less) Life$/, effect: m => ({ enemy_mods: [{ name: 'Life', type: 'MORE', value: (m[2] === 'more' ? 1 : -1) * Number(m[1]) }], life_more: (m[2] === 'more' ? 1 : -1) * Number(m[1]) }) },
  { re: /^(\d+)% increased effect of Explicit Modifiers on your Maps$/, effect: m => ({ map_mod_effect: Number(m[1]) }) },
  { re: /^(\d+)% increased effect of Explicit Modifiers on your Maps per Explicit Modifier$/, effect: m => ({ map_mod_effect_per_mod: Number(m[1]) }) }
];
const combatText = /^(Monsters|Unique Monsters|Rare Monsters|Magic Monsters) in your Maps (deal|have|take|are|gain)|^(Map Bosses|Unique Bosses) (deal|have|take|are)|effect of Explicit Modifiers on your Maps|additional (Monster )?Modifier/i;

export function loadAtlasNodes(file = knowledgeFile) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const seen = new Map();
    for (const r of db.prepare("SELECT name, payload_json FROM records WHERE category = 'atlas_nodes'").all()) {
      const p = JSON.parse(r.payload_json);
      if (!p.name || !(p.stats ?? []).length) continue;
      const stats = p.stats.map(clean);
      const key = `${p.name}|${stats.join('|')}`;
      if (!seen.has(key)) seen.set(key, { name: p.name, notable: !!p.isNotable, keystone: !!p.isKeystone, stats });
    }
    return [...seen.values()];
  } finally { db.close(); }
}

export function classifyAtlasNode(node) {
  const lines = node.stats.map(text => {
    const rule = rules.find(r => r.re.test(text));
    if (rule) return { text, status: 'modelled', effect: rule.effect(text.match(rule.re)) };
    return { text, status: combatText.test(text) ? 'not_modelled' : 'no_combat_effect' };
  });
  const status = lines.some(l => l.status === 'not_modelled') ? (lines.some(l => l.status === 'modelled') ? 'partial' : 'not_modelled')
    : lines.some(l => l.status === 'modelled') ? 'modelled' : 'no_combat_effect';
  return { ...node, status, lines };
}

export function atlasCombatNodes({ search = null, includeAll = false } = {}) {
  const s = search?.toLowerCase();
  return loadAtlasNodes().map(classifyAtlasNode)
    .filter(n => (includeAll || n.status !== 'no_combat_effect') && (!s || n.name.toLowerCase().includes(s) || n.stats.some(t => t.toLowerCase().includes(s))));
}

// Combined effect of chosen atlas nodes (by exact name, case-insensitive; a name with several copies counts once
// per listed occurrence, so "Map Modifier Effect" can be passed several times for several allocated small nodes).
export function atlasEffects(names, { explicitModCount = 0, nodes = null } = {}) {
  const all = (nodes ?? loadAtlasNodes()).map(classifyAtlasNode);
  const out = { enemy_mods: [], map_mod_effect: 0, life_more: 0, applied: [], not_modelled: [] };
  for (const raw of names) {
    const node = all.find(n => n.name.toLowerCase() === String(raw).trim().toLowerCase());
    if (!node) throw new Error(`Unknown atlas node: ${raw}. Try: analyze atlas --search <text>`);
    for (const l of node.lines) {
      if (l.status === 'not_modelled') out.not_modelled.push({ node: node.name, text: l.text });
      if (l.status !== 'modelled') continue;
      const e = l.effect;
      out.enemy_mods.push(...(e.enemy_mods ?? []).map(m => ({ ...m, source: `Atlas ${node.name}` })));
      out.map_mod_effect += (e.map_mod_effect ?? 0) + (e.map_mod_effect_per_mod ?? 0) * explicitModCount;
      out.life_more += e.life_more ?? 0;
      out.applied.push({ node: node.name, text: l.text });
    }
  }
  return out;
}
