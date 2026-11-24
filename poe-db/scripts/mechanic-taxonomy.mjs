// Mechanic taxonomy (master prompt 3 "every mechanic"): the machine list of mechanics is what the pinned PoB parses.
// PoB's ModCache.lua maps every known mod line of items/tree/gems to internal mod names (Life, ImpaleChance, ...)
// with tags (Condition/Multiplier vars, PerStat, SkillType ...). This module derives from it:
//   - mod names with line counts and examples (the vocabulary PoB calculates with);
//   - condition/multiplier variables (situations a build must satisfy: KilledRecently, Frenzy charges, ...);
//   - lines PoB does not parse at all, or only partly (automatic PoB-gap candidates);
//   - coverage: which mod names are explained by a mechanic card (mechanics/cards.json) or the gap registry.
// Read-only over vendored PoB; no network. Counts describe PoB's mod vocabulary, not how often builds use a mod.
import fs from 'node:fs';
import path from 'node:path';
import { dbRoot, readJson, atomicJson, flags } from './workspace.mjs';
import { gaps as gapRegistry } from '../mechanics/gaps.mjs';

const modCacheFile = () => path.join(dbRoot, 'vendor/pob/src/Data/ModCache.lua');
const hasRange = s => /\(\d+(\.\d+)?-\d+(\.\d+)?\)|#/.test(s);
const unescape = s => s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

// Parse ModCache.lua lines: c["text"]={ {mods...} | nil , "leftover" | nil }.
export function parseModCache(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    const m = /^c\["((?:[^"\\]|\\.)*)"\]=\{(.*)\}\s*$/.exec(line);
    if (!m) continue;
    const body = m[2];
    const unparsed = body.startsWith('nil,');
    const leftover = /,"((?:[^"\\]|\\.)*)"\}?$/.exec(body)?.[1]?.trim() ?? null;
    const mods = [], vars = [];
    // Innermost tables first (tags), each replaced by a token, so a mod table with nested tags becomes innermost next.
    let rest = body.replace(/"(?:[^"\\]|\\.)*"/g, s => s.replace(/[{}]/g, ''));
    for (let guard = 0; guard < 50 && /\{[^{}]*\}/.test(rest); guard++) {
      rest = rest.replace(/\{([^{}]*)\}/g, (_, inner) => {
        const kv = Object.fromEntries([...inner.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|[^,]+)/g)].map(x => [x[1], x[2].replace(/^"|"$/g, '')]));
        if (kv.name && kv.type && 'flags' in kv) mods.push({ name: kv.name, type: kv.type });
        else if (kv.type && (kv.var || kv.varList || kv.stat || kv.skillType || kv.skillName)) vars.push({ type: kv.type, var: kv.var ?? kv.stat ?? kv.skillName ?? kv.skillType ?? kv.varList });
        return 'T';
      });
    }
    entries.push({ text: unescape(m[1]), unparsed, leftover: leftover && !unparsed ? leftover : null, mods, vars });
  }
  return entries;
}

const words = s => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
// Card keywords: id parts, aliases, title words. A mod name is covered when one of its words (or the whole name) matches.
export function cardIndex(cards, gaps = []) {
  const idx = new Map();
  const add = (w, id) => { if (!idx.has(w)) idx.set(w, new Set()); idx.get(w).add(id); };
  for (const c of cards) for (const w of [...String(c.id).split('-'), ...(c.aliases ?? []).flatMap(words), ...words(c.title ?? '')]) if (w.length > 2) add(w.toLowerCase(), `card:${c.id}`);
  for (const g of gaps) for (const w of [...String(g.id).split(/[-_]/), ...words(g.title ?? '')]) if (w.length > 2) add(w.toLowerCase(), `gap:${g.id}`);
  return idx;
}
// Explicit name rules first (generic stat names that keyword matching cannot place); `non_combat` names are excluded
// from coverage (loot, light radius). Unmatched names stay uncovered: they are real holes of the knowledge base.
export const NAME_RULES = [
  [/^(Damage|DoubleDamageChance|TripleDamageChance)$|^(Physical|Fire|Cold|Lightning|Chaos|Elemental)?(Damage|Min|Max)$/, ['card:added-damage', 'card:increased-more']],
  [/Resist|Penetration|ResChance/, ['card:resistance-penetration']],
  [/Explode|Cull/, ['gap:on_kill_explosions']],
  [/^Condition:(Chilled|Crushed|Intimidated|Blinded|Debilitated|Maimed|Hindered|Unnerved)$|Debilitate|AsThoughDealing/, ['card:enemy-debuffs', 'card:ailments']],
  [/Evade|Evasion/, ['card:avoidance-block-suppression']],
  [/ConvertTo|GainAs|DealNo/, ['card:conversion']],
  [/Scorch|Brittle|Sap(Base|Effect)?$|^CannotSap|Malediction/, ['card:ailments', 'card:enemy-debuffs']],
  [/^(SkillData|Dummy|DisableSkill|EnableSkill|WeaponData|ExtraSkill|ExtraSupport|GemProperty|SocketedIn|LinkedSupport)$/, ['internal']],
  [/^Loot|LightRadius|^ItemQuantity|^ItemRarity/, ['non_combat']]
];
export function ruleCover(name) { for (const [re, ids] of NAME_RULES) if (re.test(name)) return ids; return null; }
const STOP = new Set(['damage', 'increased', 'chance', 'base', 'more', 'per', 'with', 'the', 'and', 'for', 'you', 'your', 'when', 'all', 'from', 'skill', 'skills', 'effect', 'rate']);
export function coverOf(name, idx) {
  const ws = words(name).filter(w => !STOP.has(w));
  const hits = new Set();
  for (const w of ws) for (const id of idx.get(w) ?? []) hits.add(id);
  return [...hits].sort();
}

export function buildTaxonomy({ entries, cards = [], gaps = [] }) {
  const names = new Map(), vars = new Map();
  for (const e of entries) {
    for (const m of e.mods) {
      const r = names.get(m.name) ?? { name: m.name, lines: 0, types: new Set(), example: e.text };
      r.lines++; r.types.add(m.type); names.set(m.name, r);
    }
    for (const v of e.vars) {
      const k = `${v.type}:${v.var}`;
      const r = vars.get(k) ?? { type: v.type, var: v.var, lines: 0, example: e.text };
      r.lines++; vars.set(k, r);
    }
  }
  const idx = cardIndex(cards, gaps);
  const gapIds = new Set(gaps.map(g => `gap:${g.id}`));
  const modNames = [...names.values()].map(r => {
    const rule = ruleCover(r.name)?.filter(id => id === 'non_combat' || id === 'internal' || id.startsWith('card:') || gapIds.has(id));
    return { name: r.name, lines: r.lines, types: [...r.types].sort(), example: r.example, covered_by: rule?.length ? rule : coverOf(r.name, idx) };
  }).sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
  const unparsed = entries.filter(e => e.unparsed && !hasRange(e.text)).map(e => e.text);
  const partial = entries.filter(e => e.leftover && !hasRange(e.leftover)).map(e => ({ text: e.text, leftover: e.leftover }));
  // Unparsed lines grouped by their most frequent content words: the themes PoB does not calculate.
  const themes = new Map();
  for (const t of unparsed) for (const w of new Set(words(t).filter(w => !STOP.has(w) && !/^\d+$/.test(w)))) themes.set(w, (themes.get(w) ?? 0) + 1);
  const uncovered = modNames.filter(r => !r.covered_by.length);
  return {
    schema: 'mechanic-taxonomy/1', source: 'vendor/pob/src/Data/ModCache.lua (pinned PoB)', entries: entries.length,
    summary: { mod_names: modNames.length, covered_mod_names: modNames.length - uncovered.length, covered_lines_share: round3(modNames.filter(r => r.covered_by.length).reduce((a, r) => a + r.lines, 0) / Math.max(1, modNames.reduce((a, r) => a + r.lines, 0))),
      condition_vars: vars.size, unparsed_lines: unparsed.length, partial_lines: partial.length, cards: cards.length, gaps: gaps.length },
    mod_names: modNames, uncovered: uncovered.map(r => ({ name: r.name, lines: r.lines, example: r.example })),
    condition_vars: [...vars.values()].sort((a, b) => b.lines - a.lines || a.var.localeCompare(b.var)),
    unparsed: { count: unparsed.length, themes: [...themes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([word, n]) => ({ word, lines: n })), examples: unparsed.slice(0, 40) },
    partial: { count: partial.length, examples: partial.slice(0, 40) },
    note: 'Coverage is keyword matching of PoB mod names to mechanic cards/gap ids: a quick map of what the knowledge base explains, not a proof. Unparsed lines are PoB-gap candidates; ranged template lines are excluded.'
  };
}
const round3 = v => Math.round(v * 1000) / 1000;

export function loadTaxonomy({ refresh = false } = {}) {
  const cache = path.join(dbRoot, 'cache/mechanic-taxonomy.json');
  const src = modCacheFile();
  const stat = fs.statSync(src);
  const cardsFile = path.join(dbRoot, 'mechanics/cards.json');
  const cardsMtime = fs.existsSync(cardsFile) ? fs.statSync(cardsFile).mtimeMs : null;
  if (!refresh && fs.existsSync(cache)) { const c = readJson(cache); if (c.source_mtime === stat.mtimeMs && c.source_size === stat.size && c.cards_mtime === cardsMtime) return c; }
  const cards = fs.existsSync(path.join(dbRoot, 'mechanics/cards.json')) ? readJson(path.join(dbRoot, 'mechanics/cards.json')) : [];
  const t = { ...buildTaxonomy({ entries: parseModCache(fs.readFileSync(src, 'utf8')), cards, gaps: gapRegistry }), source_mtime: stat.mtimeMs, source_size: stat.size, cards_mtime: cardsMtime };
  atomicJson(cache, t);
  return t;
}

export function taxonomyCommand(args) {
  const { positional, options } = flags(args, ['search', 'top', 'out'], ['refresh', 'uncovered', 'unparsed', 'vars']);
  if (positional[0] !== 'taxonomy') throw new Error('Use mechanic taxonomy [--uncovered|--unparsed|--vars] [--search text] [--top 40] [--refresh]');
  const t = loadTaxonomy({ refresh: !!options.refresh });
  const top = Number(options.top ?? 40);
  const q = options.search ? String(options.search).toLowerCase() : null;
  const match = s => !q || String(s).toLowerCase().includes(q);
  const out = { schema: t.schema, source: t.source, summary: t.summary, note: t.note };
  if (options.uncovered) out.uncovered = t.uncovered.filter(r => match(r.name) || match(r.example)).slice(0, top);
  else if (options.unparsed) out.unparsed = { count: t.unparsed.count, themes: t.unparsed.themes.slice(0, top), examples: t.unparsed.examples.filter(match).slice(0, top) };
  else if (options.vars) out.condition_vars = t.condition_vars.filter(v => match(v.var)).slice(0, top);
  else out.mod_names = t.mod_names.filter(r => match(r.name) || match(r.example)).slice(0, top).map(r => ({ name: r.name, lines: r.lines, covered_by: r.covered_by, example: r.example }));
  if (options.out) atomicJson(path.resolve(options.out), t);
  return out;
}
export const taxonomyHelp = {
  'mechanic taxonomy [--uncovered|--unparsed|--vars] [--search text] [--top 40] [--refresh]': 'Machine list of mechanics from the pinned PoB ModCache: mod names PoB calculates with (line counts, examples), condition/multiplier variables, lines PoB does not parse (PoB-gap candidates) and which mod names the mechanic cards/gap registry cover (keyword map)'
};
