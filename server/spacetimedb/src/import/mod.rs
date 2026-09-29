//! Snapshot importers (Pear portable snapshot formats).
//!
//! One module per source format. Each importer is self-contained and
//! exposes its own `#[reducer]` entry points (`pear_v1` has a single
//! blob reducer; `pear_v2` is chunked: begin / chunk / commit / abort).
//! The `__pear`-tagged decode helpers shared by both pear formats live
//! in `decode`.

mod decode;
pub(crate) mod pear_v2;
