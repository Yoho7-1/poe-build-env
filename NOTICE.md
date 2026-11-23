# Third-party data and licenses

The MIT license in `LICENSE` applies only to this project's own code and documentation. The following material keeps its original terms. Exact source URLs, commits and SHA-256 hashes are recorded in `poe-db/cache/manifest.json`, `poe-db/cache/knowledge/manifest.json`, `poe-db/mechanics/sources.json` and `poe-db/vendor/pob-source.json`.

| Material | Where | Source | Terms |
|---|---|---|---|
| Uniques catalog, item mods/stats (`poe-3.30.sqlite`, `uniques-3.30.jsonl`, parts of the data release) | data release | [PoE Wiki](https://www.poewiki.net/) Cargo API | [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/) (as reported by the API, `cache/wiki-rights.json`). Attribution: PoE Wiki contributors. Non-commercial; derivatives under the same license. |
| Game data export (`knowledge-3.30.sqlite`, `data/knowledge/*.jsonl`) | data release | [RePoE fork](https://repoe-fork.github.io/), PoB data export | See the respective projects; underlying game data (c) Grinding Gear Games |
| Passive and atlas trees (`research/330/ggg-passive-tree.json`) | git | [grindinggear/skilltree-export](https://github.com/grindinggear/skilltree-export), [atlastree-export](https://github.com/grindinggear/atlastree-export) | Official export by Grinding Gear Games |
| Path of Building Community 2.68.1 (headless subset) | downloaded by `setup-pob.mjs`, not redistributed | [PathOfBuildingCommunity/PathOfBuilding](https://github.com/PathOfBuildingCommunity/PathOfBuilding) | MIT, see `poe-db/vendor/pob/LICENSE.md` after install |
| Price observations (`workbench-3.30.sqlite`, `cache/research`) | data release | public economy API of [poe.ninja](https://poe.ninja/) | Dated snapshot for reference; credit poe.ninja |
| Reference PoBs (`poe-db/references/originals`, `migrated`) | git | public build guides by their authors (PathofEvening, BalorMage, Shads404; see `references/provenance`) | Authors' work, kept for analysis with attribution; ask the authors for any other use |
| `fast-xml-parser` | installed by npm | npm | MIT |

Path of Exile and all related names, text and data are (c) Grinding Gear Games. This is an unofficial fan project, not affiliated with or endorsed by Grinding Gear Games. Because the data release contains CC BY-NC-SA material, the published data release as a whole is distributed under CC BY-NC-SA 3.0 and must not be used commercially.
