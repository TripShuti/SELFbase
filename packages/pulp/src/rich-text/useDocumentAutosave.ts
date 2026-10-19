"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { usePulp } from "../context/PulpProvider";
import { Autosave } from "./autosave";
import { hasUnsavedChanges } from "./hasUnsavedChanges";

/** Persistence follows the document, including while its editor is off screen. */
export function useDocumentAutosave(doc: Y.Doc, componentId: bigint, suppress: RefObject<boolean>, initiallyDirty: boolean, serverState?: Uint8Array) {
  const context = usePulp();
  const latest = useRef(context);
  latest.current = context;
  const queueRef = useRef<Autosave | null>(null);
  const prefix = context.config.idbPrefix;

  useLayoutEffect(() => {
    let ready = false;
    let disposed = false;
    const queue = new Autosave({
      canSave: () => ready && !suppress.current && latest.current.config.isConnected !== false && latest.current.tree.byId.has(componentId),
      save: () => latest.current.saveYjsState({ componentId, data: Y.encodeStateAsUpdate(doc) }),
      onError: error => console.warn(`[RichText] unsaved changes for component ${componentId}; retrying:`, error),
    });
    queueRef.current = queue;
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin !== "remote" && origin !== "ai") queue.changed();
    };
    doc.on("update", onUpdate);
    const persistence = new IndexeddbPersistence(`${prefix}:component:${componentId}`, doc);
    if (initiallyDirty) queue.changed();
    // get() also observes database-open failures; whenSynced alone never rejects.
    void persistence.get("autosave-version").then(() => persistence.whenSynced).then(() => {
      if (disposed) return;
      ready = true;
      void queue.flush();
    }).catch(error => {
      if (disposed) return;
      // A storage failure must not disable saving to the server.
      ready = true;
      console.warn(`[RichText] local persistence unavailable for component ${componentId}:`, error);
      void queue.flush();
    });
    const flush = () => { void queue.flush(); };
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("online", flush);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      doc.off("update", onUpdate);
      window.removeEventListener("online", flush);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
      queue.stop();
      queueRef.current = null;
      void persistence.destroy();
    };
  }, [doc, componentId, prefix, suppress, initiallyDirty]);

  useLayoutEffect(() => {
    if (context.config.isConnected === false) queueRef.current?.disconnected();
    else void queueRef.current?.flush();
  }, [context.config.isConnected]);

  useEffect(() => {
    if (!serverState?.byteLength) return;
    try {
      // The substrate stores full snapshots. If another writer overwrote our
      // acknowledged content, publish the merged document again.
      if (hasUnsavedChanges(doc, serverState)) queueRef.current?.changed();
    } catch (error) {
      console.warn(`[RichText] invalid server state for component ${componentId}:`, error);
    }
  }, [doc, componentId, serverState]);
}
