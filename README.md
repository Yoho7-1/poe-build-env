# PoE 3.30 build environment for AI agents

Local, offline toolkit that lets an AI coding agent (Codex, Claude Code, etc.) design and audit **Path of Exile 1 / 3.30 / Softcore** builds with real data instead of memory:

- SQLite knowledge base: 98 870 records in 40 sections (gems by level, mods, bases, tree, ascendancies, bloodlines, essences, fossils...), uniques catalog filtered by 3.30 availability, 40 mechanic cards with sources;
- headless **Path of Building 2.68.1** runner: import, scenarios (`sustained`, `burst`, ...), compare, explicit 3.28/3.29 -> 3.30 tree migration;
- dated price snapshots (poe.ninja), craft-bench recipes, audited reference PoBs;
- versioned build state with decisions and evidence; agent skills in `.agents/skills`.

Documentation is in Russian; game terms stay in English. Entry point for agents: [`AGENTS.md`](AGENTS.md).

## Requirements

- Windows x64 (the PoB runner uses the bundled LuaJIT `lua51.dll` via PowerShell);
- Node.js >= 24, PowerShell 7 (`pwsh.exe`), Git;
- ~1.5 GB free disk after setup.

## Install

```powershell
git clone https://github.com/Yoho7-1/poe-build-env.git PoE-env
cd PoE-env
node poe-db/scripts/setup.mjs --deep
```

The data archive is downloaded anonymously from the public release. If the repository is made private, ask the owner for collaborator access, install [GitHub CLI](https://cli.github.com/) and run `gh auth login`: `setup.mjs` then falls back to `gh release download`. Offline alternative: `setup.mjs --archive <file>`.

`setup.mjs` downloads the data snapshot pinned in `poe-db/data-release.json` from GitHub Releases and checks its SHA-256, runs `npm ci --ignore-scripts`, fetches the pinned PoB commit, creates an empty build `main` and runs `doctor`. Nothing already present is overwritten. After that everything works offline.

## Use

```powershell
.\poe.ps1 bootstrap
.\poe.ps1 query knowledge gem Fireball --level 20
.\poe.ps1 mechanic get resource-sustain --related
.\poe.ps1 pob run poe-db/fixtures/fireball-control.xml --scenario sustained
```

Point your agent at the folder and tell it to read `AGENTS.md`.

## Update

```powershell
git pull
node poe-db/scripts/setup.mjs
```

Code, skills and mechanic cards come with `git pull`. When a new data snapshot is published, `data-release.json` changes; move the old `poe-db/data` aside (or delete it) and rerun `setup.mjs`. Your `builds/` stay local and are never committed. Maintainers: see [`RELEASING.md`](RELEASING.md).

## Licenses

Code: [MIT](LICENSE). Data is **not** covered by the code license: PoE Wiki content is CC BY-NC-SA 3.0 (non-commercial, share-alike), Path of Building is MIT, game content belongs to Grinding Gear Games. Details: [`NOTICE.md`](NOTICE.md). This is an unofficial fan project, not affiliated with or endorsed by Grinding Gear Games.

---

## Кратко по-русски

Локальное окружение, с которым нейросеть-агент собирает и проверяет билды PoE 1 3.30 по реальным данным и расчётам PoB, а не по памяти. Установка — три команды выше (Windows, Node.js 24+, PowerShell 7, Git), дальше работает без сети. Обновление — `git pull` и повторный `setup.mjs`. Личные билды хранятся в `builds/` и в репозиторий не попадают. Инструкции для агента — `AGENTS.md`, методика — `poe-db/docs/BUILDING.md`, устройство — `poe-db/docs/ENVIRONMENT.md`.
