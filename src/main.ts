// ControlFinan in Node.js: same screens, rules and database as the Rails 8 + Hotwire app.
// Node runs JavaScript on one thread, so production starts WEB_CONCURRENCY worker processes (default 2)
// with node:cluster; they share the port and each one has its own database pool.
import cluster from "node:cluster";
import { createPool, migrate } from "./models";
import { buildServer } from "./server";

const env = (name: string, fallback: string) => process.env[name] || fallback;

async function startWorker() {
  const secret = process.env.SECRET_KEY_BASE;
  if (!secret) throw new Error("SECRET_KEY_BASE is required");
  const db = createPool(env("DATABASE_URL", "postgres://app:app@localhost:5432/controlfinan_node"), Number(env("DB_POOL", "10")));
  const app = buildServer({
    db, secret, bcryptCost: Number(env("BCRYPT_COST", "12")), timeZone: env("APP_TIMEZONE", "America/Sao_Paulo"),
  });
  await app.listen({ port: Number(env("PORT", "8000")), host: "0.0.0.0" });
}

async function main() {
  const workers = Number(env("WEB_CONCURRENCY", process.env.NODE_ENV === "production" ? "2" : "1"));
  if (cluster.isPrimary) {
    // The tables are created once, before the workers start.
    const db = createPool(env("DATABASE_URL", "postgres://app:app@localhost:5432/controlfinan_node"), 1);
    await migrate(db);
    await db.end();
    console.log(`ControlFinan listening on :${env("PORT", "8000")} (${workers} worker${workers > 1 ? "s" : ""})`);
    if (workers <= 1) return startWorker();
    for (let i = 0; i < workers; i++) cluster.fork();
    cluster.on("exit", (worker, code) => {
      console.error(`worker ${worker.process.pid} exited (${code}), starting another`);
      cluster.fork();
    });
    return;
  }
  await startWorker();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
