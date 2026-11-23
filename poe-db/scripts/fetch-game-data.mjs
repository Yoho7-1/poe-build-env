// Explicit network step: downloads leveling and patch-change sources into cache/wiki with sha256.
// Usage: node scripts/fetch-game-data.mjs [leveling|changes|all]
import { loadWikiManifest, fetchCargo, fetchWikitext } from './wiki-source.mjs';

const what = process.argv[2] ?? 'all';
const manifest = loadWikiManifest();
const log = meta => console.log(`${meta.file}: ${meta.rows ?? meta.revid} (${meta.bytes} bytes, sha256 ${meta.sha256.slice(0, 12)})`);

if (what === 'leveling' || what === 'all') {
  log((await fetchCargo(manifest, 'quest_rewards', { tables: 'quest_rewards', fields: '_pageName=item,act,quest,quest_id,classes,class_ids,item_level,rarity,sockets,notes' })).meta);
  log((await fetchCargo(manifest, 'vendor_rewards', { tables: 'vendor_rewards', fields: '_pageName=item,act,quest,quest_id,npc,classes,class_ids' })).meta);
  log((await fetchWikitext(manifest, 'page_vendor_recipe_system', 'Vendor recipe system')).meta);
}
if (what === 'changes' || what === 'all') {
  for (const v of ['3.30.0', '3.30.0b', '3.30.0c', '3.30.0d']) log((await fetchWikitext(manifest, `page_version_${v.replaceAll('.', '_')}`, `Version ${v}`)).meta);
}
