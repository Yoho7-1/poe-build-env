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
- `analysis-core.mjs`: метрики (dps, fulldps, ehp, maxhit, life, es, mana_sustain), один calculation contract на пакет, кэш `cache/analysis` по ключу (контракт + изменение). `analysis-rank.mjs`: ранжирование за очко, trade-offs, цены без сложения при `inconsistent_currency_conversion`. `analysis-upgrades.mjs`: формат `--candidates` и пакеты с проверкой конфликтов слотов/конфига. `analysis-nodes.mjs`: кандидаты узлов по графу (граф подставляется), пробы статов через `custom_mods`.
- `eval list|show|prompts|template|score --answers f`: прогон `evaluations/cases.json`. Промпты слепые (без критериев), автоматические сигналы — только подсказка, итог pass/partial/fail ставит человек.

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
