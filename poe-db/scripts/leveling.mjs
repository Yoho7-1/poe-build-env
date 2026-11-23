// Offline leveling queries over data/leveling-3.30.json (built by build-leveling.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { dbRoot, readJson, flags } from './workspace.mjs';
import { levelingFile, CLASSES } from './build-leveling.mjs';

let cached = null;
export function loadLeveling() {
  if (cached) return cached;
  if (!fs.existsSync(levelingFile)) throw new Error('data/leveling-3.30.json missing: run node scripts/build-leveling.mjs (offline, from cache/wiki)');
  cached = readJson(levelingFile);
  return cached;
}

const norm = s => String(s ?? '').toLowerCase().trim();
function resolveClassName(value) {
  if (!value) throw new Error('--class <Marauder|Ranger|Witch|Duelist|Templar|Shadow|Scion> required');
  const found = CLASSES.find(c => norm(c) === norm(value));
  if (!found) throw new Error(`Unknown class ${value}. Use one of ${CLASSES.join(', ')} (base class, not ascendancy)`);
  return found;
}
const forClass = (row, cls) => row.classes.includes('all') || row.classes.includes(cls);
const provenance = d => Object.fromEntries(Object.entries(d.provenance).map(([k, v]) => [k, { origin: v.origin ?? v.version, sha256: v.sha256, obtained_at: v.obtained_at ?? null, revid: v.revid ?? null }]));

export function levelingGems(options, d = loadLeveling()) {
  const cls = resolveClassName(options.class);
  const act = options.act == null ? null : Number(options.act);
  if (act != null && (!Number.isInteger(act) || act < 1 || act > 10)) throw new Error('--act must be 1..10');
  const cumulative = !!options.cumulative;
  const kind = options.kind ?? 'all';
  if (!['all', 'active', 'support'].includes(kind)) throw new Error('--kind active|support|all');
  const text = norm(options.search);
  const rows = d.rewards.filter(r => r.kind === 'gem' && forClass(r, cls)
    && (act == null || (cumulative ? r.act <= act : r.act === act))
    && (!options.source || r.source === options.source)
    && (kind === 'all' || (kind === 'support') === d.gems[r.item].support)
    && (!text || norm(r.item).includes(text) || d.gems[r.item].tags.some(t => norm(t) === text)));
  const quests = new Map();
  for (const r of rows) {
    const key = `${r.act}|${r.quest}`;
    if (!quests.has(key)) quests.set(key, { act: r.act, quest: r.quest, quest_id: r.quest_id, reward_choice: [], vendor: [], vendor_npc: null });
    const q = quests.get(key);
    const g = d.gems[r.item];
    const entry = { gem: r.item, support: g.support, color: g.color, required_level: g.required_level };
    if (r.source === 'quest_reward') { if (r.client_check && r.client_check !== 'match') entry.client_check = r.client_check; q.reward_choice.push(entry); }
    else { q.vendor.push(entry); q.vendor_npc = r.npc; }
  }
  const order = [...quests.values()].sort((a, b) => a.act - b.act || a.quest_id?.localeCompare(b.quest_id ?? '') || 0);
  for (const q of order) { q.reward_choice.sort((a, b) => a.gem.localeCompare(b.gem)); q.vendor.sort((a, b) => a.gem.localeCompare(b.gem)); }
  const limit = Number(options.limit ?? 400);
  let shown = 0;
  const quests_out = [];
  let omitted = 0;
  for (const q of order) {
    const size = q.reward_choice.length + q.vendor.length;
    if (shown + size > limit && quests_out.length) { omitted += size; continue; }
    shown += size; quests_out.push(q);
  }
  // First time each gem becomes obtainable for the class (quest choice or purchase).
  const firstSeen = new Map();
  for (const r of d.rewards) if (r.kind === 'gem' && forClass(r, cls)) {
    const prev = firstSeen.get(r.item);
    if (!prev || r.act < prev.act) firstSeen.set(r.item, { act: r.act, via: r.source, quest: r.quest });
  }
  const conflicts = d.source_conflicts.filter(c => (c.only_client ?? []).includes(cls) || (c.only_wiki ?? []).includes(cls) || (c.type === 'quest_missing_in_wiki' && c.client.classes.includes(cls)));
  return {
    class: cls, act, cumulative, total_rows: rows.length, unique_gems: new Set(rows.map(r => r.item)).size,
    first_available_by_act: act == null ? null : Object.fromEntries([...Array(cumulative ? act : 1)].map((_, i) => cumulative ? i + 1 : act).map(a => [a, [...firstSeen].filter(([, v]) => v.act === a).length])),
    quests: quests_out, omitted_rows: omitted,
    source_conflicts: conflicts.map(c => ({ gem: c.item, type: c.type, act: c.act ?? c.client?.act, quest: c.quest ?? c.client?.quest, only_client: c.only_client, only_wiki: c.only_wiki })),
    notes: ['reward_choice: pick ONE gem per quest. vendor: purchasable from the NPC after the quest (cost not modelled).',
      'Siosa (Act 3, after A Fixture of Fate) and Lilly Roth (Act 6) sell many gems to all classes: use --source quest_reward to see only class-specific choices.',
      'Source rows are PoE Wiki Cargo data cross-checked with RePoE 3.30 client quest_reward; conflicts are listed, not resolved.'],
    provenance: provenance(d)
  };
}

export function levelingGem(name, d = loadLeveling()) {
  const target = Object.keys(d.gems).find(g => norm(g) === norm(name));
  if (!target) {
    const similar = Object.keys(d.gems).filter(g => norm(g).includes(norm(name))).slice(0, 10);
    return { gem: name, found: false, note: 'Not a quest/vendor reward (transfigured, drop-only or unknown gem).', similar };
  }
  const rows = d.rewards.filter(r => r.item === target);
  const byClass = Object.fromEntries(CLASSES.map(cls => {
    const own = rows.filter(r => forClass(r, cls)).sort((a, b) => a.act - b.act);
    const q = own.find(r => r.source === 'quest_reward'), v = own.find(r => r.source === 'vendor');
    return [cls, { first_act: own[0]?.act ?? null, quest_reward: q ? { act: q.act, quest: q.quest } : null, vendor: v ? { act: v.act, quest: v.quest, npc: v.npc } : null }];
  }));
  return { gem: target, ...d.gems[target], by_class: byClass,
    rows: rows.map(r => ({ source: r.source, act: r.act, quest: r.quest, npc: r.npc, classes: r.classes, client_check: r.client_check })),
    source_conflicts: d.source_conflicts.filter(c => c.item === target), provenance: provenance(d) };
}

export function levelingBooks(d = loadLeveling()) {
  const books = d.rewards.filter(r => r.kind === 'passive_point_book').sort((a, b) => a.act - b.act).map(r => ({ act: r.act, quest: r.quest, quest_id: r.quest_id }));
  const respec = d.rewards.filter(r => r.kind === 'respec_book').sort((a, b) => a.act - b.act).map(r => ({ act: r.act, quest: r.quest }));
  return { passive_point_books: books, count: books.length, respec_books: respec,
    notes: ['Each Book of Skill grants 1 passive skill point (Wiki quest_rewards rows).',
      'Bandit (Deal with the Bandits) rewards are not in these tables. GGG 3.30 tree max is 123 points = 99 levels + 24 quest points; reconcile 24 with these rows before relying on an exact quest total.'],
    provenance: provenance(d) };
}

export function levelingRecipes(options, d = loadLeveling()) {
  const text = norm(options.search);
  const rows = d.recipes.filter(r => (options.all ? true : r.leveling_relevant) && (!text || norm([r.result, ...r.ingredients, ...r.notes].join(' ')).includes(text)));
  const limit = Number(options.limit ?? 20);
  return { total: rows.length, scope: options.all ? 'all parsed recipe rows' : 'leveling_relevant (keyword heuristic over basic crafting/flasks/sockets)',
    results: rows.slice(0, limit), omitted: Math.max(0, rows.length - limit),
    notes: ['Parsed from the Wiki vendor recipe page (revision pinned in provenance); wording is simplified from wiki markup.'], provenance: { vendor_recipes: provenance(d).vendor_recipes } };
}

const NON_EQUIPMENT = /Map|Contract|Blueprint|Heist|Fishing|Relic|Sanctum|Fragment|Incubator|Currency|Item Piece/i;
export function levelingUniques(options) {
  const maxLevel = Number(options['max-level'] ?? 40);
  if (!Number.isFinite(maxLevel) || maxLevel < 1) throw new Error('--max-level must be a positive number');
  const slot = norm(options.slot);
  const text = norm(options.search);
  const file = path.join(dbRoot, 'data/uniques-3.30.jsonl');
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const u = JSON.parse(line);
    const lvl = u.requirements?.level;
    if (lvl == null || lvl > maxLevel) continue;
    if (u.availability?.status !== 'source_asserted_obtainable') continue;
    if (NON_EQUIPMENT.test(u.item_class ?? '')) continue;
    if (slot && !norm(u.item_class).includes(slot)) continue;
    const effects = [u.effects?.implicit, u.effects?.explicit_fixed].filter(Boolean).join('\n');
    if (text && !norm(`${u.name}\n${effects}`).includes(text)) continue;
    rows.push({ name: u.name, base_type: u.base_type, item_class: u.item_class, required_level: lvl, effects });
  }
  rows.sort((a, b) => a.required_level - b.required_level || a.name.localeCompare(b.name));
  const unique = [...new Map(rows.map(r => [`${r.name}|${r.base_type}`, r])).values()];
  const limit = Number(options.limit ?? 25);
  return { max_level: maxLevel, total: unique.length, flag: 'leveling_candidate = obtainable (Wiki acquisition flag) and required level <= max-level; heuristic list, not a recommendation or drop-rate claim',
    results: unique.slice(0, limit), omitted: Math.max(0, unique.length - limit), source: 'data/uniques-3.30.jsonl (catalog snapshot)' };
}

export function levelingCommand(args) {
  const [operation, ...rest] = args;
  const { positional, options } = flags(rest, ['class', 'act', 'kind', 'source', 'search', 'limit', 'max-level', 'slot'], ['cumulative', 'all']);
  if (operation === 'gems') return levelingGems(options);
  if (operation === 'gem') { if (!positional.length) throw new Error('leveling gem <name> required'); return levelingGem(positional.join(' ')); }
  if (operation === 'books') return levelingBooks();
  if (operation === 'recipes') return levelingRecipes({ ...options, search: options.search ?? positional.join(' ') });
  if (operation === 'uniques') return levelingUniques(options);
  if (operation === 'conflicts') { const d = loadLeveling(); return { total: d.source_conflicts.length, source_conflicts: d.source_conflicts, provenance: provenance(d) }; }
  throw new Error('Use leveling gems|gem|books|recipes|uniques|conflicts');
}
