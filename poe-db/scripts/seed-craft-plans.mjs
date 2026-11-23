import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {dbRoot,atomicJson} from './workspace.mjs';
import {referenceDb,importCraftPlan,priceQuery} from './reference-store.mjs';

const data=new DatabaseSync(path.join(dbRoot,'data/knowledge-3.30.sqlite'),{readOnly:true}),db=referenceDb();
const recipes=data.prepare("SELECT id,name,payload_json FROM records WHERE category='bench_crafts'").all().map(row=>({...row,data:JSON.parse(row.payload_json)}));
const targets=[['life',/^\+\(\d+-\d+\) to maximum Life$/],['fire-resistance',/^\+\(\d+-\d+\)% to Fire Resistance$/],
  ['cold-resistance',/^\+\(\d+-\d+\)% to Cold Resistance$/],['lightning-resistance',/^\+\(\d+-\d+\)% to Lightning Resistance$/],
  ['strength',/^\+\(\d+-\d+\) to Strength$/],['dexterity',/^\+\(\d+-\d+\) to Dexterity$/],['intelligence',/^\+\(\d+-\d+\) to Intelligence$/],
  ['movement-speed',/^\(\d+-\d+\)% increased Movement Speed$/]];
const results=[];
try {
  for(const [label,pattern]of targets) {
    const craft=recipes.filter(r=>pattern.test(r.name)).sort((a,b)=>a.data.bench_tier-b.data.bench_tier||Number(a.id)-Number(b.id))[0];
    if(!craft)throw new Error(`No source recipe for ${label}`);
    const baseName=craft.data.item_classes.includes('Amulet')?'Amber Amulet':craft.data.item_classes.includes('Boots')?'Rawhide Boots':null;
    if(!baseName)throw new Error(`A reviewed base class must be selected for ${label}`);
    const base=data.prepare("SELECT id,payload_json FROM records WHERE category='base_items' AND name=?").get(baseName);
    if(!base)throw new Error('Missing source base');
    const modId=craft.data.actions.add_explicit_mod;
    const mod=JSON.parse(data.prepare("SELECT payload_json FROM records WHERE category='mods' AND id=?").get(modId).payload_json);
    const source=data.prepare('SELECT s.url,s.sha256,s.source_version FROM records r JOIN sources s ON s.id=r.source_id WHERE r.category=? AND r.id=?').get('bench_crafts',craft.id);
    const costs=Object.entries(craft.data.cost).map(([currency,amount])=>{
      const row=data.prepare("SELECT name FROM records WHERE category='base_items' AND id=?").get(currency);
      const quote=row?priceQuery('get',row.name,db,{platform:'pc',limit:1}).results[0]:null;
      return {currency_id:currency,name:row?.name??currency,amount,unit_estimate_chaos:quote?.chaos??null,price_snapshot_id:quote?.snapshot_id??null,price_observed_at:quote?.observed_at??null};
    });
    const plan={id:`bench-${label}-330`,title:`Верстак: ${craft.name}`,game:'poe1',patch:'3.30',base_id:base.id,item_level:86,
      bench_craft_id:craft.id,target_mod_ids:[modId],tool_version:'RePoE 3.30.0.4 recipe definition',observed_at:new Date().toISOString(),source_url:source.url,
      preconditions:[`Предмет нужного класса: ${baseName}; реальный экземпляр проверяется отдельно.`,`Свободный ${mod.generation_type}; группа ${mod.groups.join(', ')} не конфликтует с существующими модами.`,
        'Редкий изменяемый предмет, не corrupted/mirrored; соответствующий рецепт открыт и доступен.','Лимит crafted modifiers допускает добавление; метамоды/особые ограничения проверены отдельно.'],
      steps:[{action:'bench_add_explicit_mod',recipe_id:craft.id,mod_id:modId,result_source_text:craft.name,cost:craft.data.cost}],
      source_evidence:{recipe_id:craft.id,source_version:source.source_version,sha256:source.sha256,mod_generation_type:mod.generation_type,mod_required_level:mod.required_level,mod_groups:mod.groups},
      costs,estimated_one_application_chaos:costs.every(c=>c.unit_estimate_chaos!==null)?costs.reduce((n,c)=>n+c.amount*c.unit_estimate_chaos,0):null,
      caveats:['Это условный рецепт одного применения, не проверка конкретного предмета.','Диапазон roll сохранён; стоимость получения максимального roll не рассчитана.','Рыночная стоимость валюты и расход NPC — разные величины; цена датирована.']};
    atomicJson(path.join(dbRoot,'references/crafting',`${plan.id}.json`),plan);
    const existing=db.prepare('SELECT payload_json FROM craft_plans WHERE id=?').get(plan.id);
    if(!existing)importCraftPlan(plan,db);
    results.push({id:plan.id,recipe_id:craft.id,mod_id:modId,base:baseName,costs:plan.costs,estimated_one_application_chaos:plan.estimated_one_application_chaos});
  }
} finally {data.close();db.close();}
atomicJson(path.join(dbRoot,'reports/craft-plans-summary.json'),{at:new Date().toISOString(),game:'poe1',patch:'3.30',plans:results,scope:'Eight conditional bench recipes; source action and item-class checked, no full crafting simulator or actual-item eligibility proof.'});
console.log(JSON.stringify({conditional_recipes:results.length}));
