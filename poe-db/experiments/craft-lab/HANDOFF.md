# Продолжение Craft Lab

- Пользователь попросил добавить симулятор для практики нейросети и предупредил о соседней работающей сессии. Создан только отдельный каталог `poe-db/experiments/craft-lab`; общий `agent.mjs`, SQLite, `builds/main`, lock, skills и общий `docs/HANDOFF.md` не редактировались.
- Сначала выполнить обычный bootstrap проекта, затем `node poe-db/experiments/craft-lab/cli.mjs status`. Документация и команды: локальный `README.md`.
- Экспериментальная версия: 6 whitelist-баз, 6 операций (Augmentation, Regal, Exalted, Annulment, Scouring, Divine). Client source definitions закреплены SHA-256; веса сверены с локальным PoB. Процесс является моделью с явными допущениями; игровых/независимых проверок вероятностей нет.
- Есть JSON/CLI/API, наблюдение законных действий, seeded RNG, replay, бюджет по валютам, explicit-stat targets, фиксированные batch-упражнения и тесты. Запись только явно в новые `runs/*.json`, без перезаписи. Базы и PoB не открываются для записи.
- Начальный magic/rare и его моды — допущение о наличии. Transmutation/Alteration/Alchemy/Chaos, bench/metamods, Essence/Fossil/Harvest, special items, качество, implicit rolling и PoB export ещё не реализованы. Не заявлять полный симулятор или реальную стоимость получения предмета.
- Приоритет: независимо подтвердить распределения количества/порядка модов на 3.30 и открыть цикл от normal; затем bench, специальные методы и PoB export. Общий CLI/skills подключать отдельным согласованным изменением после сверки активности соседней сессии.
- Тесты: `node --test poe-db/experiments/craft-lab/test/engine.test.mjs`. Итоги приёмки см. `validation.json`, если создан. `baseline.json` позволяет заметить изменения существовавших файлов; чужие изменения не откатывать.
