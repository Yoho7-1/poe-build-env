// Automatic upgrade candidates for `analyze upgrades`: supports for one socket group, uniques for one slot,
// amulet anointments. Output is the ordinary candidates-file format of analysis-upgrades.mjs.
// Sources: PoB 2.68.1 data (gem names, unique item texts and variants: the engine parses exactly these),
// knowledge DB (RePoE skill types and support type expressions), uniques catalog (Wiki acquisition flag),
// dated price snapshots. A prefilter is not proof: the engine result (applied_supports, unparsed lines) decides.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbRoot, flags, atomicJson, readJson } from './workspace.mjs';
import { parseLuaTable } from './lua-table.mjs';
import { decodeBuild, runPob } from './pob.mjs';
import { referenceDb, priceQuery } from './reference-store.mjs';
import { validateCandidateFile, expandCandidates } from './analysis-upgrades.mjs';
import { analyzeUpgrades } from './analysis-run.mjs';
import { runBatch, batchRunner, defaultConcurrency } from './analysis-engine.mjs';
import { readMetric, metrics } from './analysis-core.mjs';
import { planAblation, isSupportGem } from './analysis-ablation.mjs';

const pobSrc = rel => path.join(dbRoot, 'vendor/pob/src', rel);
const asArray = v => v == null ? [] : Array.isArray(v) ? v : [v];
const disclaimer = 'Generated candidates are hypotheses from PoB data, RePoE types and the Wiki acquisition flag; engine deltas are a numeric experiment, not a game test.';

// ---------- pure helpers ----------

// PoB calcLib.doesTypeExpressionMatch: RPN over skill types with AND/OR/NOT; any true stack value matches.
export function evalTypeExpression(tokens, types) {
  const stack = [];
  for (const t of tokens ?? []) {
    if (t === 'OR') { const other = stack.pop(); stack[stack.length - 1] = stack[stack.length - 1] || other; }
    else if (t === 'AND') { const other = stack.pop(); stack[stack.length - 1] = stack[stack.length - 1] && other; }
    else if (t === 'NOT') stack[stack.length - 1] = !stack[stack.length - 1];
    else stack.push(types.has(t));
  }
  return stack.some(Boolean);
}

// Prefilter mirroring calcLib.canGrantedEffectSupportActiveSkill (types only; weapon types and item-granted cases are left to the engine).
export function supportCompatible(support, activeTypes, { fromGem = true } = {}) {
  const sg = support?.support_gem;
  if (!sg) return { ok: false, reason: 'no_support_data' };
  if (sg.supports_gems_only && !fromGem) return { ok: false, reason: 'supports_gems_only' };
  if (sg.excluded_types?.length && evalTypeExpression(sg.excluded_types, activeTypes)) return { ok: false, reason: 'excluded_type' };
  if (sg.allowed_types?.length && !evalTypeExpression(sg.allowed_types, activeTypes)) return { ok: false, reason: 'required_type_missing' };
  return { ok: true, reason: null };
}

export function parseSockets(text) {
  if (!text) return null;
  const groups = text.trim().split(/\s+/).map(g => g.split('-').filter(Boolean).length);
  return { total: groups.reduce((s, n) => s + n, 0), largest_link: Math.max(0, ...groups) };
}

export function slugId(prefix, ...parts) {
  const body = parts.filter(p => p != null && p !== '').join('-').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${prefix}-${body}`.slice(0, 64).replace(/-+$/, '');
}
function uniqueIds(list) {
  const seen = new Map();
  for (const c of list) {
    let id = c.id, n = 2;
    while (seen.has(id)) { const suffix = `-${n++}`; id = c.id.slice(0, 64 - suffix.length) + suffix; }
    seen.set(id, true);
    c.id = id;
  }
  return list;
}

// A PoB unique raw text (Data/Uniques/*.lua): name, base, variants. "Pre x.y" variants are legacy versions.
export function parseUniqueRaw(raw) {
  const lines = raw.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  const variants = lines.filter(l => l.startsWith('Variant: ')).map(l => l.slice(9));
  const current = variants.map((name, i) => ({ index: i + 1, name })).filter(v => !/^Pre \d/i.test(v.name));
  return { name: lines[0], base: lines[1], lines, variants, current, has_alt_variant: lines.some(l => /^Has Alt Variant/.test(l)),
    level_req: Number(/^(?:Requires Level|LevelReq:) (\d+)/.exec(lines.find(l => /^(Requires Level|LevelReq:) \d+/.test(l)) ?? '')?.[1] ?? NaN) || null };
}

// Item text PoB parses: rarity line, raw lines, explicit variant selection when the item has variants.
export function uniqueItemText(raw, variantIndex = null) {
  const { lines } = parseUniqueRaw(raw);
  const out = ['Rarity: UNIQUE', lines[0], lines[1]];
  if (variantIndex != null) out.push(`Selected Variant: ${variantIndex}`);
  return [...out, ...lines.slice(2)].join('\n');
}

// Replace (or insert) the anointment line of an amulet text; returns null when the text has no Implicits header.
export function withAnoint(itemText, notable) {
  const lines = itemText.replace(/\r/g, '').split('\n');
  const line = `{crafted}Allocates ${notable}`;
  const at = lines.findIndex(l => /^(\{[^}]*\})*Allocates /.test(l.trim()));
  if (at >= 0) { lines[at] = line; return lines.join('\n'); }
  const imp = lines.findIndex(l => /^Implicits: \d+$/.test(l.trim()));
  if (imp < 0) return null;
  const n = Number(lines[imp].trim().slice(11));
  lines.splice(imp, 1, `Implicits: ${n + 1}`, line);
  return lines.join('\n');
}
export const currentAnoint = itemText => /^(?:\{[^}]*\})*Allocates (.+)$/m.exec(itemText ?? '')?.[1]?.trim() ?? null;

const family = name => name.replace(/^Awakened /, '');

export const slotClasses = {
  Helmet: ['Helmet'], 'Body Armour': ['Body Armour'], Gloves: ['Gloves'], Boots: ['Boots'], Amulet: ['Amulet'],
  'Ring 1': ['Ring'], 'Ring 2': ['Ring'], Belt: ['Belt'],
  'Weapon 1': ['Bow', 'Claw', 'Dagger', 'Rune Dagger', 'One-Handed Axe', 'Two-Handed Axe', 'One-Handed Mace', 'Two-Handed Mace', 'Sceptre', 'One-Handed Sword', 'Thrusting One-Handed Sword', 'Two-Handed Sword', 'Staff', 'Warstaff', 'Wand'],
  'Weapon 2': ['Shield', 'Quiver', 'Claw', 'Dagger', 'Rune Dagger', 'One-Handed Axe', 'One-Handed Mace', 'Sceptre', 'One-Handed Sword', 'Thrusting One-Handed Sword', 'Wand'],
  ...Object.fromEntries([1, 2, 3, 4, 5].map(i => [`Flask ${i}`, ['Utility Flask', 'Life Flask', 'Mana Flask', 'Hybrid Flask']]))
};
export function normalizeSlot(slot) {
  if (!slot) throw new Error(`--slot required: ${Object.keys(slotClasses).join(', ')}`);
  const s = String(slot).trim().toLowerCase().replace(/\s+/g, ' ');
  const alias = { ring: 'Ring 1', body: 'Body Armour', chest: 'Body Armour', helm: 'Helmet', weapon: 'Weapon 1', offhand: 'Weapon 2', 'off hand': 'Weapon 2', flask: 'Flask 1' };
  const hit = Object.keys(slotClasses).find(k => k.toLowerCase() === s) ?? alias[s];
  if (!hit) throw new Error(`Unknown slot ${slot}; use ${Object.keys(slotClasses).join(', ')}`);
  return hit;
}

// Choose a price row for one exact gem level/quality or unique variant; never merges variants.
export function choosePriceRow(rows, want = {}) {
  if (!rows.length) return { status: 'no_observation', variant: null };
  if (want.gemLevel != null) {
    const hits = rows.filter(r => r.variant?.gemLevel === want.gemLevel && !r.variant?.corrupted && (want.gemQuality == null || (r.variant?.gemQuality ?? 0) === want.gemQuality || (want.gemQuality === 0 && r.variant?.gemQuality == null)));
    if (hits.length === 1 && hits[0].variant?.variant) return { status: 'matched', variant: hits[0].variant.variant };
    // Another quality of the same level is a different market variant: report it, never attach it.
    const nearest = rows.filter(r => r.variant?.gemLevel === want.gemLevel && !r.variant?.corrupted).map(r => r.variant.variant).filter(Boolean);
    return { status: hits.length > 1 ? 'ambiguous' : 'no_exact_variant', variant: null, nearest: nearest.length ? nearest : undefined };
  }
  const named = rows.filter(r => r.variant?.variant);
  if (want.variantName) {
    const hit = named.filter(r => r.variant.variant.toLowerCase() === want.variantName.toLowerCase());
    if (hit.length === 1) return { status: 'matched', variant: hit[0].variant.variant };
  }
  if (rows.length === 1 && !named.length) return want.itemVariants > 1 ? { status: 'variant_not_distinguished_in_price_data', variant: null } : { status: 'matched', variant: null };
  return { status: 'variant_required', variant: null };
}

// ---------- data loaders (read-only, cached per process) ----------
const memo = new Map();
const once = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };

export const pobGems = () => once('pobGems', () => {
  const table = parseLuaTable(fs.readFileSync(pobSrc('Data/Gems.lua'), 'utf8'));
  const byEffect = new Map();
  for (const [key, g] of Object.entries(table)) if (g && typeof g === 'object' && g.grantedEffectId && !byEffect.has(g.grantedEffectId)) byEffect.set(g.grantedEffectId, { key, ...g });
  return byEffect;
});

export const pobUniques = () => once('pobUniques', () => {
  const dir = pobSrc('Data/Uniques');
  const byName = new Map();
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.lua')).sort()) {
    const t = parseLuaTable(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const raw of Array.isArray(t) ? t : Object.values(t)) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const u = parseUniqueRaw(raw);
      if (!byName.has(u.name)) byName.set(u.name, []);
      byName.get(u.name).push({ file, raw, ...u });
    }
  }
  return byName;
});

export const uniquesCatalog = () => once('catalog', () => fs.readFileSync(path.join(dbRoot, 'data/uniques-3.30.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)));

const knowledge = () => once('knowledge', () => {
  const db = new DatabaseSync(path.join(dbRoot, 'data/knowledge-3.30.sqlite'), { readOnly: true });
  try {
    const gems = new Map();
    for (const r of db.prepare("SELECT category,id,name,eligibility,payload_json FROM records WHERE category IN ('gems','granted_skills')").all()) {
      const d = JSON.parse(r.payload_json);
      if (!gems.has(r.id) || r.category === 'gems') gems.set(r.id, { category: r.category, id: r.id, name: r.name, eligibility: r.eligibility, display_name: d.display_name ?? r.name,
        is_support: !!d.is_support, tags: d.tags ?? [], support_gem: d.support_gem ?? null,
        types: d.active_skill?.types ?? d.types ?? d.skill_types ?? [], minion_types: d.active_skill?.minion_types ?? d.minion_types ?? [] });
    }
    const anoints = db.prepare("SELECT id,name,eligibility,payload_json FROM records WHERE category='anointments' ORDER BY name").all().map(r => ({ id: r.id, name: r.name, eligibility: r.eligibility, ...JSON.parse(r.payload_json) }));
    const baseClass = new Map(db.prepare("SELECT name,payload_json FROM records WHERE category='base_items'").all().map(r => [r.name, JSON.parse(r.payload_json).item_class ?? null]));
    return { gems, anoints, baseClass };
  } finally { db.close(); }
});

// ---------- build reading ----------
export function readBuild(file) {
  const { root } = decodeBuild(fs.readFileSync(file));
  const sets = asArray(root.Skills?.SkillSet);
  const active = sets.find(s => String(s.id) === String(root.Skills?.activeSkillSet)) ?? sets[0];
  const groups = asArray(active?.Skill ?? root.Skills?.Skill).map((s, i) => ({ index: i + 1, label: s.label ?? '', slot: s.slot ?? null, enabled: s.enabled !== 'false', source: s.source ?? null,
    gems: asArray(s.Gem).map((g, k) => ({ index: k + 1, name: g.nameSpec, skill_id: g.skillId, gem_id: g.gemId, level: Number(g.level), quality: Number(g.quality), enabled: g.enabled !== 'false' })) }));
  const items = new Map(asArray(root.Items?.Item).map(i => [String(i.id), typeof i === 'string' ? i : (i.text ?? '')]));
  const itemSets = asArray(root.Items?.ItemSet);
  const itemSet = itemSets.find(s => String(s.id) === String(root.Items?.activeItemSet)) ?? itemSets[0];
  const slots = new Map();
  for (const s of asArray(itemSet?.Slot ?? root.Items?.Slot)) if (s.itemId && s.itemId !== '0' && items.has(String(s.itemId))) slots.set(s.name, items.get(String(s.itemId)));
  const specs = asArray(root.Tree?.Spec);
  const spec = specs[Number(root.Tree?.activeSpec ?? 1) - 1] ?? specs[0];
  const allocated = new Set(String(spec?.nodes ?? '').split(',').filter(Boolean));
  // Chosen mastery effects of the active spec ({node,effect} pairs; only allocated mastery nodes count).
  const masteries = [...String(spec?.masteryEffects ?? '').matchAll(/\{(\d+),(\d+)\}/g)].map(m => ({ node: Number(m[1]), effect: Number(m[2]) })).filter(m => allocated.has(String(m.node)));
  return { level: Number(root.Build.level), class: root.Build.className, ascendancy: root.Build.ascendClassName, main_socket_group: Number(root.Build.mainSocketGroup ?? 1),
    groups, slots, allocated, masteries };
}
const itemName = text => { const l = (text ?? '').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean); return l[0]?.startsWith('Rarity:') ? l[1] : l[0]; };
const itemBase = text => { const l = (text ?? '').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean); return /^Rarity: (UNIQUE|RARE|RELIC)/i.test(l[0] ?? '') ? l[2] : l[1]; };

function withPriceDb(fn) {
  let db;
  try { db = referenceDb(undefined, { readOnly: true }); } catch (e) { return fn(null, e.message); }
  try { return fn(db, null); } finally { db.close(); }
}
function priceRows(db, name) {
  if (!db) return { rows: [], error: 'price_db_unavailable' };
  try { return { rows: priceQuery('get', name, db, { platform: 'pc', limit: 100, history: false }).results, error: null }; }
  catch (e) { return { rows: [], error: e.message }; }
}

// A support-only group feeds the active skill an item grants in the same slot (e.g. Death Aura from Death's Oath):
// PoB applies supports socketed in that item to its granted skill. Returns the item-granted group, or null.
export function itemGrantedTarget(build, g, info) {
  if (!g?.slot) return null;
  return build.groups.find(x => x !== g && x.slot === g.slot && /^Item:/.test(x.source ?? '') && x.enabled
    && x.gems.some(gem => gem.enabled && info(gem) && !info(gem).is_support)) ?? null;
}
// Group whose skill is measured for support candidates of group N: N itself, or the item-granted skill it supports.
export function measuredGroup(file, group) {
  const build = readBuild(file);
  const g = build.groups[group - 1];
  const k = knowledge();
  const info = gem => k.gems.get(gem.skill_id) ?? null;
  if (!g || g.gems.some(x => x.enabled && info(x) && !info(x).is_support)) return group;
  return itemGrantedTarget(build, g, info)?.index ?? group;
}

// ---------- generators ----------
export function generateSupportCandidates({ file, group = null, replace = 'auto', quality = 20, excludeAwakened = false, search = null, limit = null } = {}) {
  const build = readBuild(file);
  const g = build.groups[(group ?? build.main_socket_group) - 1];
  if (!g) throw new Error(`Socket group ${group ?? build.main_socket_group} not found (active skill set has ${build.groups.length})`);
  const k = knowledge(), pob = pobGems();
  const info = gem => k.gems.get(gem.skill_id) ?? null;
  if (g.source) throw new Error(`Group ${g.index} is granted by ${g.source}; add supports to the support group socketed in the same slot (${g.slot ?? 'no slot'})`);
  let actives = g.gems.filter(x => x.enabled && info(x) && !info(x).is_support);
  const granted = actives.length ? null : itemGrantedTarget(build, g, info);
  if (granted) actives = granted.gems.filter(x => x.enabled && info(x) && !info(x).is_support);
  if (!actives.length) throw new Error(`Group ${g.index} has no enabled active gem known to the knowledge DB and no item-granted skill in slot ${g.slot ?? '(none)'}`);
  const supports = g.gems.filter(x => info(x)?.is_support);
  const activeInfo = info(actives[0]);
  const sockets = parseSockets(/^Sockets: (.+)$/m.exec(build.slots.get(g.slot) ?? '')?.[1]);
  const free = sockets ? sockets.largest_link - g.gems.length : null;
  let target;
  if (replace === 'add' || (replace === 'auto' && (!supports.length || free > 0))) target = { mode: 'add', gem: null };
  else if (replace === 'auto' || replace === 'weakest') target = { mode: 'weakest', gem: supports[supports.length - 1].index, provisional: true };
  else {
    const n = Number(replace);
    const gem = g.gems[n - 1];
    if (!Number.isInteger(n) || !gem || !info(gem)?.is_support) throw new Error(`--replace must be add|weakest|auto or the index of a support gem in group ${g.index}: ${supports.map(s => `${s.index}=${s.name}`).join(', ')}`);
    target = { mode: 'replace', gem: n };
  }
  const replaced = target.gem ? g.gems[target.gem - 1] : null;
  const remaining = supports.filter(s => s.enabled && s !== replaced);
  // Types added by the supports that stay in the group (PoB adds them to the active skill); the replaced gem's are dropped.
  const types = new Set([...activeInfo.types, ...activeInfo.minion_types, ...remaining.flatMap(s => info(s).support_gem?.added_types ?? [])]);
  const remainingFamilies = new Set(remaining.map(s => family(pob.get(s.skill_id)?.name ?? s.name)));
  const present = new Set(g.gems.map(s => s.skill_id));
  const candidates = [], excluded = [];
  const text = search?.toLowerCase();
  withPriceDb((db, dbError) => {
    for (const [effect, gem] of [...pob].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      if (!gem.tags?.support) continue;
      const kInfo = k.gems.get(effect);
      const name = gem.name;
      if (text && !name.toLowerCase().includes(text) && !(gem.tagString ?? '').toLowerCase().includes(text)) continue;
      const skip = reason => excluded.push({ name, reason });
      if (!kInfo) { skip('not_in_knowledge_db'); continue; }
      if (kInfo.eligibility !== 'released_in_client') { skip(`eligibility_${kInfo.eligibility}`); continue; }
      if (present.has(effect)) { skip('already_in_group'); continue; }
      if (excludeAwakened && gem.tags.awakened) { skip('awakened_excluded'); continue; }
      if (remainingFamilies.has(family(name))) { skip('same_family_in_group'); continue; }
      const compat = supportCompatible(kInfo, types, { fromGem: true });
      if (!compat.ok) { skip(compat.reason); continue; }
      const exceptional = !!(gem.tags.exceptional || gem.tags.awakened);
      const level = gem.naturalMaxLevel ?? 20;
      // Empower/Enlighten/Enhance are traded and used without quality.
      const q = gem.tags.low_max_level && /^(Awakened )?(Empower|Enlighten|Enhance)$/.test(name) ? 0 : quality;
      const spec = { name, level, quality: q };
      const changes = target.mode === 'add'
        ? { skills: { groups: [{ group: g.index, add_gems: [spec] }] } }
        : { skills: { groups: [{ group: g.index, replace_gems: [{ gem: target.gem, ...spec }] }] } };
      const { rows, error } = priceRows(db, kInfo.display_name);
      const pick = error ? { status: dbError ?? error, variant: null } : choosePriceRow(rows, { gemLevel: level, gemQuality: q });
      const price = pick.status === 'matched' ? { name: kInfo.display_name, ...(pick.variant ? { variant: pick.variant } : {}) } : null;
      const upgrade = replaced && family(name) === family(pob.get(replaced.skill_id)?.name ?? replaced.name);
      candidates.push({ id: slugId('sup', name, target.gem ? `r${target.gem}` : 'add'),
        label: `${target.mode === 'add' ? 'Add' : `Replace ${replaced.name} with`} ${name} ${level}/${q}${upgrade ? ' (upgrade of the same gem)' : ''}`,
        changes, price, cost: null,
        generated: { kind: 'supports', support: name, granted_effect: effect, level, quality: q, exceptional, awakened: !!gem.tags.awakened,
          replaces: replaced ? { gem: replaced.index, name: replaced.name } : null, price_match: pick.status, price_nearest_variants: pick.nearest, price_note: price ? null : 'price not attached: exact level/quality variant not observed' } });
    }
  });
  let list = uniqueIds(candidates);
  if (limit) list = list.slice(0, limit);
  return { kind: 'supports', group: { index: g.index, slot: g.slot, label: g.label, gems: g.gems.map(x => `${x.index}:${x.name} ${x.level}/${x.quality}${x.enabled ? '' : ' (disabled)'}`) },
    active_skill: { name: actives[0].name, skill_id: actives[0].skill_id, types: [...types].sort(), other_actives: actives.slice(1).map(a => a.name),
      ...(granted ? { item_granted: true, source: granted.source, measured_group: granted.index } : {}) },
    measured_group: granted ? granted.index : g.index,
    sockets, free_sockets: free, target, candidates: list, excluded,
    notes: ['Prefilter: RePoE allowed/excluded type expressions against the active skill types plus added_types of the other supports (PoB rule, without weapon-type and item-granted checks).',
      'Engine run decides: candidates whose support is missing from applied_supports are excluded from the ranking.',
      ...(granted ? [`Group ${g.index} has no active gem: candidates are measured on the skill granted by ${granted.source} (group ${granted.index}, same slot). PoB may not apply every support to item-granted skills; check applied_supports.`] : []),
      'Levels: PoB natural max level (exceptional 3-4, awakened 5), quality --quality (default 20). Corrupted 21/23 gems are not generated. Price only for the exact level/quality variant.',
      ...(target.provisional ? ['Replacement target "weakest" is resolved by removal probes at run time; --plan shows the last support as a provisional target.'] : [])] };
}

export function generateUniqueCandidates({ file, slot, search = null, limit = null, includeLegacy = false } = {}) {
  const build = readBuild(file);
  const s = normalizeSlot(slot);
  let classes = slotClasses[s];
  const current = build.slots.get(s);
  const k = knowledge();
  if (current && s.startsWith('Weapon')) { const cls = k.baseClass.get(itemBase(current)); if (cls) classes = [cls]; }
  const catalog = uniquesCatalog().filter(r => classes.includes(r.item_class) && r.availability?.status === 'source_asserted_obtainable');
  const byName = new Map();
  for (const r of catalog) { if (!byName.has(r.name)) byName.set(r.name, []); byName.get(r.name).push(r); }
  const pob = pobUniques();
  const candidates = [], excluded = [];
  const text = search?.toLowerCase();
  const currentName = current ? itemName(current) : null;
  withPriceDb((db, dbError) => {
    for (const [name, records] of [...byName].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (text && !name.toLowerCase().includes(text) && !records.some(r => (r.effects?.explicit_fixed ?? '').toLowerCase().includes(text))) continue;
      if (name === currentName) { excluded.push({ name, reason: 'currently_equipped' }); continue; }
      const entries = (pob.get(name) ?? []).filter(e => records.some(r => r.base_type === e.base) || !records.some(r => (pob.get(name) ?? []).some(x => x.base === r.base_type)));
      if (!entries.length) { excluded.push({ name, reason: 'no_pob_item_text' }); continue; }
      const reqLevel = Math.min(...records.map(r => r.requirements?.level ?? 0));
      if (reqLevel > build.level) { excluded.push({ name, reason: 'level_requirement', detail: `${reqLevel} > ${build.level}` }); continue; }
      const { rows, error } = priceRows(db, name);
      for (const e of entries) {
        const variants = e.variants.length ? (includeLegacy ? e.variants.map((v, i) => ({ index: i + 1, name: v })) : e.current) : [{ index: null, name: null }];
        if (!variants.length) { excluded.push({ name, reason: 'only_legacy_variants' }); continue; }
        for (const v of variants) {
          const pick = error ? { status: dbError ?? error, variant: null } : choosePriceRow(rows, { variantName: v.name, itemVariants: variants.length });
          const price = pick.status === 'matched' ? { name, ...(pick.variant ? { variant: pick.variant } : {}) } : null;
          candidates.push({ id: slugId('uniq', name, entries.length > 1 ? e.base : null, v.index ? `v${v.index}` : null),
            label: `${name}${v.name ? ` [${v.name}]` : ''} (${e.base}) in ${s}`,
            changes: { replace_items: [{ slot: s, text: uniqueItemText(e.raw, v.index) }] }, price, cost: null,
            generated: { kind: 'uniques', slot: s, name, base: e.base, pob_variant: v.name, pob_variant_index: v.index, pob_file: e.file,
              catalog_ids: records.map(r => r.id), catalog_records: records.length, has_alt_variant: e.has_alt_variant,
              rolls: 'ranged lines at PoB default affix quality (0.5)', price_match: pick.status,
              price_note: price ? null : pick.status === 'variant_not_distinguished_in_price_data' ? 'single price row without variant field; not attached to a specific variant' : 'price not attached' } });
        }
      }
    }
  });
  let list = uniqueIds(candidates);
  if (limit) list = list.slice(0, limit);
  return { kind: 'uniques', slot: s, item_classes: classes, currently_equipped: currentName, candidates: list, excluded,
    notes: ['Availability: Wiki acquisition flag in the uniques catalog (not independently verified). Item text and variants come from PoB 2.68.1 data; every current (non "Pre x.y") variant is a separate candidate.',
      'Ranged values use PoB default roll (middle of range). Alt variants (Has Alt Variant) keep PoB defaults. Generated uniques (Forbidden Shako, Megalomaniac, Precursor\'s Emblem) have no static text and are excluded.',
      'Requirements beyond level are not filtered: check new_warnings for attributes.'] };
}

// Anoint options for an amulet text and a set of allocated tree node ids (also used by design generate: WP11).
export function anointOptions({ amulet = null, allocated = new Set(), search = null } = {}) {
  const existing = currentAnoint(amulet);
  const text = search?.toLowerCase();
  const options = [], excluded = [];
  for (const a of knowledge().anoints) {
    if (text && !a.name.toLowerCase().includes(text) && !(a.stats ?? []).join(' ').toLowerCase().includes(text)) continue;
    if (a.name === existing) { excluded.push({ name: a.name, reason: 'current_anoint' }); continue; }
    if (allocated.has(String(a.node_id))) { excluded.push({ name: a.name, reason: 'allocated_on_tree' }); continue; }
    options.push(a);
  }
  return { existing, options, excluded };
}
export function generateAnointCandidates({ file, search = null, limit = null } = {}) {
  const build = readBuild(file);
  const amulet = build.slots.get('Amulet') ?? null;
  const existing = currentAnoint(amulet);
  const mode = amulet && withAnoint(amulet, 'X') ? 'replace_amulet_anoint' : 'custom_mods';
  const text = search?.toLowerCase();
  const candidates = [], excluded = [];
  for (const a of knowledge().anoints) {
    if (text && !a.name.toLowerCase().includes(text) && !(a.stats ?? []).join(' ').toLowerCase().includes(text)) continue;
    if (a.name === existing) { excluded.push({ name: a.name, reason: 'current_anoint' }); continue; }
    if (build.allocated.has(String(a.node_id))) { excluded.push({ name: a.name, reason: 'allocated_on_tree' }); continue; }
    const changes = mode === 'replace_amulet_anoint' ? { replace_items: [{ slot: 'Amulet', text: withAnoint(amulet, a.name) }] } : { custom_mods: `Allocates ${a.name}` };
    candidates.push({ id: slugId('anoint', a.name), label: `Anoint ${a.name}`, changes, price: null, cost: null,
      generated: { kind: 'anoints', notable: a.name, node_id: a.node_id, oils: a.oils ?? [], stats: a.stats ?? [], mode, replaces: existing } });
  }
  let list = uniqueIds(candidates);
  if (limit) list = list.slice(0, limit);
  if (mode === 'replace_amulet_anoint' && existing) list.unshift({ id: 'anoint-control', label: `Control: amulet re-imported with current anoint ${existing}`, changes: { replace_items: [{ slot: 'Amulet', text: withAnoint(amulet, existing) }] }, price: null, cost: null,
    generated: { kind: 'anoints', control: true, notable: existing, mode } });
  return { kind: 'anoints', amulet: amulet ? itemName(amulet) : null, current_anoint: existing, mode, candidates: list, excluded,
    notes: [mode === 'custom_mods' ? 'No amulet with an Implicits header: anoint is modelled as a custom "Allocates X" line (no item replaced).' : 'The equipped amulet is re-imported with the anoint line replaced; anoint-control measures re-import drift (ModRange elements outside the text are not carried).',
      'Oil prices are not attached; oils[] lists the recipe. Blight-ravaged ring anoints are not covered.'] };
}

export function generateCandidates({ kind, ...options }) {
  const out = kind === 'supports' ? generateSupportCandidates(options) : kind === 'uniques' ? generateUniqueCandidates(options) : kind === 'anoints' ? generateAnointCandidates(options)
    : (() => { throw new Error('--kind supports|uniques|anoints (cluster notables are not generated)'); })();
  if (out.candidates.length) validateCandidateFile({ candidates: out.candidates });
  return { game: 'poe1', patch: '3.30', ...out, total: out.candidates.length, disclaimer };
}

// ---------- engine-backed ----------
// Removal probes: drop each enabled support once; the smallest loss of `metric` is the weakest support.
export function weakestSupport({ file, scenario = 'sustained', group, base = {}, metric = 'dps', concurrency = defaultConcurrency }) {
  // Removal probes are the support components of the ablation plan (one definition of 'remove a support').
  const build = readBuild(file);
  const probes = planAblation({ build, isSupport: isSupportGem(pobGems()), kinds: ['supports'], base, supportGroup: group }).components
    .map(c => ({ gem: c.target.gem, name: c.label, changes: c.changes }));
  if (!probes.length) return null;
  const baseline = runPob({ input: fs.readFileSync(file), scenario, changes: base });
  const before = readMetric(baseline, metric);
  const batch = runBatch({ file, scenario, changesList: probes.map(p => p.changes), concurrency });
  const run = batchRunner(batch);
  const rows = probes.map(p => { try { const v = readMetric(run(p.changes), metric); return { gem: p.gem, name: p.name, after: v, loss_pct: before > 0 && v != null ? (1 - v / before) * 100 : null }; } catch (e) { return { gem: p.gem, name: p.name, error: e.message }; } });
  const ok = rows.filter(r => r.loss_pct != null).sort((a, b) => a.loss_pct - b.loss_pct);
  return { metric, before, probes: rows, weakest: ok[0] ?? null, engine_runs: batch.runs };
}

function verifyRow(file, scenario, base, candidate) {
  let r;
  try { r = runPob({ input: fs.readFileSync(file), scenario, changes: { ...base, ...candidate.changes } }); } catch (e) { return { status: 'error', detail: e.message }; }
  const gen = candidate.generated ?? {};
  if (gen.kind === 'supports') {
    const applied = (r.applied_supports ?? []).some(s => s.id === gen.granted_effect || s.name === gen.support);
    return { status: applied ? 'applied' : 'not_applied', applied_supports: (r.applied_supports ?? []).map(s => `${s.name} ${s.level}/${s.quality}`) };
  }
  if (candidate.changes.custom_mods) {
    const bad = r.unparsed_custom_mods ?? [];
    return { status: bad.length ? 'unparsed_lines' : 'parsed', custom_mods: candidate.changes.custom_mods, unparsed: bad.length ? bad : undefined };
  }
  const slot = candidate.changes.replace_items?.[0]?.slot;
  const unparsed = (r.unparsed_item_modifiers ?? []).filter(u => !slot || u.slot === slot);
  const equipped = slot ? (r.equipped_items ?? []).find(e => e.slot === slot)?.name ?? null : null;
  return { status: unparsed.length ? 'unparsed_lines' : 'parsed', equipped, unparsed: unparsed.length ? unparsed : undefined };
}

export function analyzeAutoUpgrades({ file, kind, slot = null, group = null, replace = 'auto', metric = 'dps', top = 20, concurrency = defaultConcurrency, scenario = 'sustained', base = {}, search = null, limit = null, quality = 20, excludeAwakened = false } = {}) {
  if (!metrics[metric]) throw new Error(`Unknown metric ${metric}`);
  const started = Date.now();
  let probe = null, runBase = base;
  const build = readBuild(file);
  const groupIndex = group ?? build.main_socket_group;
  const measured = kind === 'supports' ? measuredGroup(file, groupIndex) : groupIndex;
  if (kind === 'supports' && measured !== build.main_socket_group) runBase = { ...base, selection: { ...(base.selection ?? {}), main_socket_group: measured } };
  let gen = generateCandidates({ kind, file, slot, group: groupIndex, replace, search, limit, quality, excludeAwakened });
  if (kind === 'supports' && gen.target.mode === 'weakest') {
    probe = weakestSupport({ file, scenario, group: groupIndex, base: runBase, metric, concurrency });
    if (probe?.weakest) gen = generateCandidates({ kind, file, group: groupIndex, replace: String(probe.weakest.gem), search, limit, quality, excludeAwakened });
  }
  // Supports already in the group that the engine does not apply to the measured skill (e.g. Controlled Destruction
  // or Empower on Death Aura): reported, not hidden.
  let existingNotApplied;
  if (kind === 'supports') {
    const k = knowledge();
    const base0 = runPob({ input: fs.readFileSync(file), scenario, changes: runBase });
    const applied = new Set((base0.applied_supports ?? []).flatMap(s => [s.id, s.name]));
    existingNotApplied = build.groups[groupIndex - 1].gems.filter(x => x.enabled && k.gems.get(x.skill_id)?.is_support && !applied.has(x.skill_id) && !applied.has(x.name))
      .map(x => ({ gem: x.index, name: x.name, skill_id: x.skill_id }));
  }
  if (!gen.candidates.length) return { ...gen, analysis: 'auto_upgrades', ranking: [], existing_supports_not_applied: existingNotApplied, note: 'No candidates generated' };
  const expanded = expandCandidates({ candidates: gen.candidates });
  const result = analyzeUpgrades({ file, scenario, metric, candidates: expanded, base: runBase, top: expanded.length, concurrency });
  const byId = new Map(gen.candidates.map(c => [c.id, c]));
  const verification = new Map(result.ranking.map(r => [r.id, verifyRow(file, scenario, runBase, byId.get(r.id))]));
  const rejected = new Set([...verification].filter(([, v]) => v.status === 'not_applied').map(([id]) => id));
  const ranking = result.ranking.filter(r => !rejected.has(r.id)).slice(0, top).map((r, i) => ({ ...r, rank: i + 1, verification: verification.get(r.id), generated: byId.get(r.id).generated }));
  return { ...result, analysis: 'auto_upgrades', kind, generation: { ...gen, candidates: undefined, excluded: gen.excluded.length, excluded_reasons: countBy(gen.excluded, 'reason'), total: gen.candidates.length },
    measured_group: kind === 'supports' ? measured : undefined, existing_supports_not_applied: existingNotApplied, replacement_probe: probe, ranking,
    excluded: [...result.excluded, ...[...rejected].map(id => ({ id, reason: 'support_not_applied', detail: verification.get(id).applied_supports }))],
    by_price: { ...result.by_price, ranked: result.by_price.ranked.filter(r => !rejected.has(r.id)) },
    verification_summary: countBy([...verification.values()], 'status'),
    timing: { ...result.timing, total_ms: Date.now() - started }, disclaimer: `${result.disclaimer} ${disclaimer}` };
}
const countBy = (list, key) => list.reduce((m, x) => { m[x[key]] = (m[x[key]] ?? 0) + 1; return m; }, {});

// ---------- CLI ----------
const intOpt = (v, name, min, max) => { if (v == null) return null; const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer ${min}-${max}`); return n; };

export function autoUpgradeOptions(file, options) {
  return { file: path.resolve(file), kind: options.auto ?? options.kind, slot: options.slot ?? null, group: intOpt(options.group, 'group', 1, 100), replace: options.replace ?? 'auto',
    metric: options.metric ?? 'dps', top: intOpt(options.top, 'top', 1, 500) ?? 20, concurrency: intOpt(options.concurrency, 'concurrency', 1, 16) ?? defaultConcurrency,
    scenario: options.scenario ?? 'sustained', base: options.changes ? readJson(path.resolve(options.changes)) : {}, search: options.search ?? null,
    limit: intOpt(options.limit, 'limit', 1, 2000), quality: intOpt(options.quality, 'quality', 0, 23) ?? 20, excludeAwakened: !!options['exclude-awakened'] };
}

export function candidatesCommand(rest) {
  const { positional, options } = flags(rest, ['kind', 'slot', 'group', 'replace', 'search', 'limit', 'out', 'metric', 'top', 'concurrency', 'scenario', 'changes', 'quality'], ['plan', 'exclude-awakened']);
  const file = positional[0];
  if (!file) throw new Error('Build file required: analyze candidates <xml> --kind supports|uniques|anoints [--slot Helmet] [--plan]');
  if (!options.kind) throw new Error('--kind supports|uniques|anoints required');
  const o = autoUpgradeOptions(file, options);
  if (options.plan) {
    const gen = generateCandidates({ kind: o.kind, file: o.file, slot: o.slot, group: o.group, replace: o.replace, search: o.search, limit: o.limit, quality: o.quality, excludeAwakened: o.excludeAwakened });
    if (options.out) { atomicJson(path.resolve(options.out), { candidates: gen.candidates }); gen.candidates_file = path.resolve(options.out); }
    return { ...gen, candidates: gen.candidates.map(c => ({ id: c.id, label: c.label, price: c.price, price_match: c.generated.price_match })),
      excluded: gen.excluded.length, excluded_reasons: countBy(gen.excluded, 'reason'),
      usage: 'Full changes: --out file.json (usable as analyze upgrades --candidates). Engine run: drop --plan.' };
  }
  const result = analyzeAutoUpgrades(o);
  if (options.out) atomicJson(path.resolve(options.out), result);
  return result;
}

export const candidatesHelp = {
  'analyze candidates <xml> --kind supports [--group N] [--replace auto|add|weakest|<gem index>] [--search text] [--exclude-awakened] [--plan] [--out f.json]': 'Auto candidates: every type-compatible support for the main (or chosen) group, replacing the weakest support (removal probes) or added to a free linked socket; engine checks applied_supports',
  'analyze candidates <xml> --kind uniques --slot <Helmet|Body Armour|Gloves|Boots|Amulet|Ring 1|Ring 2|Belt|Weapon 1|Weapon 2|Flask N> [--search text] [--limit N] [--plan]': 'Obtainable uniques (Wiki flag) for the slot with PoB item text, one candidate per current variant, dated price when the variant matches',
  'analyze candidates <xml> --kind anoints [--search text] [--limit N] [--plan]': 'Amulet anointment notables (replaces the current anoint; anoint-control measures re-import drift)',
  'analyze upgrades <xml> --auto supports|uniques|anoints [--slot S] [--metric dps] [--top N]': 'Same as analyze candidates without --plan: generation plus ranking with prices in one call'
};
