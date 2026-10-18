import { NextResponse } from "next/server";
import { callerTransport, httpPageId, serviceTransport, sourceEnvironment, loadSource, searchSource, syncExternalRow, workerStatus } from "@/src/lib/external-sources/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorize(request: Request, write: boolean) {
  const url = new URL(request.url);
  const databaseId = url.searchParams.get("databaseId") || "";
  const rowId = url.searchParams.get("rowId") || "";
  if (!/^[1-9]\d*$/.test(databaseId) || (write && !/^[1-9]\d*$/.test(rowId))) throw new Error("Invalid page id");
  if (url.searchParams.get("db") !== sourceEnvironment().db) throw new Error("Different workspace");
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) throw new Error("Sign in to use external data sources");
  const transport = callerTransport(token);
  await transport.call("authorize_blob_access", [httpPageId(databaseId), false]);
  if (write) await transport.call("authorize_blob_access", [httpPageId(rowId), true]);
  return { transport, databaseId, rowId };
}
export async function GET(request: Request) {
  let caller;
  try { caller = await authorize(request, false); }
  catch { return NextResponse.json({ error: "Not authorized for this workspace/database" }, { status: 403 }); }
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("status") === "1") return NextResponse.json(workerStatus(caller.databaseId));
    const source = await loadSource(serviceTransport(), caller.databaseId);
    const records = await searchSource(source, url.searchParams.get("q") || "");
    return NextResponse.json({ records });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "External source unavailable" }, { status: 502 });
  }
}
export async function POST(request: Request) {
  let caller;
  try { caller = await authorize(request, true); }
  catch { return NextResponse.json({ error: "Not authorized to update this row" }, { status: 403 }); }
  try {
    const source = await loadSource(serviceTransport(), caller.databaseId);
    const record = await syncExternalRow(caller.transport, source, caller.databaseId, caller.rowId);
    return NextResponse.json({ record });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "External source refresh failed" }, { status: 502 });
  }
}
