# Craft Lab v2: продолжение

- Вход: `node poe-db/experiments/craft-lab/v2/cli.mjs status`, затем `coverage`. Команды и JSON описаны в `README.md`, источники и изменения 3.30 — в `SOURCES-3.30.md`, правила с уровнем доверия — в `rules.mjs` (`cli rules --match <text>`).
- Устройство: `catalog` (закреплённый RePoE, связи Elevated) → `item` (состояние, ёмкость, метамоды) → `draw` (пулы, тиры, срез Strands/Foulborn, reforge) → `actions/basic|crafts|special` → `actions.mjs` (диспетчер, Hinekora, расход Strands) → `session` (replay, цели, observe). Каждый шаг пишет в историю `rules` и `notes`.
- Проверено (24.11.2026): 19/19 тестов v2; прогон всех 782 рецептов верстака, всех применимых эссенций и фоссилов без программных ошибок; фаззинг около 1350 шагов. Веса пула совпали с двумя независимыми опубликованными числами (Leather Belt 51 550 / 67 000, Lightning на амулете 14 950). Игровой проверки нет.
- Неизвестные шансы не подставлять: Chance и rarity reroll требуют `assume`, стоимость свапа задаёт вызывающий. Выбор мода для частичного лока, ветви Tainted и сокращение у Recombinator в 3.30 — явные допущения (`conf: model`).
- Пробелы перечислены в `coverage.gaps`: уникальные предметы, Gwennen/Rog, Djinn/Lapidary, Synthesis/Fog, системы энчантов, базовые защиты/Sacred, Allflame/Ducat/Threads. Не менять `complete` на true без игровой проверки.
- Следующие шаги: сравнить распределения с актуальным Craft of Exile на контрольных маршрутах; добавить уникальные предметы из `poe-3.30.sqlite`; подключить команду к `agent.mjs` и навыкам; сверить экспорт с `pob run` на реальном билде.
