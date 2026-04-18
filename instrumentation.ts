// Runs once per Node.js process on server startup. Used to register the
// in-process cron scheduler so we don't need an external scheduler.
// See https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startCronJobs } = await import("@/lib/cron/scheduler");
  startCronJobs();
}
