import { runScopedTableRegression } from "./scoped-table-browser";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { PulpProvider } from "../src/context/PulpProvider";
import { useDocumentAutosave } from "../src/rich-text/useDocumentAutosave";
import type { BlockTree, PulpMutations } from "../src/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await act(() => sleep(25));
  }
  throw new Error(message);
}
function Host({ doc, state }: { doc: Y.Doc; state?: Uint8Array }) {
  const suppress = useRef(false);
  useDocumentAutosave(doc, 1n, suppress, false, state);
  return null;
}

async function run() {
  const prefix = `autosave-regression-${crypto.randomUUID()}`;
  const tree = { byId: new Map([[1n, {}]]) } as unknown as BlockTree;
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  let connected = false;
  let subscriptionsReady = true;
  let fail = false;
  let hang = false;
  let calls = 0;
  const attempts: Uint8Array[] = [];
  let saved: Uint8Array | undefined;
  let saveVersion = 1;
  let usedVersion = 0;
  const render = async (doc: Y.Doc, state?: Uint8Array) => {
    const version = saveVersion;
    const mutations = { saveYjsState: async ({ data }: { data: Uint8Array }) => {
      calls++; usedVersion = version;
      attempts.push(data);
      if (fail) throw new Error("simulated disconnect");
      if (hang) await new Promise<void>(() => {});
      saved = data;
    } } as PulpMutations;
    await act(async () => root.render(createElement(PulpProvider, {
      tree, config: { idbPrefix: prefix, isConnected: connected, isReady: subscriptionsReady }, mutations,
      children: createElement(Host, { doc, state }),
    })));
  };
  const first = new Y.Doc();
  await render(first);
  first.getText("text").insert(0, "offline survives reload");
  // Allow the real IndexedDB transaction to commit, then discard the document.
  await act(() => sleep(100));
  await act(async () => root.unmount());
  first.destroy();
  check(calls === 0, "offline content was sent while disconnected");

  root = createRoot(container);
  const restored = new Y.Doc();
  await render(restored);
  await until(() => restored.getText("text").toString() === "offline survives reload", "IndexedDB did not recover offline edits");
  // Another client edits while this client is offline. Activity flips before
  // the new subscriptions apply: stale cached state must not be published.
  const remote = new Y.Doc();
  remote.getText("text").insert(0, "remote during outage ");
  const remoteSnapshot = Y.encodeStateAsUpdate(remote);
  connected = true;
  subscriptionsReady = false;
  saveVersion = 2;
  fail = true;
  await render(restored);
  window.dispatchEvent(new Event("online"));
  window.dispatchEvent(new Event("pagehide"));
  await act(() => sleep(100));
  check(calls === 0, "reconnect flushed before subscriptions applied");
  subscriptionsReady = true;
  // Host deliberately has no separate remote-hydration effect: the autosave
  // hook must merge this update before its very first save attempt.
  await render(restored, remoteSnapshot);
  await until(() => calls > 0, "subscription readiness did not flush pending edits");
  check(usedVersion === 2, "save used a stale callback after reconnect");
  const firstAttempt = new Y.Doc();
  Y.applyUpdate(firstAttempt, attempts[0]);
  check(firstAttempt.getText("text").toString().includes("offline survives reload"), "first reconnect save omitted local changes");
  check(firstAttempt.getText("text").toString().includes("remote during outage"), "first reconnect save omitted remote changes");
  firstAttempt.destroy();
  fail = false;
  await until(() => !!saved, "failed save was not retried without another edit");
  const accepted = new Y.Doc();
  Y.applyUpdate(accepted, saved!);
  check(accepted.getText("text").toString().includes("offline survives reload"), "recovered snapshot lost local text");
  check(accepted.getText("text").toString().includes("remote during outage"), "first save overwrote unseen remote text");
  remote.destroy();

  const before = calls;
  Y.applyUpdate(restored, saved!, "remote");
  await render(restored, saved);
  window.dispatchEvent(new Event("online"));
  await act(() => sleep(100));
  check(calls === before, "acknowledged server state caused an echo save");

  // Simulate a second tab replacing our saved snapshot with its own state.
  const other = new Y.Doc();
  other.getText("text").insert(0, "other tab");
  const stale = Y.encodeStateAsUpdate(other);
  Y.applyUpdate(restored, stale, "remote");
  await render(restored, stale);
  window.dispatchEvent(new Event("online"));
  await until(() => calls > before, "overwritten local state was not repaired");
  Y.applyUpdate(other, saved!, "remote");
  check(other.getText("text").toString() === restored.getText("text").toString(), "two-tab state did not converge");

  hang = true;
  restored.getText("text").insert(0, "latest edit ");
  window.dispatchEvent(new Event("online"));
  await until(() => calls > before + 1, "hanging reducer was not dispatched");
  const hangingCalls = calls;
  connected = false;
  await render(restored);
  hang = false;
  connected = true;
  saveVersion = 3;
  await render(restored);
  await until(() => calls > hangingCalls, "unresolved old reducer blocked reconnect");
  const latest = new Y.Doc();
  Y.applyUpdate(latest, saved!);
  check(latest.getText("text").toString() === restored.getText("text").toString(), "reconnect did not save latest state");
  latest.destroy();

  await act(async () => root.unmount());
  restored.destroy(); accepted.destroy(); other.destroy();
  indexedDB.deleteDatabase(`${prefix}:component:1`);
  container.remove();
  return { checks: ["offline IndexedDB recovery", "reconnect flush", "latest reducer callback", "retry without typing", "no remote echo", "concurrent snapshot repair", "unresolved reducer reconnect", "post-subscription merged reconnect"] };
}
Object.assign(window, { runAutosaveRegression: run, runScopedTableRegression });
