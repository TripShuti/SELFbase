import { act, createElement, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { useScopedTable } from "../../../web/src/hooks/useScopedTable";
import { ConnectionContext } from "./spacetime-react-fixture";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function connection() {
  const subscriptions: Array<{ apply: () => void; error: () => void; ended: boolean }> = [];
  let rows = [{ value: "cached" }];
  const cache = {
    iter: () => rows,
    onInsert() {}, removeOnInsert() {}, onDelete() {}, removeOnDelete() {},
    onUpdate() {}, removeOnUpdate() {},
  };
  return {
    subscriptions,
    setRows: (next: typeof rows) => { rows = next; },
    db: { row: cache },
    subscriptionBuilder() {
      let apply = () => {};
      let error = () => {};
      const builder = {
        onApplied(callback: () => void) { apply = callback; return builder; },
        onError(callback: (ctx: unknown) => void) { error = () => callback({ event: "test rejection" }); return builder; },
        subscribe(_sql: string) {
          const subscription = { apply: () => apply(), error: () => error(), ended: false };
          subscriptions.push(subscription);
          return { isEnded: () => subscription.ended, unsubscribe: () => { subscription.ended = true; } };
        },
      };
      return builder;
    },
  };
}

export async function runScopedTableRegression() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const first = connection();
  const second = connection();
  let state = { isActive: true, getConnection: () => first };
  let sql = "SELECT * FROM row";
  let snapshots: Array<{ ready: boolean; rows: readonly { value: string }[] }> = [];
  function Probe() {
    const snapshot = useScopedTable<{ value: string }>({ sourceName: "row", accessorName: "row" }, sql, () => true);
    // Inspect layout, before the subscription's passive effect can reset state.
    useLayoutEffect(() => { snapshots.push(snapshot); });
    return null;
  }
  const render = async () => {
    snapshots = [];
    await act(async () => root.render(createElement(ConnectionContext.Provider, { value: state }, createElement(Probe))));
  };
  try {
    await render();
    check(snapshots.every(s => !s.ready), "initial unapplied subscription was ready");
    await act(async () => first.subscriptions[0].apply());
    check(snapshots.at(-1)?.ready, "initial subscription did not become ready");

    state = { isActive: false, getConnection: () => first };
    await render();
    check(snapshots.every(s => !s.ready), "disconnect exposed cached readiness before passive effects");
    state = { isActive: true, getConnection: () => second };
    await render();
    check(snapshots.every(s => !s.ready), "new connection reused readiness for identical SQL");
    await act(async () => first.subscriptions[0].apply());
    check(snapshots.every(s => !s.ready), "late old subscription acknowledged the new connection");
    second.setRows([{ value: "fresh remote" }]);
    await act(async () => second.subscriptions[0].apply());
    check(snapshots.at(-1)?.ready && snapshots.at(-1)?.rows[0].value === "fresh remote", "ready snapshot did not include refreshed cache rows");

    sql = "SELECT * FROM row WHERE id = 1";
    await render();
    check(snapshots.every(s => !s.ready), "changed scope exposed previous readiness");
    const abandoned = second.subscriptions.at(-1)!;
    sql = "SELECT * FROM row";
    await render();
    check(snapshots.every(s => !s.ready), "returning to a previous query reused its ended subscription");
    await act(async () => abandoned.apply());
    check(!snapshots.at(-1)?.ready, "abandoned scope acknowledged current subscription");
    await act(async () => second.subscriptions.at(-1)!.apply());
    check(snapshots.at(-1)?.ready, "returned scope did not become ready");

    sql = "SELECT * FROM row WHERE id = 1";
    await render();
    await act(async () => second.subscriptions.at(-1)!.error());
    check(!snapshots.at(-1)?.ready, "fallback was ready before applying");
    await act(async () => second.subscriptions.at(-1)!.apply());
    check(snapshots.at(-1)?.ready, "fallback subscription did not become ready");
    await act(async () => second.subscriptions.at(-1)!.error());
    check(!snapshots.at(-1)?.ready, "failed fallback retained stale readiness");
    return { checks: ["synchronous readiness reset", "new-connection subscription", "late callback ignored", "fresh ready snapshot", "scope and fallback readiness", "failed fallback invalidated", "returning scope waits"] };
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}
