// Applies docs/influencer.sql to the live database (admin handle).
// Usage: npx tsx scripts/apply-influencer-sql.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

function readEnvVar(name: string): string | undefined {
  const env = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  for (const line of env.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return trimmed
        .slice(name.length + 1)
        .replace(/^["']|["']$/g, "")
        .trim();
    }
  }
  return undefined;
}

async function main() {
  const url =
    process.env.DATABASE_ADMIN_URL ??
    process.env.DATABASE_URL ??
    readEnvVar("DATABASE_ADMIN_URL") ??
    readEnvVar("DATABASE_URL");
  if (!url) throw new Error("No DATABASE_ADMIN_URL / DATABASE_URL configured");

  const pool = new Pool({
    connectionString: url,
    ssl: url.includes("rlwy.net") ? { rejectUnauthorized: false } : undefined,
  });

  const sql = readFileSync(resolve(process.cwd(), "docs/influencer.sql"), "utf8");
  await pool.query(sql);

  const check = await pool.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name like 'persona%'
     order by table_name`,
  );
  console.log("tables:", check.rows.map((r) => r.table_name).join(", "));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
