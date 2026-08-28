import { OpenAPIHono } from '@hono/zod-openapi';
import { AgentSpecSchema } from '@truefoundry/trueforge-core/agent-session';
import { createSchedulesRouter } from '../../../src/apis/schedules';
import { TENANT_ID } from '../../../src/apis/sessions';
import type { UserContext } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { ListSchedulesResponseSchema } from '../../../src/schemas/schedule';

const ALICE: UserContext = { userRef: 'alice', role: 'user' };
const BOB: UserContext = { userRef: 'bob', role: 'user' };

const scheduleBody = {
  agent_name: 'reporter',
  name: 'daily-report',
  manifest: { task: 'Say hi', cron: '0 13 * * *', timezone: 'UTC' },
};

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const agentStore = new SqliteAgentStore(db);
  const scheduleStore = new SqliteScheduleStore(db);
  await agentStore.createAgent({
    tenant_id: TENANT_ID,
    name: 'reporter',
    manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
  });

  let current: UserContext = ALICE;
  const app = new OpenAPIHono();
  app.route(
    '/',
    createSchedulesRouter({
      scheduleStore,
      agentStore,
      withTransaction: callback => db.transaction().execute(callback),
      resolveUserContext: () => current,
    }),
  );

  const asUser = (user: UserContext) => {
    current = user;
  };
  const postJson = (path: string, method: string, body: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  return { app, asUser, postJson };
}

describe('schedule RBAC — creator-only access', () => {
  it("hides another user's schedule from get, update, delete, and list", async () => {
    const { app, asUser, postJson } = await setup();

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    expect(created.status).toBe(201);
    const { id } = (await created.json()).data as { id: string };

    asUser(BOB);
    expect((await app.request(`/${id}`)).status).toBe(403);
    expect((await postJson(`/${id}`, 'PUT', { name: 'renamed', manifest: scheduleBody.manifest })).status).toBe(403);
    expect((await app.request(`/${id}`, { method: 'DELETE' })).status).toBe(403);

    const bobList = await app.request('/');
    expect(bobList.status).toBe(200);
    expect(ListSchedulesResponseSchema.parse(await bobList.json()).data).toEqual([]);
  });

  it('lets the creator see and manage their own schedule', async () => {
    const { app, asUser, postJson } = await setup();

    asUser(ALICE);
    const created = await postJson('/', 'POST', scheduleBody);
    const { id } = (await created.json()).data as { id: string };

    expect((await app.request(`/${id}`)).status).toBe(200);
    const aliceList = await app.request('/');
    expect(ListSchedulesResponseSchema.parse(await aliceList.json()).data).toHaveLength(1);
    expect((await app.request(`/${id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('does not leak existence: a missing schedule is 404, not 403', async () => {
    const { app, asUser } = await setup();
    asUser(BOB);
    expect((await app.request('/01jqzz000000000000000nope')).status).toBe(404);
  });
});
