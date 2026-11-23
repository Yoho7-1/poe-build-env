# Craft Lab v1: расширенный локальный движок

**Статус: experimental, complete=false.** Пользователь запросил полную версию; эта итерация существенно расширяет рабочее покрытие, но не выдаёт неустановленные правила за готовые механики. Точный список реализованного и оставшихся пробелов доступен командой `coverage`. Игровой проверки и полного независимого сравнения вероятностей пока нет.

Новая версия лежит отдельно от v0. Старые модули и сохранения остаются работоспособными. Основной CLI, общие базы, `builds/main`, lock окружения, skills и общая сводка не изменялись. Во время работы читались закреплённые данные; два внешних проекта скачаны в соседний `research` только как справка, их движки не установлены и не исполняются. Новых зависимостей, глобальных настроек и серверов нет.

## Быстрый запуск

Из корня проекта:

```powershell
node poe-db/experiments/craft-lab/v1/cli.mjs help
node poe-db/experiments/craft-lab/v1/cli.mjs status
node poe-db/experiments/craft-lab/v1/cli.mjs coverage

node poe-db/experiments/craft-lab/v1/cli.mjs new --file poe-db/experiments/craft-lab/v1/examples/normal-start.json --save my-start
node poe-db/experiments/craft-lab/v1/cli.mjs step --file poe-db/experiments/craft-lab/v1/runs/my-start.json --action "Orb of Alchemy" --save my-rare
node poe-db/experiments/craft-lab/v1/cli.mjs step --file poe-db/experiments/craft-lab/v1/runs/my-rare.json --action "Chaos Orb" --save my-reroll
node poe-db/experiments/craft-lab/v1/cli.mjs replay --file poe-db/experiments/craft-lab/v1/runs/my-reroll.json
node poe-db/experiments/craft-lab/v1/cli.mjs export --file poe-db/experiments/craft-lab/v1/runs/my-reroll.json --save my-item

# Короткая проверка адаптивной политики; увеличивать episodes осознанно.
node poe-db/experiments/craft-lab/v1/cli.mjs train --file poe-db/experiments/craft-lab/v1/examples/chaos-policy.json --episodes 20 --max-steps 22 --seed 42 --save my-training
node --test poe-db/experiments/craft-lab/v1/test/expanded.test.mjs
```

`--save` принимает имя без расширения: ASCII lowercase, цифры и дефисы. Snapshot JSON или экспорт TXT сохраняется только внутри `v1/runs`, с запретом перезаписи. Без `--save` все команды только возвращают JSON. Абсолютный путь к CLI работает из любой папки; пути к входам разрешаются относительно cwd.

## Добавленное покрытие

- Каталог принимает 1720 released-баз десяти доменов: equipment, Flask, Jewel/Abyss/Cluster Jewel, Tincture, Heist Trinket, Map/area, contract и chart. Это число записей, а не доказательство доступности всех баз в текущей лиге. Специальные исключения каждого предмета не проверены поголовно. Дубли имён требуют точного ID; unknown/unique-only/internal базы не превращаются в обычные предметы.
- Полный базовый цикл normal → magic → rare: Transmutation, Alteration, Augmentation, Regal, Alchemy, Chaos, Exalted, Annulment, Scouring, Divine и Blessed. Fracturing Orb и fractured rolls; редкие jewels ограничены четырьмя модами, Flask/Tincture не становятся rare. Учтены implicit-изменения ёмкости аффиксов экспериментальных баз. Для Cluster Jewel явно задаются `cluster.skill` и `cluster.passives`.
- Bench использует 782 определения для поиска. Реализованы отдельный explicit mod, Remove Crafted Mods, enchantment/removal и гарантированные links на уже заданных sockets. Проверяются класс, groups, свободный аффикс, crafted limit, multimod, открытие рецепта и исходная цена. Прочие действия рецепта возвращают ошибку: число записей не означает 782 полностью исполнимых recipes.
- Full/count locks 3.30 и фильтры Attack/Caster при генерации. Цены full locks берутся из 3.30 source recipes. Annulment не защищает Attack/Caster по этим фильтрам, согласно [изменению реализации CoE для 3.30](https://beta.craftofexile.com/changelog?game=poe1). Равномерный выбор аффиксов counted locks — непроверенное допущение модели, которое явно возвращается в metadata.
- Essences: class mapping, гарантированный мод, ограничения rarity/tier и item-level cap остальных модов. Обычные Fossils: 1–4 разных fossil, размер и тип resonator, веса/запреты тегов, forced mods. Специальные эффекты Fossils не подменяются простым весом.
- Harvest tagged reforge/augment; caller явно задаёт `cost` в единицах Lifeforce. Imprint/restore; при imprint явно задаются beast resources. Исторические keep-prefix/suffix Harvest и beast add/remove не выдаются за доступные методы.
- Шесть influenced Exalted Orbs, их классы/ограничения и influenced pools. Восемь Ember/Ichor и Eldritch Exalted/Annulment/Chaos с выбором стороны по dominance.
- Veiled Exalted → `unveil` → `choose_unveil`. Офферы сохраняются в состоянии; последующее действие требует явного выбора. Распределение офферов и выбор стороны veiled пока являются допущениями.
- Адаптивные политики агента вместо одного жёсткого списка действий; цели, бюджеты, расходы неудачных и остановленных попыток, учёт явно указанной стоимости начального предмета, Wilson interval и replay.
- ASCII-экспорт предмета для PoB: реальные rolls переводятся через закреплённые stat translations. Неподдерживаемые handlers, unresolved markup, качество и Cluster topology останавливают экспорт. Безопасно завершить экспорт ошибкой важнее, чем пропустить мод.

## Программный интерфейс и JSON

`loadCatalog()` из `catalog.mjs`; `createSession`, `step`, `replay`, `observe` из `session.mjs`; `train` из `training.mjs`; `exportPob` из `export.mjs`.

Сценарий имеет поля `item`, `seed`, `budget`, `target`, `unlocked_recipes`, `start_cost`. Начальные моды — IDs либо `{ "id": "IncreasedLife5", "values": [81], "fractured": true }`. Имплиситы базы разыгрываются из исходных диапазонов. Владение предметом остаётся допущением. `start_cost:null` означает неизвестную/неучтённую стоимость получения; `{}` означает явно бесплатный/given start. Бюджет `null` не ограничен; отсутствующая валюта в заданном budget имеет лимит 0. Ресурсы не пересчитываются между Chaos/Divine.

`unlocked_recipes` — список строковых IDs. `null` не подтверждает ни одного открытия. Значение `"all_assumed"` явно допускает все открытия как допущение упражнения, а не как профиль игрока.

Строка действия — обычная валюта. Параметризованные примеры:

```json
{ "type": "bench", "recipe": "769" }
{ "type": "essence", "essence": "Deafening Essence of Greed" }
{ "type": "fossils", "fossils": ["Scorched Fossil", "Pristine Fossil"] }
{ "type": "harvest", "method": "reforge", "tag": "fire", "cost": { "Primal Crystallised Lifeforce": 50 } }
{ "type": "beast", "method": "imprint", "cost": { "Craicic Chimeral": 1, "Yellow Beast": 3 } }
{ "type": "beast", "method": "restore_imprint" }
{ "type": "unveil" }
{ "type": "choose_unveil", "index": 0 }
```

Это отдельные объекты, не один JSON-файл. Для CLI сохранить нужный объект и передать `--action-file`. Приведённые Harvest/Beast costs иллюстрируют формат явной оценки: актуальную цену конкретного рецепта caller обязан подтвердить. Поиск идентификаторов: `bases|mods|recipes|essences|fossils --match text --limit 5`.

Цели/условия поддерживают `all`, `any`, `not`, `mods`, `groups`, `stats` с min/max, `rarity`, `open_prefixes`, `open_suffixes`, `crafted`, `offers`, `corrupted`. Numeric target проверяет **raw explicit stats**, без качества, implicit-magnitude effects или характеристик персонажа. Это не обещание DPS/EHP билда.

Policy — упорядоченные правила `{when,action}` или `{when,stop:true}`. Первое подходящее выполняется; отсутствие `when` — безусловное правило. После достижения target эпизод останавливается. Лимиты steps/бюджета не превращаются в успешный результат; их расходы включаются в mean всех попыток. Ни JS, ни shell-код из политики не исполняется.

Любой загруженный внешний snapshot сначала проверять через `replay`. CLI делает это автоматически. RNG/начальные данные/потраченные ресурсы/история воспроизводятся; изменённый результат отклоняется. Source contract включает девять source hashes, восемь новых модулей и общий RNG v0. Изменение кода требует явного нового эксперимента: v0 и v1 автоматически не мигрируют.

## Что мешает назвать версию полной

В `coverage.gaps` перечислены десять незакрытых семейств: unique variants/acquisition; все исключения rare-only 3.30; special Fossils; Foulborn/Memory Strands; расширенный Harvest/Bestiary; Awakener/Dominance; Recombinator/Genesis; Vaal/double corruption/Tainted/reflection/synthesis; качество/Catalysts/random sockets; остальные special enchantments/vendor/Hinekora/legacy.

Локальная выгрузка содержит не все правила процессов и вероятности. Проверенный официальный [developer interface CoE](https://beta.craftofexile.com/developers) не предоставляет API. Старые open-source реализации не подходят для автоматического переноса всех правил на 3.30. Поэтому непроверенные переходы здесь отказаны, а установленное reference-поведение помечено как модель. Программные тесты не доказывают полное соответствие серверу игры.

Проверки и сохранённый smoke run — в `validation.json`, когда создан. `HANDOFF.md` даёт короткое продолжение. Следующая содержательная работа — закрывать конкретные gaps независимыми источниками/контрольными примерами, а не менять `complete:false` на `true`.
