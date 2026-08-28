import { sql } from 'kysely';
import { Pool } from 'pg';
import { ulid } from 'ulid';

import { migrateToLatest } from '../../../src/db/migratePostgres';
import { createDb } from '../../../src/db/postgres/client';
import { TRUEFORGE_SCHEMA } from '../../../src/db/postgres/schema';
import { createPostgresTestDatabase, type PostgresTestDatabase } from './testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

const TABLES_TO_CHECK = ['session', 'kysely_migration', 'kysely_migration_lock'] as const;

const APP_AND_KYSELY_TABLES = [
  'kysely_migration_lock',
  'kysely_migration',
  'oauth_pending_authorization',
  'oauth_token',
  'mcp_server',
  'schedule_run',
  'schedule',
  'agent',
  'sandbox_provider',
  'skill',
  'model_provider',
  'thread_capability_state',
  'thread_context_log',
  'session_event',
  'turn_thread',
  'turn',
  'session',
] as const;

async function tableSchema(db: PostgresTestDatabase['db'], tableName: string): Promise<string | undefined> {
  const { rows } = await sql<{ table_schema: string }>`
    SELECT table_schema
    FROM information_schema.tables
    WHERE table_name = ${tableName}
      AND table_schema IN (${TRUEFORGE_SCHEMA}, 'public')
  `.execute(db);
  return rows[0]?.table_schema;
}

async function migrationNames(db: PostgresTestDatabase['db']): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    SELECT name FROM kysely_migration ORDER BY name
  `.execute(db);
  return rows.map(row => row.name);
}

function withDatabase(connectionString: string, database: string): string {
  const parsed = new URL(connectionString.replace(/^postgres:/, 'http:'));
  parsed.pathname = `/${database}`;
  return parsed.toString().replace(/^http:/, 'postgres:');
}

describePg('trueforge Postgres schema bootstrap', () => {
  it('places app and Kysely tables in the trueforge schema on a greenfield database', async () => {
    const env = await createPostgresTestDatabase();
    if (env === undefined) {
      throw new Error('Postgres test environment unavailable despite globalSetup probe');
    }
    try {
      for (const tableName of TABLES_TO_CHECK) {
        expect(await tableSchema(env.db, tableName)).toBe(TRUEFORGE_SCHEMA);
      }

      const { rows: searchPathRows } = await sql<{ search_path: string }>`
        SHOW search_path
      `.execute(env.db);
      expect(searchPathRows[0]?.search_path).toBe(TRUEFORGE_SCHEMA);

      const names = await migrationNames(env.db);
      expect(names.length).toBeGreaterThan(0);

      await migrateToLatest(env.db);
      expect(await migrationNames(env.db)).toEqual(names);
    } finally {
      await env.teardown();
    }
  }, 120_000);

  it('moves legacy public tables into trueforge and preserves migration history', async () => {
    const adminUrl = process.env['PG_STORE_TESTS_ADMIN_URL'];
    if (adminUrl === undefined || adminUrl === '') {
      throw new Error('PG_STORE_TESTS_ADMIN_URL unset despite globalSetup probe');
    }

    const databaseName = `test_${ulid().toLowerCase()}`;
    if (!/^[a-z0-9_]+$/.test(databaseName)) {
      throw new Error(`invalid database name: ${databaseName}`);
    }

    const adminPool = new Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    } finally {
      await adminPool.end();
    }

    const databaseUrl = withDatabase(adminUrl, databaseName);
    const db = createDb({
      connectionString: databaseUrl,
      poolMax: 5,
      statementTimeoutMs: 60_000,
      idleInTransactionSessionTimeoutMs: 60_000,
    });

    try {
      await migrateToLatest(db);
      const beforeNames = await migrationNames(db);

      // Simulate a pre-upgrade install: objects in public, trueforge schema gone.
      // Use a search_path-free pool so we can address trueforge.* after createDb pinned search_path.
      const publicPool = new Pool({ connectionString: databaseUrl });
      try {
        for (const tableName of APP_AND_KYSELY_TABLES) {
          await publicPool.query(`ALTER TABLE IF EXISTS trueforge.${tableName} SET SCHEMA public`);
        }
        await publicPool.query('DROP SCHEMA IF EXISTS trueforge CASCADE');
      } finally {
        await publicPool.end();
      }

      await migrateToLatest(db);

      for (const tableName of TABLES_TO_CHECK) {
        expect(await tableSchema(db, tableName)).toBe(TRUEFORGE_SCHEMA);
      }
      expect(await migrationNames(db)).toEqual(beforeNames);

      await migrateToLatest(db);
      expect(await migrationNames(db)).toEqual(beforeNames);
    } finally {
      await db.destroy();
      const dropPool = new Pool({ connectionString: adminUrl });
      try {
        await dropPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [databaseName],
        );
        await dropPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      } finally {
        await dropPool.end();
      }
    }
  }, 120_000);
});
