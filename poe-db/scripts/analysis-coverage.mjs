// Coverage audit (master prompt 3A.6 / 10 / 11): which power layers a build leaves unused. The system must not
// "forget" items, mods, passives or mechanics, so every layer PoE offers is listed with its state and, for a gap, the
// command that measures it. Facts come from the PoB XML and one PoB calculation; nothing is valued here: a gap is
// a place to look (analyze nodes / candidates / upgrades measure it), not proof that filling it helps.
import fs from 'node:fs';
import path from 'node:path';
import { decodeBuild, runPob } from './pob.mjs';
import { readBuild, pobGems } from './analysis-candidates.mjs';
import { loadTree } from './tree-graph.mjs';
import { flags, atomicJson } from './workspace.mjs';

const asArray = v => v == null ? [] : Array.isArray(v) ? v : [v];
const lines = text => String(text ?? '').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);
export const EQUIPMENT = ['Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt'];
const ARMOUR = ['Helmet', 'Body Armour', 'Gloves', 'Boots'];
const FLASKS = ['Flask 1', 'Flask 2', 'Flask 3', 'Flask 4', 'Flask 5'];
const TWO_HAND = /\b(Two Hand|Staff|Bow|Warstaff|Quarterstaff)\b|^(Bow|Staff)$|Greatsword|Maul|Greataxe|Longbow|Spine Bow|Lion Pelt|Judgement Staff|Eclipse Staff|Maelstr|Coronal Maul|Vaal Axe|Despot Axe|Exquisite Blade|Infernal Sword/;

export function itemFacts(text) {
  const ls = lines(text);
  const rarity = /^Rarity:\s*(\w+)/i.exec(ls[0] ?? '')?.[1]?.toUpperCase() ?? null;
  const base = rarity === 'RARE' || rarity === 'UNIQUE' || rarity === 'RELIC' ? ls[2] : ls[1];
  const sockets = /^Sockets:\s*(.+)$/i.exec(ls.find(l => /^Sockets:/i.test(l)) ?? '')?.[1] ?? '';
  const quality = Number(/^Quality:\s*(\d+)/i.exec(ls.find(l => /^Quality:/i.test(l)) ?? '')?.[1] ?? 0);
  const openPrefix = ls.filter(l => /^Prefix:\s*None$/i.test(l)).length, openSuffix = ls.filter(l => /^Suffix:\s*None$/i.test(l)).length;
  const socketList = sockets ? sockets.split(/[\s-]+/).filter(Boolean) : [];
  return { rarity, base: base ?? null, sockets: socketList.filter(s => s.toUpperCase() !== 'A').length, abyss_sockets: socketList.filter(s => s.toUpperCase() === 'A').length, quality, corrupted: ls.some(l => /^Corrupted$/i.test(l)),
    crafted: ls.some(l => /\{crafted\}/.test(l) && !/Allocates/.test(l)), eldritch: ls.some(l => /\{(exarch|eater)\}/.test(l)), anoint: ls.find(l => /Allocates /.test(l))?.replace(/^(\{[^}]*\})*Allocates /, '') ?? null,
    open_prefixes: openPrefix, open_suffixes: openSuffix, affix_lines_known: ls.some(l => /^(Prefix|Suffix):/i.test(l)), used_when: ls.some(l => /Used when/i.test(l)) };
}

// Pure: build = readBuild(); sockets = [{node, item}] from the active spec; result = PoB run; tree = loadTree(); gems = pobGems().
export function coverageOf({ build, sockets = [], result, tree = null, gems = new Map(), config = {} }) {
  const findings = [];
  const add = (layer, code, severity, detail, next = null) => findings.push({ layer, code, severity, detail, next });
  const o = result.output ?? {};
  const b = result.budget ?? {};
  // --- passive tree ---
  const free = (b.passive_available ?? 0) - (b.passive_used ?? 0), freeAsc = (b.ascendancy_available ?? 0) - (b.ascendancy_used ?? 0);
  if (free > 0) add('tree', 'unspent_passive_points', 'gap', `${free} passive point(s) unspent`, 'analyze nodes <xml>');
  if (freeAsc > 0) add('tree', 'unspent_ascendancy_points', 'gap', `${freeAsc} ascendancy point(s) unspent`, 'tree search --ascendancy');
  const nodes = [...build.allocated].map(id => tree?.nodes.get(Number(id))).filter(Boolean);
  const chosen = new Set((build.masteries ?? []).map(m => m.node));
  const emptyMasteries = nodes.filter(n => n.type === 'mastery' && !chosen.has(n.id));
  if (emptyMasteries.length) add('tree', 'mastery_without_effect', 'gap', `${emptyMasteries.length} allocated mastery node(s) without a chosen effect: ${emptyMasteries.map(n => n.name).join(', ')}`, 'tree node <id> (mastery options)');
  const filled = new Set(sockets.filter(s => s.item && s.item !== '0').map(s => Number(s.node)));
  const emptyJewels = nodes.filter(n => n.type === 'jewel_socket' && !filled.has(n.id));
  if (emptyJewels.length) add('tree', 'empty_jewel_socket', 'gap', `${emptyJewels.length} allocated jewel socket(s) without a jewel${emptyJewels.some(n => n.expansion?.size) ? ' (incl. cluster sockets)' : ''}`, 'item pool --slot jewel');
  const jewelSockets = nodes.filter(n => n.type === 'jewel_socket').length;
  if (!jewelSockets) add('tree', 'no_jewel_sockets', 'check', 'no jewel sockets allocated (no jewels, no cluster jewels)', 'analyze nodes <xml> --types Notable');
  if (!nodes.some(n => n.type === 'keystone')) add('tree', 'no_keystone', 'check', 'no keystone allocated', 'analyze nodes <xml> --types Keystone');
  // --- equipment ---
  const facts = new Map([...build.slots].map(([slot, text]) => [slot, itemFacts(text)]));
  const twoHanded = TWO_HAND.test(facts.get('Weapon 1')?.base ?? '');
  for (const slot of EQUIPMENT) {
    if (facts.has(slot)) continue;
    if (slot === 'Weapon 2' && twoHanded) continue;
    add('items', 'empty_slot', 'gap', `${slot} is empty`, 'analyze candidates <xml> --kind uniques');
  }
  const flaskCount = FLASKS.filter(s => facts.has(s)).length;
  if (flaskCount < 5) add('flasks', 'empty_flask_slot', 'gap', `${5 - flaskCount} flask slot(s) empty`, 'query knowledge search Flask --category items');
  if (flaskCount && !FLASKS.some(s => facts.get(s)?.used_when)) add('flasks', 'no_automatic_flask', 'check', 'no flask with "Used when ..." (every utility flask is pressed manually)', 'corpus norms --check <xml>');
  const amulet = facts.get('Amulet');
  if (amulet && !amulet.anoint) add('items', 'no_anoint', 'gap', 'amulet without anoint', 'analyze candidates <xml> --kind anoints');
  for (const slot of ARMOUR) {
    const f = facts.get(slot);
    if (f && f.rarity === 'RARE' && !f.eldritch && !f.corrupted) add('items', 'no_eldritch_implicit', 'check', `${slot}: rare without eldritch implicits`, 'craftsim help (eldritch currency)');
  }
  for (const [slot, f] of facts) {
    if (!['Weapon 1', 'Weapon 2', ...ARMOUR].includes(slot) || f.rarity === 'UNIQUE' || f.corrupted) continue;
    if (f.quality < 20) add('items', 'item_quality_below_20', 'check', `${slot}: quality ${f.quality}`, null);
  }
  for (const [slot, f] of facts) {
    if (f.rarity !== 'RARE' || !f.affix_lines_known) continue;
    const open = f.open_prefixes + f.open_suffixes;
    if (open && !f.crafted) add('items', 'open_affix_no_craft', 'gap', `${slot}: ${f.open_prefixes} open prefix / ${f.open_suffixes} open suffix and no bench craft`, 'craft list; item check');
  }
  // --- gems and sockets ---
  const enabled = build.groups.filter(g => g.enabled && !g.source);
  const bySlot = new Map();
  for (const g of enabled) if (g.slot) bySlot.set(g.slot, (bySlot.get(g.slot) ?? 0) + g.gems.filter(x => x.enabled).length);
  for (const [slot, f] of facts) {
    if (!f.sockets) continue;
    const used = bySlot.get(slot) ?? 0;
    if (used < f.sockets) add('gems', 'empty_gem_sockets', 'gap', `${slot}: ${f.sockets - used} of ${f.sockets} socket(s) without a gem`, 'analyze candidates <xml> --kind supports');
  }
  for (const [slot, f] of facts) {
    if (!f.abyss_sockets) continue;
    const jewels = [...facts.keys()].filter(s => s.startsWith(`${slot} Abyssal Socket`)).length;
    if (jewels < f.abyss_sockets) add('items', 'empty_abyss_socket', 'gap', `${slot}: ${f.abyss_sockets - jewels} abyssal socket(s) without an abyss jewel`, 'item pool --slot jewel');
  }
  const info = g => gems.get(g.skill_id);
  const low = enabled.flatMap(g => g.gems.filter(x => x.enabled && info(x) && !info(x).tags?.exceptional && !info(x).tags?.awakened && (x.level < 20 || x.quality < 20)).map(x => `${x.name} ${x.level}/${x.quality}`));
  if (low.length) add('gems', 'gem_below_20_20', 'check', `gems below 20/20: ${low.slice(0, 12).join(', ')}${low.length > 12 ? ` (+${low.length - 12})` : ''}`, null);
  const all = enabled.flatMap(g => g.gems.filter(x => x.enabled).map(info)).filter(Boolean);
  const hasCurse = all.some(g => g.tags?.curse || g.tags?.hex || g.tags?.mark);
  if (!hasCurse) add('mechanics', 'no_curse', 'check', 'no curse or mark gem in enabled groups (item curses on hit not detected)', 'analyze candidates <xml> --kind supports');
  const auras = all.filter(g => g.tags?.aura || g.tags?.herald).length;
  const manaFree = o.ManaUnreserved ?? null, mana = o.Mana ?? null;
  if (manaFree != null && mana && manaFree > Math.max(200, mana * 0.35) && (o.ManaPerSecondCost ?? 0) < manaFree / 5) add('mechanics', 'unreserved_mana', 'check', `${manaFree} of ${mana} mana unreserved (${auras} aura/herald gems): room for another aura, herald or blessing`, 'analyze candidates <xml> --kind supports');
  if (!all.some(g => g.tags?.movement || g.tags?.travel)) add('mechanics', 'no_movement_skill', 'check', 'no movement/travel skill', null);
  if (!all.some(g => g.tags?.guard)) add('mechanics', 'no_guard_skill', 'check', 'no guard skill (Steelskin, Molten Shell, ...)', null);
  // --- configuration layers ---
  if (!config.pantheonMajorGod || config.pantheonMajorGod === 'None') add('config', 'no_major_pantheon', 'gap', 'no major Pantheon god set', 'analyze encounter <xml> --pantheon-major <god>');
  if (!config.pantheonMinorGod || config.pantheonMinorGod === 'None') add('config', 'no_minor_pantheon', 'gap', 'no minor Pantheon god set', 'analyze encounter <xml> --pantheon-minor <god>');
  if (config.bandit && config.bandit !== 'None') add('config', 'bandit_chosen', 'info', `bandit: ${config.bandit} (None gives 2 passive points)`, null);
  const gaps = findings.filter(f => f.severity === 'gap').length, checks = findings.filter(f => f.severity === 'check').length;
  return { schema: 'coverage/1', summary: { gaps, checks, layers: [...new Set(findings.map(f => f.layer))] }, findings,
    used: { passive_points: b.passive_used ?? null, jewel_sockets: jewelSockets, jewels: filled.size, masteries: chosen.size, keystones: nodes.filter(n => n.type === 'keystone').map(n => n.name),
      flasks: flaskCount, automatic_flasks: FLASKS.filter(s => facts.get(s)?.used_when).length, anoint: amulet?.anoint ?? null, eldritch_items: ARMOUR.filter(s => facts.get(s)?.eldritch).length, aura_gems: auras },
    note: 'A gap is unused power to measure, not a proven gain; "check" items may be intentional. Numbers from PoB; run the listed command to value each.' };
}

export function analyzeCoverage({ file, scenario = 'sustained' }) {
  const raw = fs.readFileSync(file);
  const { root } = decodeBuild(raw);
  const specs = asArray(root.Tree?.Spec);
  const spec = specs[Number(root.Tree?.activeSpec ?? 1) - 1] ?? specs[0];
  const sockets = asArray(spec?.Sockets?.Socket).map(s => ({ node: s.nodeId, item: s.itemId }));
  const result = runPob({ input: raw, scenario, full: true });
  let tree = null; try { tree = loadTree(); } catch { tree = null; }
  return { build_file: path.basename(file), scenario, calculation_id: result.calculation_id, ...coverageOf({ build: readBuild(file), sockets, result, tree, gems: pobGems(), config: result.config ?? {} }) };
}
export function coverageCommand(args) {
  const { positional, options } = flags(args, ['scenario', 'out']);
  if (!positional[0]) throw new Error('Use analyze coverage <xml> [--out f.json]');
  const r = analyzeCoverage({ file: path.resolve(positional[0]), scenario: options.scenario ?? 'sustained' });
  if (options.out) atomicJson(path.resolve(options.out), r);
  return r;
}
