import fs from 'node:fs';
import path from 'node:path';
import { dbRoot,atomicJson } from './workspace.mjs';
import { runPob } from './pob.mjs';
import { referenceDb,importExample,refreshExampleAudits } from './reference-store.mjs';

const input=fs.readFileSync(path.join(dbRoot,'fixtures/fireball-control.xml'),'utf8');
const examples=[
  {id:'fireball-requirements',title:'Положительный DPS при невыполненных требованиях',file:'fireball-control.xml',changes:{},
    lessons:['PoB считает урон при нехватке Intelligence; читать engine_warnings.','Стоимость 20 Mana × 1.333 применения/с превышает 10.2 Mana regen/с; одного запаса Mana недостаточно для устойчивого применения.'],mechanics:['resource-sustain','gem-quality']},
  {id:'fireball-support-mismatch',title:'Несовместимая поддержка не усиливает Fireball',file:'fireball-incompatible-support.xml',changes:{add_support:'Melee Physical Damage'},
    lessons:['Наличие поддержки в socket group не доказывает её применения.','Проверять applied_supports; сравнение с тем же baseline не даёт усиления попадания.'],mechanics:['support-compatibility']},
  {id:'fireball-life-control',title:'Замена предмета меняет Life, но не решает остальные ограничения',file:'fireball-life-control.xml',
    changes:{replace_items:[{slot:'Body Armour',text:'Rarity: RARE\nTest Robe\nSimple Robe\nImplicits: 0\n+100 to maximum Life'}]},
    lessons:['Контрольная замена увеличивает Life на 100.','Синтетический предмет не является проверенным рецептом крафта; остальные предупреждения остаются.'],mechanics:['defense-metrics','availability']}
];
const db=referenceDb();
try {
  for(const e of examples) {
    const filename=path.join(dbRoot,'fixtures',e.file);
    const result=runPob({input,changes:e.changes,saveXml:fs.existsSync(filename)?null:filename});
    atomicJson(path.join(dbRoot,'reports',`example-${e.id}.json`),result);
    if(!db.prepare('SELECT 1 FROM examples WHERE id=?').get(e.id))importExample({...e,file:filename,kind:'synthetic',source_url:'local:poe-db/fixtures/fireball-control.expected.json'},db);
    console.log(`${e.id}: synthetic, ${result.engine.version}, calculation ${result.calculation_id.slice(0,12)}`);
  }
  refreshExampleAudits(db);
} finally {db.close();}
