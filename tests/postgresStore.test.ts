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

  test("uses scalar account bindings compatible with Bun SQL", async () => {
	const calls: Array<{ parameters: readonly unknown[]; sql: string }> = [];
	const rows = [
		{ allow_negative: false, created_at: new Date(), currency: "USD", id: "wallet:buyer", owner_id: "buyer", status: "active" as const },
		{ allow_negative: true, created_at: new Date(), currency: "USD", id: "wallet:clearing", owner_id: null, status: "active" as const },
	];
	const client: WalletSqlClient = {
		query: async <Row>(sql: string, parameters: readonly unknown[] = []) => {
			calls.push({ parameters, sql });
			if (sql.includes("FOR UPDATE")) return { rowCount: rows.length, rows: rows as Row[] };
			if (sql.includes("balance_cents")) return { rowCount: 1, rows: [{ ...rows[0], balance_cents: 500, reserved_cents: 0 }] as Row[] };
			return { rowCount: 1, rows: [] };
		},
		transaction: async (run) => run(client),
	};
	await createPostgresWalletStore({ client }).applyFundingEvent({ accountId: "wallet:buyer", amountCents: 500, clearingAccountId: "wallet:clearing", idempotencyKey: "funding-1", kind: "funding", paymentRef: "pi-1" });
	const lock = calls.find(({ sql }) => sql.includes("FOR UPDATE"));
	expect(lock?.sql).toContain("id IN ($1,$2)");
	expect(lock?.sql).not.toContain("ANY(");
	expect(lock?.parameters).toEqual(["wallet:buyer", "wallet:clearing"]);
  });

  test("queries account inventory by a bounded prefix", async () => {
	const calls: Array<{ parameters: readonly unknown[]; sql: string }> = [];
	const client: WalletSqlClient = {
		query: async <Row>(sql: string, parameters: readonly unknown[] = []) => {
			calls.push({ parameters, sql });
			return { rowCount: 0, rows: [] as Row[] };
		},
		transaction: async (run) => run(client),
	};
	await createPostgresWalletStore({ client }).listAccounts({ limit: 25, prefix: "wallet:project:" });
	expect(calls[0]?.sql).toContain("id LIKE $1 || '%'");
	expect(calls[0]?.parameters).toEqual(["wallet:project:", 25]);
  });
});
