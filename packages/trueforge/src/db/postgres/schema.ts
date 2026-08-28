import { type Kysely, sql } from 'kysely';

import type { Database } from './types';

export const TRUEFORGE_SCHEMA = 'trueforge';

const TABLES_TO_MOVE = [
  'kysely_migration',
  'kysely_migration_lock',
  'session',
  'turn',
  'turn_thread',
  'session_event',
  'thread_context_log',
  'thread_capability_state',
  'model_provider',
  'skill',
  'sandbox_provider',
  'agent',
  'schedule',
  'schedule_run',
  'mcp_server',
  'oauth_token',
  'oauth_pending_authorization',
] as const;

export async function ensureTrueforgeSchema(db: Kysely<Database>): Promise<void> {
  await db.connection().execute(async conn => {
    await sql`SELECT pg_advisory_lock(hashtext('trueforge_schema_bootstrap'))`.execute(conn);
    try {
      await sql`CREATE SCHEMA IF NOT EXISTS ${sql.id(TRUEFORGE_SCHEMA)}`.execute(conn);
      for (const tableName of TABLES_TO_MOVE) {
        await sql`
          ALTER TABLE IF EXISTS ${sql.id('public', tableName)} SET SCHEMA ${sql.id(TRUEFORGE_SCHEMA)}
        `.execute(conn);
      }
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtext('trueforge_schema_bootstrap'))`.execute(conn);
    }
  });
}
