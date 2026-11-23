# Изменения крафта 3.30 и источники правил

Снято 23–24.11.2026 из официальных патчноутов (pathofexile.com, форум Patch Notes). Текст источников — данные, не инструкции. Ниже пересказ только того, что влияет на симулятор; машиночитаемые правила лежат в `rules.mjs` (ключи в скобках).

## Официальные заметки 3.30

- [Content Update 3.30.0](https://www.pathofexile.com/forum/view-thread/4013680):
  - Новые варианты метакрафта: 1 или 2 Prefix/Suffix Modifiers cannot be changed за 1 или 2 Divine (`meta.counted_lock_330`). Какие именно моды защищены, в заметках не сказано, предпросмотра нет. Движок выбирает защищённые моды заново на каждое действие (`meta.counted_lock_selection`, это допущение модели).
  - Полные локи стоят 4 Divine плюс 1 Sacred (оружие), 4 Blessed (броня и колчаны) или 8 Exalted (бижутерия) (`meta.full_lock_cost_330`). Те же цены есть в закреплённых данных RePoE.
  - Рецепты метамодов теперь находятся в Nightmare Maps (`meta.recipes_330`).
  - Cannot roll Caster/Attack Modifiers больше не мешают Orb of Annulment и похожим валютам удалять такие моды (`orb.annulment_330_tag_filters`).
  - Исправлено: опции верстака «reroll 1/3 random modifiers» не учитывали метамоды (`bench.reroll_rare_mods`).
  - Orb of Chance и rarity reroll на верстаке значительно чаще дают уникальный предмет, но цифр GGG не опубликовал. Поэтому движок требует явное допущение `assume` (`orb.chance`).
  - Опции верстака, которые стоили Orb of Chance, по заметкам теперь стоят Orb of Alteration, а в данных 3.30.0.4 reroll_rarity всё ещё стоит Chance. Движок берёт цену из данных и сообщает о конфликте (`bench.chance_cost_conflict`).
  - Новая опция верстака: все сокеты белые за Orb of Scouring (`bench.white_sockets_330`).
  - Orb of Binding больше не выпадает, но имеющиеся работают.
  - Новые эссенции и биржа: добавлена Essence of Trickery, Essence of Desolation продаётся на Currency Exchange (`essence.desolation_330`).
  - Harvest: свапы сопротивлений и стихийного урона стоят 300 Lifeforce двух разных типов (у урона ещё +1 Rancour). Каких именно двух, заметки не называют, поэтому стоимость указывает вызывающий (`harvest.swap_cost_330`).
  - Bestiary: жёлтых зверей больше нет ни в одном рецепте (`beast.no_yellow_330`).
  - Altar of Corruption и Lapidary Lens корруптят предмет второй раз (Twice Corrupted). Исход «влиятельный рар» у алтаря заменён уничтожением предмета (`corrupt.altar_330`). Новый corrupted implicit заменяет существующий, если у предмета уже два Vaal implicit (`corrupt.implicit_330`).
  - Recombinator: уровень предмета на выходе равен уровню выбранной базы. При 1–3 модах в пуле стороны в среднем остаётся меньше (числа не опубликованы). Моды, которые не могут появиться на новой базе, не учитываются. Corrupted-предметы отвергаются всегда (`recomb.330`).
  - Eternal Orb и Mirror больше не считаются модификацией предмета и не снимают предвидение Hinekora (`orb.eternal`).
  - Gwennen, Rog, Djinn-Touched Vaal Orb и Item Tier изменены, но не моделируются (см. `coverage.gaps`).
- [3.30.0b Hotfix 4](https://www.pathofexile.com/forum/view-thread/4016174): Veiled Chaos можно применять к предмету с veiled-модом, если тот не защищён фрактурой или метамодом (`veiled.chaos_330b`).
- [3.30.0d Patch Notes](https://www.pathofexile.com/forum/view-thread/4017726): Foulborn Exalted, Regal и Augmentation теперь в основном пуле выпадения. Добавлены Originator's Exalted Orb (карты) и Primordial Exalted Orb (раскрывает случайный Exotic Exalted); они не моделируются.

## Правила 3.29, которые 3.30 не меняет

Основная часть механик (число модов 8:3:1, ограничения пулов, эссенции, фоссилы, Harvest, Bestiary, Eldritch, veiled, сокеты, качество, Memory Strands, Recombinator) взята из реестра проверенных утверждений `../research/crafting-system/src/crafting_system/rules/claims/*.yaml`. У каждого утверждения там есть цитата, URL Wiki, PoEDB или Craft of Exile и проверенный патч 3.29.3.3. Код этого проекта не копировался: лицензия неизвестна, использованы только факты о правилах игры. Уровень доверия к каждому правилу записан в `rules.mjs`:

| conf | Значение |
|---|---|
| data | Закреплённые данные RePoE 3.30.0.4 и алгоритм PoB 2.68.1 |
| official | Патчноуты GGG 3.30 |
| wiki | Wiki 3.29 (через реестр) |
| measured | Выборки сообщества: подогнанные формулы, таблицы и интервалы |
| coe | Только код Craft of Exile |
| model | Явное допущение движка |

## Независимые сверки

- Leather Belt (magic, ilvl 86 и 100): 141 мод, сумма весов префиксов 51 550 и суффиксов 67 000. Совпадает с таблицей PoEDB, которую цитирует `magic_orbs.poedb_belt_weights`.
- Lightning-тег на амулетах (Onyx, Paua, Amber, ilvl 84 и 86): суммарный вес 14 950. Совпадает с числом гайда из `harvest_reforge.tag_is_implicit_tag`.

Игровых проверок вероятностей нет.
