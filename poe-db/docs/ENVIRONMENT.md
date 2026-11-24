# Локальное окружение для билдостроения

## Начало работы

Из корня общей папки:

```powershell
.\poe.ps1 bootstrap
.\poe.ps1 doctor --deep
.\poe.ps1 query knowledge gem Fireball --level 20
.\poe.ps1 mechanic get resource-sustain --related
.\poe.ps1 build show main
```

Из любой папки: `node "<project>\poe-db\scripts\agent.mjs" bootstrap`. Сессия должна иметь доступ к папке. Для базы и расчётов сервер, сетевой порт и логин не нужны. Локальность данных не означает, что сама модель запускается на компьютере.

Поиск и использование установленного окружения работают без сети. Первичная установка и явное обновление источников требуют скачивания. Глобальные настройки Codex/аккаунтов не изменены; проектные навыки находятся в `.agents/skills`, на них ссылается `AGENTS.md`.

## Данные и инструменты

| Путь относительно poe-db | Назначение |
|---|---|
| `data/poe-3.30.sqlite` | Уникальные предметы с фильтром Wiki |
| `data/knowledge-3.30.sqlite` | 40 справочных разделов, 98 870 записей |
| `data/mechanics-3.30.sqlite` | 40 карточек, условия, ошибки и связи |
| `mechanics/catalog.mjs`, `mechanics/advanced.mjs` | Редактируемое содержание карточек |
| `mechanics/sources.json` | 17 источников, версии и SHA-256 |
| `mechanics/gaps.mjs` | Реестр пробелов PoB (WP9): что PoB считает, чего нет, модель и правила валидатора |
| `data/workbench-3.30.sqlite` | Примеры PoB, снимки цен и крафтовые планы |
| `../builds/main/build.json` | Требования, решения и состояние будущего билда |
| `../builds/*/history/` | История ревизий |
| `vendor/pob/` | Headless-часть PoB 2.68.1 с LuaJIT runtime |
| `vendor/pob-source.json` | Commit и суммы 364 файлов PoB, включая Glorious Vanity |
| `references/originals/`, `references/migrated/` | Авторские архивы и отдельные производные XML |
| `references/crafting/`, `cache/research/` | Условные рецепты и датированные ответы источников |
| `cache/calculations/` | Кэш расчётов и XML по содержимому |
| `environment.lock.json`, `package-lock.json` | Закреплённые версии и снимки |
| `evaluations/cases.json` | Задачи для отдельной проверки поведения модели |
| `experiments/craft-lab/v2/` | Симулятор крафта 3.30 (`agent.mjs craftsim`), правила с уровнем доверия, README и источники |

## Экономия контекста

`agent.mjs query` использует старый интерфейс `query.mjs`, добавляя brief/full и выбор полей. Поиск по умолчанию выдаёт пять кандидатов. Источник, идентичность, статус и исходные единицы сохраняются. Неизвестное поле — ошибка.

В brief предмета остаются фиксированные эффекты и текст получения; большие случайные пулы помечаются `random_pool.omitted=true`. Полный пул раскрывается через `--view full`, числовые варианты ищутся через `stat ... --include-random`. Число blocks не является числом одновременно выпадающих модов.

Карточка камня содержит конкретный уровень, стоимость, требования, типы навыка, ограничения поддержки и исходные коэффициенты качества. Отсутствующий уровень остаётся null. Качество не применено; текст и числовые характеристики не являются двумя отдельными наборами свойств.

`bootstrap` загружает только версии, короткие правила и текущее состояние. Полные каталоги, все механики и история не включаются автоматически. Ориентиры контекста: инструкции 500–1 000 токенов, состояние 500–1 500, релевантная карточка 200–600. Отчёт `context-benchmark.json` измеряет символы, не токены конкретной модели.

## Расчёт PoB

Адаптер: Windows x64, Node.js >=24 (проверено 26.13.0), PowerShell-хост, Git для установки/проверки commit. Хост ищется так: `POE_POWERSHELL` (явный путь), `pwsh.exe` в PATH или `Program Files\PowerShell\7`, затем встроенный Windows PowerShell 5.1 (`System32\WindowsPowerShell\v1.0\powershell.exe`). `pob-host.ps1` совместим с 5.1 и 7+. Запуск идёт с `-ExecutionPolicy Bypass` только для дочернего процесса — системная политика не меняется. Если хоста нет, ошибка перечисляет проверенные пути. Штатный LuaJIT `lua51.dll` запускается через небольшой локальный host; GUI не открывается. Установленные исходники/библиотеки проверяются по суммам.

`doctor` проверяет запускаемость (`pob-engine`: хост + LuaJIT выполняют скрипт), а не только наличие файлов. `doctor --deep` дополнительно пересчитывает контроль Fireball без кэша.

```powershell
node scripts/agent.mjs pob inspect fixtures/fireball-control.xml
node scripts/agent.mjs pob run fixtures/fireball-control.xml --scenario sustained --out reports/before.json
node scripts/agent.mjs pob run fixtures/fireball-control.xml --scenario sustained --changes changes.json --out reports/after.json
node scripts/agent.mjs pob compare reports/before.json reports/after.json
```

Вход — локальный XML или файл с compressed code. URL не скачиваются неявно. Для расчёта обязательно обычное дерево `3_30`; старые, неизвестные и Ruthless-версии можно инспектировать, но они не считаются текущими.

Явный перенос стандартных деревьев 3.28/3.29: `pob migrate old.xml --save-xml new.xml --out migration.json`. Используется штатный `TreeTab:ConvertAllToVersion`; сохраняются исходник, изменения узлов и число всех импортированных деревьев. Перенос не подтверждает доступность предметов или работоспособность всех стадий. Ошибка движка при импорте прекращает расчёт; неполная загрузка дерева не принимается.

Создание и обмен (локально, без сети):

```powershell
node scripts/agent.mjs pob new --class Witch --ascendancy Elementalist --level 40 --changes start.json --save-xml builds/x/act1.xml
node scripts/agent.mjs pob run builds/x/act1.xml --changes edit.json --save-xml builds/x/act2.xml
node scripts/agent.mjs pob export-code builds/x/act2.xml --save-code builds/x/act2.code.txt
node scripts/agent.mjs pob import-code builds/x/act2.code.txt --save-xml builds/x/act2-imported.xml
```

`pob new` создаёт пустой валидный 3_30-билд штатным `newBuild` PoB и выбирает класс/восхождение/bloodline; `--changes` в том же шаге может распределить узлы и добавить камни. `export-code` кодирует XML, сохранённый PoB (`SaveDB`), как кнопка Generate: base64 (`+`→`-`, `/`→`_`) от zlib. Затем он проверяет байтовый round-trip и повторный расчёт по всем числовым показателям; `--raw` проверяет только байты. `import-code` принимает файл или `--code`, сохраняет XML после пересохранения PoB и проверяет, что он считается так же. Операции `--changes` для дерева, камней, наборов и джевелов описаны в `BUILDING.md`.

`--changes` допускает явный выбор наборов: `{"selection":{"tree_spec":9,"item_set":4,"skill_set":2,"character_level":95,"main_socket_group":2}}`. Это пример синтаксиса: выбирать по содержимому конкретного XML. Неправильный ID вызывает ошибку. `minion_output` содержит отдельную область статистик миньона; число одного существа не является уроном всей армии.

Отчёт содержит commit/version, hash XML, calculation ID, конфигурацию, изменения, выделенные очки, применённые supports, предупреждения и неразобранные части модов предметов. `bloodline_subset` уже входит в `ascendancy_total`. FullDPS зависит от выбранных для него групп и может быть нулём; CombinedDPS относится к главному навыку.

Сценарии `imported`, `sustained`, `burst`, `unbuffed` перечислены в `pob scenarios`. Они меняют только перечисленные флаги. Остальные флаконы, заряды, guard, ailments, weapon sets и uptime проверяются отдельно. `burst` наследует конфигурацию; достижимость пика не доказывается.

Кэш учитывает XML, исходники движка, код адаптера/worker/host/runtime/edit (`pob-edit.lua`, `pob-changes.mjs`), сценарий и изменения. Сравнение требует одинаковый `calculation_contract_sha256`, baseline и сценарий. `--save-xml` не перезаписывает существующий файл. Установлены пять закреплённых частей данных Glorious Vanity, необходимых для одного реального примера; остальные Timeless-базы и GUI-ресурсы не установлены. Для другого типа — явная установка `node scripts/setup-pob.mjs --timeless LethalPride` (список в скрипте). Поведение в игре и удобство требуют игрового теста.

Контроль Fireball — синтетический: без дерева/экипировки и с нехваткой Intelligence. Независимая арифметическая проверка воспроизводит среднее попадание из базового урона, крита и сопротивления цели. Он демонстрирует ошибки требований/sustain и не предлагается как рабочий билд.

## Анализ и оценка модели

Модули `scripts/analysis-*.mjs`, команды `agent.mjs analyze ...` и `agent.mjs eval ...` (полный список — `agent.mjs help`). Любой результат — числовой эксперимент движка, не игровой тест.

- Сценарии боссов: `scenarios/bosses.json` (отслеживается в git) собран `analyze bosses build` из закреплённых данных PoB (`BossSkills`, `Bosses`, `monsterDamageTable`) с хешами источников. Урон повторяет арифметику пресета PoB (уровень врага 84 pinnacle / 85 uber, roll range 70%). У 7 боссов есть реальные пресеты скиллов (Shaper, Maven, Sirus, Exarch, Eater, Atziri, Cortex), остальные — только generic-профиль.
- `analyze boss-changes <boss> --tier uber --out-dir d` пишет по одному `--changes` на скилл; `pob run x.xml --scenario sustained --changes f --out r.json`; `analyze survive --boss X --tier uber --results d` — доля max hit по типам и «что убивает первым». Смешанные удары суммируются линейно (приближение), DoT-скиллы без вердикта, уклонение/восстановление между ударами не учтены; результаты с разным baseline/контрактом/сценарием отвергаются.
- **Исправление адаптера (24.11.2026)**: PoB читает тип босса для пресетов скиллов (`enemyIsBoss`) и тир модов карт (`multiplierMapModTier`) из состояния выпадающего списка, а не из `input`. Раньше `pob-worker.lua` менял только `input`, поэтому uber-пресеты считались с уроном Pinnacle (Uber Shaper Slam: 14 388 вместо 23 980), а моды карт — всегда как красные. Теперь для DropDown вызывается `SelByValue`, неизвестное значение списка — ошибка. Результаты `analyze survive --tier uber` до этой даты считать неверными. Контракт расчёта изменился, старый кэш не используется.
- **Новые изменения `pob run`**: `enemy_mods` — моды противника в словаре PoB (`{name, type: BASE|INC|MORE|FLAG|OVERRIDE, value, condition?, source?}`), добавляются после каждого `BuildModList`, как это делают map-аффиксы PoB. В результате появилось поле `unparsed_custom_mods`: строки `custom_mods`, которые PoB не распознал (раньше они молча отбрасывались).
- **База противников** `scenarios/enemies.json` (в git; `analyze enemies build` из `cache/knowledge` и закреплённого PoB, хеши источников, `doctor` сверяет версии, `--deep` — хеши):
  - Архетипы: `normal|magic|rare|unique` по конвенции PoB «No» плюс множители редкости из RePoE (`MonsterMagic/Rare/Unique`: здоровье +148/+390/+698% more, урон +30/50/70% more и −20/−33/−33% less при +20/33/33% скорости). Кроме того, `map_boss` (PoB Standard Boss), `pinnacle`, `uber`.
  - Таблицы монстров по уровням 1–100 (PoB `monster*Table`, `mapLevel(Boss)LifeMult` и RePoE `default_monster_stats`).
  - Тиры карт: white T1–5 / yellow T6–10 / red T11–16 / t17; уровень зоны = 67 + тир, T17 = 84 совпадает с `world_areas`.
  - 111 модов карт из RePoE 3.30 (area prefix/suffix с весом на low/mid/top/uber_tier_map или default). У каждого тира мода указан способ расчёта:
    - `pob_map_affix` — аффикс выбирается в списке PoB (33 из 41 описанных в `ModMap.lua`; PoB берёт максимум диапазона);
    - `translated` — перевод статов RePoE в `enemy_mods`, `custom_mods` игрока или пробивание врага; так считаются все моды T17 и те, которых нет в списке PoB;
    - `partial` — часть мода посчитана (например, Prismatic как ожидаемое разделение 1/3 на стихию);
    - `not_modelled` — с осью опасности (reflect, ground, ailments, flask и т. д.);
    - `no_combat_effect` — состав монстров, лиговый контент.
  - Значения берутся по худшему краю диапазона. Проклятия карт заданы уровнем из RePoE (`You are cursed with Level N ...`).
  - Здоровье считается только для обычных/редких монстров. Здоровье боссов зависит от вида монстра и в локальных данных отсутствует, его передают через `--enemy-life`.
- **Анализ выживаемости и урона** (`encounter.mjs`, `analysis-encounter.mjs`):
  - `analyze enemy <тип> --map-tier N --mods a,b` показывает сценарий и точные `changes` без расчёта.
  - `analyze encounter <xml> --enemy rare|map_boss|uber|boss:Shaper:"Shaper Ball" --map-tier 17 --mods savage,exposure [--map-mod-effect P] [--delirium P] [--enemy-life N] [--md f.md]` выдаёт DPS и время убийства, удар врага, удары до смерти, max hit по типам, EHP, восстановление. Результат сравнивается с тем же врагом без модов, а для нерассчитанных механик даются проверки по билду.
  - `analyze mapmod-sweep <xml> --map-tier 16` прогоняет каждый мод тира по отдельности против редкого монстра и выдаёт вердикт `avoid|caution|manual|ok`. Пороги лежат в `thresholds`, учитываются DPS, удары до смерти, max hit худшего типа и EHP.
  - `analyze report <xml> [--md f.md]`: противники T16/T17, generic-боссы, все пресеты скиллов боссов (DoT-скиллы — как дегген против DoT EHP и регенерации) и проверка модов T16/T17. Для Toxic Rain около 120 расчётов занимают ~30 с.
  - Обычный монстр PoB бьёт только физическим уроном, поэтому стихийные моды видны через max hit, а не через удары до смерти.
- **Боссы, профили урона, пантеон, атлас** (этап 3):
  - `fetch-game-data.mjs monsters` скачивает Wiki Cargo (`monsters` is_boss, `monster_types`, `monster_resistances`, `monster_map_multipliers`, `monster_life_scaling`) в `cache/wiki` с sha256; эти файлы входят в архив данных и в источники `enemies.json`.
  - Для 11 боссов сопоставлен вид монстра из Wiki (`bossVarietyIds`). Сопротивления вида заменяют дефолт PoB 50/30 (у Atziri 40/25).
  - Здоровье босса считается двумя формулами и выдаётся диапазоном, время убийства — тоже диапазоном с пометкой «оценка», без игровой проверки:
    - A: life(L) × health_multiplier × unique rarity × Wiki boss_life;
    - B: life(L) × health_multiplier × PoB `mapLevelBossLifeMult`.
  - Для Uber здоровье неизвестно: убер-скейлинг в данных отсутствует, передавайте `--enemy-life`.
  - Колонки ES/брони/уклонения в `monster_types` противоречат страницам Wiki, поэтому не используются.
  - `--damage-profile physical|elemental|fire|cold|lightning|chaos|mixed` делит общий удар PoB для монстров по типам урона. В `report` добавлены редкие монстры со смешанным уроном на T16 и T17.
  - `--pantheon-major/--pantheon-minor` задают настройки PoB.
  - `analyze atlas [--search]` и `--atlas "Node,Node"` переводят узлы атласа:
    - моделируются «Monsters in your Maps deal/have X% more/less …» и «increased effect of Explicit Modifiers» (в том числе «за каждый мод»);
    - остальные узлы, влияющие на бой, попадают в `not_modelled`.
- **CI**: `.github/workflows/test.yml` при push/PR на Windows выполняет `setup.mjs --deep` (релиз данных, npm ci, PoB) и `node --test`. Рабочий процесс завязан на опубликованный снимок `data-release.json`: после изменения данных сначала выпустить релиз, потом пушить.
- `analysis-core.mjs`: метрики (dps, fulldps, ehp, maxhit, life, es, mana_sustain), один calculation contract на пакет, кэш `cache/analysis` по ключу (контракт + изменение). `analysis-rank.mjs`: ранжирование за очко, trade-offs, цены без сложения при `inconsistent_currency_conversion`. `analysis-upgrades.mjs`: формат `--candidates` и пакеты с проверкой конфликтов слотов/конфига. `analysis-nodes.mjs`: кандидаты узлов по графу (граф подставляется), пробы статов через `custom_mods`.
- `eval list|show|prompts|template|score --answers f`: прогон `evaluations/cases.json`. Промпты слепые (без критериев), автоматические сигналы — только подсказка, итог pass/partial/fail ставит человек.

## Подбор улучшений, предметы, цены, механики, прогрессия, наблюдения (24.11.2026)

### Этап 1: автоматические кандидаты улучшений

Модуль `scripts/analysis-candidates.mjs` строит кандидатов в формате файла `analyze upgrades --candidates`, так что писать его вручную больше не нужно.

- `analyze candidates <xml> --kind supports [--group N] [--replace auto|add|weakest|<gem>] [--search t] [--exclude-awakened] [--plan] [--out f.json]`: перебирает все support gems, совместимые с active skill группы. Совместимость проверяется по выражениям allowed/excluded types из RePoE, как в PoB, с учётом added_types остающихся supports. `auto`: если в связке есть свободный сокет, gem добавляется; иначе заменяется самый слабый support, который находится removal probes (по одному прогону на каждый support). После прогона кандидаты, которых нет в `applied_supports`, убираются из рейтинга.
- `--kind uniques --slot <Helmet|Body Armour|...|Weapon 1|Flask N>`: берёт uniques из каталога (флаг Wiki) с текстом предмета из данных PoB 2.68.1. Каждый текущий variant (не "Pre x.y") идёт отдельным кандидатом. Цена прикрепляется только при точном совпадении variant, иначе остаётся `null` с `price_match`.
- `--kind anoints`: заменяет anoint на надетом amulet. `anoint-control` измеряет погрешность повторного импорта. Если amulet нет, используется строка custom mod `Allocates X`. Цены oils не подставляются.
- `--plan`: только список кандидатов, без прогонов движка. `--out` сохраняет готовый файл кандидатов. Без `--plan` выполняются генерация и `analyzeUpgrades` с проверкой (`verification`: applied / parsed / unparsed_lines).

Ограничения:
- Диапазоны значений берутся из середины (PoB default 0.5). Alt variants остаются по умолчанию.
- Generated uniques (Forbidden Shako, Megalomaniac, Precursor's Emblem) пропускаются.
- Цены оружия и брони с вариантами по links: `quoteFor` принимает `price.filters` (например `{links: 6}`), но генератор пока не заполняет его, поэтому такие предметы остаются `variant_required`.
- Corrupted gems 21/23 и cluster notables не генерируются. Weapon-type ограничения supports проверяет только движок.
- Предметы с десятками variants (The Devouring Diadem, Vivinsect) дают десятки прогонов: используйте `--search`/`--limit`.
- Результат — числовой эксперимент PoB, а не игровой тест.

### Абляционный разбор билда (`scripts/analysis-ablation.mjs`)

`analyze ablate <xml> [--kinds supports,skills,items,tree,config] [--plan] [--limit N] [--changes base.json] [--core 25 --major 10 --minor 2] [--md f.md] [--out f.json]` отвечает, что в билде ядро, а что заменимо. Против одного baseline и одного контракта расчёта убирается по одному компоненту:
- `supports` — каждый включённый support основной группы (`remove_gems`);
- `skills` — каждая другая включённая редактируемая группа (ауры, проклятия, guard, movement) выключается; группы от предметов/модов (`source`) пропускаются;
- `items` — предмет заменяется белой базой того же типа (`Rarity: NORMAL` + base): снимаются все моды, включая implicit, база остаётся. Пропускаются weapon swap, неактивные флаконы, cluster/timeless jewels, NORMAL-предметы (Viscera: эффект базы так не снять);
- `tree` — каждый keystone, notable (и восхождения), mastery оценивается штатным сравнением узлов PoB (как всплывающая подсказка дерева, `PassiveTreeView`): калькулятор `GetMiscCalculator` с `override.removeNodes`, дерево не меняется. Изменение `remove_nodes: [{node, with_dependents}]` (новое в `pob run --changes`, нельзя смешивать с правками tree/jewels/sets). Класс узла — по нему одному; для узлов, от которых зависят другие (`node.depends`), второй прогон даёт `with_dependents`: очки ветки, потеря всей ветки, другие notable/keystone/mastery в ней (`bridge`), `dps_loss_per_point`;
- `config` — см. ниже.

Классы по наибольшей потере (offense — худшее из main DPS и FullDPS; defense — худшее из EHP, max hit, life, ES): `core` ≥ 25% или отключение основного скилла / DPS 0; `major` ≥ 10%; `minor` ≥ 2%; `removal_improves` — без потерь, но метрика растёт; `negligible`. Переход mana sustain через ноль поднимает до `major`. Дополнительно: новые невыполненные требования атрибутов, падение сопротивлений, скорость передвижения. Кэш `cache/analysis` (`ablation-v2`, `ablation-dependents-v1`); на контрольном билде 72 + 10 расчётов ≈ 60 с при 8 процессах, повтор ≈ 4 с. `only` (из кода) ограничивает набор компонентов — так считает `lab bench score`.

Узлы-мосты: мост сам по себе может почти ничего не давать, а ветка за ним — десятки процентов DPS; поэтому `with_dependents` показывает цену всей ветки. Ранее в этой сессии использовалось приближённое отрицание статов через `custom_mods`; оно удалено как дубль штатной функции PoB (числа совпали).

Условия конфигурации (`--kinds config`, входит в набор по умолчанию): каждое допущение, отличающееся от значения по умолчанию нового билда того же класса (`conditionEnemyChilled`, `usePowerCharges`, `overridePowerCharges`, pantheon …), сбрасывается к умолчанию — чувствительность к uptime и боевым условиям. Ключи описания противника (`enemy*`, `preset*`, `resistancePenalty`, режимы усреднения) не трогаются. На контрольном билде все условия < 2% DPS, Solaris −3.8% защиты.

Ограничения: удаления по одному не аддитивны; `negligible` значит только, что измеряемые метрики не изменились (recoup, взрывы, иммунитеты, флаконы, зачистка не считаются); базовые эффекты NORMAL-предметов и джевелы со структурой не абляцируются; бонусы, зависящие от числа выделенных notable/keystone/mastery, PoB пересчитывает сам (CalcSetup).

### Взаимодействия компонентов (`scripts/analysis-interactions.mjs`)

`analyze interactions <xml> [--from ablation.json] [--top 6] [--triples 4] [--threshold 5] [--md f.md] [--out f.json]`: берёт сильнейшие core/major компоненты абляции (узлы дерева — сами по себе, через removeNodes), снимает пары и тройки вместе. Для метрики `r = after/before`: ожидание при независимости `Π r_i`, взаимодействие `r_joint / Π r_i − 1`. Меньше −порога — `synergy` (вместе теряется больше, компоненты усиливают друг друга), больше +порога — `overlap` (дублируют, хватает одного), иначе `independent`. Судится по метрике, которую компоненты реально двигают (наибольшая ожидаемая потеря среди dps/fulldps/ehp/maxhit). `--from` проверяет файл, сценарий и `input_sha256`. Изменения объединяются (`mergeChanges`: remove_gems одной группы, config, custom_mods, remove_nodes). На контрольном билде 6 компонентов: 15 пар и 4 тройки независимы (|взаимодействие| ≤ 1.6% DPS; защитная пара Frost Shroud + Grave Ward +3.9% max hit) — главные множители перемножаются. 25 расчётов ≈ 16 с.

### Пакетный режим PoB: варианты сравнения в одном процессе

PoB сам сравнивает узлы через калькулятор `GetMiscCalculator` (`override.removeNodes` / `override.addNodes`; так работают подсказки дерева и Node Power в PoB). `pob run --changes` принимает:
- `variants: [{id, remove_nodes: [{node, with_dependents}], add_nodes: [id]}]` + `variant_keys: [...]` — каждый вариант считается в том же процессе после основного расчёта; `add_nodes` выделяет путь `node.path`, найденный самим PoB; дерево не меняется. Результат — `variants[id] = {output, minion_output, removed_nodes, added_nodes, points}` (только запрошенные ключи) или `{skipped: 'no_dependents'}`.
- `node_power: {max_dist, types, shard}` — PoB сам перечисляет невыделенные узлы с `pathDist ≤ max_dist` (без восхождения и пожалованных) и считает каждый как вариант `add:<id>`.

JS: `runVariants` / `variantRunner` (`analysis-engine.mjs`) делят варианты на `concurrency` процессов и отдают их `evaluateCandidates` как обычные результаты с тем же контрактом (`calculation_id = <chunk>#<variant>`). Замеры на контрольном билде: 105 вариантов в одном процессе ≈ 3.5 с (раньше ≈ 5 с на каждый вариант отдельным процессом); абляция дерева 76 вариантов ≈ 6 с; `analyze nodes --radius 3` — 102 кандидата ≈ 6.5 с (раньше 32 кандидата ≈ 28 с). `analyze nodes` больше не использует собственный BFS и правку дерева: кандидаты, путь и стоимость берутся из PoB (`pathDist`, `node.path`). Для атак воркер дополнительно выгружает значения по рукам как `MainHand:<ключ>` / `OffHand:<ключ>`; `main_skill` — основной скилл по PoB (`mainSkill.activeEffect`).

### Производительность команд (24.11.2026)

Из чего складывается время (замеры на этом компьютере при фоновой нагрузке, разброс ±30%):
- Холодный расчёт PoB ≈ 7–9 с: старт Windows PowerShell и компиляция C#-хоста `Add-Type` ≈ 1.5–2 с, загрузка данных PoB (`HeadlessWrapper.lua`) ≈ 4.5–5.5 с, импорт билда ≈ 1 с, сам расчёт ≈ 0.1 с. Расчёт из кэша `cache/calculations` — доли секунды; ключ — XML + сценарий + changes + `calculation_contract_sha256`.
- `verifyEngine` (хэши 369 файлов PoB) ≈ 0.17 с один раз на процесс; `loadTree`/`pobGems` уже мемоизированы внутри процесса.

Изменения:
1. `agent.mjs` загружает модули команд лениво (синхронный `require(esm)`, Node ≥ 22.12), `agent()` остаётся синхронным. Вызов платит только за модули своей группы, а не за весь инструмент (полный импорт ≈ 0.5–0.6 с). Статически остаётся `price-refresh.mjs`: `fetch-economy.mjs` использует top-level await, а `require` такой модуль не грузит. Новый модуль группы с top-level await сломает свою команду — это ловит `test/performance.test.mjs`.
2. Пакетный пул анализа (`runBatch` в `analysis-engine.mjs`; на нём `analyze report|mapmod-sweep|ablate|interactions|progression|nodes|upgrades|candidates`, `runVariants`, `design generate`) выполняет задания в worker-потоках (`analysis-batch-worker.mjs`) вместо отдельного `node agent.mjs pob run` на каждое задание. Задание — тот же вызов `runPob` и тот же JSON `--out`, ошибка — тот же `{error, code}`; `pob.mjs` грузится один раз на поток, поэтому задание из кэша стоит миллисекунды вместо старта Node. Холодный расчёт по-прежнему запускает свой процесс PoB, одновременно не больше `concurrency`. Задание дольше `timeoutPerRun` завершает поток, его место занимает новый.
3. Файлы контракта расчёта (`pob.mjs`, `pob-worker.lua`, `pob-host.ps1`, `pob-runtime.lua`, `pob-edit.lua`, `pob-changes.mjs`) не менялись: любое их изменение меняет `calculation_contract_sha256` и обесценивает весь кэш (≈ 30 тыс. файлов).

| Команда | До | После |
|---|---|---|
| `analyze report <xml>` из кэша | 21.3 с | 5.2 с |
| `analyze ablate <xml>` из кэша | 15.0 с | 4.9 с |
| `bootstrap` | 0.94 с | 0.59 с |
| `query knowledge search Fireball` | 0.98 с | 0.78 с |
| `query item Mageblood` | 0.64 с | 0.50 с |

Вывод команд сверен побайтно (A/B старой и новой версии `agent.mjs` по 13 командам; `analyze report|ablate` — без учёта времени). Холодные `analyze report` (≈ 170 с) и `ablate` (≈ 95 с) почти целиком — холодные процессы PoB; новый пул экономит только старт Node на задание (≈ 0.6–0.8 с из 7–9 с).

Что ещё даст выигрыш, но требует решения (меняет контракт или чужие модули):
- Долгоживущий процесс PoB, который загружает данные один раз и считает много билдов (`HeadlessWrapper` ≈ 5 с из ≈ 7–9 с холодного расчёта): ускорение холодных пакетов в 3–5 раз. Нужно менять `pob-worker.lua`/`pob.mjs` (кэш обесценится), а побайтное совпадение чисел при повторном использовании состояния PoB надо доказать отдельной сверкой.
- Предкомпилированная сборка C#-хоста вместо `Add-Type` при каждом запуске (≈ 1 с на холодный расчёт). Тоже меняет `pob-host.ps1`, то есть контракт.
- `build card` (`chooseMainGroup`) делает до 12 отдельных прогонов PoB для выбора основной группы; их можно отдать одним пакетом `runBatch` (параллельно).
- В записи кэша из старой сессии и в свежем расчёте с тем же контрактом обнаружен разный `equipped_items` (у одного из билдов свежий расчёт показывает больше слотов, числа совпадают). Значит, при неизменном контракте вывод воркера менялся; стоит выяснить, какой файл влияет на вывод, но не входит в контракт.

### Локальный корпус (`scripts/corpus.mjs`)

`corpus add <file.xml|code.txt> [--source url] [--trust own|author|community|generated|unknown] [--origin-patch 3.29]`, `corpus import-dir <dir> [--sources a.json,...]`, `corpus list|summary`. Без сети: файл или код уже на диске → при дереве 3_28/3_29 явная миграция PoB (`pob migrate`, счётчики удалённых/добавленных/изменённых узлов) → XML в `research/lab/corpus/xml` → карточка с `identity.origin` (исходный файл, sha256, исходный патч, миграция). `--sources` сопоставляет имя файла со ссылкой из списков `[name, url]` или `{id, pob}`. Перенос 3.29 → 3.30 — локальная миграция, не авторский билд 3.30. Если сохранённый основной скилл почти не наносит урона (аура, утилита), карточка просит PoB посчитать каждую активную группу основной и описывает сильнейшую (`skills.main_selection`).

По ссылке: `corpus add-url <pobb.in|pob.codes|pastebin link>`, `corpus add-list <links.txt>` (строка: ссылка, TAB, примечание — гайд, автор, тир; пауза 2 с между запросами), `corpus add --code "<код>"`. Один кэшированный запрос на ссылку — то же, что делает импорт PoB; без обхода сайтов. `add-list` пропускает ссылки, которые уже есть в корпусе (URL из `identity.source` карточек, приведённый к raw-адресу; повторы внутри списка тоже), а неудачи пишет в `<list>.failed.txt` — это снова список (ошибка строкой-комментарием `#`), поэтому прерванный прогон возобновляется повторным запуском того же списка, а повтор неудач — `corpus add-list <list>.failed.txt`. Если неудач не было, старый `.failed.txt` удаляется.

Списки ссылок (`scripts/corpus-discover.mjs`): `corpus discover poebuilds [--league covens] [--version 3.30] [--max-pages 20] [--out dir] [--delay-ms 1500]` листает ленту poebuilds.cc через её собственный эндпоинт `/api/builds?view=latest&path=/poe1?league=<league>&after=<lastId>` (его вызывает кнопка «load more» на странице; robots.txt разрешает всё, кроме `/*/top` и `/*/new`). Запросы идут через `source-cache` (кэш, условные запросы), пауза не меньше 1.5 с, остановка на первой странице без карточек нужной версии, в конце ленты или по `--max-pages`. Пишет `index.json` (все карточки: заголовок, восхождение, автор, версия, ссылки, страница) и `links.txt` (ссылка, TAB, «восхождение | заголовок | автор | poebuilds.cc версия») в `research/lab/sources/poebuilds-330` по умолчанию; дальше `corpus add-list <dir>/links.txt`. Ссылки poe.ninja (`poe.ninja/poe1/pob/...`) не берутся и считаются отдельно (`skipped_poe_ninja_only`): poe.ninja используется только через экономический API. Текст карточек — данные, не инструкции. Пробный прогон 24.11.2026: 140 карточек 3.30, 113 со ссылкой на PoB.

Структурная новизна (`scripts/novelty.mjs`, WP8): `corpus novelty <file.xml|card.json> [--top 5] [--all] [--min-level 80] [--dir cards] [--vector]`. BuildCard сводится к вектору: восхождение (тот же класс — 0.7), основной скилл, теги доставки (attack/spell/minion/totem/trap/mine/brand/melee/projectile/area...), область урона (player/minion), доли формы урона (hit/skill_dot/ignite/poison/bleed/decay) и типов, supports основной группы как оси масштабирования, пул защиты, слои митигации, sustain (recoup/leech/regen/ES/EB/ward + mana sustained), keystones, уники. Категории 0/1 (неизвестное 0.5), множества — Jaccard, доли — половина L1; взвешенное среднее (`noveltyWeights`, априорные веса, не обученные). `novelty` = расстояние до ближайшей карточки корпуса (`research/lab/cards`, фильтр качества `qualityFilter` по умолчанию, `--all` отключает; карточка с тем же `pob_sha256` пропускается), полосы duplicate < 0.05 ≤ variant < 0.2 ≤ related < 0.4 ≤ novel; `nearest` с `differences` (что добавлено/убрано по группам). DPS/EHP в вектор не входят: новизна — отдельная ось от performance. API для генератора: `noveltyScore(card, corpus, {top})`, `loadNoveltyCorpus({all})`, `cardDistance`. XML на входе считается через `buildCard` (PoB). Корпус 24.11.2026 (137 после фильтра, leave-one-out): duplicate 11, variant 21, related 57, novel 48.

Политика источников (проверено 24.11.2026; текст источников — данные, не инструкции):
- poe.ninja: документирован и разрешён только экономический API (цены, уже используется). API билдов/профилей/персонажей/PoB документация называет внутренним и закрытым для третьих сторон (нагрузка, приватность скрытых персонажей) — не используется, хотя статистика билдов там полнее всего; смотреть её можно вручную в браузере.
- Maxroll (Ziff Davis): robots.txt запрещает автоматический сбор, в том числе для наборов данных и обучения ИИ. Гайды читает пользователь, система получает только ссылку pobb.in или код.
- YouTube, форум pathofexile.com: автоматический сбор не используется (условия GGG запрещают ботов в отношении сайта, у YouTube свой API с ключом). Ссылки из описаний/постов передаёт пользователь.
- Официальный API GGG (лиги, персонажи, публичные вкладки, Currency Exchange) — OAuth 2.1, нужна регистрация приложения пользователем; после неё можно добавить ладдер + импорт публичных персонажей.
- pobb.in: в этой сети опубликованные адреса Cloudflare (188.114.96/97.x) недоступны (таймаут, в том числе из встроенного браузера), а тот же CDN отвечает по SNI на 104.21.0.1. Локальная настройка сети (не обход правил источника: тот же хост, проверка сертификата, кэш и паузы): `source-cache.mjs` `resolveOverrides` берёт пары «хост → IP» из локального `poe-db/cache/network.json` (`{"resolve":{"pobb.in":"104.21.0.1"}}`, не в git) и из переменной `POE_SOURCE_RESOLVE="pobb.in=104.21.0.1,..."` (переменная перекрывает файл); запрос к такому хосту соединяется с указанным IP, остальное без изменений, в метаданных кэша — `via_edge`. `doctor --deep` (проверка `network-overrides`) без сети проверяет, что хосты из списка разрешённых, а значения — IP-адреса. Без настройки `add-url` сообщает о недоступности и предлагает `--code`. pastebin.com и api.pob.codes (`pob.codes/b/<id>` → `api.pob.codes/<id>/raw`, как в PoB) доступны и разрешены.
- Рынок: poe.trade закрыт (октябрь 2022 по вторичным источникам); официальный trade-сайт — вручную по фильтрам `item appraise`; его поисковый API внутренний.

Обучение на корпусе (`scripts/corpus-learn.mjs`): фильтр качества по умолчанию — исключаются карточки с level < 80 (`--min-level`), без восхождения (наёмники, черновики) и повторы одной `signature` (остаётся одна: выше уровень, затем не перенесённая этим проектом, затем авторская 3.30, затем по имени файла); каждая команда выводит `quality_filter` со списком исключённых и причинами, `--all` отключает фильтр. Карточка сопоставляется с XML/абляцией по `identity.file`; XML без карточки при фильтре не абляцируется (`no card`). `lab bench` обучает базовое правило `empirical` на тех же отфильтрованных абляциях. `corpus ablate-all [--limit N]` — абляция каждого (прошедшего фильтр) XML корпуса (возобновляемо, `research/lab/corpus/ablation`), `corpus learn` — эмпирическая модель классов (`tier-model.json`: частоты core/major/minor/negligible по ключам от частного к общему — support по имени, уник, слот+редкость, тип узла, допущение, вид компонента; медианные потери DPS/защиты), `corpus insights` — «основы билдостроения»: какие supports/уники/типы узлов/допущения чаще несут билд, какие чаще заменимы. Это частоты по небольшому корпусу (частично перенесённому с 3.29) — гипотезы для проверки абляцией и переносом, не правила. `lab bench` использует модель как базовое правило `empirical` (обучение без билда задачи; `lab bench rescore <B>` пересчитывает базовые правила по сохранённым правильным ответам).

Состояние 24.11.2026: Timeless-данные установлены (`setup-pob --timeless LethalPride,BrutalRestraint,MilitantFaith,ElegantHubris,HeroicTragedy`, ≈ 10 МБ; HeroicTragedy добавлен в список установщика; Abyss-базы ≈ 30 МБ каждая не ставились), корпус пополняется из `research/pob-cache`, `research/dependency-cache` и `research/*.xml`.

### Карточка билда (`scripts/build-card.mjs`)

`build card <xml> [--ablation ablate.json] [--source text] [--trust own|author|community|generated|unknown] [--save] [--brief]`, `build card list`. Детерминированный снимок из одного расчёта PoB: основной скилл и supports, активные скиллы, форма урона (доли hit / skill DoT / ignite / poison / bleed / decay) и типы урона (по average hit и DoT по типу — грубое разбиение, не трассировка конверсии), для миньон-билдов профиль миньона (`scope: minion`, на одного) и FullDPS игрока; модель защиты (`life`/`es`/`hybrid`/`ci_es`) и слои по явным порогам, max hit по типам, восстановление, ресурсы и mana sustain, keystones, ascendancy notables, уники, допущения конфигурации; с `--ablation` — `core` / `implementation` / `replaceable` / `assumption_sensitivity` (`bridges` — узлы, за которыми ветка с другими ключевыми узлами, и потеря всей ветки). `signature` — хэш структурных признаков (класс, восхождение, скилл, область и форма урона, тип, пул, слои, keystones, уники) для дедупликации и будущей оценки новизны. `--save` пишет `research/lab/cards/<pob_sha256[0:16]>.json` (локально) и сообщает карточки с той же сигнатурой. Карточки хранятся локально (вне git), например для reference-билдов SRS Necromancer и Toxic Rain Pathfinder (reference, локальные переносы).

BuildCard v2 (`schema_version: 2`, WP1 ч.2). `buttons`: оценка числа нажимаемых клавиш. Источник — флаги активных скиллов, которые отдаёт сам PoB (`active_skills` в результате `runPob`: SkillType/skillFlags каждого скилла из `env.player.activeSkillList`). Правило: отдельное имя скилла = клавиша, кроме автоматических (triggered, aura, herald, резерв, постоянные миньоны/големы); тотемы/ловушки/мины/бренды считаются (их ставят); movement/guard/warcry/vaal/mark/banner/buff — `utility` (тоже клавиши); кулдаун без бафа (Cold Snap) — урон. Флаконы: `Used when ...` и магические utility под Mageblood — авто, прочие utility — клавиши (часто одна клавиша/макрос), life/mana/hybrid — только в `maximum`. `estimate` = pressed + utility + ручные utility-флаконы; `minimum` = pressed; `maximum` добавляет призывы миньонов без резерва (`uncertain`) и life/mana. Не моделируется: бинды и макросы, скиллы раз за карту, скиллы предметов, которых нет в списке PoB. `features.buttons` = `estimate` (в сигнатуру не входит). `damage.conversion`: `links` (`from`/`to`/`convert|gain_as`/`pct` — доля исходного типа после масштабирования PoB), `chains` (по порядку Physical > Lightning > Cold > Fire > Chaos), `unconverted_share`, `basis` (`skill`, `main_hand` для атак, `minion`), `other_bases` при отличии таблиц; читается из `conversionTable` PoB, без пересчёта; если PoB таблицу не отдал — `null` и `conversion_reason`. Итоговые доли типов — по-прежнему `damage.types`. `build card diff <a.json> <b.json> [--out]`: признаки, множества (keystones, уники, ascendancy notables, supports основной группы, активные скиллы), слоты, дельты DPS/EHP/max hit/резистов/mana sustain, кнопки, ссылки конверсии, допущения конфигурации и `notes` о несопоставимости (сценарий, уровень, версии, схема). Карточки v1 читаются, отсутствующие поля — `not_in_card`. Изменение `pob-worker.lua`/`pob.mjs` сменило контракт расчёта: кэш `cache/calculations` пересчитывается при первом обращении.

### Журнал исследований (`scripts/lab.mjs`)

Записи переживают сессии: `research/lab/ledger.jsonl` (локально, вне git). Каждое изменение дописывает полную новую версию записи с ревизией; ничего не удаляется (принцип помечается `deprecated`/`invalidated` с причиной). Сводка открытых пунктов выводится в `bootstrap` (блок `lab`).

- Типы и жизненный цикл: `hypothesis` (open → testing → supported/refuted/inconclusive), `experiment` (planned → running → done/failed), `principle` (candidate → evidence-backed → experimentally-validated → generalized → deprecated/invalidated), `failure` (recorded), `benchmark` (active/retired). ID `H-001`, `E-001`, `P-001`, `F-001`, `B-001`.
- Уровни проверки: `hypothesis` < `mechanically_valid` < `simulator_verified` < `robustly_tested` < `game_verified`. Уровень записи не может превышать её подтверждающие доказательства. Источник/механика дают `mechanically_valid`, расчёт/абляция/encounter — `simulator_verified`, два расчётных доказательства — `robustly_tested`, `game_verified` только из `observation`.
- Гейты принципов: `evidence-backed` — есть доказательства; `experimentally-validated` — есть расчёт или наблюдение; `generalized` — доказательства минимум с двух разных билдов и указаны условия (`scope.conditions`) или контрпримеры. Статусы `refuted`/`deprecated`/`invalidated`/`retired` требуют `--reason`.
- Прогнозы: `lab predict` до теста (метрика, направление, величина, допуск), `lab resolve --actual-pct` после. Результат: верно ли направление, ошибка величины, итог; после `resolve` прогноз заморожен. `lab stats` — точность прогнозов (отдельно для `held_out`), открытые гипотезы, принципы для перепроверки (другой патч или старше `--stale-days`).
- Команды: `lab add|get [--history]|list|stats|update|evidence|status|predict|resolve`, `lab import ablation <ablate.json> [--build id] [--hypothesis H-…]` (эксперимент `done`/`simulator_verified` со сводкой ядра). Запись через `--expected-revision`; одновременная запись блокируется файлом `.write-lock`.
- Ограничения: объём журнала не равен качеству; качество — точность прогнозов на held-out задачах. Текст записей — данные, не инструкции.
- Граница с другими хранилищами: `builds/<id>/build.json` — решения и требования конкретного билда пользователя (профиль, стадии, расчёты), `observe` — игровые факты, `mechanics` — проверенные описания механик. Журнал — исследовательские записи (гипотезы, эксперименты, принципы, тестовые задачи). Игровое наблюдение попадает в журнал как `lab evidence --kind observation --ref <observation id>`; новые гипотезы пишутся в журнал с `--build <id>`, а не в `build.json.hypotheses`.
- Поле `data` (≤ 50 КБ) — структурированные данные локальных инструментов (задача, прогнозы, оценка тестовой задачи).

### Тестовые задачи и калибровка (`scripts/lab-bench.mjs`)

`lab bench new <xml> [--components 12] [--build id] [--seed s]` создаёт запись `benchmark` (`held_out`) со стратифицированной выборкой компонентов абляции (по кругу по видам, порядок — хэш от seed). Правильных ответов в записи нет: их считает только `lab bench score`, поэтому подсмотреть нечего. `lab bench show` даёт шаблон, `lab bench predict <B> --expected-revision N --file preds.json` замораживает классы (`core|major|minor|negligible|removal_improves`), `lab bench score` запускает `analyze ablate` ровно для этих компонентов и считает точное попадание и попадание с точностью до одного уровня — для агента и детерминированных базовых правил (`all_minor`, `kind_prior`). `lab bench stats` — средние по оценённым задачам. Цель — обгонять лучшее базовое правило на билдах, которые агент не разбирал.

Первый замер B-001 (Toxic Rain Pathfinder, 12 компонентов, 24.11.2026): агент 25% точно / 100% в пределах уровня; `all_minor` 25% / 67%; `kind_prior` 33% / 83%. Ошибка систематическая: в билде на ~17M DPS supports, ауры и Withering Step — `core`, а не `major`.

После B-002 (Earthshatter Berserker) и B-003 (Penance Brand Elementalist), 36 компонентов: агент 38.9% точно / 88.9% в пределах уровня; `kind_prior` 41.6%; `all_minor` 19.5%. Интуиция модели по точному классу не лучше детерминированного правила — следующая проверка (H-002): локальный эмпирический прогнозатор по накопленным абляциям.

### Этап 2: конструктор предметов (`scripts/item-builder.mjs`)

- Назначение: собрать normal/magic/rare предмет из модов RePoE и получить текст для PoB (`replace_items: [{slot, text}]`) без ручного набора.
- Данные и логика пула берутся из Craft Lab v2 (`loadCatalog`, `tierInfo`, `pool`, `renderRoll`): закреплённый RePoE 3.30.0.4, сверка SHA-256. Свой пул не дублируется.
- Мод задаётся как `REF[:Tn][=v1,v2]`: REF = id мода (`IncreasedLife9`), имя type (`Strength`) или текст (`maximum Life`). T1 = лучший тир, доступный на этой базе при этом ilvl. Без `=` значение берётся по `--roll max|min|mid` (числовой край диапазона в единицах RePoE: для "reduced" модов max не лучший ролл).
- Проверки: spawn weight по тегам базы/influence/rarity, domain, prefix/suffix, `required_level <= ilvl`, лимит 3/3 (magic 1/1), одна группа на мод, bench recipe для item class, лимит crafted (1, или 3 с multimod), блок "cannot roll attack/caster". Каждое нарушение выводится кодом; `--allow-illegal` строит гипотетический предмет с предупреждением `hypothetical_item`.
- Essence-only моды дают предупреждение, а не нарушение; unlock рецепта бенча и стоимость не проверяются; источник нестандартных implicit не проверяется.
- `item check ... --check build.xml [--slot]` запускает `runPob` до и после замены и показывает `unparsed_item_modifiers` слота и дельты Life/ES/резистов/CombinedDPS. Это оценка движка, а не игровой тест.
- Не поддержано: cluster/abyss jewel-специфика, fractured/synthesised/eldritch implicit как отдельные состояния, catalyst quality, veiled моды, имена magic-предметов (печатается только база).

### Оценка редкого предмета (`scripts/item-appraise.mjs`)

- `item appraise --file item.txt|- | --text "..." [--check build.xml] [--slot S] [--scenario S] [--brief] [--out f.json]`. Вход: текст из игры (Ctrl+C или расширенный Ctrl+Alt+C) или текст предмета PoB.
- Разбор: база (одноимённые базы вроде Two-Stone Ring различаются по implicit), ilvl, качество, сокеты, influence, Corrupted/Mirrored/Fractured/Synthesised; моды сопоставляются шаблонам строк RePoE с проверкой диапазона значений. Натуральные строки ищутся в пуле базы, затем во всех аффиксах домена (`not_in_base_pool`), crafted — среди опций бенча класса.
- Для каждого мода: id, prefix/suffix, тир на этой базе при этом ilvl (`tier_scope`), тир из расширенной копии игры (`game_tier`, нумерация игры может отличаться), качество ролла 0..1 внутри тира. Сводка: T1/T1-T2, средний ролл, открытые префиксы/суффиксы, возможность крафта на бенче.
- Обычная копия игры суммирует одинаковые строки и не показывает границы модов: тогда возможны `merged_lines_possible` и `ambiguous_mod_grouping` (гибрид или два мода). Для точности копировать Ctrl+Alt+C.
- Рынок: офлайн-цены на редкие предметы нет (poe.ninja их не оценивает). `market.trade_search` даёт псевдо-суммы (life с учётом Str/2, элементальные/все резисты) и фильтры с минимумом 90% значений предмета для ручного поиска; сеть не используется.
- Ценность для билда: `--check build.xml` надевает предмет (слот по классу; кольцо — Ring 1, второе — `--slot "Ring 2"`) через `checkItem` и выдаёт дельты Life/ES/резистов/EHP/DPS против текущего предмета. Оценка движка, не игровой тест.

### Этап 4: свежесть и обновление цен

- Модуль `scripts/price-refresh.mjs`: `price status [--stale-days 3]` (офлайн) и `price refresh [--categories a,b] [--dry-run]` (сеть только здесь).
- `status`: самый новый снимок по league/platform/category, возраст, флаг `stale` (порог по умолчанию 3 дня), число хранимых снимков, проверка `inconsistent_currency_conversion` (курс chaos/divine из item-категорий против Divine Orb из Currency, правило 25%, как в `priceQuery`).
- `refresh` использует `cachedSource` (sha256 и сырые тела в `cache/research`), `normalizeOverview` из `fetch-economy.mjs` и `importPrices`/`reindexPriceVariants`; старые снимки остаются историей (`price get --history`). Блокировка `cache/price-refresh.lock` против параллельного запуска.
- Если league id `Covens` пропал из списка лиг poe.ninja, обновление останавливается с ошибкой и списком объявленных лиг; замена не угадывается.
- `priceFreshness(db)` + `attachFreshness(priceResult, freshness)` добавляют к котировкам предупреждение о возрасте.
- Список категорий и шаблон URL продублированы из `main()` `fetch-economy.mjs` (там не экспортированы); при правке стоит экспортировать их оттуда.
- Расхождение курса (item feeds ~190 chaos/div против Currency ~116) сохраняется и после обновления: бюджеты в Chaos и Divine не объединять.
- Редкие предметы не оцениваются. Для этого нужен официальный trade API (pathofexile.com/api/trade): POST search + GET fetch, жёсткие лимиты по заголовкам `X-Rate-Limit-*` (бан при превышении), обязательный User-Agent с контактом, ToS GGG; данные — объявления, а не сделки. Требуется решение пользователя (платформа, согласие на сетевые запросы, политика кэша); здесь не реализовано.

### Этап 5: новые карточки механик

Добавлено 11 карточек (40 -> 51) в `mechanics/coverage.mjs`, источники — закреплённые файлы PoB 2.68.1 (6 новых, 17 -> 23):
- `projectile-behaviour` — Pierce/Fork/Chain, skillPierceCount/ChainCount/ForkCount, shotgun только через навыко-специфичные опции; Return в PoB не моделируется (открытый вопрос).
- `impale` — 10% сохранённого урона, 5 stacks, 8 с, броня цели к суммарному повтору; multiplierImpalesOnEnemy.
- `stun` — threshold, шанс 200×урон/threshold с порогом 20%, avoid, длительность; странное ветвление enemyDamageType отмечено; Heavy Stun не найден.
- `charges` — Power/Frenzy/Endurance: эффекты за заряд, use*/override*, генерация не моделируется.
- `rage` — 1% more attack damage за Rage, максимум 30, потеря 10/с после 2 с, нужен источник CanGainRage.
- `aura-herald-effect` — группы aura/buff effect, Herald multiplier, резерв отдельно.
- `warcry-exert` — Warcry Power (20 на boss preset), warcryMode AVERAGE/MAX, исключения exert.
- `brand-channelling` — attached Brands как множитель DPS, Channelling условия и ограничения.
- `low-life-ci-hybrid` — порог Low Life 50%, CI, chaos bypass ES у гибрида.
- `enemy-debuffs` — Intimidate/Unnerve 10%, Wither 6%×15, Maim, Hinder, Blind.
- `pantheon-map-context` — Pantheon применяет все души, map mods вручную; Atlas tree движком не моделируется; несколько общих строк переводит `analyze --atlas`.
Тест: `test/mechanics-extra.test.mjs` (проверяет базу и существование всех упомянутых Config-переменных).

### Генератор архитектур, Build Request Mode (WP5, `scripts/design-*.mjs`)

Перебор, расчёты и хранение — код и PoB; агент выбирает запрос и интерпретирует фронт. Модули: `design-blueprint.mjs` (чистая логика: схема запроса `poe-design-request/1` и Blueprint `poe-design-blueprint/1` с валидацией, таблицы тем/осей/условий узлов, оценка кандидатов, жёсткие фильтры, счёт кнопок, разнообразие, Pareto), `design-kit.mjs` (типовой комплект редких предметов), `design-generate.mjs` (конвейер и CLI). Ничего не привязано к конкретному билду: темы (`THEMES`: explosion, on_kill_explosion, minion, totem, trap, mine, brand, damage_over_time, poison, bleed, ignite, projectile, melee, spell, attack, channelling, типы урона), оси дерева (`AXIS_RULES` по типам скилла RePoE) и условия узлов (`NODE_REQUIREMENTS`: «Cursed/Bleeding/Ignited/Poisoned enemies», «Totems/Minions kill») — таблицы, расширяются строками.

- `design request [--profile <build.json> | --request req.json] [--ascendancy A,B] [--themes t1,t2] [--level N] [--map-tier N]` — запрос из профиля: восхождения и темы из текста, тир из «T17», «few buttons» → не больше 3 нажимаемых скиллов (интерпретация, помечена), «flask pressing» в нелюбимом → ограничение «мана без флаконов». Неизвестное остаётся `null`, каждое значение по умолчанию (уровень 92, T16) — в `assumptions`.
- `design candidates` — активные камни knowledge DB (выпущенные, есть в PoB, не vaal/royale, наносят урон: Attack/Damage/DamageOverTime/миньоны; утилиты отсеяны с причиной) × восхождения запроса. Оценка: цвет камня/класс, синергия узлов восхождения с осями скилла, темы (скиллом или узлом восхождения, чьё условие выполнимо: проклятие ставит генератор, кровотечение/поджог — только сам скилл).
- `design generate [...] [--limit 6] [--screen 24] [--budget-calcs 1000] [--links 6] [--gems id,id] [--no-lab] [--out dir]`:
  1. разнообразие по ключу «восхождение | форма урона | основной тип» → `--screen` кандидатов;
  2. прототип = пустой билд класса (`pob new`, один на восхождение) + `--changes`: дерево — жадное легальное распределение очков (BFS `tree-graph`, ценность узла / длина пути) по осям скилла и life (+ ось реген/стоимость маны при ограничении «без флаконов»), восхождение — 8 очков по осям и темам; комплект — `design-kit` (моды из легального пула базы через `item pool`, тир 3, средние роллы, по одному на группу модов, 3+3; оружие по `weapon_restrictions`; моды, которые item-builder не экспортирует, пропускаются с пометкой); основной камень 20/20 в 6L;
  3. скрининг: голый прототип через PoB, ранжирование по DPS PoB (с миньонами — `minion_output`);
  4. для `--limit` архитектур: каждая совместимая поддержка (префильтр типов `supportCompatible`, без awakened/exceptional/trigger, без totem/trap/mine при «мало кнопок»; более 40 — по пересечению тегов) пробуется отдельно, берутся лучшие 5 (приближение: не аддитивно, итог проверяет финальный расчёт); ауры (резерв, без Herald/Banner) — лучшая по DPS и лучшая по EHP; если узел восхождения требует проклятия — лучший hex с Blasphemy;
  5. финальный расчёт; если основной скилл нечем оплатить — снимаются ауры; ремонты: невыполненные атрибуты → недостающий атрибут даёт база брони (`kitPlan`, `ARMOUR[...]`), затем узлы дерева (`attribute_tree`); реген маны в комплекте при «без флаконов»; минус мана → до 4 раундов: аура для маны в слоте `Aura` или `Aura 2`, иначе снятие поддержки; каждый шаг в `repairs`;
  6. `analyze encounter` map boss и rare тира запроса; валидатор механик WP9 (`validatePrototype`: `fail` → отказ); жёсткие фильтры `hardFilters` (нет урона, требования, стоимость, мана без флаконов, нераспознанные моды); Pareto по `boss_dps`↑, `weakest_max_hit`↑, `ehp`↑, `buttons`↓, `clear_score`↑ (эвристика: area/projectile/minion + взрывы, о которых сообщил PoB).
  Результаты: `research/lab/designs/<run>/` — `request.json`, `candidates.json`, `blueprints/<id>.json` (Blueprint + метрики + пробы), `prototypes/<id>.xml`, `report.json`, `report.md`; отклонённые прототипы — `lab failure` (с `--no-lab` не пишутся). Числа сравнивают архитектуры при одной политике предметов и дерева — это не оптимизированные билды (WP6) и не игровой тест.
- `design verify --example <id> [--prototype]` — проверка генератора: запрос из reference-примера (восхождение + структура основного скилла: форма доставки и основной тип урона, без имени), ранг reference-скилла среди кандидатов; с `--prototype` — доходит ли он до PoB-прототипа.
- Тест: `test/design.test.mjs` (запрос из профиля, фильтр скиллов, оси, условия узлов, оценка, разнообразие, кнопки, жёсткие фильтры, Pareto, схема Blueprint, подбор модов комплекта).

### Пробелы PoB, приближённые модели и валидатор механик (WP9)

- Реестр `mechanics/gaps.mjs` (22 записи: 9 `not_modelled`, 10 `partial`, 3 `config_assumed`). Каждая запись: что делает PoB (`pob_does`), пробел (`gap`), оси опасности базы противников (`axes`; тест требует, чтобы каждая ось `scenarios/enemies.json` принадлежала ровно одной записи), модель, правила валидатора, карточки механик, источники (файлы PoB из `mechanics/sources.json` или ссылки Wiki как `community_wiki`, без загрузки). Команда: `mechanic gaps [id] [--status S] [--axis A] [--full]`. Реестр читается напрямую, `mechanic build` не нужен.
- Приближённые модели `scripts/mechanic-models.mjs` (чистая арифметика над одним результатом PoB, движок не запускают, числа PoB не меняют):
  - `recoup_sustain` (medium): устойчивое восстановление recoup = recoup% × урон за секунду (`totalTakenHit / enemySkillTime`), длительность 3/4 с из `TotalLifeRecoupRecovery / LifeRecoupRecoveryMax`, покрытие входящего урона без и с recoup, урон первого окна до recoup; для дегена неприменимо (PoB: recoup только от ударов).
  - `on_kill_explosions` (low): урон взрыва = % здоровья противника × (1 − резист цели; для обычных монстров 0, если encounter не задал `enemy<Type>Resist`), доля здоровья normal/magic того же уровня, сколько взрывов normal нужно на normal (цепь). Модификаторы игрока и дебаффы цели не применяются.
  - `thorns_retaliation` (low): flat-thorns из текста мода × `<Type>TakenReflect` (элемент — худший), срабатываний до пустого пула, сколько срабатываний в секунду держит восстановление; какие удары игрока вызывают thorns — не проверено.
  - `degen_tolerance` (low): максимальный дегген по типу = восстановление / (1 − резист), рядом `<Type>DotEHP` PoB для сравнения.
- Вывод: `analyze encounter` — блок `approximations` верхнего уровня (не внутри `damage`/`defence`), в Markdown — раздел «Приближённые модели вне PoB (WP9)». `analyze report` — `approximations` для первого rare-противника, thorns по модам старшего тира `--sweep-tiers`. Прежнее поле `damage.on_kill_explosions` оставлено для совместимости (без резистов и сравнения с паком).
- Валидатор `scripts/mechanic-validate.mjs` (для генератора WP5: `validatePrototype(spec)`, `specFromInspect(inspect, run)`), команда `mechanic validate <prototype.json|build.xml> [--run] [--rules a,b] [--out f.json]`. Правила: `profane_bloom_curse`, `curse_limit`, `blasphemy_hex`, `ci_life_recovery`, `eb_mom_shared_pool`, `corpse_source`, `ascendancy_budget`, `config_charge_sources`. Статусы `pass|fail|warn|unknown|not_applicable`; `unknown` = в прототипе нет поля, это не «ок». Для XML keystones и узлы восхождения берутся из активного tree spec (дерево GGG 3.30), `--run` добавляет источники взрывов, curse limit, восстановление и очки восхождения из PoB. Списки проклятий/генераторов зарядов — статические, дерево и предметы как источник зарядов не распознаются (`warn` с подсказкой `charge_sources`).
- Тест: `test/mechanic-gaps.test.mjs`.

### Этап 6: анализ прогрессии гайда (`analyze progression`)

- Модуль `scripts/analysis-progression.mjs`: `progression <xml> [--stages f.json] [--plan] [--md f.md] [--out f.json] [--concurrency N] [--scenario S]`.
- Этапы берутся из tree specs / item sets / skill sets. Ведущий список — самый длинный (при равенстве tree specs). Сопоставление: метка `{n}` -> одинаковое название -> последний набор, начатый не позже конца этапа -> самый ранний набор -> по порядку. Правило печатается в отчёте, у каждого набора указано, каким правилом он выбран.
- Main socket group для каждого skill set: группа с основным скиллом сборки, иначе группа с наибольшим числом supports. Переопределение — `main_socket_group` в `--stages`.
- Уровень персонажа: число из названия (`Level 40`, `Lvl 1-12` -> верхняя граница), иначе оценка по очкам основного дерева с квестовыми очками по актам (2/5/7/8/10/13/16/19/21/24), зажатая в диапазон этапа; оценки помечены `~`.
- Кампания: rare и unique (заменитель босса акта, без его скиллов) на area level конца акта. `resistancePenalty`: 0 в актах 1-5, -30 в актах 6-10, -60 после Kitava в Act 10 и в картах. Если в названии есть "End of Act N", этап считается пройденным после убийства босса этого акта.
- Карты: early maps — T5 (rare, map boss), maps — T10, early endgame — T16, endgame — T16/T17 и pinnacle, final — плюс uber. Моды карт не применяются.
- По каждому этапу выводятся DPS, TTK, число ударов до смерти, самый слабый max hit, резисты относительно капа (`Missing*Resist`), life/ES, `mana_sustain`, `engine_warnings` (требования, мана) и `skill_disabled_reason`. Также проверяется бюджет очков дерева по актам и регрессии между соседними этапами (DPS -15%, life+ES -10%, max hit -20%, резисты, мана).
- `--stages`: список `{label, tree_spec, item_set, skill_set, character_level, area_level, main_socket_group?, resistance_penalty?, enemies?}`. `tree_spec` — номер по порядку, `item_set` и `skill_set` — id из PoB.
- Ограничения. Уровни актов и квестовые очки приблизительные. Гемы, флаконы и конфигурация гайда не корректируются. Если в гайде нет набора предметов для кампании, берётся ближайший более поздний (правило `earliest_later`), и это видно в отчёте.

### Этап 7: игровые наблюдения (калибровка)

- Модуль `scripts/observations.mjs`; хранение — append-only `builds/<id>/observations.jsonl` (локально, не в git). Сборка должна существовать (`loadBuild`).
- `observe add <id> --file obs.json` или флаги: `--kind death|boss_kill|map_clear|sustain_issue|note`, `--map-tier`, `--mods a,b`, `--boss`, `--boss-tier`, `--enemy`, `--killed-by`, `--damage-type`, `--ttk`, `--deaths`, `--calculation-id`, `--pob-sha256`/`--pob-file`, `--date`, `--notes`. Неизвестное = null; неизвестные поля — ошибка.
- `observe list <id> [--kind K]`; `observe compare <id> --report analysis.json` принимает вывод `analyze encounter|report|mapmod-sweep`.
- Сопоставление: босс + скилл (`killed_by`) → строка boss skill (strong); тир карты + архетип + моды → строка матрицы (weak); моды карты → строки sweep (weak).
- Проверки: смерть при `survives_hit`/`sustains_degen` → противоречие; смерть при `one_shot`/`dangerous` → согласие; тип урона против `dominant_type`; TTK observed/predicted в 0.67–1.5 → согласие. Пережитый one-shot — inconclusive (уклонение).
- Если `calculation_id` наблюдения не совпадает с расчётом отчёта — `different_character_snapshot`. Строки матрицы `report` содержат `calculation_id` (с 24.11.2026).
- Это инструмент калибровки, не доказательство: одно событие — одна выборка.

### Основы билда, нормы корпуса, полнота и таксономия механик (WP5b/WP9, 24.11.2026)

- `BuildCard.foundation` (`scripts/build-foundation.mjs`, схема `foundation/1`): источник маны и жизни (leech/regen/on-hit/recoup, баланс в секунду), запас атрибутов над требованиями (ReqStr/ReqDex/ReqInt PoB), masteries с текстом эффекта, eldritch implicits, cluster jewels, анойнт, автофлаконы, keystones. Только числа и XML PoB.
- `corpus norms [--ascendancy A] [--skill-tag attack|spell|minion] [--form hit|dot] [--backfill]`: нормы по карточкам корпуса с фильтром качества; `--backfill` дозаполняет старые карточки (один кэшированный расчёт PoB на билд). `corpus norms --check <xml>`: отклонения одного билда как предупреждения; группа норм выбирается так: восхождение+тип скилла, затем тип скилла, затем восхождение, затем весь корпус (не меньше 8 билдов). Нормы описывают популярные гайды, а не оптимум.
- `design generate --seed both|only|none` (по умолчанию `both`): кроме прототипа с нуля строится посевной — дерево, предметы, jewels, флаконы, masteries и вспомогательные группы ближайшего билда корпуса того же восхождения (`scripts/design-seed.mjs`), заменяется только основная группа; supports пробует PoB, кнопки считаются по флагам PoB. Неразобранные моды авторских предметов — не жёсткий отказ. В `design verify` посев выключен, чтобы эталон не просочился. Прототипы с нуля оставляют резерв очков под masteries (медиана нормы), эффекты пробует PoB (`probeMasteries`). В каждом прототипе есть блок `foundation` со статусом и предупреждениями.
- `analyze coverage <xml>`: аудит неиспользованных слоёв силы (свободные очки, masteries без эффекта, пустые гнёзда jewels, абиссальные гнёзда и гнёзда камней, пустые слоты и флаконы, анойнт, eldritch, открытые аффиксы без крафта, качество, камни ниже 20/20, проклятие, свободная мана, movement/guard, Pantheon) с командой, которая оценивает каждый пробел. `gap` — неиспользованная сила, которую надо измерить; `check` — может быть осознанным выбором.
- Посев учитывает бюджет запроса в divine: нижняя граница цены уников семени (самый дешёвый вариант в снимке, `divineValue` poe.ninja, рынок PC как допущение) выше бюджета — семя идёт после всех семян в бюджете (иначе сила семени объясняется его экипировкой, а не архитектурой). Каждый прототип получает новизну относительно корпуса (`noveltyScore`), она — ось Pareto (`--no-novelty` выключает).
- `design optimize <xml> [--metric balanced|dps|ehp] [--rounds 3] [--keep 0.97] [--out new.xml]` (WP6): обмены узлов дерева, посчитанные PoB (removeNodes/addNodes в одном процессе), лучший допустимый обмен за раунд применяется настоящей правкой; узлы с условиями помечаются `check_conditions`.
- `design reverse "<цель regex>" [--xml билд]` (WP8): все источники цели в локальных данных с ценой пути; ценность каждого пути затем меряется PoB.
- `corpus principles [--record N]` (WP7): условные кандидаты принципов по абляциям корпуса, с опорами и контрпримерами; в `lab` записываются как гипотезы.
- `mechanic taxonomy [--uncovered|--unparsed|--vars] [--search t] [--refresh]`: машинный список механик из `vendor/pob/src/Data/ModCache.lua` (имена модов, переменные условий, неразобранные и частично разобранные строки) и покрытие карточками и реестром пробелов (ключевые слова плюс явные правила `NAME_RULES`). Кэш — `cache/mechanic-taxonomy.json`, пересчитывается при изменении ModCache или `cards.json`. После добавления карточки — `mechanic build`.

## Дерево, прокачка, изменения 3.30 и мета

Модули сессии 2 регистрируются через `scripts/data-cli.mjs` (`tree`, `leveling`, `changes`, `meta`; полный синтаксис — `agent.mjs help`). Запросы офлайн; сеть нужна только явному `fetch-game-data.mjs`.

- **Граф дерева** (`tree-graph.mjs`): закреплённый GGG tree 3.30.0 (`research/330/ggg-passive-tree.json`, sha256 сверяется с `cache/knowledge/manifest.json`). Правила обхода как в PoB 2.68.1 `BuildAllDependsAndPaths`: связи out+in, путь не входит в class/ascendancy start, не выходит из mastery, не пересекает восхождения; proxy (cluster), blighted, historical и неподтверждённая Velka исключены. `tree path --from Witch --to "Elemental Equilibrium"` — 0-1 BFS от старта и уже взятых узлов (`--allocated`, `--xml` 3_30); несколько целей — минимум по порядкам (до 6 целей), иначе жадно (не доказанный Steiner-оптимум). Ascendancy/bloodline считаются отдельной секцией. Выход `allocate[]` — список node id для `--changes tree`; mastery требуют выбора эффекта (`mastery_choices_required`). Неоднозначное имя (например, `Life Mastery`) разрешается ближайшим узлом с пометкой. `tree cost` проверяет связность и бюджет (123/8), `tree near` — радиусы PoB 3_16 (small 960 … massive 2880; Timeless — large), `tree search` — по имени/тексту статов (разметка `[Id|Text]` GGG очищается), `tree node`, `tree classes`. Ценность узлов и требования не оцениваются.
- **Прокачка** (`fetch-game-data.mjs leveling` → `cache/wiki/*.json` с sha256 и revid → `build-leveling.mjs` → `data/leveling-3.30.json` → `leveling.mjs`): Wiki Cargo `quest_rewards` (529 строк) и `vendor_rewards` (1308), страница Vendor recipe system (рецепты, `leveling_relevant` — эвристика по ключевым словам). Квестовые камни сверены с клиентскими данными RePoE 3.30 (`gems.quest_reward`): статус `client_check`, расхождения в `source_conflicts` (17, не разрешаются). `classes: ["all"]` — строка без ограничения класса (Siosa после A Fixture of Fate, Lilly Roth в Act 6). `leveling gems --class Witch --act 1` группирует по квестам: `reward_choice` (взять один) и `vendor` (покупка). `leveling books` — 23 строки Book of Skill; бандиты в таблицах отсутствуют, и 24 квестовых очка из GGG `points` не сведены с этим числом. `leveling uniques --max-level N` — эвристический список доступных уникальных предметов по требуемому уровню, не рекомендация.
- **Изменения 3.29 → 3.30** (`patch-changes.mjs build` → `data/changes-3.30.json`): diff PoB TreeData 3_29/3_30 (215 узлов: added/changed/relinked), уникальные предметы с `Pre 3.30.0` в PoB (11 — PoB ведёт историю не для всех), строки официальных patch notes с Wiki-страниц Version 3.30.0–3.30.0d (821 строка, ссылки на сущности из `[[...]]`/`{{il|psl|sl|ml}}`). `changes get <entity>` объединяет все три источника; `no_record` не доказывает отсутствия изменений (числа камней 3.29 не сохранены, `gems: omitted`). Diff дерева и patch notes могут расходиться (пример: Master Toxicist описан в notes, но совпадает в PoB 3_29/3_30) — показывать оба. `changes card` — чек-лист проверки старого гайда.
- **Мета** (`meta.mjs build` → `data/meta-research.sqlite`): `research/verified-builds.json`, `additional-builds.json`, `sources.json` (300), `FINDINGS.md` по разделам и агрегаты цен SkillGem/Unique из дампов poe.ninja Allflame и Hardcore Allflame (лига 3.29, 2026-07-24…2026-11-11; медиана/первая неделя/последнее значение по High-confidence). Каждый ответ несёт предупреждение: корпус собран 12.11.2026, до релиза 3.30.0 (13.11.2026), цены — не популярность и не 3.30. `stale: true` у билдов с PoB не 3.30. Пересборка читает 330 МБ CSV (~4 с) и требует локальной папки `research/` (не публикуется).
- **Timeless jewels** (проверено без загрузки): установлен только Glorious Vanity (5 частей zip + распакованный `.bin` 51 МБ). `setup-pob.mjs --timeless <Type>` принимает `GloriousVanity, LethalPride, BrutalRestraint, MilitantFaith, ElegantHubris` (≈0.8–2.4 МБ каждый по Git-метаданным закреплённого commit). PoB 2.68.1 содержит ещё `HeroicTragedy.zip` (2.1 МБ) и пять Abyss-баз (`AbyssTecrod/Ulaman/Kurgal/Amanamu/Zorath`, 26–28 МБ каждая, по 6 частей), но текущий список скрипта их не допускает. Установка — только после согласия пользователя.

## Состояние

`build show main` возвращает ревизию. Для записи требований: `build update main --file requirements.json --expected-revision N`. Например, структура patch: `{"profile":{"trade_mode":"trade"}}`; это только пример формата, не предпочтение пользователя.

Решение записывается через `build decision`; поля: `statement`, `reason`, `evidence[]`, `status` из accepted/rejected/deferred. Пустое evidence у отложенной гипотезы не является доказательством. `build calculate main --file <PoB.xml> --expected-revision N` сохраняет входной XML и результат отдельно от краткого состояния.

При конфликте ревизий перечитать и совместить изменения. `.write-lock` защищает запись; оставшийся после аварии lock удалять вручную лишь убедившись, что писатель завершён. История и подробные расчёты не включаются в стартовый контекст целиком. Подробная методика — в BUILDING.md.

## Установка, обновление и восстановление

Первичная установка зависимостей: `npm ci --ignore-scripts`. Закреплена `fast-xml-parser` 5.12.1 с транзитивными зависимостями; install scripts не запускаются. `node scripts/setup-pob.mjs` получает нужные файлы commit `a41fec6c20f822a658ae5df1273e8c69d5969bac`, проверяя Git blob SHA-1 и SHA-256. `--cached-only` проверяет уже полученные файлы без сети. Лицензия — `vendor/pob/LICENSE.md`.

Перед обновлением: `agent.mjs backup before-update`. Сохраняются четыре согласованные копии SQLite, состояние, код, инструкции, необходимые исходники, реальные XML, ответы рынка и установленный runtime/зависимости. Открыть копию отдельным проектом и запустить `doctor --deep` до замены рабочего проекта. Диагностика проверяет также хеши ценовых снимков/ответов, целостность XML и соответствие отчётов ссылкам библиотеки. Наличие папки само по себе не доказывает успешного восстановления.

После изменения источников пересобрать нужные базы, выполнить тесты и глубокую диагностику, проверить разницу. Lock менять после проверки. Для нового патча сохранять отдельную область; старые результаты привязаны к старой версии.

## Текущее покрытие

Готов цикл поиска, чтения механик, расчёта, сравнения и сохранения решений. Помимо трёх синтетических примеров есть три авторских архива 3.29 и три явных локальных переноса на 3.30: Toxic Rain Pathfinder, Poison SRS Necromancer и Tornado Inquisitor. Пересчитан выбранный комплект каждого, без утверждения о проверке всех стадий или актуальности авторской загрузки. Один старый неполный импорт Tornado изолирован как `quarantined`. У SRS сохранено предупреждение о требовании Dexterity для Haste.

Предыдущие версии локальных переносов хранятся как `historical` со статусом `superseded_local_migration` и ссылкой на замену. Отчёты в `reports/references/calculations/` привязаны к calculation ID, поэтому обновление библиотеки сохраняет основания старых записей. Короткие файлы по имени архетипа — только указатели на последний прогон. Сохранённые свидетельства сопоставления авторов/URL лежат в `references/provenance/`; исходное время получения архивов неизвестно.

Рынок: 28 761 наблюдение в десяти категориях, полученных 23 ноября 2026 из публичного economy API poe.ninja для Covens/PC. `node scripts/fetch-economy.mjs --cached-only` проверяет/импортирует кэш без сети; без флага запрашивается явное обновление с HTTP-кэшированием. Builds/profiles API не используются. `price get Mageblood --variant "4 Flasks"` выбирает конкретный вариант; отсутствие полей corruption не означает false. По умолчанию берётся последний полный снимок категории; `--history` раскрывает старые. Обнаружено расхождение курсов между Currency и item-категориями: предупреждение запрещает молча считать их единым курсом. Дата получения ответа и время исходной рыночной выборки различаются.

Есть восемь условных рецептов верстака с исходной стоимостью и проверкой действия/класса базы. Конкретный предмет, открытие рецепта, свободный аффикс и конфликты проверяются отдельно. Полного симулятора Craft of Exile, Harvest/Bestiary/vendor-каталогов и игровых проверок пользовательских билдов пока нет. Полнота получения и Foulborn не доказана. Текущее состояние — `reports/environment-progress.json`, проверка — `reports/environment-validation.json`.
