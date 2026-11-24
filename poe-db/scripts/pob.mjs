import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { dbRoot, readJson, atomicJson, hashFile } from './workspace.mjs';
import { validateEditChanges } from './pob-changes.mjs';

// Windows PowerShell 5.1 and PowerShell 7+ are both supported; pwsh is preferred when present.
let resolvedHost;
export function resolvePowerShellHost({ refresh = false } = {}) {
  if (resolvedHost && !refresh) return resolvedHost;
  const tried = [];
  const pathDirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  const inPath = name => { for (const dir of pathDirs) { const file = path.join(dir, name); if (fs.existsSync(file)) return file; } return null; };
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const candidates = [
    ...(process.env.POE_POWERSHELL ? [{ kind: 'override', file: process.env.POE_POWERSHELL }] : []),
    { kind: 'pwsh', file: inPath('pwsh.exe') },
    { kind: 'pwsh', file: path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe') },
    { kind: 'windows-powershell', file: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') },
    { kind: 'windows-powershell', file: inPath('powershell.exe') }
  ];
  for (const candidate of candidates) {
    if (!candidate.file) continue;
    tried.push(candidate.file);
    if (fs.existsSync(candidate.file)) return (resolvedHost = { kind: candidate.kind, file: candidate.file });
  }
  throw new Error(`No PowerShell host found for the PoB engine. Tried: ${tried.join('; ') || 'pwsh.exe/powershell.exe in PATH'}. Windows PowerShell 5.1 ships with Windows; set POE_POWERSHELL to the full path of powershell.exe or pwsh.exe if it is elsewhere.`);
}
function hostArgs(runtime, script) {
  // -ExecutionPolicy Bypass applies to this child process only; machine/user policy is not changed.
  return ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(dbRoot,'scripts/pob-host.ps1'),'-RuntimeDirectory',runtime,'-ScriptFile',script];
}
export function smokeEngine({ timeout = 30000 } = {}) {
  const host = resolvePowerShellHost();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poe-pob-smoke-'));
  try {
    const script = path.join(directory, 'smoke.lua');
    fs.writeFileSync(script, "local ffi=require('ffi')\nassert(jit and jit.version,'LuaJIT expected')\nio.write('POE_SMOKE_OK '..jit.version..'\\n')\n");
    const child = spawnSync(host.file, hostArgs(path.join(dbRoot,'vendor/pob/runtime'), script), { encoding: 'utf8', timeout, windowsHide: true });
    const match = /POE_SMOKE_OK ([^\r\n]+)/.exec(child.stdout ?? '');
    if (child.error || child.status !== 0 || !match) throw new Error(`PoB host smoke test failed with ${host.file}: ${child.error?.message ?? ''} ${(child.stderr ?? '').trim()} ${(child.stdout ?? '').trim()}`.slice(0, 2000));
    return { host: host.kind, host_file: host.file, lua: match[1].trim() };
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('poe-pob-smoke-')) throw new Error('Invalid smoke directory');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const asArray = x => x == null ? [] : Array.isArray(x) ? x : [x];
let verifiedEngineStamp;
export function verifyEngine() {
  const manifest=readJson(path.join(dbRoot,'vendor/pob-source.json'));
  const lock=readJson(path.join(dbRoot,'environment.lock.json'));
  if(manifest.commit!==lock.versions.pob_commit)throw new Error('PoB source manifest does not match environment lock');
  const stamp=manifest.files.map(entry=>{const s=fs.statSync(path.join(dbRoot,'vendor/pob',entry.file));return `${entry.file}:${s.size}:${s.mtimeMs}:${entry.sha256}`;}).join('\n');
  if(stamp!==verifiedEngineStamp) {
    for(const entry of manifest.files)if(hashFile(path.join(dbRoot,'vendor/pob',entry.file))!==entry.sha256)throw new Error(`Modified pinned PoB file: ${entry.file}; restore with setup-pob.mjs`);
    verifiedEngineStamp=stamp;
  }
  return {source_fingerprint:createHash('sha256').update(JSON.stringify(manifest.files.map(f=>[f.file,f.sha256]))).digest('hex'),timeless_types:manifest.timeless_types??[]};
}
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', textNodeName: 'text', parseTagValue: false, parseAttributeValue: false, trimValues: true });
export function decodeBuild(input) {
  let text = Buffer.isBuffer(input) ? input.toString('utf8') : input;
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('PoB input exceeds 16 MiB');
  text = text.trim();
  if (!text.startsWith('<')) {
    if (!/^[a-zA-Z\d_+\/=\s-]+$/.test(text)) throw new Error('Expected local XML or a compressed PoB code; URLs are not downloaded implicitly');
    text = inflateSync(Buffer.from(text.replaceAll('-','+').replaceAll('_','/'), 'base64'), { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8');
  }
  text=text.trim();
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('DTD/entity declarations are not accepted');
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw new Error(`Invalid PoB XML: ${valid.err.msg}`);
  const root = parser.parse(text).PathOfBuilding;
  if (!root || !root.Build) throw new Error('Missing PathOfBuilding/Build');
  return { xml: text, root };
}
export function inspectBuild(input) {
  const { root } = decodeBuild(input);
  const specs = asArray(root.Tree?.Spec);
  const skillSets=asArray(root.Skills?.SkillSet);
  const activeSkillSet=skillSets.find(set=>String(set.id)===String(root.Skills?.activeSkillSet))??skillSets[0];
  const skills = asArray(activeSkillSet?.Skill ?? root.Skills?.Skill).map((skill, index) => ({ index: index + 1, label: skill.label, slot: skill.slot, enabled: skill.enabled,
    gems: asArray(skill.Gem).map(g => ({ id: g.gemId ?? g.skillId, name: g.nameSpec, level: Number(g.level), quality: Number(g.quality), enabled: g.enabled, skill_id: g.skillId })) }));
  const sets = asArray(root.Config?.ConfigSet);
  const configSet = sets.find(set => String(set.id) === String(root.Config?.activeConfigSet)) ?? sets[0];
  const config = Object.fromEntries(asArray(configSet?.Input ?? root.Config?.Input).map(i => [i.name, i.boolean === undefined ? i.number === undefined ? i.string : Number(i.number) : i.boolean === 'true']));
  const saved = Object.fromEntries(asArray(root.Build.PlayerStat).map(s => [s.stat, Number(s.value)]));
  const treeVersion = specs.find(s => String(s.id) === String(root.Tree?.activeSpec))?.treeVersion ?? specs[Number(root.Tree?.activeSpec ?? 1) - 1]?.treeVersion ?? specs[0]?.treeVersion ?? null;
  const warnings = [];
  if (treeVersion!=='3_30') warnings.push({ code: 'wrong_or_unknown_tree', detail: `Tree ${treeVersion}; target is standard 3_30. Do not present as a validated standard 3.30 build.` });
  if (config.customMods) warnings.push({ code: 'custom_modifiers', detail: 'Custom modifiers require explicit justification; they may represent unsupported effects or synthetic bonuses.' });
  if (Object.entries(config).some(([key,value]) => /killed|onKill|recently/i.test(key) && !!value)) warnings.push({ code: 'conditional_config', detail: 'Recent/on-kill conditions are configured; inspect boss uptime.' });
  if (Object.entries(config).some(([key,value]) => /shock|wither|scorch|brittle|sap/i.test(key) && !!value)) warnings.push({ code: 'ailment_or_stack_assumptions', detail: 'Configured ailments/stacks need magnitude, application and uptime evidence.' });
  return { game: 'poe1', target_patch: '3.30', name: root.Build.className, class: root.Build.className, ascendancy: root.Build.ascendClassName,
    level: Number(root.Build.level), tree_version: treeVersion, main_socket_group: Number(root.Build.mainSocketGroup ?? 1),
    skills, config, config_placeholders_are_not_explicit_inputs:true,
    skill_sets:skillSets.map(set=>({id:set.id,title:set.title,groups:asArray(set.Skill).length})),
    active_item_set:root.Items?.activeItemSet,
    items: asArray(root.Items?.Item).length, tree_specs: specs.map(s => ({ title: s.title, version: s.treeVersion, nodes: s.nodes ? s.nodes.split(',').length : 0 })),
    saved_stats: saved, saved_stats_are_recomputed: false, warnings };
}

export const scenarios = {
  imported: { label: 'Imported configuration, unchanged', config: {}, note: 'No uptime or enemy assumptions are corrected automatically.' },
  sustained: { label: 'Sustained boss audit', config: { conditionKilledRecently: false, multiplierKilledRecently: 0, buffOnslaught: false },
    note: 'Only the listed toggles are overridden. Flasks, charges, ailments and skill counts still require individual evidence.' },
  burst: { label: 'Imported peak configuration', config: {}, note: 'Peak configuration is inherited, not proof that its effects can overlap.' },
  unbuffed: { label: 'Reduced temporary buffs audit', config: { conditionKilledRecently: false, multiplierKilledRecently: 0, buffOnslaught: false, usePowerCharges: false, useFrenzyCharges: false, useEnduranceCharges: false },
    note: 'A partial stress scenario, not a guarantee that all temporary buffs are removed.' }
};
const selectedStats = ['FullDPS','CombinedDPS','CombinedAvg','TotalDPS','TotalDot','TotalDotDPS','IgniteDPS','TotalIgniteDPS','PoisonDPS','TotalPoisonDPS','BleedDPS','DecayDPS','AverageDamage','Speed','HitChance','CritChance','Life','LifeUnreserved','EnergyShield','Mana','ManaUnreserved',
  'ManaCost','ManaPerSecondCost','ManaRegen','ManaRegenRecovery','ManaLeechGainRate','LifeRegen','LifeRegenRecovery','LifeLeechGainRate','Armour','Evasion','EffectiveMovementSpeedMod','FireResist','ColdResist','LightningResist','ChaosResist',
  'BlockChance','SpellBlockChance','SpellSuppressionChance','PhysicalMaximumHitTaken','FireMaximumHitTaken','ColdMaximumHitTaken','LightningMaximumHitTaken','ChaosMaximumHitTaken','TotalEHP'];

// variants / node_power: PoB comparison calculations (misc calculator) in one process; see pob-worker.lua.
const nodeRefOk = r => r && typeof r === 'object' && Number.isInteger(r.node) && r.node > 0 && Object.keys(r).every(k => ['node','with_dependents'].includes(k)) && (r.with_dependents == null || typeof r.with_dependents === 'boolean');
export function validateVariants(changes) {
  if (changes.variants != null) {
    if (!Array.isArray(changes.variants) || !changes.variants.length || changes.variants.length > 500) throw new Error('variants must list 1-500 entries');
    const ids = new Set();
    for (const v of changes.variants) {
      if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !/^[\w:+.-]{1,120}$/.test(v.id)) throw new Error('variant needs id (1-120 of letters, digits, _:+.-)');
      if (ids.has(v.id)) throw new Error(`Duplicate variant id ${v.id}`); ids.add(v.id);
      for (const k of Object.keys(v)) if (!['id','remove_nodes','add_nodes'].includes(k)) throw new Error(`Unsupported variant field: ${k}`);
      if (v.remove_nodes != null && (!Array.isArray(v.remove_nodes) || !v.remove_nodes.every(nodeRefOk))) throw new Error(`variant ${v.id}: remove_nodes entries need node and optional with_dependents`);
      if (v.add_nodes != null && (!Array.isArray(v.add_nodes) || !v.add_nodes.every(n => Number.isInteger(n) && n > 0))) throw new Error(`variant ${v.id}: add_nodes must be node ids`);
      if (!v.remove_nodes?.length && !v.add_nodes?.length) throw new Error(`variant ${v.id} changes nothing`);
    }
  }
  if (changes.node_power != null) {
    const p = changes.node_power;
    if (!p || typeof p !== 'object' || !Number.isInteger(p.max_dist) || p.max_dist < 1 || p.max_dist > 12) throw new Error('node_power.max_dist must be 1-12');
    for (const k of Object.keys(p)) if (!['max_dist','types','shard'].includes(k)) throw new Error(`Unsupported node_power field: ${k}`);
    if (p.types != null && (!Array.isArray(p.types) || !p.types.every(t => ['Notable','Keystone','Normal'].includes(t)))) throw new Error('node_power.types: Notable|Keystone|Normal');
    if (p.shard != null && !(Number.isInteger(p.shard.count) && p.shard.count >= 1 && Number.isInteger(p.shard.index) && p.shard.index >= 0 && p.shard.index < p.shard.count)) throw new Error('node_power.shard needs index < count');
  }
  if ((changes.variants || changes.node_power) && (!Array.isArray(changes.variant_keys) || !changes.variant_keys.length || changes.variant_keys.some(k => typeof k !== 'string' || !/^[A-Za-z][\w:]*$/.test(k)))) throw new Error('variant_keys must list the output keys to return');
  if (changes.variant_keys != null && !changes.variants && !changes.node_power) throw new Error('variant_keys only with variants or node_power');
}

export function runPob({ input = null, scenario = 'imported', changes = {}, saveXml = null, full = false, timeout = 120000, migrate = false, newBuild = null, noCache = false } = {}) {
  if (process.platform !== 'win32') throw new Error('This pinned runtime adapter currently supports Windows x64 only');
  if (!scenarios[scenario]) throw new Error(`Unknown scenario: ${scenario}`);
  const allowed = ['config','custom_mods','enemy_mods','add_support','replace_items','gem_levels','selection','sets','tree','jewels','skills','remove_nodes','variants','node_power','variant_keys'];
  if(!changes||typeof changes!=='object'||Array.isArray(changes))throw new Error('Changes must be a JSON object');
  for (const key of Object.keys(changes)) if (!allowed.includes(key)) throw new Error(`Unsupported change: ${key}`);
  if(changes.selection!=null) {
    if(typeof changes.selection!=='object'||Array.isArray(changes.selection))throw new Error('selection must be an object');
    for(const [key,value]of Object.entries(changes.selection))if(!['tree_spec','item_set','skill_set','character_level','main_socket_group'].includes(key)||!Number.isInteger(value)||value<1||key==='character_level'&&value>100)throw new Error(`Invalid selection.${key}`);
  }
  for(const key of ['custom_mods','add_support'])if(changes[key]!=null&&typeof changes[key]!=='string')throw new Error(`${key} must be a string`);
  if(changes.config!=null&&(typeof changes.config!=='object'||Array.isArray(changes.config)))throw new Error('config must be an object');
  for(const [key,value]of Object.entries(changes.config??{}))if(!['number','boolean','string'].includes(typeof value)||(typeof value==='number'&&!Number.isFinite(value)))throw new Error(`Invalid configuration value: ${key}`);
  if(changes.enemy_mods!=null){
    if(!Array.isArray(changes.enemy_mods))throw new Error('enemy_mods must be an array');
    for(const m of changes.enemy_mods){
      if(!m||typeof m!=='object'||!/^[A-Za-z][A-Za-z0-9:]*$/.test(m.name??'')||!['BASE','INC','MORE','FLAG','OVERRIDE'].includes(m.type))throw new Error('enemy_mods entry needs name (PoB mod name) and type BASE|INC|MORE|FLAG|OVERRIDE');
      if(m.type==='FLAG'?m.value!==true:!(typeof m.value==='number'&&Number.isFinite(m.value)))throw new Error(`Invalid enemy_mods value for ${m.name}`);
      if(m.condition!=null&&!/^[A-Za-z]+$/.test(m.condition))throw new Error('enemy_mods condition must be a PoB condition name');
      if(m.source!=null&&(typeof m.source!=='string'||m.source.length>120))throw new Error('enemy_mods source must be a short string');
      for(const k of Object.keys(m))if(!['name','type','value','condition','source'].includes(k))throw new Error(`Unsupported enemy_mods field: ${k}`);
    }
  }
  for(const key of ['gem_levels','replace_items'])if(changes[key]!=null&&!Array.isArray(changes[key]))throw new Error(`${key} must be an array`);
  for(const g of changes.gem_levels??[])if(!Number.isInteger(g.group)||g.group<1||!Number.isInteger(g.gem)||g.gem<1||g.level!=null&&(!Number.isInteger(g.level)||g.level<1||g.level>40)||g.quality!=null&&(!Number.isInteger(g.quality)||g.quality<0||g.quality>1000))throw new Error('Invalid gem level/quality change');
  for(const item of changes.replace_items??[])if(typeof item.slot!=='string'||typeof item.text!=='string'||!item.text.trim())throw new Error('Item change requires slot and item text');
  if(changes.remove_nodes!=null){
    // PoB node comparison (misc calculator removeNodes): stats of allocated nodes left out, tree unchanged.
    if(!Array.isArray(changes.remove_nodes)||!changes.remove_nodes.length||changes.remove_nodes.length>100)throw new Error('remove_nodes must list 1-100 entries');
    for(const r of changes.remove_nodes){
      if(!r||typeof r!=='object'||!Number.isInteger(r.node)||r.node<1)throw new Error('remove_nodes entry needs node (allocated node id)');
      if(r.with_dependents!=null&&typeof r.with_dependents!=='boolean')throw new Error('remove_nodes.with_dependents must be boolean');
      for(const k of Object.keys(r))if(!['node','with_dependents'].includes(k))throw new Error(`Unsupported remove_nodes field: ${k}`);
    }
    if(changes.tree||changes.jewels||changes.sets)throw new Error('remove_nodes is a calculation override; do not combine it with tree/jewels/sets edits');
  }
  validateVariants(changes);
  validateEditChanges(changes);
  if (newBuild && input != null) throw new Error('newBuild cannot be combined with an input build');
  const xml = input == null ? null : decodeBuild(input).xml;
  const audit = xml ? inspectBuild(xml) : null;
  if(migrate&&(!audit||!['3_28','3_29','3_30'].includes(audit.tree_version)||audit.tree_specs.some(s=>!['3_28','3_29','3_30'].includes(s.version))))throw new Error('Explicit migration supports standard 3_28/3_29/3_30 trees only');
  if (!migrate&&audit&&audit.tree_version!=='3_30') throw new Error('Calculation requires the standard 3_30 tree; archive older/Ruthless/unknown builds separately');
  const lock = readJson(path.join(dbRoot, 'environment.lock.json'));
  const installed=verifyEngine();
  const contract=createHash('sha256').update(JSON.stringify({source:installed.source_fingerprint,
    worker:hashFile(path.join(dbRoot,'scripts/pob-worker.lua')),host:hashFile(path.join(dbRoot,'scripts/pob-host.ps1')),
    adapter:hashFile(path.join(dbRoot,'scripts/pob.mjs')),runtime:hashFile(path.join(dbRoot,'scripts/pob-runtime.lua')),edit:hashFile(path.join(dbRoot,'scripts/pob-edit.lua')),
    changes:hashFile(path.join(dbRoot,'scripts/pob-changes.mjs'))})).digest('hex');
  const cacheId = createHash('sha256').update(JSON.stringify({ input:xml, newBuild, scenario, definition:scenarios[scenario], changes, migrate,contract })).digest('hex');
  const cache = path.join(dbRoot,'cache/calculations',cacheId);
  const present = !noCache && fs.existsSync(`${cache}.json`) && fs.existsSync(`${cache}.xml`);
  function display(cached, wasCached) {
    const answer = structuredClone(cached);
    if (!full) answer.output = Object.fromEntries(selectedStats.filter(key => answer.output[key] !== undefined).map(key => [key,answer.output[key]]));
    if(!full&&answer.minion_output)answer.minion_output=Object.fromEntries(selectedStats.filter(key=>answer.minion_output[key]!==undefined).map(key=>[key,answer.minion_output[key]]));
    if(!full&&answer.migration)answer.migration={...answer.migration,detail:'Full node deltas are available with --full and in the cached result.',trees:answer.migration.trees.map(t=>({index:t.index,title:t.title,before_version:t.before_version,after_version:t.after_version,removed_nodes:t.removed.length,added_nodes:t.added.length,changed_nodes:t.changed.length}))};
    answer.cache_hit = wasCached;
    if (saveXml) {
      fs.mkdirSync(path.dirname(path.resolve(saveXml)),{recursive:true});
      try { fs.copyFileSync(`${cache}.xml`,path.resolve(saveXml),fs.constants.COPYFILE_EXCL); }
      catch (error) { if (error.code === 'EEXIST') throw new Error(`--save-xml target already exists; choose a new file: ${path.resolve(saveXml)}`); throw error; }
      answer.saved_xml = path.resolve(saveXml);
    }
    return answer;
  }
  if(present) return display(readJson(`${cache}.json`),true);
  const directory = path.join(dbRoot, 'vendor/pob/src');
  const jobName = `.agent-${randomUUID()}`, job = path.join(directory, jobName);
  fs.mkdirSync(job);
  let answer;
  try {
    const config = { ...scenarios[scenario].config, ...changes.config };
    const request = { ...changes, config,new_build:newBuild??undefined,runtime_helpers:`${jobName}/runtime.lua`,edit_helpers:`${jobName}/edit.lua`,expected_tree_specs:audit?.tree_specs.length,migrate_to:migrate?'3_30':undefined,xml: xml ? `${jobName}/input.xml` : undefined, result: `${jobName}/result.json`, save_xml: `${jobName}/result.xml` };
    atomicJson(path.join(job, 'request.json'), request);
    if (xml) fs.writeFileSync(path.join(job, 'input.xml'), xml);
    const worker = fs.readFileSync(path.join(dbRoot, 'scripts/pob-worker.lua'), 'utf8');
    fs.writeFileSync(path.join(job, 'launch.lua'), `AGENT_REQUEST = '${jobName}/request.json'\n${worker}`);
    fs.copyFileSync(path.join(dbRoot,'scripts/pob-runtime.lua'),path.join(job,'runtime.lua'));
    fs.copyFileSync(path.join(dbRoot,'scripts/pob-edit.lua'),path.join(job,'edit.lua'));
    const host = resolvePowerShellHost();
    const child = spawnSync(host.file, hostArgs(path.join(dbRoot,'vendor/pob/runtime'),path.join(job,'launch.lua')),
      { cwd: directory, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, CI: 'true' } });
    if (child.error || child.status !== 0 || !fs.existsSync(path.join(job,'result.json'))) {
      const combined = `${child.stderr ?? ''}\n${child.stdout ?? ''}`;
      const changeError = /Change error: [^\r\n]*/.exec(combined);
      if (changeError) throw new Error(changeError[0]);
      const reason = child.error?.code === 'ETIMEDOUT' ? `timeout after ${timeout} ms` : child.error?.message ?? `exit code ${child.status}`;
      throw new Error(`PoB execution failed (host ${host.file}): ${reason}\n${child.stderr ?? ''}\n${(child.stdout ?? '').split(/\r?\n/).slice(-30).join('\n')}`.slice(0,10000));
    }
    const result = readJson(path.join(job,'result.json'));
    const outputXml = fs.readFileSync(path.join(job,'result.xml'),'utf8');
    const output = result.output;
    answer = { game: 'poe1', patch: '3.30', engine: { name: 'Path of Building Community', version: lock.versions.pob, commit: lock.versions.pob_commit,...installed },calculation_contract_sha256:contract,
      input_sha256: createHash('sha256').update(xml ?? (newBuild ? `new-build:${JSON.stringify(newBuild)}` : 'synthetic-fireball-control-v1')).digest('hex'),
      new_build: newBuild ?? undefined,
      adapter_sha256: hashFile(path.join(dbRoot,'scripts/pob-worker.lua')), scenario, scenario_definition: scenarios[scenario], changes,
      calculation_id: cacheId, computed_at: new Date().toISOString(), output, config: result.config, groups: result.groups, level: result.level,
      unparsed_item_modifiers: result.unparsed_item_modifiers, unparsed_custom_mods: result.unparsed_custom_mods,
      tree_version:result.tree_version,migration:result.migration,minion_output:result.minion_output,
      selection:result.selection,
      equipped_items:result.equipped_items,
      applied_supports: result.applied_supports, explode_mods: result.explode_mods, skill_disabled_reason:result.skill_disabled_reason, removed_nodes: result.removed_nodes, variants: result.variants, main_skill: result.main_skill,
      conversion: result.conversion, active_skills: result.active_skills, card_export_error: result.card_export_error,
      allocated_points:result.allocated_points,budget:result.budget,engine_warnings:result.engine_warnings,
      class:result.class,ascendancy:result.ascendancy,edit_report:result.edit_report,
      tree_specs:result.tree_specs,item_sets:result.item_sets,skill_sets:result.skill_sets,
      interpretation:'CombinedDPS describes the selected main skill; for average-damage skills (e.g. Essence Drain) PoB leaves TotalDotDPS out of it, analyze uses hit + TotalDotDPS then. FullDPS requires configured skill groups and can be zero when not selected. Bloodline points are a subset of ascendancy_total. Costs and recovery require matching resource and scenario.',
      warnings: [...(audit?.warnings ?? []),...(migrate?[{code:'migration_requires_review',detail:'Explicit tree migration is not proof of acquisition, item/gem legality or gameplay. Inspect all node deltas and original provenance.'}]:[]), { code: 'conditional_calculation', detail: 'Engine estimate; validate configuration, unsupported mods and actual gameplay.' }],
      synthetic_control: !xml && !newBuild };
    fs.mkdirSync(path.dirname(cache),{recursive:true});
    const xmlTemp=`${cache}.${randomUUID()}.tmp`;
    fs.writeFileSync(xmlTemp,outputXml);
    fs.renameSync(xmlTemp,`${cache}.xml`);
    atomicJson(`${cache}.json`,answer);
  } finally {
    // This function only deletes the UUID job directory it created under the pinned source directory.
    if (path.dirname(job) !== directory || !path.basename(job).startsWith('.agent-')) throw new Error('Invalid temporary job directory');
    fs.rmSync(job, { recursive: true, force: true });
  }
  return display(answer,false);
}

export function compareResults(before, after) {
  if (before.engine.commit !== after.engine.commit || before.input_sha256 !== after.input_sha256 || before.scenario !== after.scenario) throw new Error('Comparison requires the same engine, baseline XML and scenario');
  if(!before.calculation_contract_sha256||before.calculation_contract_sha256!==after.calculation_contract_sha256)throw new Error('Calculation adapter/data contract differs or is unknown; recompute both results');
  const flatten=result=>({...result.output,...Object.fromEntries(Object.entries(result.minion_output??{}).map(([key,value])=>[`minion.${key}`,value]))});
  const a=flatten(before),b=flatten(after);
  const keys = [...new Set([...Object.keys(a),...Object.keys(b)])];
  return { game:'poe1',patch:'3.30',scenario:before.scenario,engine:before.engine,changes:after.changes,
    differences: keys.filter(key => a[key] !== b[key]).map(key => ({ stat:key,before:a[key] ?? null,after:b[key] ?? null,
      delta: typeof a[key] === 'number' && typeof b[key] === 'number' ? b[key]-a[key] : null,
      percent: a[key]&&b[key]!==undefined ? (b[key]/a[key]-1)*100 : null })),
    warnings: after.warnings };
}

// A fresh, valid 3_30 build created through PoB's own newBuild + class/ascendancy selection.
export function newPob({ className, ascendancy = null, bloodline = null, level = 1, changes = {}, saveXml = null, full = false, scenario = 'imported' } = {}) {
  if (typeof className !== 'string' || !/^[A-Za-z]+$/.test(className)) throw new Error('--class is required (e.g. Witch)');
  if (!Number.isInteger(level) || level < 1 || level > 100) throw new Error('--level must be 1-100');
  if (changes?.tree?.class != null) throw new Error('Use --class instead of tree.class for a new build');
  const tree = { ...(changes.tree ?? {}), class: className };
  if (ascendancy != null) { if (changes?.tree?.ascendancy != null) throw new Error('Ascendancy given twice'); tree.ascendancy = ascendancy; }
  if (bloodline != null) { if (changes?.tree?.bloodline != null) throw new Error('Bloodline given twice'); tree.bloodline = bloodline; }
  const merged = { ...changes, tree, selection: { ...(changes.selection ?? {}), character_level: level } };
  return runPob({ input: null, newBuild: { class: className, ascendancy, bloodline, level, tree_version: '3_30' }, changes: merged, saveXml, full, scenario });
}

// PoB share codes: base64 (+ -> -, / -> _) of zlib-deflated SaveDB XML, as in ImportTab "Generate".
export function encodeShareCode(xml) {
  return deflateSync(Buffer.from(xml, 'utf8'), { level: 9 }).toString('base64').replaceAll('+','-').replaceAll('/','_');
}
const roundTripStats = (a, b) => {
  const keys = [...new Set([...Object.keys(a.output), ...Object.keys(b.output)])].sort();
  const mismatches = keys.filter(key => {
    const x = a.output[key], y = b.output[key];
    return !(x === y || (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x))));
  }).map(key => ({ stat: key, before: a.output[key] ?? null, after: b.output[key] ?? null }));
  return { compared_stats: keys.length, mismatches };
};
export function exportCode(input, { raw = false, scenario = 'imported' } = {}) {
  const { xml } = decodeBuild(input);
  let encoded = xml, normalized = false, engine;
  if (!raw) {
    // Encode PoB's own SaveDB output (what the GUI exports), then verify it recomputes identically.
    const base = runPob({ input: xml, scenario, full: true });
    encoded = fs.readFileSync(path.join(dbRoot, 'cache/calculations', `${base.calculation_id}.xml`), 'utf8');
    normalized = encoded !== xml;
    const code = encodeShareCode(encoded);
    const reimported = runPob({ input: decodeBuild(code).xml, scenario, full: true });
    engine = { scenario, base_calculation_id: base.calculation_id, reimported_calculation_id: reimported.calculation_id, ...roundTripStats(base, reimported) };
  }
  const code = encodeShareCode(encoded);
  const bytesEqual = decodeBuild(code).xml === encoded.trim();
  const ok = bytesEqual && (!engine || engine.mismatches.length === 0);
  if (!ok) throw new Error(`Share code round-trip failed: ${JSON.stringify({ bytes_equal: bytesEqual, mismatches: engine?.mismatches.slice(0, 10) })}`);
  return { game: 'poe1', patch: '3.30', code, code_length: code.length, xml_sha256: createHash('sha256').update(encoded).digest('hex'),
    source_xml_sha256: createHash('sha256').update(xml).digest('hex'), normalized_by_pob: normalized,
    round_trip: { ok, bytes_equal: bytesEqual, engine: engine ?? 'skipped (--raw)' },
    note: 'Local code only; nothing is uploaded. Paste into PoB Import/Export Build -> Import from code.' };
}
export function importCode(input, { saveXml, scenario = 'imported', full = false } = {}) {
  if (!saveXml) throw new Error('import-code requires --save-xml <new-file.xml>');
  const text = (Buffer.isBuffer(input) ? input.toString('utf8') : String(input)).trim();
  if (text.startsWith('<')) throw new Error('Input is already XML; use pob run/inspect');
  const { xml } = decodeBuild(text);
  const imported = runPob({ input: xml, scenario, full: true, saveXml });
  const saved = fs.readFileSync(path.resolve(saveXml), 'utf8');
  const recomputed = runPob({ input: saved, scenario, full: true });
  const check = roundTripStats(imported, recomputed);
  if (check.mismatches.length) throw new Error(`Imported build does not recompute identically after PoB re-save: ${JSON.stringify(check.mismatches.slice(0, 10))}`);
  const answer = runPob({ input: xml, scenario, full });
  return { ...answer, saved_xml: path.resolve(saveXml), import: { decoded_xml_sha256: createHash('sha256').update(xml).digest('hex'),
    saved_xml_sha256: createHash('sha256').update(saved).digest('hex'), round_trip: { ok: true, ...check } } };
}
