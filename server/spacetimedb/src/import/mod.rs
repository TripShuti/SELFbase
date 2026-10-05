//! Snapshot importers (SELFbase portable snapshot formats).
//!
//! One module per source format. Each importer is self-contained and
//! exposes its own `#[reducer]` entry points (`snapshot_v2` is chunked:
//! begin / chunk / commit / abort).
//! The `__selfbase`-tagged decode helpers shared by the snapshot formats
//! live in `decode`.

mod decode;
pub(crate) mod snapshot_v2;
