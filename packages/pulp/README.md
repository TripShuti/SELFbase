# @eclosion-tech/pulp

Block editor for the web — registry, chrome, RichText (y-prosemirror), split/merge, viewport-aware mounting.

**SELFbase consumes this package** via `web/src/components/component-renderers/ComponentTreeRenderer.tsx`, which wires SpacetimeDB subscriptions and reducers into pulp's storage-agnostic API.

## Quick start (inside the SELFbase monorepo)

```tsx
import {
  BlockEditor,
  PulpProvider,
  SurfaceFocusCoordinator,
  SurfaceFocusProvider,
  registerCoreBlocks,
} from "@eclosion-tech/pulp";

// Host app provides tree + mutations + config — see ComponentTreeRenderer.
```

## Package boundary

| Pulp | Host (SELFbase) |
|---|---|
| `BlockTree`, `BlockNode`, registry | Substrate rows → `BlockTree` |
| `PulpMutations` | SpacetimeDB reducers |
| `BlockEditor`, RichText, chrome | Domain blocks (Container, Heading, …) |
| `SurfaceFocusCoordinator` | Insert subscription bridge |

Public npm publish is planned after sprint 3c.3–4 stabilizes the API.

## Tests

```bash
cd packages/pulp
pnpm test        # run once
pnpm test:watch  # watch mode
```

Vitest covers block navigation, structural actions (nest/merge/turn-into), heading Enter semantics, drag-move resolution, rich-text formatting, and ProseMirror keymap handlers.

## Undo / redo

`SurfaceUndoCoordinator` + `<SurfaceUndoProvider>` — document-wide Cmd-Z mixing Yjs text edits and structural ops. Host app wraps mutations via `coordinator.wrapMutations()` and wires `restoreBlock` for soft-delete undo (SELFbase: `restore_component`).
