const asciiText = (value, where) => { if (typeof value !== 'string' || !/^[\x20-\x7E]{1,100}$/.test(value)) throw new Error(`${where} must be printable ASCII, 1-100 characters`); };
const nodeRef = (value, where) => { if (!(Number.isInteger(value) && value > 0) && !(typeof value === 'string' && value.trim() && value.length <= 120)) throw new Error(`${where} must be a node id or exact node name`); };
const isObject = value => value != null && typeof value === 'object' && !Array.isArray(value);
const arrayOf = (value, where) => { if (value != null && !Array.isArray(value)) throw new Error(`${where} must be an array`); return value ?? []; };
const onlyKeys = (value, keys, where) => { if (!isObject(value)) throw new Error(`${where} must be an object`); for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unsupported ${where}.${key}`); };
function validateGem(gem, where) {
  onlyKeys(gem, ['name','level','quality','enabled','gem'], where);
  if (typeof gem.name !== 'string' || !gem.name.trim()) throw new Error(`${where}.name required`);
  if (gem.level != null && (!Number.isInteger(gem.level) || gem.level < 1 || gem.level > 40)) throw new Error(`${where}.level must be 1-40`);
  if (gem.quality != null && (!Number.isInteger(gem.quality) || gem.quality < 0 || gem.quality > 1000)) throw new Error(`${where}.quality invalid`);
}
// Structural validation only; PoB itself resolves names, paths, budgets and legality (fatal errors).
export function validateEditChanges(changes) {
  arrayOf(changes.sets, 'sets').forEach((op, i) => {
    onlyKeys(op, ['type','action','from','title','activate'], `sets[${i}]`);
    if (!['tree','item','skill'].includes(op.type) || !['new','copy'].includes(op.action)) throw new Error(`sets[${i}] requires type tree|item|skill and action new|copy`);
    if (op.from != null && (!Number.isInteger(op.from) || op.from < 1)) throw new Error(`sets[${i}].from must be a positive integer`);
    if (op.title != null) asciiText(op.title, `sets[${i}].title`);
    if (op.activate != null && typeof op.activate !== 'boolean') throw new Error(`sets[${i}].activate must be boolean`);
  });
  if (changes.tree != null) {
    const t = changes.tree;
    onlyKeys(t, ['class','ascendancy','bloodline','allocate','deallocate','masteries','quest_points','ascendancy_points','allow_over_budget'], 'tree');
    for (const key of ['class','ascendancy','bloodline']) if (t[key] != null) asciiText(t[key], `tree.${key}`);
    for (const key of ['allocate','deallocate']) arrayOf(t[key], `tree.${key}`).forEach((ref, i) => nodeRef(ref, `tree.${key}[${i}]`));
    arrayOf(t.masteries, 'tree.masteries').forEach((m, i) => {
      onlyKeys(m, ['node','effect'], `tree.masteries[${i}]`);
      nodeRef(m.node, `tree.masteries[${i}].node`);
      if (!(Number.isInteger(m.effect) || (typeof m.effect === 'string' && m.effect.trim()))) throw new Error(`tree.masteries[${i}].effect must be an effect id or text`);
    });
    if (t.quest_points != null && (!Number.isInteger(t.quest_points) || t.quest_points < 0 || t.quest_points > 30)) throw new Error('tree.quest_points must be 0-30');
    if (t.ascendancy_points != null && (!Number.isInteger(t.ascendancy_points) || t.ascendancy_points < 0 || t.ascendancy_points > 8)) throw new Error('tree.ascendancy_points must be 0-8');
    if (t.allow_over_budget != null && typeof t.allow_over_budget !== 'boolean') throw new Error('tree.allow_over_budget must be boolean');
  }
  arrayOf(changes.jewels, 'jewels').forEach((j, i) => {
    onlyKeys(j, ['node','text','allocate'], `jewels[${i}]`);
    if (!Number.isInteger(j.node) || j.node < 1) throw new Error(`jewels[${i}].node must be a socket node id`);
    if (typeof j.text !== 'string' || !j.text.trim() || j.text.length > 20000) throw new Error(`jewels[${i}].text must be raw item text`);
    arrayOf(j.allocate, `jewels[${i}].allocate`).forEach((ref, k) => nodeRef(ref, `jewels[${i}].allocate[${k}]`));
  });
  if (changes.skills != null) {
    const s = changes.skills;
    onlyKeys(s, ['groups','remove_groups','add_groups'], 'skills');
    arrayOf(s.remove_groups, 'skills.remove_groups').forEach((g, i) => { if (!Number.isInteger(g) || g < 1) throw new Error(`skills.remove_groups[${i}] must be a group index`); });
    arrayOf(s.groups, 'skills.groups').forEach((g, i) => {
      const where = `skills.groups[${i}]`;
      onlyKeys(g, ['group','label','slot','enabled','include_in_full_dps','add_gems','remove_gems','replace_gems'], where);
      if (!Number.isInteger(g.group) || g.group < 1) throw new Error(`${where}.group required`);
      if (g.label != null && g.label !== '') asciiText(g.label, `${where}.label`);
      if (g.slot != null && g.slot !== '') asciiText(g.slot, `${where}.slot`);
      for (const key of ['enabled','include_in_full_dps']) if (g[key] != null && typeof g[key] !== 'boolean') throw new Error(`${where}.${key} must be boolean`);
      arrayOf(g.add_gems, `${where}.add_gems`).forEach((gem, k) => { if (gem?.gem != null) throw new Error(`${where}.add_gems[${k}].gem is not used here`); validateGem(gem, `${where}.add_gems[${k}]`); });
      arrayOf(g.replace_gems, `${where}.replace_gems`).forEach((gem, k) => { validateGem(gem, `${where}.replace_gems[${k}]`); if (!Number.isInteger(gem.gem) || gem.gem < 1) throw new Error(`${where}.replace_gems[${k}].gem index required`); });
      arrayOf(g.remove_gems, `${where}.remove_gems`).forEach((k, n) => { if (!Number.isInteger(k) || k < 1) throw new Error(`${where}.remove_gems[${n}] must be a gem index`); });
    });
    arrayOf(s.add_groups, 'skills.add_groups').forEach((g, i) => {
      const where = `skills.add_groups[${i}]`;
      onlyKeys(g, ['label','slot','enabled','include_in_full_dps','main','gems'], where);
      if (g.label != null && g.label !== '') asciiText(g.label, `${where}.label`);
      if (g.slot != null) asciiText(g.slot, `${where}.slot`);
      for (const key of ['enabled','include_in_full_dps','main']) if (g[key] != null && typeof g[key] !== 'boolean') throw new Error(`${where}.${key} must be boolean`);
      if (!Array.isArray(g.gems) || !g.gems.length || g.gems.length > 12) throw new Error(`${where}.gems must list 1-12 gems`);
      g.gems.forEach((gem, k) => { if (gem?.gem != null) throw new Error(`${where}.gems[${k}].gem is not used here`); validateGem(gem, `${where}.gems[${k}]`); });
    });
  }
}
