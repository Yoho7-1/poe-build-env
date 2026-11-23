# Craft Lab v2: симулятор крафта PoE 1 / 3.30

Локальный движок, на котором нейросеть проверяет крафты. Он работает без сети, без сервера и без новых зависимостей. Модель задаёт стартовый предмет, применяет действия как в игре и получает предмет с тирами модов, список легальных действий, расход ресурсов и проверку цели. Каждый шаг перечисляет id правил из `rules.mjs`, на которых он основан. В `observe.approximations_used` попадают правила, которые не являются данными или официальными заметками: подогнанные формулы, код CoE, допущения модели.

**Статус:** experimental, `complete:false`, `game_validated:false`. Что реализовано и что намеренно отвергается, показывает команда `coverage`. Источники и изменения 3.30 описаны в [SOURCES-3.30.md](SOURCES-3.30.md). Версии v0 и v1 рядом сохранены без изменений, их сессии в v2 не переносятся.

## Быстрый старт (из корня проекта)

```powershell
$c = "poe-db/experiments/craft-lab/v2/cli.mjs"
node $c status
node $c coverage
node $c tiers --base "Vaal Regalia" --ilvl 86 --match Life          # тиры, уровни, веса
node $c pool --base "Leather Belt" --ilvl 86 --rarity magic --match '"side":"prefix"'   # пул и шансы следующего добавления
node $c new --file poe-db/experiments/craft-lab/v2/examples/body-life-es.json --save my-0
node $c step --file poe-db/experiments/craft-lab/v2/runs/my-0.json --action "Orb of Alchemy" --save my-1
node $c step --file poe-db/experiments/craft-lab/v2/runs/my-1.json --action-json '{"type":"harvest","method":"reforge","tag":"life"}' --save my-2
node $c train --file poe-db/experiments/craft-lab/v2/examples/essence-policy.json --episodes 1000 --max-steps 200
node --test poe-db/experiments/craft-lab/v2/test/v2.test.mjs
```

`step` и `replay` воспроизводят всю цепочку по seed, поэтому отредактированный «удачный» результат будет отвергнут. Если `--save` не указан, файлы не пишутся. С `--save` создаётся новый файл в `v2/runs` и никогда не перезаписывает существующий.

## Действия

Строка означает валюту: `"Chaos Orb"`. Объект означает действие с параметрами:

| type | Поля | Что делает |
|---|---|---|
| currency | name, omen?, assume? | Около 70 валют: базовые, Foulborn, Remembrance/Unravelling, 6 influenced Exalted, Ember/Ichor, Eldritch-орбы, Conflict, Dominance, Veiled Exalted/Chaos, Vaal, Tainted, Jeweller/Fusing/Chromatic (+Omens), Whetstone/Scrap, 12 Catalysts, Hinekora's Lock, Mirror, Chance (`assume:{magic,rare,unique}`) |
| bench | recipe, assume? | Любая из 782 опций по id (`recipes --match`). Unlock задаётся сценарием (`unlocked_recipes`) |
| essence | essence | Название или id эссенции |
| fossils | fossils[1..4], resonator? | Все 25 фоссилов, Chaotic/Alchemical-резонатор |
| harvest | method, tag?, from?, to?, kind?, cost? | `reforge` (тег), `more_likely`, `less_likely`, `influence_reforge`, `augment` (тег), `swap` (resistance/damage, cost обязателен) |
| beast | method, … | `imprint`, `restore_imprint`, `talisman_imprint`, `add_prefix_remove_suffix`, `add_suffix_remove_prefix` (beast_level), `metamod`, `aspect` (cat/bird/spider/crab, level 20/30), `talisman_fracture` (count), `influence`, `max_sockets`, `max_links` |
| unveil / choose_unveil | index | Предложения unveil и явный выбор |
| awakener | donor | Донор берётся из `inventory` сценария и уничтожается |
| recombinator | other | Два предмета превращаются в один |
| altar | — | Altar of Corruption: корруптит второй раз (Twice Corrupted), может уничтожить предмет |

`preview --file s.json --action "Chaos Orb"` работает только на предмете под Hinekora's Lock: превью совпадает с результатом следующего применения этой валюты.

## Сценарий и цели

Поля сценария: `item` (base, item_level, rarity, mods [id или {id, values, fractured, kind}], implicits?, influences, sockets {colours, links}, quality, quality_type, memory_strands, corrupted, cluster), `inventory` {id: item}, `seed`, `budget` (`null` означает без лимита; валюта, не указанная в заданном бюджете, получает лимит 0), `target`, `unlocked_recipes` (`null`, список или `"all_assumed"`), `start_cost`.

Условия для `target` и `when` в политиках: `all/any/not`, `mods`, `fractured`, `implicits`, `groups`, `influences`, `min_tier:[{group|type, tier}]`, `stats:[{id,min,max,scope: explicit|implicit|all|catalysed}]`, `rarity`, `open_prefixes/open_suffixes`, `mod_count`, `crafted`, `corrupted`, `offers`, `links`, `sockets`, `colours`, `quality`, `memory_strands`, `status` (active/destroyed/unique_outcome). Тиры считаются по базе: тир 1 — мод с наибольшим required level среди модов этого типа, которые могут появиться на базе.

## Принципы достоверности

- Данные (моды, веса, базы, рецепты, эссенции, фоссилы) берутся из закреплённого RePoE 3.30.0.4 и сверяются по SHA-256. Порядок весов проверен по PoB 2.68.1.
- Если шанс не опубликован (Orb of Chance, rarity reroll), движок требует явное `assume` и не подставляет число молча. Если не опубликована структура (стоимость Harvest-свапа), вызывающий должен её указать.
- Уникальный исход (Chance, Vaal на джевеле) и уничтожение (Altar) завершают эпизод статусом. Личность уникального предмета не моделируется.
- Неуспешный шаг ничего не тратит и не меняет; RNG тоже не сдвигается.
- Проверка цели работает по выпавшим значениям. Scope `catalysed` учитывает качество катализатора. Характеристики персонажа и DPS проверяются отдельно через `pob run` после `export`.
