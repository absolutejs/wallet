import { describe, expect, test } from "bun:test";
import { createPostgresAgentWalletStore, walletPostgresSchemaSql, type WalletSqlClient } from "../src";

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
        accountId: "account-1", agentId: "agent-1", allowanceId: "allowance-1",
        autoApproveUpToCents: 100, currency: "USD", dailyLimitCents: 1000,
        maximumOpenReservations: 1, ownerId: "user-1", perTransactionLimitCents: 100,
        status: "active", weeklyLimitCents: 2000,
      });
    });
    expect(rootCalls).toHaveLength(0);
    expect(transactionCalls[0]).toContain("pg_advisory_xact_lock");
    expect(transactionCalls[1]).toContain("INSERT INTO wallet.agent_allowances");
  });

  test("schema upgrades existing allowance and mandate tables with JSON state", () => {
    const sql = walletPostgresSchemaSql();
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS data");
  });
});
