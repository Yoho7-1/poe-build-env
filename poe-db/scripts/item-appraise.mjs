// Rare item appraisal: parse an item copied from the game (Ctrl+C or advanced Ctrl+Alt+C) or PoB item text,
// match its modifiers to pinned RePoE 3.30.0.4 mods (tier, roll quality, prefix/suffix, open affixes),
// compute trade-style pseudo totals and manual trade-search filters, and optionally measure its value
// for a build in the pinned PoB engine (equip in a slot, compare key stats with the unchanged build).
// Offline only: rare items have no market price in the local snapshots; the market part is a search
// suggestion, not a price.
import fs from 'node:fs';
import path from 'node:path';
import { flags, atomicJson } from './workspace.mjs';
import { checkItem } from './item-builder.mjs';
import { loadCatalog, influenceSuffix } from '../experiments/craft-lab/v2/catalog.mjs';
import { emptyItem, itemTags, capacity, isAffix } from '../experiments/craft-lab/v2/item.mjs';
import { tierInfo, pool as craftPool } from '../experiments/craft-lab/v2/draw.mjs';
import { renderRoll } from '../experiments/craft-lab/v2/export.mjs';
import { firstWeight } from '../experiments/craft-lab/engine.mjs';

const SCOPE = 'Mod matching uses pinned RePoE 3.30.0.4 (Craft Lab v2 catalog). Tiers and roll quality are descriptive; they are not a market price. '
  + 'Rare items have no price in the local snapshots (poe.ninja does not price rares); build value comes only from --check (PoB estimate, not a game test).';
const SLOT_BY_CLASS = { Helmet: 'Helmet', 'Body Armour': 'Body Armour', Gloves: 'Gloves', Boots: 'Boots', Belt: 'Belt', Amulet: 'Amulet', Ring: 'Ring 1',
  Shield: 'Weapon 2', Quiver: 'Weapon 2', Bow: 'Weapon 1', Claw: 'Weapon 1', Dagger: 'Weapon 1', 'Rune Dagger': 'Weapon 1', 'One Hand Axe': 'Weapon 1',
  'One Hand Mace': 'Weapon 1', 'One Hand Sword': 'Weapon 1', 'Thrusting One Hand Sword': 'Weapon 1', Sceptre: 'Weapon 1', Staff: 'Weapon 1',
  Warstaff: 'Weapon 1', 'Two Hand Axe': 'Weapon 1', 'Two Hand Mace': 'Weapon 1', 'Two Hand Sword': 'Weapon 1', Wand: 'Weapon 1' };
const INFLUENCES = Object.keys(influenceSuffix);
const FLAG_LINES = new Set(['Corrupted', 'Mirrored', 'Split', 'Unidentified', 'Synthesised Item', 'Fractured Item', 'Searing Exarch Item', 'Eater of Worlds Item']);
const MARKERS = ['implicit', 'crafted', 'enchant', 'fractured', 'scourge', 'crucible'];

// ---------- text helpers
const NUM = /-?\d+(?:\.\d+)?/g;
const template = line => String(line).toLowerCase().replace(NUM, '#').replace(/\s+/g, ' ').trim();
const numbers = line => (String(line).match(NUM) ?? []).map(Number);
// "+68(65-69) to maximum Life" (advanced copy) -> "+68 to maximum Life"; drop "— Unscalable Value" notes.
const cleanLine = line => String(line).replace(/\((-?[\d.]+)-(-?[\d.]+)\)/g, '').replace(/\s+[—-]+\s+Unscalable Value$/i, '').trim();

// ---------- parsing
function parseHeader(line) {
  // { Prefix Modifier "Athlete's" (Tier: 2) — Life }  /  { Master Crafted Suffix Modifier "of Craft" (Rank: 1) }  /  { Implicit Modifier — Life }
  const body = line.replace(/^\{\s*/, '').replace(/\s*\}$/, '');
  const side = /\bPrefix\b/.test(body) ? 'prefix' : /\bSuffix\b/.test(body) ? 'suffix' : null;
  const kind = /Master Crafted/i.test(body) ? 'crafted' : /Implicit/i.test(body) ? 'implicit' : /Unique Modifier/i.test(body) ? 'unique' : side ? 'natural' : 'other';
  return { side, kind, fractured: /Fractured/i.test(body), name: /"([^"]+)"/.exec(body)?.[1] ?? null,
    tier: Number(/Tier:\s*(\d+)/.exec(body)?.[1] ?? NaN) || null, rank: Number(/Rank:\s*(\d+)/.exec(body)?.[1] ?? NaN) || null,
    eldritch: /Eater of Worlds|Searing Exarch/i.test(body) ? body : null, raw: line };
}

export function parseItemText(raw) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const all = text.split('\n').map(line => line.trim());
  const start = all.findIndex(line => /^Rarity:\s*/i.test(line));
  if (start < 0) throw new Error('Item text needs a "Rarity:" line (copy the item in game with Ctrl+C or Ctrl+Alt+C, or use PoB item text)');
  const format = all.includes('--------') ? 'game' : 'pob';
  const lines = all.slice(start);
  const rarity = lines[0].replace(/^Rarity:\s*/i, '').trim().toLowerCase();
  const item = { format, rarity, item_class_line: all.slice(0, start).find(line => /^Item Class:/i.test(line))?.replace(/^Item Class:\s*/i, '') ?? null,
    name: null, base_line: null, item_level: null, quality: 0, sockets: null, influences: [], flags: [], advanced: false, implicits: [], mods: [], enchants: [], skipped: [] };
  // Header: rare/unique have name + base; magic/normal a single line.
  let i = 1;
  const headerLines = [];
  while (i < lines.length && lines[i] !== '--------' && !/^[^{][^:]*:\s/.test(lines[i]) && headerLines.length < 2) headerLines.push(lines[i++]);
  if (['rare', 'unique'].includes(rarity) && headerLines.length >= 2) [item.name, item.base_line] = headerLines;
  else { item.base_line = headerLines[0] ?? null; if (headerLines[1]) i--; }
  const rest = lines.slice(i);

  // Split into sections (game) or one section (PoB).
  const sections = [];
  let current = [];
  for (const line of rest) { if (line === '--------') { if (current.length) sections.push(current); current = []; } else if (line) current.push(line); }
  if (current.length) sections.push(current);

  let pobImplicitsLeft = null;
  for (const section of sections) {
    // Game property/requirement sections contain "Key: value" lines and no mods; skip them whole.
    const propertySection = format === 'game' && section.some(line => !line.startsWith('{') && /^[^:]+:\s/.test(line) && !/^Item Level:/i.test(line));
    let header = null;
    for (const line of section) {
      if (/^Item Level:/i.test(line)) { item.item_level = Number(numbers(line)[0]); continue; }
      if (/^Quality( \([^)]*\))?:/i.test(line)) { item.quality = Number(numbers(line)[0] ?? 0); continue; }
      if (/^Sockets:/i.test(line)) { item.sockets = line.replace(/^Sockets:\s*/i, '').trim(); continue; }
      if (/^Implicits:\s*\d+/i.test(line)) { pobImplicitsLeft = Number(numbers(line)[0]); continue; }
      if (/^\{ .*\}$/.test(line)) { header = parseHeader(line); item.advanced = true; continue; }
      if (propertySection) { item.skipped.push(line); continue; }
      const influence = INFLUENCES.find(name => line === `${name} Item`);
      if (influence) { item.influences.push(influence); continue; }
      if (FLAG_LINES.has(line)) { item.flags.push(line); continue; }
      if (format === 'pob' && /^[A-Za-z][A-Za-z ]*:\s/.test(line)) { item.skipped.push(line); continue; }
      if (format === 'pob' && /^\{(tags|range|variant):[^}]*\}/.test(line) && !/\}\s*\S/.test(line)) { item.skipped.push(line); continue; }
      // Mod line: markers "(implicit)" etc. in game text, "{crafted}" etc. in PoB text.
      let body = line, marker = null;
      for (;;) {
        const pob = /^\{([a-z]+)(?::[^}]*)?\}/.exec(body);
        if (!pob) break;
        if (MARKERS.includes(pob[1])) marker = pob[1];
        body = body.slice(pob[0].length);
      }
      const suffix = new RegExp(`\\s+\\((${MARKERS.join('|')})\\)$`).exec(body);
      if (suffix) { marker = suffix[1]; body = body.slice(0, suffix.index); }
      body = cleanLine(body);
      if (!body) continue;
      const entry = { text: body, header };
      if (format === 'pob' && pobImplicitsLeft > 0 && marker !== 'enchant') { pobImplicitsLeft--; item.implicits.push({ ...entry, marker: marker ?? 'implicit' }); continue; }
      if (marker === 'implicit' || header?.kind === 'implicit') item.implicits.push({ ...entry, marker: 'implicit' });
      else if (marker === 'enchant') item.enchants.push(entry);
      else item.mods.push({ ...entry, marker: header?.kind === 'crafted' ? 'crafted' : header?.fractured ? 'fractured' : marker });
    }
  }
  if (format === 'game' && sections.length && rarity === 'unique') {
    // Unique flavour text sits in the last section; it is not a modifier. Keep it out of matching.
  }
  return item;
}

// ---------- catalogue indexes (built lazily, cached per process)
const cache = new WeakMap();
function lineTemplates(cat, mod) {
  const low = mod.stats.map(stat => Math.min(stat.min, stat.max)), high = mod.stats.map(stat => Math.max(stat.min, stat.max));
  let a, b;
  try { a = renderRoll(cat, { id: mod.id, values: low }); b = renderRoll(cat, { id: mod.id, values: high }); } catch { return null; }
  if (!a.length || a.length !== b.length) return null;
  return a.map((line, index) => {
    const lo = numbers(line), hi = numbers(b[index]);
    return { templates: [...new Set([template(line), template(b[index])])], lo: lo.map((v, k) => Math.min(v, hi[k] ?? v)), hi: lo.map((v, k) => Math.max(v, hi[k] ?? v)) };
  });
}
function indexMods(cat, mods) {
  const byTemplate = new Map(), info = new Map();
  for (const mod of mods) {
    if (!mod || info.has(mod.id)) continue;
    const lines = lineTemplates(cat, mod);
    if (!lines) continue;
    info.set(mod.id, { mod, lines });
    for (const t of new Set(lines.flatMap(line => line.templates))) {
      if (!byTemplate.has(t)) byTemplate.set(t, []);
      byTemplate.get(t).push(mod.id);
    }
  }
  return { byTemplate, info };
}
function catalogIndex(cat, key, build) {
  if (!cache.has(cat)) cache.set(cat, new Map());
  const store = cache.get(cat);
  if (!store.has(key)) store.set(key, build());
  return store.get(key);
}
function benchMods(cat, itemClass) {
  const ids = new Set();
  for (const recipe of cat.recipes.values()) if (recipe.actions?.add_explicit_mod && recipe.item_classes.includes(itemClass)) ids.add(recipe.actions.add_explicit_mod);
  return [...ids].map(id => cat.mods.get(id)).filter(Boolean);
}

// ---------- base resolution
function resolveBase(cat, parsed) {
  const warnings = [];
  let line = (parsed.base_line ?? '').replace(/^(Synthesised|Superior)\s+/i, '').trim();
  const byName = name => [...cat.bases.values()].filter(base => base.name.toLowerCase() === name.toLowerCase());
  let matches = byName(line);
  if (!matches.length && parsed.rarity === 'magic') {
    // Magic name "Athlete's Two-Stone Ring of the Fox": longest base name contained in it.
    const found = [...cat.bases.values()].filter(base => line.includes(base.name)).sort((a, b) => b.name.length - a.name.length);
    if (found.length) matches = byName(found[0].name);
  }
  if (!matches.length) throw new Error(`Unknown base "${parsed.base_line}"; unidentified, unique-only or non-craftable bases are not supported`);
  if (matches.length > 1) {
    // Same name, different implicits (e.g. Two-Stone Ring): choose by implicit templates.
    const implicitTemplates = new Set(parsed.implicits.map(row => template(row.text)));
    const scored = matches.map(base => ({ base, score: base.implicits.filter(id => {
      const lines = lineTemplates(cat, cat.mods.get(id)) ?? [];
      return lines.some(row => row.templates.some(t => implicitTemplates.has(t)));
    }).length })).sort((a, b) => b.score - a.score);
    if (scored[0].score === (scored[1]?.score ?? -1)) warnings.push({ code: 'ambiguous_base', detail: `${matches.length} bases named ${line}; chose ${scored[0].base.id}` });
    return { base: scored[0].base, warnings };
  }
  return { base: matches[0], warnings };
}

// ---------- matching
const TOL = 1e-6;
function fits(candidate, nums) {
  if (candidate.lo.length !== nums.length) return false;
  return nums.every((value, k) => {
    const tol = Number.isInteger(value) && Number.isInteger(candidate.lo[k]) ? TOL : 0.051;
    return value >= candidate.lo[k] - tol && value <= candidate.hi[k] + tol;
  });
}
// Options for covering line `index` with one mod: the mod's other lines must match other unused lines.
function optionsFor(index, lines, used, idx, allowed) {
  const line = lines[index], ids = idx.byTemplate.get(line.template) ?? [], result = [];
  for (const id of ids) {
    if (allowed && !allowed(id)) continue;
    const { mod, lines: modLines } = idx.info.get(id);
    const anchor = modLines.findIndex(row => row.templates.includes(line.template) && fits(row, line.nums));
    if (anchor < 0) continue;
    const assignment = new Array(modLines.length).fill(null);
    assignment[anchor] = index;
    const taken = new Set([index]);
    let ok = true;
    for (let k = 0; k < modLines.length && ok; k++) {
      if (k === anchor) continue;
      const j = lines.findIndex((other, n) => !used.has(n) && !taken.has(n) && other.marker === line.marker && modLines[k].templates.includes(other.template) && fits(modLines[k], other.nums));
      if (j < 0) ok = false; else { assignment[k] = j; taken.add(j); }
    }
    if (ok) result.push({ mod, lines: assignment });
  }
  return result;
}
// Exhaustive search over line covers (items have <= ~10 explicit lines). Best = most lines matched, capacity respected, fewest mods.
function solve(lines, idx, { allowed, cap, maxSolutions = 6 } = {}) {
  const best = [];
  const score = state => [state.matched, state.capOk ? 1 : 0, -state.mods.length];
  const better = (a, b) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] > b[k]; return false; };
  let budget = 20000;
  function walk(used, mods, unmatched) {
    if (--budget < 0) return;
    const next = lines.findIndex((_, n) => !used.has(n) && !unmatched.includes(n));
    if (next < 0) {
      const sides = { prefix: 0, suffix: 0 }, groups = new Set();
      let groupOk = true;
      for (const row of mods) { if (sides[row.mod.generation_type] !== undefined) sides[row.mod.generation_type]++; for (const g of row.mod.groups) { if (groups.has(g)) groupOk = false; groups.add(g); } }
      const capOk = groupOk && (!cap || (sides.prefix <= cap.prefix && sides.suffix <= cap.suffix));
      const state = { mods: [...mods], unmatched: [...unmatched], matched: lines.length - unmatched.length, capOk };
      best.push(state);
      best.sort((a, b) => better(score(a), score(b)) ? -1 : better(score(b), score(a)) ? 1 : 0);
      if (best.length > maxSolutions) best.pop();
      return;
    }
    const options = optionsFor(next, lines, used, idx, allowed);
    for (const option of options) {
      const nextUsed = new Set(used); option.lines.forEach(n => nextUsed.add(n));
      walk(nextUsed, [...mods, option], unmatched);
    }
    walk(used, mods, [...unmatched, next]);
  }
  walk(new Set(), [], []);
  return { best: best[0] ?? { mods: [], unmatched: lines.map((_, n) => n), matched: 0, capOk: true }, alternatives: best.slice(1), exhausted: budget < 0 };
}

const typeKey = mod => `${mod.generation_type}|${mod.type}`;
function tierOf(cat, item, mod, tags) {
  const info = tierInfo(cat, item, mod, tags);
  if (info.tier !== null) return { tier: info.tier, count: info.count, scope: 'base_ilvl' };
  // Out of the base/ilvl pool (essence, influence without the flag, veiled...): rank among all tiers of the type.
  const rows = (cat.byType.get(`${mod.domain}|${mod.generation_type}|${mod.type}`) ?? []).filter(row => !/Royale/.test(row.id))
    .sort((a, b) => b.required_level - a.required_level || (a.id < b.id ? -1 : 1));
  const index = rows.findIndex(row => row.id === mod.id);
  return { tier: index < 0 ? null : index + 1, count: rows.length, scope: 'unfiltered_type' };
}
function rollQuality(modLines, assignment, lines) {
  const parts = [];
  assignment.forEach((n, k) => {
    const row = modLines[k];
    lines[n].nums.forEach((value, p) => { const span = row.hi[p] - row.lo[p]; parts.push(span > 0 ? (value - row.lo[p]) / span : 1); });
  });
  return parts.length ? Math.round(1000 * parts.reduce((a, b) => a + b, 0) / parts.length) / 1000 : null;
}

// ---------- pseudo totals (trade-site style, from all lines)
export function pseudoTotals(lines) {
  const total = { life: 0, energy_shield: 0, mana: 0, fire_res: 0, cold_res: 0, lightning_res: 0, chaos_res: 0, strength: 0, dexterity: 0, intelligence: 0, movement_speed: 0 };
  for (const text of lines) {
    let m;
    if ((m = /^\+(\d+) to maximum (Life|Energy Shield|Mana)$/.exec(text))) total[{ Life: 'life', 'Energy Shield': 'energy_shield', Mana: 'mana' }[m[2]]] += Number(m[1]);
    else if ((m = /^\+(\d+)% to (.+?) Resistances?$/.exec(text)) && !/maximum/i.test(m[2])) {
      const names = /all Elemental/i.test(m[2]) ? ['Fire', 'Cold', 'Lightning'] : m[2].split(/\s+and\s+|,\s*/);
      for (const name of names) { const key = `${name.trim().toLowerCase()}_res`; if (key in total) total[key] += Number(m[1]); }
    } else if ((m = /^\+(\d+) to (.+)$/.exec(text)) && /^(all Attributes|Strength|Dexterity|Intelligence)( and (Strength|Dexterity|Intelligence))?$/.test(m[2])) {
      const names = /all Attributes/.test(m[2]) ? ['Strength', 'Dexterity', 'Intelligence'] : m[2].split(' and ');
      for (const name of names) total[name.toLowerCase()] += Number(m[1]);
    } else if ((m = /^(\d+)% increased Movement Speed$/.exec(text))) total.movement_speed += Number(m[1]);
  }
  const elemental = total.fire_res + total.cold_res + total.lightning_res;
  return { ...total, total_life_with_strength: total.life + Math.floor(total.strength / 2), total_elemental_resistance: elemental, total_resistance: elemental + total.chaos_res };
}

// ---------- appraisal
export function appraiseItem(rawText, cat = loadCatalog()) {
  const parsed = parseItemText(rawText);
  const warnings = [];
  if (parsed.flags.includes('Unidentified')) throw new Error('Unidentified item: identify it first; unidentified mods cannot be appraised');
  if (parsed.rarity === 'unique') return { game: 'poe1', patch: '3.30', rarity: 'unique', name: parsed.name, base: parsed.base_line,
    note: `Uniques are priced by name: run "price get ${parsed.name}" (check --variant) or "analyze candidates <xml> --kind uniques".`, game_tested: false };
  if (!['rare', 'magic', 'normal'].includes(parsed.rarity)) throw new Error(`Unsupported rarity ${parsed.rarity}`);
  const { base, warnings: baseWarnings } = resolveBase(cat, parsed);
  warnings.push(...baseWarnings);
  if (base.domain !== 'item') warnings.push({ code: 'non_equipment_domain', detail: `Base domain ${base.domain}: only equipment appraisal is verified` });
  const itemLevel = parsed.item_level ?? 100;
  if (parsed.item_level == null) warnings.push({ code: 'item_level_unknown', detail: 'No "Item Level:" line; tiers are computed for ilvl 100' });
  const item = emptyItem(base, itemLevel);
  item.rarity = parsed.rarity;
  item.influences = parsed.influences.filter(name => { try { return !!influenceSuffix[name]; } catch { return false; } });
  const tags = itemTags(cat, item);
  const corrupted = parsed.flags.includes('Corrupted'), mirrored = parsed.flags.includes('Mirrored');

  // Implicits: base implicits first, then any implicit-type mod of the domain.
  const implicitLines = parsed.implicits.map(row => ({ text: row.text, template: template(row.text), nums: numbers(row.text), marker: 'implicit' }));
  const implicitIdx = () => catalogIndex(cat, `implicit:${base.domain}`, () => indexMods(cat, (cat.byDomain.get(base.domain) ?? []).filter(mod => !isAffix(mod) && !/Royale/.test(mod.id))));
  const baseImplicitIdx = indexMods(cat, base.implicits.map(id => cat.mods.get(id)));
  let implicitSolution = solve(implicitLines, baseImplicitIdx);
  if (implicitSolution.best.unmatched.length) implicitSolution = solve(implicitLines, implicitIdx(), { maxSolutions: 2 });
  const implicits = implicitSolution.best.mods.map(row => ({ id: row.mod.id, type: row.mod.type, generation_type: row.mod.generation_type,
    from_base: base.implicits.includes(row.mod.id), lines: row.lines.map(n => implicitLines[n].text) }));
  const unmatchedImplicits = implicitSolution.best.unmatched.map(n => implicitLines[n].text);

  // Explicit affixes: natural/fractured lines against the base pool (then all affixes), crafted against bench options.
  const explicitLines = parsed.mods.map(row => ({ text: row.text, template: template(row.text), nums: numbers(row.text), marker: row.marker === 'crafted' ? 'crafted' : 'natural',
    fractured: row.marker === 'fractured' || !!row.header?.fractured, header: row.header }));
  const poolIds = new Set(craftPool(cat, item, { ignore_capacity: true, ignore_level: true }).rows.map(row => row.id));
  const poolIdx = catalogIndex(cat, `pool:${base.id}:${[...tags].sort().join(',')}`, () => indexMods(cat, [...poolIds].map(id => cat.mods.get(id))));
  const affixIndex = () => catalogIndex(cat, `affix:${base.domain}`, () => indexMods(cat, (cat.candidates.get(base.domain + ':affix') ?? []).filter(mod => !/Royale/.test(mod.id))));
  const benchIdx = catalogIndex(cat, `bench:${base.item_class}`, () => indexMods(cat, benchMods(cat, base.item_class)));
  const cap = capacity(cat, item);
  const merged = { byTemplate: new Map(), info: new Map() };
  for (const idx of [poolIdx, benchIdx]) { for (const [k, v] of idx.info) merged.info.set(k, v); for (const [t, ids] of idx.byTemplate) merged.byTemplate.set(t, [...(merged.byTemplate.get(t) ?? []), ...ids]); }
  const allowedFor = line => id => line.marker === 'crafted' ? benchIdx.info.has(id) : poolIdx.info.has(id);
  let ambiguous = false, solution;
  if (parsed.advanced && explicitLines.some(line => line.header)) {
    // Advanced copy: each header owns its lines -> match per group (exact, no cross-mod ambiguity).
    const groups = [];
    for (const [n, line] of explicitLines.entries()) {
      const last = groups.at(-1);
      if (last && line.header && last.header === line.header) last.indexes.push(n); else groups.push({ header: line.header, indexes: [n] });
    }
    solution = { mods: [], unmatched: [] };
    for (const group of groups) {
      const sub = group.indexes.map(n => explicitLines[n]);
      const sideOk = id => !group.header?.side || (merged.info.get(id) ?? affixIndex().info.get(id))?.mod.generation_type === group.header.side;
      let found = solve(sub, merged, { allowed: id => allowedFor(sub[0])(id) && sideOk(id) }).best;
      if (found.unmatched.length && sub[0].marker !== 'crafted') found = solve(sub, affixIndex(), { allowed: sideOk }).best;
      solution.mods.push(...found.mods.map(row => ({ ...row, lines: row.lines.map(k => group.indexes[k]), header: group.header })));
      solution.unmatched.push(...found.unmatched.map(k => group.indexes[k]));
    }
  } else {
    const result = solve(explicitLines, merged, { allowed: null, cap });
    // Crafted lines must use bench mods, natural lines pool mods.
    const valid = state => state.mods.every(row => row.lines.every(n => allowedFor(explicitLines[n])(row.mod.id)));
    solution = [result.best, ...result.alternatives].find(valid) ?? result.best;
    const sameMatch = [result.best, ...result.alternatives].filter(state => valid(state) && state.matched === solution.matched && state.capOk === solution.capOk);
    const signature = state => state.mods.map(row => typeKey(row.mod)).sort().join(';');
    ambiguous = new Set(sameMatch.map(signature)).size > 1;
    if (solution.unmatched.length) {
      // Retry unmatched natural lines against every affix of the domain (essence, veiled, other influence, legacy).
      const rest = solution.unmatched.map(n => explicitLines[n]).filter(line => line.marker !== 'crafted');
      const restIndexes = solution.unmatched.filter(n => explicitLines[n].marker !== 'crafted');
      const extra = solve(rest, affixIndex(), { maxSolutions: 2 }).best;
      solution = { ...solution, mods: [...solution.mods, ...extra.mods.map(row => ({ ...row, lines: row.lines.map(k => restIndexes[k]) }))],
        unmatched: [...solution.unmatched.filter(n => explicitLines[n].marker === 'crafted'), ...extra.unmatched.map(k => restIndexes[k])] };
    }
  }

  const mods = solution.mods.map(row => {
    const { mod } = row, crafted = explicitLines[row.lines[0]].marker === 'crafted';
    const modLines = (merged.info.get(mod.id) ?? affixIndex().info.get(mod.id)).lines;
    const tier = crafted ? { tier: null, count: null, scope: 'bench' } : tierOf(cat, item, mod, tags);
    const weight = firstWeight(mod.spawn_weights, tags, 0) * firstWeight(mod.generation_weights, tags, 100) / 100;
    return { id: mod.id, name: mod.name || null, kind: crafted ? 'crafted' : 'natural', fractured: row.lines.some(n => explicitLines[n].fractured),
      side: mod.generation_type, type: mod.type, groups: mod.groups, tags: mod.implicit_tags, required_level: mod.required_level,
      tier: tier.tier, tier_count: tier.count, tier_scope: tier.scope, game_tier: row.header?.tier ?? null,
      roll_quality: rollQuality(modLines, row.lines, explicitLines), in_base_pool: crafted ? null : poolIds.has(mod.id),
      above_item_level: !crafted && mod.required_level > itemLevel, essence_only: !!mod.is_essence_only, spawn_weight: crafted ? null : weight,
      lines: row.lines.map(n => explicitLines[n].text) };
  });
  const unmatched = solution.unmatched.map(n => ({ text: explicitLines[n].text, marker: explicitLines[n].marker,
    possibly_merged: (merged.byTemplate.get(explicitLines[n].template) ?? affixIndex().byTemplate.get(explicitLines[n].template) ?? []).length > 0 }));
  for (const row of mods) {
    if (row.kind === 'natural' && !row.in_base_pool) warnings.push({ code: 'not_in_base_pool', mod: row.id, detail: 'Matched outside the natural pool of this base/influences (essence, veiled, other influence, Elevated or legacy)' });
    if (row.above_item_level) warnings.push({ code: 'mod_above_item_level', mod: row.id, detail: `requires ilvl ${row.required_level}, item is ${itemLevel}` });
  }
  if (unmatched.some(row => row.possibly_merged)) warnings.push({ code: 'merged_lines_possible', detail: 'A line matches a known mod text but not its range: two mods may be summed into one line. Copy with Ctrl+Alt+C for exact grouping.' });
  if (ambiguous) warnings.push({ code: 'ambiguous_mod_grouping', detail: 'Several mod groupings explain the lines equally well (e.g. hybrid vs two separate mods). Copy with Ctrl+Alt+C for exact grouping.' });

  // Summary.
  const sides = { prefix: 0, suffix: 0 };
  for (const row of mods) if (row.side in sides) sides[row.side]++;
  const natural = mods.filter(row => row.kind === 'natural' && isAffix(cat.mods.get(row.id)));
  const crafted = mods.filter(row => row.kind === 'crafted');
  const open = { prefix: Math.max(0, cap.prefix - sides.prefix), suffix: Math.max(0, cap.suffix - sides.suffix) };
  for (const side of ['prefix', 'suffix']) if (sides[side] > cap[side])
    warnings.push({ code: `too_many_${side}es`, detail: `${sides[side]} ${side}es matched, ${parsed.rarity} ${base.item_class} allows ${cap[side]}: the grouping or the item text is wrong (or an implicit raises the limit)` });
  const qualities = natural.map(row => row.roll_quality).filter(v => v != null);
  const topTier = natural.filter(row => row.tier === 1).length, top2 = natural.filter(row => row.tier != null && row.tier <= 2).length;
  const modifiable = !corrupted && !mirrored;
  const summary = {
    affixes: { ...sides, capacity: cap, open, crafted: crafted.length, fractured: mods.filter(row => row.fractured).length },
    natural_t1: topTier, natural_t1_t2: top2, natural_count: natural.length,
    average_roll_quality: qualities.length ? Math.round(1000 * qualities.reduce((a, b) => a + b, 0) / qualities.length) / 1000 : null,
    modifiable, bench_craft_possible: modifiable && (crafted.length > 0 || open.prefix + open.suffix > 0),
    text: `${natural.length} natural mod(s): ${topTier} T1, ${top2} T1-T2; avg roll ${qualities.length ? Math.round(100 * qualities.reduce((a, b) => a + b, 0) / qualities.length) + '%' : 'n/a'}; `
      + `open ${open.prefix}P/${open.suffix}S; ${crafted.length} crafted; ${corrupted ? 'corrupted' : mirrored ? 'mirrored' : 'modifiable'}`,
  };

  // Market: no offline rare prices; give filters for a manual comparable-listing search.
  const allLines = [...parsed.implicits.map(row => row.text), ...parsed.mods.map(row => row.text)];
  const pseudo = pseudoTotals(allLines);
  const floor90 = value => Math.floor(value * 0.9);
  const pseudoFilters = [['total_life_with_strength', '+# total maximum Life'], ['total_elemental_resistance', '+#% total Elemental Resistance'],
    ['total_resistance', '+#% total Resistance'], ['energy_shield', '+# total maximum Energy Shield'], ['movement_speed', '#% increased Movement Speed']]
    .filter(([key]) => pseudo[key] > 0).map(([key, label]) => ({ filter: `(pseudo) ${label}`, min: floor90(pseudo[key]), item_value: pseudo[key] }));
  const modFilters = mods.filter(row => row.kind === 'natural' && (row.tier ?? 99) <= 3).flatMap(row => row.lines.map(text => {
    const nums = numbers(text);
    return { filter: `(explicit) ${text.replace(NUM, '#')}`, min: nums.length ? floor90(Math.min(...nums.map(Math.abs))) : null, item_value: nums.length === 1 ? nums[0] : nums };
  }));
  const market = {
    offline_price_available: false,
    reason: 'Local price snapshots (poe.ninja) cover uniques/currency/gems, not rare items; a rare is worth what comparable listings ask.',
    trade_search: { base_type: base.name, item_level_min: parsed.item_level, influences: item.influences, corrupted, filters: [...pseudoFilters, ...modFilters],
      note: 'Manual search suggestion: minimums are 90% of this item\'s values; drop the weakest filters until 5-20 listings remain and read the lowest asking prices. Not run; no network.' },
  };

  // PoB text (normalized) for --check and item check.
  const header = [`Rarity: ${parsed.rarity.toUpperCase()}`];
  if (parsed.rarity === 'rare') header.push(/^[\x20-\x7e]+$/.test(parsed.name ?? '') ? parsed.name : 'Appraised Rare');
  header.push(base.name);
  if (parsed.sockets) header.push(`Sockets: ${parsed.sockets}`);
  if (parsed.item_level != null) header.push(`Item Level: ${parsed.item_level}`);
  if (parsed.quality) header.push(`Quality: ${parsed.quality}`);
  for (const influence of item.influences) header.push(`${influence} Item`);
  if (parsed.flags.includes('Synthesised Item')) header.push('Synthesised Item');
  if (parsed.flags.includes('Fractured Item')) header.push('Fractured Item');
  const body = [...parsed.enchants.map(row => `{enchant}${row.text}`), `Implicits: ${parsed.implicits.length}`, ...parsed.implicits.map(row => row.text),
    ...parsed.mods.map(row => (row.marker === 'crafted' ? '{crafted}' : row.marker === 'fractured' ? '{fractured}' : '') + row.text)];
  if (corrupted) body.push('Corrupted');
  const pobText = [...header, ...body].join('\n');

  return {
    game: 'poe1', patch: '3.30', source_format: parsed.format, advanced_copy: parsed.advanced,
    item: { name: parsed.name, base: base.name, base_id: base.id, item_class: base.item_class, rarity: parsed.rarity, item_level: parsed.item_level, quality: parsed.quality,
      sockets: parsed.sockets, influences: item.influences, flags: parsed.flags, default_slot: SLOT_BY_CLASS[base.item_class] ?? null },
    implicits, unmatched_implicits: unmatchedImplicits, enchants: parsed.enchants.map(row => row.text),
    mods, unmatched_mods: unmatched, summary, pseudo, market, warnings,
    pob_text: pobText, game_tested: false, scope: SCOPE,
  };
}

// ---------- CLI
function readInput(options) {
  if (options.text) return options.text;
  if (!options.file) throw new Error('item appraise needs --file <item.txt> (use "-" for stdin) or --text "<item text>"');
  return options.file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(options.file), 'utf8');
}
export function appraiseCommand(args) {
  const { positional, options } = flags(args, ['file', 'text', 'check', 'slot', 'scenario', 'out'], ['brief']);
  if (positional.length) throw new Error(`Unexpected argument: ${positional[0]}`);
  const result = appraiseItem(readInput(options));
  if (options.check && result.rarity !== 'unique') {
    const slot = options.slot ?? result.item.default_slot;
    if (!slot) throw new Error(`No default slot for ${result.item.item_class}; pass --slot`);
    result.build_value = checkItem({ build: options.check, slot, text: result.pob_text, scenario: options.scenario ?? 'imported' });
    if (/^Ring/.test(slot) && !options.slot) result.build_value.note = 'Compared against Ring 1; run again with --slot "Ring 2" for the other ring.';
  }
  if (options.brief && result.mods) {
    for (const row of result.mods) { delete row.groups; delete row.tags; delete row.spawn_weight; }
    delete result.pob_text;
  }
  if (options.out) atomicJson(path.resolve(options.out), result);
  return result;
}
export const appraiseHelp = {
  'item appraise --file <item.txt|-> | --text "<item>" [--check build.xml] [--slot Slot] [--scenario S] [--brief] [--out f.json]':
    'Rare/magic item appraisal from game Ctrl+C / Ctrl+Alt+C or PoB text: mods matched to RePoE (tier on base+ilvl, roll quality, prefix/suffix, open affixes, crafted/fractured), pseudo totals, manual trade-search filters (no offline rare prices); --check equips it in PoB and reports key stat deltas vs the current item',
};
