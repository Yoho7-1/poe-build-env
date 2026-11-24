# Как выпускать обновления

Репозиторий разделён на две части:

| Что | Как публикуется | Как получают пользователи |
|---|---|---|
| Код, навыки, карточки механик, документация, фикстуры, справочные PoB | обычные коммиты | `git pull` |
| Снимок данных (`poe-db/data`, `poe-db/cache`) | архив в GitHub Release, закреплён в `poe-db/data-release.json` | `setup.mjs` скачивает и проверяет SHA-256 |
| PoB 2.68.1 | не публикуется | `setup-pob.mjs` берёт закреплённый commit из `environment.lock.json` |

## Обновление кода

1. Внести изменения, из `poe-db` выполнить `node --test` и `node scripts/agent.mjs doctor --deep`.
2. Проверить `git status`: в коммит не должны попасть `builds/`, `KNOWLEDGE.md`, `HANDOFF.local.md`, абсолютные пути и имя пользователя. Быстрая проверка: `git grep -n -i "C:\\\\Users"`.
3. Коммит и `git push`.

## Новый снимок данных

1. Пересобрать данные (`fetch*`, `build*`, `mechanics:build`, `examples:seed`), выполнить тесты и `doctor --deep`, при необходимости обновить `environment.lock.json`.
2. `node poe-db/scripts/data-pack.mjs --tag data-3.30-YYYY-MM-DD` — создаёт `dist/poe-<tag>.tar.gz` и обновляет `poe-db/data-release.json` (тег, имя файла, SHA-256, размер).
3. Создать на GitHub Release с этим тегом и приложить архив (лимит 2 ГБ на файл). В описание релиза добавить: «Data: CC BY-NC-SA 3.0, see NOTICE.md».
4. Закоммитить `poe-db/data-release.json` и запушить. Пока коммит не запушен, пользователи получают предыдущий снимок.

Через `gh` (если установлен):

```powershell
gh release create data-3.30-YYYY-MM-DD dist/poe-data-3.30-YYYY-MM-DD.tar.gz --title "Data 3.30 YYYY-MM-DD" --notes "Data: CC BY-NC-SA 3.0, see NOTICE.md"
```

## Новый патч (например 3.31)

По правилу проекта нужен отдельный снимок и явная миграция. Новые базы получают новое имя (`*-3.31.sqlite`), релиз — тег `data-3.31-...`. Старый тег не удалять: по нему воспроизводятся старые расчёты.

## Первая публикация

1. Создать пустой репозиторий на GitHub (без README/LICENSE).
2. В `poe-db/data-release.json` указать `"repository": "owner/name"`.
3. `git remote add origin https://github.com/owner/name.git`, `git push -u origin main`.
4. Выпустить первый снимок данных по шагам выше.
