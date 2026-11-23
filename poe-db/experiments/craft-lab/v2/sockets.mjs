import { baseOf } from './catalog.mjs';
import { requireThat, definition } from './item.mjs';
import { pickWeighted } from './draw.mjs';
import { ruleValue } from './rules.mjs';

const SIX = ['Body Armour', 'Bow', 'Staff', 'Warstaff', 'Two Hand Axe', 'Two Hand Mace', 'Two Hand Sword'];
const FOUR = ['Boots', 'Gloves', 'Helmet'];
const THREE = ['Claw', 'Dagger', 'Rune Dagger', 'One Hand Axe', 'One Hand Mace', 'One Hand Sword', 'Thrusting One Hand Sword', 'Sceptre', 'Wand', 'Shield'];
export const socketClasses = Object.freeze([...SIX, ...FOUR, ...THREE]);

// Rule sockets.max: class maximum, implicit override, item-level gate.
export function maxSockets(catalog, item, { ignoreLevel = false } = {}) {
  const base = baseOf(catalog, item.base_id);
  for (const roll of item.implicits) { const index = definition(catalog, roll).stats.findIndex(stat => stat.id === 'local_has_X_sockets'); if (index >= 0) return roll.values[index]; }
  let max = SIX.includes(base.item_class) ? 6 : FOUR.includes(base.item_class) ? 4 : THREE.includes(base.item_class) ? 3 : 0;
  if (base.name === 'Gnarled Branch') max = 3;
  if (ignoreLevel) return max;
  const gates = ruleValue('sockets.max').min_level;
  while (max > 0 && item.item_level < gates[max - 1]) max--;
  return max;
}
const requirements = (catalog, item) => {
  const req = baseOf(catalog, item.base_id).requirements ?? {};
  return { R: req.strength ?? 0, G: req.dexterity ?? 0, B: req.intelligence ?? 0 };
};
// Natural colour weights by attribute requirements (rule sockets.chromatic).
export function colourWeights(catalog, item) {
  const req = requirements(catalog, item), present = Object.entries(req).filter(([, value]) => value > 0), total = present.reduce((a, [, v]) => a + v, 0);
  if (present.length === 0) return { R: 1, G: 1, B: 1 };
  if (present.length === 1) {
    const [colour, a] = present[0], out = {};
    for (const c of ['R', 'G', 'B']) out[c] = c === colour ? 0.9 * (10 + a) / (total + 20) : 0.05 + 0.9 * 5 / (total + 20);
    return out;
  }
  if (present.length === 2) { const out = {}; for (const c of ['R', 'G', 'B']) out[c] = req[c] > 0 ? 0.9 * req[c] / total : 0.1; return out; }
  return { R: req.R / total, G: req.G / total, B: req.B / total };
}
const drawColour = (weights, rng) => pickWeighted(Object.entries(weights).map(([c, weight]) => ({ c, weight })), rng).c;
export function nonWhiteChance(item) { return Math.min(1, 0.00375 * Math.max(item.item_level - 14, 1) * (1 + Math.min(item.quality, 30) / 100)); }
function rollColours(catalog, item, rng, weights = colourWeights(catalog, item)) {
  const p = nonWhiteChance(item);
  const colours = item.sockets.colours.map(colour => ['A', 'D'].includes(colour) ? colour : (rng.int(1000000) / 1000000 < p ? drawColour(weights, rng) : 'W'));
  const gem = colours.map((c, i) => [c, i]).filter(([c]) => !['A', 'D'].includes(c));
  if (gem.length && gem.every(([c]) => c === 'W')) colours[gem[0][1]] = drawColour(weights, rng);
  return colours;
}
// Chromatic Orb: result conditioned on differing from the current colours (and optional extra condition).
export function chromatic(catalog, item, rng, accept = () => true, differ = true, weights = undefined) {
  requireThat(item.sockets.colours.some(c => !['A', 'D'].includes(c)), 'No gem sockets');
  const before = item.sockets.colours.join('');
  for (let i = 0; i < 20000; i++) {
    const colours = rollColours(catalog, item, rng, weights);
    if ((!differ || colours.join('') !== before) && accept(colours)) { item.sockets.colours = colours; return; }
  }
  throw new Error('Colour condition is unreachable within the sampling limit');
}
export function setSocketCount(item, n) {
  const colours = item.sockets.colours.slice(0, n);
  while (colours.length < n) colours.push('W');
  const links = []; let used = 0;
  for (const group of item.sockets.links) { if (used >= n) break; const size = Math.min(group, n - used); links.push(size); used += size; }
  while (used < n) { links.push(1); used++; }
  item.sockets = { colours, links };
}
export function jewellerCount(catalog, item, rng, { omen = false, exclude = true } = {}) {
  const max = maxSockets(catalog, item);
  requireThat(max > 0, 'Item cannot have sockets');
  if (omen) return max;
  const base = baseOf(catalog, item.base_id), table = FOUR.includes(base.item_class) ? ruleValue('sockets.jeweller').four : ruleValue('sockets.jeweller').six;
  const rows = table.slice(0, max).map((weight, i) => ({ n: i + 1, weight })).filter(row => !exclude || row.n !== item.sockets.colours.length);
  requireThat(rows.length, 'No different socket count is available');
  return pickWeighted(rows, rng).n;
}
export function fusingLinks(n, rng) {
  const weights = ruleValue('sockets.fusing'), links = []; let left = n;
  while (left > 0) { const rows = weights.slice(0, left).map((weight, i) => ({ size: i + 1, weight })); const size = pickWeighted(rows, rng).size; links.push(size); left -= size; }
  return links;
}
export function fusing(item, rng, { omen = false } = {}) {
  const n = item.sockets.colours.length;
  requireThat(n >= 2 && item.sockets.links.length > 1, 'Fusing needs an item with two or more unlinked sockets');
  if (omen) { item.sockets.links = [n]; return; }
  const before = item.sockets.links.join(',');
  for (let i = 0; i < 20000; i++) { const links = fusingLinks(n, rng); if (links.join(',') !== before) { item.sockets.links = links; return; } }
  throw new Error('Fusing sampling limit');
}
export function randomSockets(catalog, item, rng) {
  const max = maxSockets(catalog, item); if (!max) return;
  setSocketCount(item, jewellerCount(catalog, item, rng, { exclude: false }));
  item.sockets.colours = item.sockets.colours.map(() => 'W'); item.sockets.colours = rollColours(catalog, item, rng);
  item.sockets.links = fusingLinks(item.sockets.colours.length, rng);
}
// Rule quality.gain.
export function qualityGain(item, rng) {
  const f = Math.max(1, Math.min(30 * Math.exp(-item.item_level / 30) - 0.3, 20)), low = Math.floor(f), frac = f - low;
  return frac > 0 && rng.int(1000000) / 1000000 < frac ? low + 1 : low;
}
