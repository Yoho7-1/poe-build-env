// Offline build: cache/wiki (quest/vendor rewards, vendor recipe page) + RePoE 3.30 gems -> data/leveling-3.30.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbRoot, atomicJson, readJson } from './workspace.mjs';
import { readWikiCache, decodeEntities } from './wiki-source.mjs';

export const levelingFile = path.join(dbRoot, 'data/leveling-3.30.json');
export const CLASSES = ['Marauder', 'Ranger', 'Witch', 'Duelist', 'Templar', 'Shadow', 'Scion'];
const ALL = 'all';

export function wikiPlain(text) {
  if (text == null) return '';
  let s = decodeEntities(String(text));
  s = s.replace(/<ref[^>]*\/>/g, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '').replace(/<br\s*\/?>/gi, ' ');
  for (let i = 0; i < 4; i++) {
    s = s.replace(/\{\{(?:c|colour|color)\|[^|{}]*\|([^{}]*)\}\}/gi, '$1')
      .replace(/\{\{(?:il|item link|ii|psl|sl|ml|skill link)\|([^|{}]*)(?:\|[^{}]*)?\}\}/gi, '$1')
      .replace(/\{\{(?:mod|l)\|([^|{}]*)(?:\|[^{}]*)?\}\}/gi, '$1')
      .replace(/\{\{[^{}]*\}\}/g, '');
  }
  s = s.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1').replace(/'''?/g, '').replace(/<[^>]+>/g, '');
  return s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function parseRecipes(wikitext) {
  const lines = wikitext.split('\n');
  const rows = [];
  const heading = [];
  let inTable = false, row = null, cells = [];
  const flush = () => {
    if (row && cells.length >= 2) {
      const [result, ingredients, notes] = cells.map(c => c.replace(/^\s*(?:[a-z-]+="[^"]*"\s*)+\|/i, '').trim());
      rows.push({ section: heading.filter(Boolean).join(' / '), result: wikiPlain(result), ingredients: wikiPlain(ingredients).split('\n').map(x => x.replace(/^\*\s*/, '').trim()).filter(Boolean), notes: notes ? wikiPlain(notes).split('\n').map(x => x.replace(/^\*\s*/, '').trim()).filter(Boolean) : [] });
    }
    row = null; cells = [];
  };
  for (const line of lines) {
    const h = line.match(/^(={2,5})\s*(.*?)\s*\1\s*$/);
    if (h) { heading.length = h[1].length - 1; heading[h[1].length - 2] = h[2]; continue; }
    if (line.startsWith('{|')) { inTable = true; row = null; cells = []; continue; }
    if (!inTable) continue;
    if (line.startsWith('|}')) { flush(); inTable = false; continue; }
    if (line.startsWith('|-')) { flush(); row = true; continue; }
    if (line.startsWith('!')) continue;
    if (row && line.startsWith('|')) { cells.push(line.slice(1)); continue; }
    if (row && cells.length) cells[cells.length - 1] += '\n' + line;
  }
  return rows.filter(r => r.result && r.ingredients.length);
}

const LEVELING_SECTIONS = /^(Equipment \/ Basic crafting|Equipment \/ Flasks|Sockets)/;
const LEVELING_RECIPE =/movement speed|increased physical damage|increased spell damage|added (fire|cold|lightning) damage|to all elemental resistances|chromatic|jeweller|fusing|linked/i;

export function buildLeveling() {
  const quest = readWikiCache('quest_rewards');
  const vendor = readWikiCache('vendor_rewards');
  const recipePage = readWikiCache('page_vendor_recipe_system');
  const knowledgeManifest = readJson(path.join(dbRoot, 'cache/knowledge/manifest.json'));
  const gemsFile = path.join(dbRoot, 'cache/knowledge/gems.json');
  const gemsSource = knowledgeManifest.sources.find(s => s.file === 'cache/knowledge/gems.json');
  const gems = readJson(gemsFile);
  const gemInfo = new Map();
  for (const g of Object.values(gems)) {
    const name = g.base_item?.display_name;
    if (!name || g.base_item.release_state !== 'released' || gemInfo.has(name)) continue;
    const lvl1 = g.per_level?.['1'];
    gemInfo.set(name, {
      support: !!g.is_support, color: g.color ?? null, tags: g.tags ?? [], required_level: lvl1?.required_level ?? null,
      client_quest_reward: g.quest_reward ? { act: g.quest_reward.act, quest: g.quest_reward.quest, classes: [...new Set(g.quest_reward.classes)].sort() } : null
    });
  }
  const kindOf = item => item.startsWith('Book of Skill') ? 'passive_point_book' : item.startsWith('Book of Regrets') ? 'respec_book' : gemInfo.has(item) ? 'gem' : 'item';
  const classesOf = value => { const list = (value ?? '').split(',').map(s => s.trim()).filter(Boolean); return list.length ? [...new Set(list)].sort() : [ALL]; };
  const rewards = [];
  for (const r of quest.value) {
    const item = decodeEntities(r.item);
    const row = { source: 'quest_reward', item, kind: kindOf(item), act: Number(r.act), quest: decodeEntities(r.quest), quest_id: r['quest id'] ?? null, npc: null, classes: classesOf(r.classes) };
    if (r['item level']) row.item_level = Number(r['item level']);
    if (r.rarity) row.rarity = r.rarity;
    if (r.sockets) row.sockets = Number(r.sockets);
    if (r.notes) row.notes = wikiPlain(r.notes);
    rewards.push(row);
  }
  for (const r of vendor.value) {
    const item = decodeEntities(r.item);
    rewards.push({ source: 'vendor', item, kind: kindOf(item), act: Number(r.act), quest: decodeEntities(r.quest), quest_id: r['quest id'] ?? null, npc: decodeEntities(r.npc), classes: classesOf(r.classes) });
  }
  // Cross-check quest gem rewards against client data (RePoE gems.quest_reward: one entry per gem).
  const conflicts = [];
  for (const [name, info] of gemInfo) {
    const c = info.client_quest_reward;
    if (!c) continue;
    const rows = rewards.filter(r => r.source === 'quest_reward' && r.item === name);
    const match = rows.find(r => r.act === c.act && r.quest === c.quest);
    if (!match) { conflicts.push({ item: name, type: 'quest_missing_in_wiki', client: c, wiki: rows.map(r => ({ act: r.act, quest: r.quest, classes: r.classes })) }); continue; }
    const wikiClasses = match.classes[0] === ALL ? CLASSES.slice().sort() : match.classes;
    const same = wikiClasses.join(',') === c.classes.join(',');
    match.client_check = same ? 'match' : 'class_mismatch';
    if (!same) conflicts.push({ item: name, type: 'class_mismatch', act: c.act, quest: c.quest, client_classes: c.classes, wiki_classes: match.classes,
      only_client: c.classes.filter(x => !wikiClasses.includes(x)), only_wiki: wikiClasses.filter(x => !c.classes.includes(x)) });
  }
  for (const r of rewards) if (r.source === 'quest_reward' && r.kind === 'gem' && !r.client_check) r.client_check = 'no_client_record';
  const unknownItems = [...new Set(rewards.filter(r => r.kind === 'item').map(r => r.item))].sort();
  const gemsOut = {};
  for (const name of new Set(rewards.filter(r => r.kind === 'gem').map(r => r.item))) {
    const g = gemInfo.get(name);
    gemsOut[name] = { support: g.support, color: g.color, tags: g.tags, required_level: g.required_level };
  }
  const recipes = parseRecipes(recipePage.value.wikitext).map(r => ({ ...r, leveling_relevant: LEVELING_SECTIONS.test(r.section) && LEVELING_RECIPE.test(r.result + ' ' + r.ingredients.join(' ')) }));
  const data = {
    game: 'poe1', patch: '3.30', built_at: new Date().toISOString(),
    provenance: {
      quest_rewards: { ...quest.meta, origin: 'PoE Wiki Cargo table quest_rewards (community-maintained; not pinned to a game build)' },
      vendor_rewards: { ...vendor.meta, origin: 'PoE Wiki Cargo table vendor_rewards' },
      vendor_recipes: { ...recipePage.meta, origin: 'PoE Wiki page "Vendor recipe system" (wikitext, revision pinned)' },
      gems: { file: 'cache/knowledge/gems.json', url: gemsSource?.url ?? null, sha256: gemsSource?.sha256 ?? null, version: 'RePoE 3.30.0.4', use: 'gem metadata and client quest_reward cross-check' }
    },
    semantics: {
      classes_all: 'classes ["all"] means the source row has no class restriction (e.g. Siosa after A Fixture of Fate, Lilly Roth in Act 6).',
      quest_reward: 'Quest rewards are a choice of ONE item among the options offered to the class for that quest.',
      vendor: 'Vendor rows become purchasable from the NPC after the quest; vendor stock costs currency (not modelled).',
      client_check: 'match / class_mismatch / no_client_record against RePoE gems.quest_reward (one quest per gem in client export). Conflicts are kept, not resolved.'
    },
    counts: { rewards: rewards.length, quest_rewards: quest.value.length, vendor_rewards: vendor.value.length, gems: Object.keys(gemsOut).length, recipes: recipes.length, conflicts: conflicts.length },
    gems: gemsOut, rewards, source_conflicts: conflicts, non_gem_items: unknownItems, recipes
  };
  atomicJson(levelingFile, data);
  return { file: path.relative(dbRoot, levelingFile).replaceAll('\\', '/'), counts: data.counts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(buildLeveling(), null, 2));
