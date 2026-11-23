// Explicit network step: downloads leveling and patch-change sources into cache/wiki with sha256.
// Usage: node scripts/fetch-game-data.mjs [leveling|monsters|changes|all]
import { loadWikiManifest, fetchCargo, fetchWikitext } from './wiki-source.mjs';

const what = process.argv[2] ?? 'all';
const manifest = loadWikiManifest();
const log = meta => console.log(`${meta.file}: ${meta.rows ?? meta.revid} (${meta.bytes} bytes, sha256 ${meta.sha256.slice(0, 12)})`);

if (what === 'leveling' || what === 'all') {
  log((await fetchCargo(manifest, 'quest_rewards', { tables: 'quest_rewards', fields: '_pageName=item,act,quest,quest_id,classes,class_ids,item_level,rarity,sockets,notes' })).meta);
  log((await fetchCargo(manifest, 'vendor_rewards', { tables: 'vendor_rewards', fields: '_pageName=item,act,quest,quest_id,npc,classes,class_ids' })).meta);
  log((await fetchWikitext(manifest, 'page_vendor_recipe_system', 'Vendor recipe system')).meta);
}
if (what === 'monsters' || what === 'all') {
  // Boss varieties and monster scaling tables for the enemy database (relative multipliers; absolute life is derived).
  log((await fetchCargo(manifest, 'monster_bosses', { tables: 'monsters', fields: '_pageName=page,metadata_id,name,health_multiplier,damage_multiplier,monster_type_id,mod_ids,rarity_id,skill_ids,tags', where: 'monsters.is_boss=1', orderBy: 'monsters.metadata_id' })).meta);
  log((await fetchCargo(manifest, 'monster_types', { tables: 'monster_types', fields: 'id,armour_multiplier,evasion_multiplier,energy_shield_multiplier,damage_spread,monster_resistance_id,tags', orderBy: 'monster_types.id' })).meta);
  log((await fetchCargo(manifest, 'monster_resistances', { tables: 'monster_resistances', fields: 'id,maps_fire,maps_cold,maps_lightning,maps_chaos', orderBy: 'monster_resistances.id' })).meta);
  log((await fetchCargo(manifest, 'monster_map_multipliers', { tables: 'monster_map_multipliers', fields: 'level,life,damage,boss_life,boss_damage', orderBy: 'monster_map_multipliers.level' })).meta);
  log((await fetchCargo(manifest, 'monster_life_scaling', { tables: 'monster_life_scaling', fields: 'level,magic,rare', orderBy: 'monster_life_scaling.level' })).meta);
}
if (what === 'changes' || what === 'all') {
  for (const v of ['3.30.0', '3.30.0b', '3.30.0c', '3.30.0d']) log((await fetchWikitext(manifest, `page_version_${v.replaceAll('.', '_')}`, `Version ${v}`)).meta);
}
