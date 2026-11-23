import { queryCatalog } from './query.mjs';
import { flags } from './workspace.mjs';

const identity = record => ({ id: record.id, category: record.category, name: record.name, name_ru: record.name_ru,
  eligibility: record.eligibility, availability: record.availability, source_conflicts: record.source_conflicts });
const source = record => ({ url: record.source?.url, version: record.source?.source_version ?? record.source?.version,
  sha256: record.source?.sha256, localization: record.sources?.filter(s => s.role === 'localization').map(s => ({ url: s.url, version: s.source_version })) });

function brief(record, search) {
  const result = { ...identity(record), source: source(record) };
  if (search) return { ...result, base_type: record.base_type, item_class: record.item_class };
  if (record.stat_id) return { ...result, base_type:record.base_type,item_class:record.item_class,
    stat_id:record.stat_id,mod_id:record.mod_id,min_value:record.min_value,max_value:record.max_value,is_random:record.is_random,
    source:{url:record.source_url},units:'source_native' };
  if (record.level !== undefined) {
    const d = record.data, l = record.level_data;
    return { ...result, level: record.level, level_data: l && {
      required_level: l.required_level, stat_requirements: l.stat_requirements, costs: l.costs, reservations: l.reservations,
      cooldown: l.cooldown, cost_multiplier: l.cost_multiplier, damage_effectiveness: l.damage_effectiveness,
      stats: l.stats, stat_text: l.stat_text },
      description: d.active_skill?.description ?? d.support_gem?.support_text,
      cast_time: d.cast_time, discriminator: d.discriminator, skill_types: d.active_skill?.types, weapon_restrictions: d.active_skill?.weapon_restrictions,
      support_constraints: d.support_gem, quality: { coefficients_are_raw: true, applied: false, definitions: d.static?.quality_stats },
      units: record.units, available_levels: l ? undefined : record.available_levels };
  }
  if (record.effects) return { ...result, base_type: record.base_type, item_class: record.item_class, requirements: record.requirements,
    effects: {implicit:record.effects.implicit,explicit_fixed:record.effects.explicit_fixed,enchantment:record.effects.enchantment},
    random_pool: { present:record.effects.random_options.length>0,blocks:record.effects.random_options.length,omitted:record.effects.random_options.length>0,
      meaning:'Alternative pools are not simultaneous guarantees; use --view full to read the pool, or stat --include-random to retrieve source numeric ranges.' },
    acquisition_text: record.acquisition_text,unavailable_property_groups:record.unavailable_property_groups,
    note: 'Inspect full record for numeric ranges, source alternatives and additional properties.' };
  if (record.stat_ranges) return { ...result, text: record.data.text, required_level: record.data.required_level,
    domain: record.data.domain, generation_type: record.data.generation_type, groups: record.data.groups,
    tags: record.data.implicit_tags, essence_only: record.data.is_essence_only, stat_ranges: record.stat_ranges, ordered_weights: record.ordered_weights };
  if (record.neighbors) return { ...result, stats: record.data.stats, ascendancy: record.data.ascendancyName,
    neighbors: record.neighbors, mastery_options: record.mastery_options };
  // Arbitrary definitions have no safe generic lossy summary: preserve their payload.
  return { ...result, summary: record.summary, data: record.data, relations: record.relations };
}

export function compactQuery(args) {
  const forwarded = [], controls = [];
  for (let i = 0; i < args.length; i++) {
    if (['--view', '--fields'].includes(args[i])) {
      controls.push(args[i], args[i + 1] ?? ''); i++;
    } else forwarded.push(args[i]);
  }
  const { options } = flags(controls, ['view', 'fields']);
  const view = options.view ?? 'brief';
  if (!['brief', 'full'].includes(view)) throw new Error('view must be brief or full');
  const search = forwarded.includes('search');
  if (search && !forwarded.includes('--limit')) forwarded.push('--limit', '5');
  const raw = queryCatalog(forwarded);
  if (view === 'full') return raw;
  if (!raw.results) return raw;
  const result = { ...raw, view: 'brief', detail: 'Use --view full for complete source payload; no roll, quality or combat calculation is implied.',
    results: raw.results.map(row => brief(row, search)) };
  if (options.fields) {
    const wanted = options.fields.split(',');
    const available = new Set(result.results.flatMap(row => Object.keys(row)));
    for (const field of wanted) if (!available.has(field)) throw new Error(`Unknown or unavailable field: ${field}`);
    result.results = result.results.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => wanted.includes(key) || ['id','category','name','name_ru','eligibility','availability','source_conflicts','source','units','random_pool'].includes(key))));
    result.selected_fields = wanted;
  }
  return result;
}
