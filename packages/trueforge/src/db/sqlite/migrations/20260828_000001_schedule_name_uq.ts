import { sql, type Kysely } from 'kysely';

/**
 * Names a schedule uniquely within its agent: UNIQUE (tenant_id, agent_name, name).
 * Mirrors db/postgres/migrations/20260828_000001_schedule_name_uq.ts.
 *
 * A plain CREATE INDEX needs no table rebuild, so no `PRAGMA foreign_keys` toggle.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE UNIQUE INDEX schedule_name_uq
      ON schedule (tenant_id, agent_name, name)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS schedule_name_uq`.execute(db);
}
