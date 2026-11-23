PRAGMA foreign_keys=ON;
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE sources (id INTEGER PRIMARY KEY, url TEXT NOT NULL, cache_file TEXT NOT NULL, sha256 TEXT NOT NULL, obtained_at TEXT NOT NULL) STRICT;
CREATE TABLE items (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, page_name TEXT NOT NULL UNIQUE,
 base_type TEXT, base_item_id TEXT, item_class TEXT NOT NULL, metadata_id TEXT,
 game TEXT NOT NULL CHECK(game='poe1'), patch TEXT NOT NULL CHECK(patch='3.30'),
 league TEXT NOT NULL, language TEXT NOT NULL, snapshot_id TEXT NOT NULL,
 required_level INTEGER, required_strength INTEGER, required_dexterity INTEGER, required_intelligence INTEGER,
 release_version TEXT, is_replica INTEGER, is_corrupted INTEGER, is_drop_restricted INTEGER,
 availability_basis TEXT NOT NULL, availability_confidence TEXT NOT NULL,
 acquisition_text TEXT, implicit_text TEXT, explicit_fixed_text TEXT, enchantment_text TEXT,
 random_options_json TEXT NOT NULL, source_url TEXT NOT NULL, wiki_page_id INTEGER NOT NULL,
 raw_source_json TEXT NOT NULL
) STRICT;
CREATE INDEX items_by_name ON items(name);
CREATE INDEX items_by_class ON items(item_class);
CREATE TABLE modifiers (
 row_id INTEGER PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id),
 mod_id TEXT, text TEXT, is_random INTEGER, is_implicit INTEGER, is_explicit INTEGER, is_enchantment INTEGER,
 raw_source_json TEXT NOT NULL
) STRICT;
CREATE INDEX modifiers_by_item ON modifiers(item_id);
CREATE TABLE stats (
 row_id INTEGER PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id),
 stat_id TEXT NOT NULL, mod_id TEXT, min_value REAL, max_value REAL, source_average REAL,
 is_random INTEGER, raw_source_json TEXT NOT NULL
) STRICT;
CREATE INDEX stats_by_id ON stats(stat_id, min_value, max_value);
CREATE INDEX stats_by_item ON stats(item_id);
CREATE TABLE properties (
 row_id INTEGER PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id),
 property_group TEXT NOT NULL, properties_json TEXT NOT NULL
) STRICT;
CREATE TABLE documents (
 item_id TEXT PRIMARY KEY REFERENCES items(id), content TEXT NOT NULL, record_json TEXT NOT NULL
) STRICT;
CREATE VIRTUAL TABLE item_search USING fts5(item_id UNINDEXED,name,base_type,item_class,content,tokenize='unicode61');
CREATE VIEW current_unique_items AS SELECT * FROM items;
