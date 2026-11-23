// Session-2 data commands (tree graph, leveling, 3.30 changes, research meta) for agent.mjs.
import { treeCommand } from './tree-graph.mjs';
import { levelingCommand } from './leveling.mjs';
import { changesCommand } from './patch-changes.mjs';
import { metaCommand } from './meta.mjs';

const handlers = { tree: treeCommand, leveling: levelingCommand, changes: changesCommand, meta: metaCommand };
export const dataCommands = new Set(Object.keys(handlers));
export function dataCommand(command, rest) { return handlers[command](rest); }

export const dataHelp = {
  'tree path --from <class|ascendancy> --to <node[,node...]> [--allocated ids|names] [--xml build.xml]': 'Minimum-point legal path on the 3.30 GGG tree (PoB traversal rules); output allocate[] = node ids',
  'tree cost --from <class> --allocated <ids> | --xml build.xml': 'Points used, budget, connectivity of main tree and ascendancy/bloodline',
  'tree near <node> [--radius small|medium|large|very-large|massive|N] [--type notable,keystone]': 'Nodes in jewel radius (PoB 3_16 radii; Timeless = large)',
  'tree search <text> [--type notable|keystone|mastery|normal|jewel_socket] [--scope main|ascendancy|all] [--from <class>]': 'Find nodes by name/stat text; --from adds points from class start',
  'tree node <id|name> | tree classes': 'Node details (links, mastery effects, cluster socket) / class starts',
  'leveling gems --class <class> --act N [--cumulative] [--kind active|support] [--source quest_reward|vendor] [--search text]': 'Quest reward choices and NPC gem vendors per act (Wiki Cargo + RePoE client cross-check)',
  'leveling gem <name> | books | recipes [text] [--all] | uniques [--max-level N] [--slot X] | conflicts': 'Per-class gem availability, passive point books, vendor recipes, low-level obtainable uniques',
  'changes get <entity> | search <text> | tree [--type T] [--change added|changed] | uniques | summary | card': '3.29 -> 3.30 changes: PoB tree diff, PoB unique versions, official patch-note lines; card = old-guide checklist',
  'meta skill <name> | builds [--tier] | item <name> [--league] | sources [--version 3.30] | findings [text] | info': 'Research corpus (2026-11-12) and 3.29 Allflame prices; dated, never 3.30 meta'
};
