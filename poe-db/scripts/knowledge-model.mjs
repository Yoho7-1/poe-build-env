export function mergeGemLevel(gem, level) {
  const specific = gem.per_level?.[String(level)];
  if (!specific) return null;
  const base = gem.static ?? {};
  const merged = { ...base };
  for (const [key, value] of Object.entries(specific)) if (value !== null) merged[key] = value;
  for (const key of ['costs', 'reservations', 'stat_requirements', 'stat_text']) {
    if (base[key] || specific[key]) merged[key] = { ...(base[key] ?? {}) };
    for (const [name, value] of Object.entries(specific[key] ?? {})) if (value !== null) merged[key][name] = value;
  }
  const count = Math.max(base.stats?.length ?? 0, specific.stats?.length ?? 0);
  merged.stats = [];
  for (let index = 0; index < count; index++) {
    const common = base.stats?.[index], value = specific.stats?.[index];
    if (!common && !value) continue;
    const stat = { ...(common ?? {}) };
    for (const [key, next] of Object.entries(value ?? {})) if (next !== null) stat[key] = next;
    if (!stat.id) throw new Error(`Gem stat has no identity at level ${level}, index ${index}`);
    merged.stats.push(stat);
  }
  return merged;
}

export function skillNodeKind(node) {
  if (node.isAscendancyStart || node.classStartIndex != null) return 'start';
  if (node.isMastery) return 'mastery';
  if (node.isKeystone) return 'keystone';
  if (node.isNotable) return 'notable';
  if (node.isJewelSocket) return 'jewel_socket';
  if (node.isMultipleChoiceOption) return 'choice';
  return 'normal';
}

export function treeEdges(tree) {
  const result = [];
  const seen = new Set();
  for (const [id, node] of Object.entries(tree.nodes)) for (const to of node.out ?? []) {
    if (!tree.nodes[String(to)]) throw new Error(`Unknown tree connection ${id} -> ${to}`);
    const key = `${id}:${to}`;
    if (!seen.has(key)) { seen.add(key); result.push([String(id), String(to)]); }
  }
  return result;
}

export function recordTitle(id, value) {
  return typeof value === 'string' ? value : value?.name ?? value?.display_name ?? value?.house_name ?? value?.id ?? id;
}
