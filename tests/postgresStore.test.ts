import { describe, expect, test } from "bun:test";
import {
  createPostgresAgentWalletStore,
  createPostgresWalletStore,
  walletAgentTenantInventoryPostgresSchemaSql,
  walletPostgresSchemaSql,
  type WalletSqlClient,
} from "../src";

describe("PostgreSQL agent wallet store", () => {
  test("holds the advisory lock and writes on the same transaction client", async () => {
    const rootCalls: string[] = [];
    const transactionCalls: string[] = [];
    const transaction: WalletSqlClient = {
      query: async (sql) => {
        transactionCalls.push(sql);
        return { rowCount: 1, rows: [] };
      },
      transaction: async (run) => run(transaction),
    };
    const root: WalletSqlClient = {
      query: async (sql) => {
        rootCalls.push(sql);
        return { rowCount: 1, rows: [] };
      },
      transaction: async (run) => run(transaction),
    };
    const store = createPostgresAgentWalletStore({ client: root });
    await store.withAllowanceLock("allowance-1", async () => {
      await store.saveAllowance({
        accountId: "account-1",
        agentId: "agent-1",
        allowanceId: "allowance-1",
        autoApproveUpToCents: 100,
        currency: "USD",
        dailyLimitCents: 1000,
        maximumOpenReservations: 1,
        ownerId: "user-1",
        perTransactionLimitCents: 100,
        status: "active",
        tenantId: "project-1",
        weeklyLimitCents: 2000,
      });
    });
    expect(rootCalls).toHaveLength(0);
    expect(transactionCalls[0]).toContain("pg_advisory_xact_lock");
    expect(transactionCalls[1]).toContain(
      "INSERT INTO wallet.agent_allowances",
    );
  });

  test("schema upgrades existing allowance and mandate tables with JSON state", () => {
    const sql = walletPostgresSchemaSql();
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS data");
  });

  test("publishes a separate stable tenant inventory migration", () => {
    const sql = walletAgentTenantInventoryPostgresSchemaSql();
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS tenant_id");
    expect(sql).toContain("wallet_agent_allowances_tenant_idx");
  });

  test("publishes the production core wallet adapter", async () => {
    const calls: string[] = [];
    const account = {
      allow_negative: false,
      created_at: "2026-07-20T00:00:00.000Z",
      currency: "USD",
      id: "wallet:project-1",
      owner_id: "project-1",
      status: "active" as const,
    };
    const client: WalletSqlClient = {
      query: async <Row>(sql: string) => {
        calls.push(sql);
        return {
          rowCount: sql.startsWith("INSERT") ? 1 : 0,
          rows: (sql.startsWith("SELECT id,owner_id")
            ? [account]
            : []) as Row[],
        };
      },
      transaction: async (run) => run(client),
    };
    const store = createPostgresWalletStore({ client });
    const created = await store.createAccount({
      createdAt: account.created_at,
      currency: "USD",
      id: account.id,
      ownerId: account.owner_id,
      status: "active",
    });
    expect(created.id).toBe(account.id);
    expect(
      calls.some((sql) => sql.includes("ON CONFLICT (id) DO NOTHING")),
    ).toBe(true);
  });
});
