// Multi-item and device actions: Awakener's Orb, Recombinator, Altar of Corruption.
import { baseOf } from '../catalog.mjs';
import { firstWeight } from '../../engine.mjs';
import { requireThat, definition, sideOf, capacity, makeRoll, itemTags, mutable, equipment, fracturedCount, isAffix, lowestRarity } from '../item.mjs';
import { pickWeighted, pickUniform, reforge, influenceModOf } from '../draw.mjs';
import { addCorruptedImplicits } from './basic.mjs';
import { ruleValue } from '../rules.mjs';
import { colourWeights } from '../sockets.mjs';

const other = (session, id) => { const item = session.inventory[id]; requireThat(item, `Unknown inventory item: ${id}`); return item; };

export function awakener(ctx) {
  const { catalog, session, item, action, rng } = ctx;
  const donor = other(session, action.donor);
  for (const it of [item, donor]) { mutable(catalog, it); equipment(catalog, it); requireThat(it.influences.length === 1, 'Each input needs exactly one influence'); }
  requireThat(baseOf(catalog, item.base_id).item_class === baseOf(catalog, donor.base_id).item_class, 'Inputs must share an item class');
  requireThat(item.influences[0] !== donor.influences[0], 'Influences must differ');
  const influenced = it => { const tags = itemTags(catalog, it); return it.mods.filter(roll => influenceModOf(catalog, it, definition(catalog, roll), tags)); };
  const a = influenced(item), b = influenced(donor);
  const pairs = a.flatMap(x => b.filter(y => y.id !== x.id).map(y => [x, y]));
  requireThat(pairs.length, 'Both inputs need influenced modifiers');
  const [keepR, keepD] = pickUniform(pairs, rng);
  ctx.used.push('influence.awakener');
  item.influences = [item.influences[0], donor.influences[0]];
  item.mods = [makeRoll(definition(catalog, keepR), rng, { kind: keepR.kind })];
  const clash = definition(catalog, keepD).groups.some(g => definition(catalog, keepR).groups.includes(g));
  if (!clash) item.mods.push(makeRoll(definition(catalog, keepD), rng, { kind: keepD.kind }));
  item.rarity = 'rare';
  reforge(catalog, item, rng, { respect_locks: false, keep_ids: item.mods.map(roll => roll.id), pool: { respect_tags: false, cut: item.memory_strands > 0 ? 'strands' : null } });
  delete session.inventory[action.donor];
}

const EXCLUSIVE_KINDS = ['crafted', 'essence', 'veiled', 'unveiled', 'elevated', 'beast'];
function exclusive(catalog, roll) { const mod = definition(catalog, roll); return EXCLUSIVE_KINDS.includes(roll.kind) || mod.is_essence_only || ['delve', 'crafted', 'veiled', 'unveiled'].includes(mod.domain); }
export function recombinator(ctx) {
  const { catalog, session, item, action, rng } = ctx;
  const second = other(session, action.other);
  for (const it of [item, second]) { requireThat(!it.corrupted && !it.mirrored, 'Recombinator refuses corrupted or mirrored items'); equipment(catalog, it); requireThat(['magic', 'rare'].includes(it.rarity), 'Inputs must be magic or rare'); }
  requireThat(baseOf(catalog, item.base_id).item_class === baseOf(catalog, second.base_id).item_class, 'Inputs must share an item class');
  ctx.used.push('recomb.model', 'recomb.330');
  const chosen = rng.int(2) === 0 ? item : second, out = structuredClone(chosen);
  out.mods = []; out.foreseeing = null;
  const tags = itemTags(catalog, { ...out, rarity: 'rare' });
  const legal = (roll, owner) => {
    const mod = definition(catalog, roll);
    if (roll.fractured) return owner === chosen;
    if (exclusive(catalog, roll)) return true;
    return firstWeight(mod.spawn_weights, tags, 0) > 0;
  };
  const weightOf = roll => exclusive(catalog, roll) ? 1000 : firstWeight(definition(catalog, roll).spawn_weights, tags, 0) || 1000;
  const table = ruleValue('recomb.model');
  const sides = {};
  for (const side of ['prefix', 'suffix']) {
    const pooled = [item, second].flatMap(owner => owner.mods.filter(roll => sideOf(catalog, roll) === side && legal(roll, owner)).map(roll => ({ roll, owner })));
    const n = Math.min(6, pooled.length);
    const row = n === 0 ? { 0: 1 } : table[n];
    sides[side] = { pooled, keep: Math.min(capacity(catalog, out, 'rare')[side], pickWeighted(Object.entries(row).map(([k, weight]) => ({ k: Number(k), weight })), rng).k) };
  }
  const order = rng.int(2) === 0 ? ['prefix', 'suffix'] : ['suffix', 'prefix'];
  let exclusiveTaken = false;
  for (const side of order) {
    let left = sides[side].pooled.slice();
    for (let i = 0; i < sides[side].keep && left.length; i++) {
      const pick = pickWeighted(left.map(entry => ({ entry, weight: weightOf(entry.roll) })), rng).entry;
      const mod = definition(catalog, pick.roll);
      out.mods.push(structuredClone(pick.roll));
      if (exclusive(catalog, pick.roll)) exclusiveTaken = true;
      left = left.filter(entry => entry !== pick && !definition(catalog, entry.roll).groups.some(g => mod.groups.includes(g)) && !(exclusiveTaken && exclusive(catalog, entry.roll)));
      for (const s of ['prefix', 'suffix']) if (exclusiveTaken) sides[s].pooled = sides[s].pooled.filter(entry => !exclusive(catalog, entry.roll) || out.mods.some(r => r.id === entry.roll.id));
    }
  }
  const n = { prefix: out.mods.filter(r => sideOf(catalog, r) === 'prefix').length, suffix: out.mods.filter(r => sideOf(catalog, r) === 'suffix').length };
  out.rarity = n.prefix > 1 || n.suffix > 1 ? 'rare' : out.mods.length ? 'magic' : 'normal';
  ctx.notes.push(`Recombinator base: ${chosen === item ? 'primary item' : action.other}`);
  session.item = out; delete session.inventory[action.other]; session.imprint = null;
}

export function altar(ctx) {
  const { catalog, session, item, rng } = ctx;
  equipment(catalog, item); requireThat(!item.mirrored && !item.twice_corrupted, 'Twice corrupted or mirrored items cannot be corrupted again');
  ctx.used.push('corrupt.altar_330', 'corrupt.altar_two_implicit_share', 'corrupt.implicit_330');
  if (item.corrupted) item.twice_corrupted = true; else item.corrupted = true;
  const weights = ruleValue('corrupt.altar_330');
  const outcome = pickWeighted(Object.entries(weights).map(([name, weight]) => ({ name, weight })), rng).name;
  ctx.notes.push(`Altar outcome: ${outcome}`);
  if (outcome === 'destroyed') { session.status = 'destroyed'; return; }
  if (outcome === 'two_implicits') addCorruptedImplicits(catalog, item, rng, 2);
  if (outcome === 'sockets') item.sockets.colours = item.sockets.colours.map(c => c === 'W' ? pickWeighted(Object.entries(colourWeights(catalog, item)).map(([k, weight]) => ({ k, weight })), rng).k : c);
}
export { isAffix, lowestRarity, fracturedCount };
