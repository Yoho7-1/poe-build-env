import { baseOf } from './catalog.mjs';
import { definition, requireThat, validateItem } from './state.mjs';

function handle(catalog, value, name) {
  const handler = catalog.handlers[name];
  requireThat(handler, `Unknown stat handler: ${name}`);
  if (handler.type === 'noop') return value;
  requireThat(['int', 'float'].includes(handler.type), `Stat handler requires a dedicated renderer: ${name}`);
  let result = handler.fixed ?? ((value * (handler.multiplier ?? 1)) / (handler.divisor ?? 1) + (handler.addend ?? 0));
  if (handler.precision !== null && handler.precision !== undefined) result = Number(result.toFixed(handler.precision));
  return result;
}
export function renderRoll(catalog, roll) {
  const mod = definition(catalog, roll), stats = new Map(mod.stats.map((stat, index) => [stat.id, roll.values[index]])), remaining = new Set(stats.keys()), lines = [];
  // Longest stat groups first: a two-stat line must not become two unrelated single-stat lines.
  const candidates = catalog.translations.filter(row => row.ids.some(id => remaining.has(id)) && row.ids.every(id => stats.has(id))).sort((a, b) => b.ids.length - a.ids.length);
  for (const group of candidates) {
    if (!group.ids.every(id => remaining.has(id))) continue;
    const values = group.ids.map(id => stats.get(id));
    const rule = group.English?.find(rule => rule.condition.every((condition, index) => {
      const value = values[index], inside = (condition.min === null || value >= condition.min) && (condition.max === null || value <= condition.max);
      return condition.negated ? !inside : inside;
    }));
    if (!rule) continue;
    let line = rule.string;
    values.forEach((value, index) => {
      for (const name of rule.index_handlers[index] ?? []) value = handle(catalog, value, name);
      const format = rule.format[index];
      requireThat(['#', '+#', 'ignore'].includes(format), `Unknown stat format: ${format}`);
      const rendered = format === 'ignore' ? '' : format === '+#' && value >= 0 ? `+${value}` : String(value);
      line = line.replaceAll(`{${index}}`, rendered);
    });
    requireThat(!/\{\d+\}/.test(line), `Unresolved translation placeholders: ${mod.id}`);
    line = line.replace(/\[([^\]|]+)\|([^\]]+)\]/g, '$2');
    requireThat(!/[\[\]]/.test(line), `Unresolved markup: ${mod.id}`);
    if (!group.hidden) lines.push(...line.split('\n'));
    group.ids.forEach(id => remaining.delete(id));
  }
  requireThat(!remaining.size, `Cannot safely export untranslated stats for ${mod.id}: ${[...remaining].join(', ')}`);
  return lines;
}
export function exportPob(catalog, item) {
  validateItem(catalog, item);
  requireThat(!item.cluster, 'Cluster topology export is not implemented');
  requireThat(!item.mods.some(roll => roll.kind === 'veiled'), 'Choose the veiled modifier before export');
  requireThat(!item.quality, 'Quality-dependent base properties need a verified exporter');
  const base = baseOf(catalog, item.base_id);
  const lines = [`Rarity: ${item.rarity.toUpperCase()}`, 'Craft Lab Item', base.name, `Item Level: ${item.item_level}`];
  if (item.sockets.colours.length) {
    let index = 0;
    const groups = item.sockets.links.map(count => item.sockets.colours.slice(index, index += count).join('-'));
    lines.push(`Sockets: ${groups.join(' ')}`);
  }
  for (const influence of item.influences) lines.push(`${influence} Item`);
  const implicitLines = item.implicits.flatMap(roll => renderRoll(catalog, roll));
  lines.push(`Implicits: ${implicitLines.length}`, ...implicitLines);
  for (const roll of item.enchantments) lines.push(...renderRoll(catalog, roll).map(line => `{enchant}${line}`));
  for (const roll of item.mods) {
    const prefix = roll.fractured ? '{fractured}' : roll.kind === 'crafted' ? '{crafted}' : '';
    lines.push(...renderRoll(catalog, roll).map(line => prefix + line));
  }
  if (item.corrupted) lines.push('Corrupted');
  if (item.mirrored) lines.push('Mirrored');
  if (item.split) lines.push('Split');
  const text = lines.join('\n'); requireThat(!/[^\x09\x0a\x0d\x20-\x7e]/.test(text), 'PoB export must be printable ASCII');
  return { text, format: 'pob-item-text', game_tested: false, scope: 'Supported translated raw rolls only; no character or acquisition validation' };
}
