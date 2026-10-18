export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startExternalSourceWorker } = await import("./src/lib/external-sources/server");
    startExternalSourceWorker();
  }
}
