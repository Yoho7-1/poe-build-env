import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {dbRoot,projectRoot,atomicJson,hashFile,readJson} from './workspace.mjs';
import {inspectBuild,decodeBuild,runPob} from './pob.mjs';
import {referenceDb,importExample} from './reference-store.mjs';

const catalog=[
  {id:'toxic-rain-pathofevening',title:'Toxic Rain Pathfinder',author:'PathofEvening',file:'research/dependency-cache/toxic-rain.xml',
    source_url:'https://pobb.in/NlUa8ZnB3YGK',guide:'https://www.poe-vault.com/guides/toxic-rain-pathfinder-build-guide',
    mechanics:['hit-dot','stacking','resource-sustain','flask-charge-sustain'],
    lessons:['Отдельно проверять DoT-урон и попадание: низкий hit chance не описывает урон pod DoT.','Число перекрывающихся областей и wither — допущения конкретной цели.','Перенос дерева изменяет Master Surgeon; сравнивать длительность и запас заряда флакона.']},
  {id:'poison-srs-balormage',title:'Poison SRS Necromancer',author:'BalorMage',file:'research/dependency-cache/poison-srs.xml',
    source_url:'https://pobb.in/7_6IS6EVRZfT',guide:'https://www.poe-vault.com/guides/balormage-summon-raging-spirits-necromancer-build-guide',
    mechanics:['minions-totems-traps','minion-count-sustain','ailments','uptime'],
    lessons:['Статы персонажа и миньона имеют разные области; читать minion_output.','Пиковое число духов и poison stacks нужно поддерживать призывом и длительностью.','Animate Guardian и spectres — дополнительные зависимости, не бесплатный постоянный набор баффов.']},
  {id:'tornado-shads-balormage',title:'Tornado Inquisitor',author:'BalorMage / Shads404',file:'research/dependency-cache/tornado.xml',
    source_url:'https://pobb.in/8kdqvrLk_OEi',guide:'https://www.poe-vault.com/guides/tornado-inquisitor-build-guide',
    mechanics:['conversion','stacking','resource-sustain','enemy-config'],selection:{tree_spec:9,item_set:4,skill_set:2,character_level:95,main_socket_group:2},
    lessons:['Проверять реальное число одновременно действующих Tornado и время поддержания.','Конверсию и gain as extra сверять для конкретного варианта навыка.','Наборы leveling и endgame требуют согласованных tree/item/skill sets.']}
];
const evidenceDirectory=path.join(dbRoot,'references/provenance'),evidenceManifest=path.join(evidenceDirectory,'manifest.json');
fs.mkdirSync(evidenceDirectory,{recursive:true});
const priorEvidence=fs.existsSync(evidenceManifest)?readJson(evidenceManifest).sources:[];
const evidence=['research/price-builds.cjs','research/verified-builds.json'].map(original=>{
  const input=path.join(projectRoot,original);
  if(!fs.existsSync(input)) {
    const archived=priorEvidence.find(e=>e.original===original);
    if(!archived||hashFile(path.resolve(dbRoot,archived.file))!==archived.sha256)throw new Error(`Missing reference provenance evidence: ${original}`);
    return archived;
  }
  const sha256=hashFile(input),extension=path.extname(original),stem=path.basename(original,extension);
  const destination=path.join(evidenceDirectory,`${stem}-${sha256.slice(0,16)}${extension}`);
  if(!fs.existsSync(destination))fs.copyFileSync(input,destination,fs.constants.COPYFILE_EXCL);
  if(hashFile(destination)!==sha256)throw new Error(`Changed archived evidence: ${original}`);
  return {original,file:path.relative(dbRoot,destination).replaceAll('\\','/'),sha256,scope:'Existing local research evidence; original retrieval time unknown. Stored as data, never executed.'};
});
atomicJson(evidenceManifest,{sources:evidence});
const db=referenceDb(),uniques=new DatabaseSync(path.join(dbRoot,'data/poe-3.30.sqlite'),{readOnly:true});
const results=[];
function reportPath(id,scenario) {return path.join(dbRoot,'reports/references/calculations',`${id}-${scenario}.json`);}
function storeReport(result,scenario) {
  const file=reportPath(result.calculation_id,scenario);
  if(!fs.existsSync(file))atomicJson(file,result);
  if(readJson(file).calculation_id!==result.calculation_id)throw new Error(`Reference report ID mismatch: ${file}`);
  return path.relative(dbRoot,file).replaceAll('\\','/');
}
// Preserve earlier report sets before replacing the per-guide summary pointers.
for(const row of db.prepare("SELECT id,notes_json FROM examples WHERE kind<>'quarantined'").all()) {
  const notes=JSON.parse(row.notes_json),analysis=notes.analysis;
  if(!analysis?.reports||!analysis.calculations)continue;
  const reports={};
  for(const calculation of analysis.calculations) {
    const scenario=calculation.scenario==='explicit-migration'?'migration':calculation.scenario;
    const stored=reportPath(calculation.id,scenario),cached=path.join(dbRoot,'cache/calculations',`${calculation.id}.json`);
    const candidate=fs.existsSync(stored)?stored:fs.existsSync(cached)?cached:path.resolve(dbRoot,analysis.reports[scenario]);
    const result=readJson(candidate);
    if(result.calculation_id!==calculation.id)throw new Error(`Cannot restore reference report: ${row.id}/${scenario}`);
    reports[scenario]=storeReport(result,scenario);
  }
  notes.analysis.reports=reports;
  db.prepare('UPDATE examples SET notes_json=? WHERE id=?').run(JSON.stringify(notes),row.id);
}
function insertOnce(descriptor) {
  const xml=decodeBuild(fs.readFileSync(descriptor.file)).xml,sha=createHash('sha256').update(xml).digest('hex');
  const existing=db.prepare('SELECT sha256 FROM examples WHERE id=?').get(descriptor.id);
  if(existing) {
    if(existing.sha256!==sha)throw new Error(`Reference changed for existing ID ${descriptor.id}`);
    if(descriptor.analysis||descriptor.provenance) {
      const row=db.prepare('SELECT notes_json FROM examples WHERE id=?').get(descriptor.id),notes=JSON.parse(row.notes_json);
      if(descriptor.analysis) {
        if(notes.analysis&&JSON.stringify(notes.analysis.calculations)!==JSON.stringify(descriptor.analysis.calculations))notes.previous_calculation_sets=[...(notes.previous_calculation_sets??[]),notes.analysis.calculations];
        notes.analysis=descriptor.analysis;
      }
      notes.provenance=descriptor.provenance;
      db.prepare('UPDATE examples SET notes_json=?,audit_json=? WHERE id=?').run(JSON.stringify(notes),JSON.stringify(inspectBuild(xml)),descriptor.id);
    }
    return {id:descriptor.id,already_imported:true};
  }
  return importExample(descriptor,db);
}
try {
  for(const entry of catalog) {
    let archiveFile=path.join(projectRoot,entry.file);
    if(!fs.existsSync(archiveFile)) {
      const directory=path.join(dbRoot,'references/originals');
      const candidates=fs.readdirSync(directory).filter(file=>file.startsWith(`${entry.id}-archive-`)&&file.endsWith('.xml'));
      if(candidates.length!==1)throw new Error(`Select an unambiguous original archive for ${entry.id}`);
      archiveFile=path.join(directory,candidates[0]);
    }
    const inputBytes=fs.readFileSync(archiveFile),input=decodeBuild(inputBytes).xml,audit=inspectBuild(input);
    const inputSha=createHash('sha256').update(input).digest('hex'),byteSha=createHash('sha256').update(inputBytes).digest('hex');
    const originalId=`${entry.id}-archive-${inputSha.slice(0,8)}`;
    const originalFile=path.join(dbRoot,'references/originals',`${originalId}.xml`);
    fs.mkdirSync(path.dirname(originalFile),{recursive:true});
    if(!fs.existsSync(originalFile))fs.writeFileSync(originalFile,inputBytes,{flag:'wx'});
    if(hashFile(originalFile)!==byteSha)throw new Error(`Original archive bytes changed for ${originalId}`);
    const provenance={author:entry.author,author_guide:entry.guide,author_pob:entry.source_url,original_archive_file:entry.file,
      original_bytes_sha256:byteSha,decoded_xml_sha256:inputSha,archive_tree_version:audit.tree_version,
      current_raw_download:'Unavailable from this environment; using the existing local research archive without claiming it is the current author upload.',
      stored_original_file:path.relative(dbRoot,originalFile).replaceAll('\\','/'),source_mapping_evidence:evidence,original_retrieval_timestamp:null,independently_playtested:false};
    for(const row of db.prepare("SELECT id,notes_json FROM examples WHERE kind='reference' AND id LIKE ?").all(`${entry.id}-330-%`)) {
      const notes=JSON.parse(row.notes_json);
      if(notes.analysis?.node_deltas?.length!==audit.tree_specs.length) {
        notes.analysis={...notes.analysis,status:'invalidated_partial_tree_import',invalidated_at:new Date().toISOString(),reason:'The engine previously reported a fatal import error while returning a partial tree list. This record must not be used as a valid reference.'};
        db.prepare("UPDATE examples SET kind='quarantined',notes_json=? WHERE id=?").run(JSON.stringify(notes),row.id);
      }
    }
    insertOnce({id:originalId,title:`${entry.title} — авторский архив ${audit.tree_version}`,kind:'historical',file:originalFile,source_url:entry.source_url,
      lessons:entry.lessons,mechanics:entry.mechanics,provenance});
    try {
      const migration=runPob({input,migrate:true,full:true,changes:entry.selection?{selection:entry.selection}:{}});
      const derivedFile=path.join(dbRoot,'references/migrated',`${entry.id}-${migration.calculation_id.slice(0,16)}.xml`);
      fs.mkdirSync(path.dirname(derivedFile),{recursive:true});
      if(!fs.existsSync(derivedFile))fs.copyFileSync(path.join(dbRoot,'cache/calculations',`${migration.calculation_id}.xml`),derivedFile,fs.constants.COPYFILE_EXCL);
      const migrated=inspectBuild(fs.readFileSync(derivedFile));
      if(migrated.tree_specs.length!==audit.tree_specs.length||migrated.tree_specs.some(t=>t.version!=='3_30'))throw new Error('Not all tree specs were converted');
      const sustained=runPob({input:fs.readFileSync(derivedFile),scenario:'sustained'});
      const stress=runPob({input:fs.readFileSync(derivedFile),scenario:'unbuffed'});
      const prefix=path.join(dbRoot,'reports/references',entry.id);
      atomicJson(`${prefix}-migration.json`,migration);atomicJson(`${prefix}-sustained.json`,sustained);atomicJson(`${prefix}-unbuffed.json`,stress);
      const reports={migration:storeReport(migration,'migration'),sustained:storeReport(sustained,'sustained'),unbuffed:storeReport(stress,'unbuffed')};
      const uniqueChecks=(sustained.equipped_items??[]).filter(i=>i.rarity==='UNIQUE').map(item=>{
        const base=item.name.replace(/^Foulborn /,'');
        const count=uniques.prepare('SELECT COUNT(*) n FROM items WHERE name=?').get(base).n;
        return {slot:item.slot,name:item.name,status:count?'name_present_actual_variant_unverified':'not_found_requires_acquisition_review'};
      });
      const analysis={status:'locally_migrated_reference_requires_review',author_verified_for_330:false,independently_playtested:false,
        health_guards:{fatal_engine_errors_rejected:true,complete_tree_count_checked:true},explicit_selection:entry.selection??null,
        selected_set:sustained.selection,only_selected_setup_calculated:true,
        reports,
        calculations:[{id:migration.calculation_id,scenario:'explicit-migration'},{id:sustained.calculation_id,scenario:'sustained'},{id:stress.calculation_id,scenario:'unbuffed'}],
        node_deltas:migration.migration.trees.map(t=>({index:t.index,title:t.title,removed:t.removed.length,added:t.added.length,changed:t.changed.length})),
        engine_warnings:sustained.engine_warnings,unparsed_modifier_count:sustained.unparsed_item_modifiers.length,unique_checks:uniqueChecks,
        comparison:{sustained:sustained.output,unbuffed:stress.output},
        caveats:['Scenario overrides do not disable all temporary effects.','Tree migration does not verify item variants, acquisition or gameplay.','Original author archive and locally derived XML are separate artifacts.']};
      const sha=createHash('sha256').update(decodeBuild(fs.readFileSync(derivedFile)).xml).digest('hex');
      const derivedId=`${entry.id}-330-${sha.slice(0,8)}`;
      insertOnce({id:derivedId,title:`${entry.title} — локальный перенос ${audit.tree_version} → 3.30`,kind:'reference',file:derivedFile,source_url:entry.source_url,
        provenance:{...provenance,derived_by:'Pinned PoB 2.68.1 TreeTab:ConvertAllToVersion',original_example_id:originalId},analysis,lessons:entry.lessons,mechanics:entry.mechanics});
      db.prepare("UPDATE examples SET kind='reference',title=? WHERE id=?").run(`${entry.title} — локальный перенос ${audit.tree_version} → 3.30`,derivedId);
      for(const row of db.prepare("SELECT id,notes_json FROM examples WHERE kind='reference' AND id LIKE ? AND id<>?").all(`${entry.id}-330-%`,derivedId)) {
        const notes=JSON.parse(row.notes_json);
        notes.analysis={...notes.analysis,status:'superseded_local_migration',superseded_by:derivedId};
        db.prepare("UPDATE examples SET kind='historical',notes_json=? WHERE id=?").run(JSON.stringify(notes),row.id);
      }
      results.push({id:entry.id,original_id:originalId,derived_id:derivedId,status:analysis.status,trees:migration.migration.trees.length,
        node_deltas:analysis.node_deltas,engine_warnings:analysis.engine_warnings,unparsed_modifier_count:analysis.unparsed_modifier_count});
      console.log(`${entry.id}: ${migration.migration.trees.length} tree specs converted; ${analysis.engine_warnings.length} engine warnings; ${analysis.unparsed_modifier_count} unparsed modifier lines.`);
    } catch(error) {results.push({id:entry.id,original_id:originalId,status:'migration_failed',error:error.message});console.log(`${entry.id}: migration failed; archive retained.`);}
  }
} finally {db.close();uniques.close();}
atomicJson(path.join(dbRoot,'reports/references-summary.json'),{at:new Date().toISOString(),game:'poe1',target_patch:'3.30',results,
  scope:'Real author archives plus explicitly generated 3.30 references; not independently played builds or current author upload assertions.'});
