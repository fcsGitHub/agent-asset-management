#!/usr/bin/env tsx
/**
 * 迁移 runner：按文件名顺序执行 migrations/*.sql，记录到 schema_migrations。
 * 每个迁移在单个事务中执行。--role=admin 时使用 DATABASE_ADMIN_URL。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "migrations");

function dbUrl(): string {
  const useAdmin = process.argv.includes("--role=admin");
  if (useAdmin) {
    const url = process.env.DATABASE_ADMIN_URL;
    if (!url) throw new Error("DATABASE_ADMIN_URL 未设置");
    return url;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 未设置");
  return url;
}

async function loadDotEnv(): Promise<void> {
  // 最小 .env 加载器，避免额外依赖
  const envPath = join(root, ".env");
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // 无 .env 时依赖真实环境变量
  }
}

interface MigrationFile {
  name: string;
  sql: string;
}

function listMigrations(): MigrationFile[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(migrationsDir, name), "utf8") }));
}

async function main(): Promise<number> {
  await loadDotEnv();
  const client = new Client({ connectionString: dbUrl() });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
        (r) => r.name
      )
    );
    const files = listMigrations();
    let count = 0;
    for (const file of files) {
      if (applied.has(file.name)) continue;
      process.stdout.write(`applying ${file.name} ... `);
      await client.query("BEGIN");
      try {
        await client.query(file.sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file.name]);
        await client.query("COMMIT");
        process.stdout.write("ok\n");
        count++;
      } catch (err) {
        await client.query("ROLLBACK");
        process.stdout.write("FAILED\n");
        throw err;
      }
    }
    console.log(`migrations complete: ${count} applied, ${files.length} total`);
    return 0;
  } finally {
    await client.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("migration error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
