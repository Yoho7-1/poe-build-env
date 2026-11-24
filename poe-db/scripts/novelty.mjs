// Structural novelty (WP8, part 1): how different a build's architecture is from the corpus, separate from performance.
// A BuildCard is reduced to a structural vector (ascendancy, skill and delivery, damage form/types, scaling supports,
// defense model, sustain, keystones, uniques). Each group gives a distance in 0..1 (categorical: 0/1, sets: Jaccard,
// share vectors: half L1); the weighted mean is the distance between two cards. novelty = distance to the nearest
// corpus card (quality-filtered by default), so a corpus duplicate scores ~0, one swapped item scores low and another
// archetype scores high. Numbers (DPS, EHP) are deliberately not part of the vector: performance is a separate axis.
// Weights are a stated prior, not fitted; read `differences` before trusting the score.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, flags } from './workspace.mjs';
import { readCards, qualityFilter } from './corpus-learn.mjs';
import { cardDirectory } from './build-card.mjs';

export const noveltyWeights = Object.freeze({
  ascendancy: 1.5, main_skill: 2, delivery: 1.5, damage_scope: 1.5, damage_form: 2, damage_types: 1.5,
  scaling: 1, defense_pool: 1.5, defense_layers: 1, sustain: 0.75, keystones: 1.25, uniques: 1
});
// Main-skill tags that describe how damage is delivered (not element or attribute).
const deliveryTags = new Set(['attack', 'spell', 'minion', 'totem', 'trap', 'mine', 'brand', 'melee', 'projectile', 'area', 'channelling', 'chaining', 'bow', 'strike', 'slam', 'retaliation', 'warcry', 'herald', 'golem', 'triggerable', 'orb', 'nova', 'blink', 'travel', 'duration']);
const sustainLayers = new Set(['life_recoup', 'life_leech', 'life_regen', 'energy_shield', 'eldritch_battery', 'ward']);
const formKeys = ['hit', 'skill_dot', 'ignite', 'poison', 'bleed', 'decay'];
const typeKeys = ['Physical', 'Fire', 'Cold', 'Lightning', 'Chaos'];
const finite = v => typeof v === 'number' && Number.isFinite(v);
const r3 = v => Math.round(v * 1000) / 1000;

// ---------- vector ----------
export function noveltyVector(card) {
  const f = card.features ?? {};
  const main = card.skills?.main ?? {};
  const layers = f.defense_layers ?? card.defense?.layers ?? [];
  const sustained = card.resources?.sustained;
  const shares = (obj, keys) => Object.fromEntries(keys.map(k => [k, finite(obj?.[k]) ? obj[k] : 0]));
  return {
    ascendancy: f.ascendancy ?? null, class: f.class ?? null,
    main_skill: f.main_skill ?? null,
    delivery: (main.tags ?? []).filter(t => deliveryTags.has(t)).sort(),
    damage_scope: f.damage_scope ?? card.damage?.scope ?? 'player',
    damage_form: shares(card.damage?.parts, formKeys), primary_form: f.primary_form ?? null,
    damage_types: shares(card.damage?.types, typeKeys), primary_type: f.primary_type ?? null,
    scaling: [...(main.supports ?? [])].sort(),
    defense_pool: f.defense_pool ?? card.defense?.pool ?? null,
    defense_layers: layers.filter(l => !sustainLayers.has(l)).sort(),
    sustain: [...layers.filter(l => sustainLayers.has(l)), ...(sustained === true ? ['mana_sustained'] : sustained === false ? ['mana_unsustained'] : [])].sort(),
    keystones: [...(f.keystones ?? [])].sort(), uniques: [...(f.uniques ?? [])].sort()
  };
}

const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); if (!A.size && !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return 1 - i / (A.size + B.size - i); };
const halfL1 = (a, b) => { const keys = new Set([...Object.keys(a), ...Object.keys(b)]); const sa = Object.values(a).reduce((s, v) => s + v, 0), sb = Object.values(b).reduce((s, v) => s + v, 0);
  if (!sa && !sb) return 0; if (!sa || !sb) return 1; let d = 0; for (const k of keys) d += Math.abs((a[k] ?? 0) / sa - (b[k] ?? 0) / sb); return Math.min(1, d / 2); };
// Unknown (null) on either side counts as half a difference: neither proven equal nor different.
const categorical = (a, b) => a == null || b == null ? 0.5 : a === b ? 0 : 1;

export function groupDistances(va, vb) {
  return {
    // Same class, other ascendancy is a smaller step than another class.
    ascendancy: va.ascendancy === vb.ascendancy && va.ascendancy != null ? 0 : va.class && va.class === vb.class ? 0.7 : categorical(va.ascendancy, vb.ascendancy),
    main_skill: categorical(va.main_skill, vb.main_skill), delivery: jaccard(va.delivery, vb.delivery), damage_scope: categorical(va.damage_scope, vb.damage_scope),
    damage_form: halfL1(va.damage_form, vb.damage_form), damage_types: halfL1(va.damage_types, vb.damage_types), scaling: jaccard(va.scaling, vb.scaling),
    defense_pool: categorical(va.defense_pool, vb.defense_pool), defense_layers: jaccard(va.defense_layers, vb.defense_layers), sustain: jaccard(va.sustain, vb.sustain),
    keystones: jaccard(va.keystones, vb.keystones), uniques: jaccard(va.uniques, vb.uniques)
  };
}

export function cardDistance(a, b, weights = noveltyWeights) {
  const va = a.vector ?? noveltyVector(a), vb = b.vector ?? noveltyVector(b);
  const groups = groupDistances(va, vb);
  let sum = 0, w = 0;
  for (const [k, d] of Object.entries(groups)) { const wk = weights[k] ?? 0; sum += wk * d; w += wk; }
  return { distance: w ? r3(sum / w) : 0, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, r3(v)])) };
}

// What differs from a neighbour, in words a player reads (only groups that differ).
export function describeDifferences(va, vb, groups) {
  const setDiff = (a, b) => ({ added: a.filter(x => !b.includes(x)), removed: b.filter(x => !a.includes(x)) });
  const out = [];
  for (const [k, d] of Object.entries(groups).sort((x, y) => (noveltyWeights[y[0]] * y[1]) - (noveltyWeights[x[0]] * x[1]))) {
    if (!(d > 0)) continue;
    const row = { group: k, distance: d, weighted: r3(d * noveltyWeights[k]) };
    if (Array.isArray(va[k])) Object.assign(row, setDiff(va[k], vb[k]));
    else if (k === 'damage_form') Object.assign(row, { this: va.primary_form, neighbour: vb.primary_form });
    else if (k === 'damage_types') Object.assign(row, { this: va.primary_type, neighbour: vb.primary_type });
    else if (k === 'ascendancy') Object.assign(row, { this: `${va.class}/${va.ascendancy}`, neighbour: `${vb.class}/${vb.ascendancy}` });
    else Object.assign(row, { this: va[k], neighbour: vb[k] });
    out.push(row);
  }
  return out;
}

const cardId = c => c._card ?? c.identity?.file ?? c.signature ?? null;
// Generator API (WP5): noveltyScore(card, corpus) -> { novelty 0..1, nearest[] }. corpus = array of BuildCards
// (use loadNoveltyCorpus() for the quality-filtered local corpus). The card itself (same pob_sha256) is skipped.
export function noveltyScore(card, corpus, { top = 5, weights = noveltyWeights } = {}) {
  const v = noveltyVector(card);
  const self = card.identity?.pob_sha256 ?? null;
  const skipped = [];
  const rows = [];
  for (const c of corpus) {
    if (self && c.identity?.pob_sha256 === self) { skipped.push(cardId(c)); continue; }
    const vc = noveltyVector(c);
    rows.push({ c, vc, ...cardDistance({ vector: v }, { vector: vc }, weights) });
  }
  rows.sort((a, b) => a.distance - b.distance || String(cardId(a.c)).localeCompare(String(cardId(b.c))));
  const nearest = rows.slice(0, top).map(r => ({ card: cardId(r.c), distance: r.distance, signature: r.c.signature ?? null, same_signature: !!card.signature && r.c.signature === card.signature,
    ascendancy: r.c.features?.ascendancy ?? null, main_skill: r.c.features?.main_skill ?? null, form: r.c.features?.primary_form ?? null, type: r.c.features?.primary_type ?? null,
    pool: r.c.features?.defense_pool ?? null, source: r.c.identity?.source ?? null, differences: describeDifferences(v, r.vc, r.groups) }));
  const dists = rows.map(r => r.distance);
  const meanK = arr => arr.length ? r3(arr.reduce((s, x) => s + x, 0) / arr.length) : null;
  return {
    novelty: rows.length ? rows[0].distance : null,
    novelty_mean_top: meanK(dists.slice(0, top)),
    band: !rows.length ? null : rows[0].distance < 0.05 ? 'duplicate' : rows[0].distance < 0.2 ? 'variant' : rows[0].distance < 0.4 ? 'related' : 'novel',
    compared: rows.length, skipped_self: skipped, nearest,
    same_ascendancy_skill: rows.filter(r => r.c.features?.ascendancy === v.ascendancy && r.c.features?.main_skill === v.main_skill).length
  };
}

export function loadNoveltyCorpus({ directory = cardDirectory(), all = false, minLevel = 80 } = {}) {
  const cards = readCards(directory);
  if (all) return { cards, filter: null };
  const q = qualityFilter(cards, { minLevel });
  const stem = c => String(c.identity?.file ?? c._card ?? '').replace(/\.(xml|json)$/i, '');
  return { cards: cards.filter(c => q.keep.has(stem(c))), filter: { min_level: q.min_level, cards: q.cards, kept: q.kept, excluded: q.excluded.length } };
}

// ---------- CLI ----------
export async function noveltyCommand(args) {
  const { positional, options } = flags(args, ['top', 'dir', 'min-level', 'scenario'], ['all', 'help', 'vector']);
  const target = positional[1];
  if (options.help || !target) return { command: 'corpus novelty', usage: Object.keys(noveltyHelp)[0], description: Object.values(noveltyHelp)[0], weights: noveltyWeights };
  const file = path.resolve(target);
  if (!fs.existsSync(file)) throw new Error(`File not found: ${target}`);
  let card;
  if (/\.json$/i.test(file)) {
    card = readJson(file);
    if (card.kind !== 'build_card') throw new Error('JSON input must be a BuildCard (build card <xml> --out f.json)');
  } else {
    const { buildCard } = await import('./build-card.mjs');
    card = buildCard({ file, scenario: options.scenario ?? 'sustained' });
  }
  const directory = options.dir ? path.resolve(options.dir) : cardDirectory();
  const { cards, filter } = loadNoveltyCorpus({ directory, all: !!options.all, minLevel: options['min-level'] ? Number(options['min-level']) : 80 });
  const top = options.top ? Math.max(1, Number(options.top)) : 5;
  const score = noveltyScore(card, cards, { top });
  return { analysis: 'novelty', input: path.basename(file), signature: card.signature ?? null,
    build: { class: card.features?.class, ascendancy: card.features?.ascendancy, main_skill: card.features?.main_skill, form: card.features?.primary_form, type: card.features?.primary_type, pool: card.features?.defense_pool },
    ...score, ...(options.vector ? { vector: noveltyVector(card) } : {}),
    corpus: { directory, quality_filter: filter }, weights: noveltyWeights,
    note: 'Structural distance to the nearest corpus card (0 = same architecture, 1 = shares nothing); bands duplicate < 0.05 <= variant < 0.2 <= related < 0.4 <= novel. Performance (DPS/EHP) is not part of it. Weights are a prior, not fitted; unmodelled mechanics are not seen by the card.' };
}
export const noveltyHelp = {
  'corpus novelty <file.xml|card.json> [--top 5] [--all] [--min-level 80] [--dir cards] [--vector]':
    'Structural novelty vs the corpus cards (quality filter by default): weighted distance over ascendancy, main skill/delivery, damage form/types, scaling supports, defense pool/layers, sustain, keystones, uniques -> novelty 0..1, band, nearest neighbours and what differs; separate from performance. API for generators: noveltyScore(card, corpus)'
};
