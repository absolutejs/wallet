import { AsyncLocalStorage } from "node:async_hooks";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  type PgAsyncDatabase,
} from "drizzle-orm/pg-core";
import type {
  AgentAllowance,
  AgentAllowanceStatus,
  AgentWalletStore,
  SpendMandate,
  SpendMandateStatus,
} from "./allowances";
import {
  assertBalanced,
  type WalletAccount,
  type WalletAccountStatus,
  type WalletReservation,
  type WalletSnapshot,
  type WalletStore,
  type WalletTransaction,
  type WalletTransactionKind,
} from "./core";

type AnyPgDatabase = PgAsyncDatabase<any, any>;
const portableJsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  fromDriver: (value) =>
    typeof value === "string" ? JSON.parse(value) : value,
  toDriver: (value) => JSON.stringify(value),
});
const encodedJsonb = <Value>(value: Value) =>
  sql<Value>`${JSON.stringify(value)}::text::jsonb`;

const namespaceOf = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/i.test(value))
    throw new Error("wallet: PostgreSQL namespace must be a simple identifier");
  return value;
};
const date = (value: string | null | undefined) =>
  value ? new Date(value) : null;
const iso = (value: Date) => value.toISOString();
const safeCents = (value: number | string) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error("wallet: PostgreSQL amount exceeds safe integer cents");
  return result;
};

export const walletDrizzleSchema = (namespace = "wallet") => {
  const schema = pgSchema(namespaceOf(namespace));
  const accounts = schema.table("accounts", {
    allow_negative: boolean().notNull().default(false),
    created_at: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    currency: text().notNull().default("USD"),
    id: text().primaryKey(),
    owner_id: text(),
    status: text().$type<WalletAccountStatus>().notNull().default("active"),
  });
  const transactions = schema.table("transactions", {
    created_at: timestamp({ mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    id: text().primaryKey(),
    idempotency_key: text().notNull().unique(),
    kind: text().$type<WalletTransactionKind>().notNull(),
    metadata: portableJsonb().$type<Record<string, string>>().notNull(),
  });
  const entries = schema.table(
    "entries",
    {
      account_id: text()
        .notNull()
        .references(() => accounts.id, { onDelete: "restrict" }),
      amount_cents: bigint({ mode: "number" }).notNull(),
      position: integer().notNull(),
      transaction_id: text()
        .notNull()
        .references(() => transactions.id, { onDelete: "restrict" }),
    },
    (table) => [
      primaryKey({ columns: [table.transaction_id, table.position] }),
      index("wallet_entries_account_idx").on(
        table.account_id,
        table.transaction_id,
      ),
    ],
  );
  const reservations = schema.table(
    "reservations",
    {
      account_id: text()
        .notNull()
        .references(() => accounts.id, { onDelete: "restrict" }),
      amount_cents: bigint({ mode: "number" }).notNull(),
      capture_transaction_id: text().references(() => transactions.id, {
        onDelete: "restrict",
      }),
      created_at: timestamp({ mode: "date", withTimezone: true })
        .notNull()
        .defaultNow(),
      expires_at: timestamp({ mode: "date", withTimezone: true }),
      id: text().primaryKey(),
      idempotency_key: text().notNull().unique(),
      purpose: text().notNull(),
      status: text()
        .$type<WalletReservation["status"]>()
        .notNull()
        .default("active"),
    },
    (table) => [
      index("wallet_reservations_active_idx")
        .on(table.account_id, table.expires_at)
        .where(eq(table.status, "active")),
    ],
  );
  const agentAllowances = schema.table(
    "agent_allowances",
    {
      account_id: text()
        .notNull()
        .references(() => accounts.id, { onDelete: "restrict" }),
      agent_id: text().notNull(),
      allowance_id: text().primaryKey(),
      created_at: timestamp({ mode: "date", withTimezone: true })
        .notNull()
        .defaultNow(),
      currency: text().notNull(),
      data: portableJsonb().$type<AgentAllowance>().notNull(),
      owner_id: text().notNull(),
      policy: portableJsonb().$type<AgentAllowance>().notNull(),
      status: text().$type<AgentAllowanceStatus>().notNull(),
      tenant_id: text(),
      updated_at: timestamp({ mode: "date", withTimezone: true })
        .notNull()
        .defaultNow(),
      valid_from: timestamp({ mode: "date", withTimezone: true }),
      valid_until: timestamp({ mode: "date", withTimezone: true }),
    },
    (table) => [
      index("wallet_agent_allowances_agent_idx").on(
        table.agent_id,
        table.status,
      ),
      index("wallet_agent_allowances_tenant_idx").on(
        table.tenant_id,
        table.status,
        table.updated_at,
      ),
    ],
  );
  const spendMandates = schema.table(
    "spend_mandates",
    {
      agency_action_id: text(),
      agent_id: text().notNull(),
      allowance_id: text()
        .notNull()
        .references(() => agentAllowances.allowance_id, {
          onDelete: "restrict",
        }),
      amount_cents: bigint({ mode: "number" }).notNull(),
      binding_digest: text().notNull(),
      captured_transaction_id: text().references(() => transactions.id, {
        onDelete: "restrict",
      }),
      cart_hash: text().notNull(),
      created_at: timestamp({ mode: "date", withTimezone: true })
        .notNull()
        .defaultNow(),
      currency: text().notNull(),
      data: portableJsonb().$type<SpendMandate>().notNull(),
      expires_at: timestamp({ mode: "date", withTimezone: true }).notNull(),
      idempotency_key: text().notNull(),
      mandate_id: text().primaryKey(),
      merchant_id: text().notNull(),
      reservation_id: text()
        .notNull()
        .unique()
        .references(() => reservations.id, { onDelete: "restrict" }),
      signature: text().notNull(),
      status: text().$type<SpendMandateStatus>().notNull(),
    },
    (table) => [
      uniqueIndex("wallet_spend_mandates_idempotency_idx").on(
        table.allowance_id,
        table.idempotency_key,
      ),
      index("wallet_spend_mandates_allowance_idx").on(
        table.allowance_id,
        table.created_at,
      ),
      index("wallet_spend_mandates_status_idx").on(
        table.status,
        table.created_at,
      ),
    ],
  );

  return {
    accounts,
    agentAllowances,
    entries,
    reservations,
    spendMandates,
    transactions,
  };
};

type WalletTables = ReturnType<typeof walletDrizzleSchema>;
type AccountRow = WalletTables["accounts"]["$inferSelect"];
type ReservationRow = WalletTables["reservations"]["$inferSelect"];

const accountOf = (row: AccountRow): WalletAccount => ({
  ...(row.allow_negative ? { allowNegative: true } : {}),
  createdAt: iso(row.created_at),
  currency: row.currency,
  id: row.id,
  ownerId: row.owner_id,
  status: row.status,
});
const reservationOf = (row: ReservationRow): WalletReservation => ({
  accountId: row.account_id,
  amountCents: safeCents(row.amount_cents),
  createdAt: iso(row.created_at),
  expiresAt: row.expires_at ? iso(row.expires_at) : null,
  id: row.id,
  purpose: row.purpose,
  status: row.status,
});

export const createDrizzleAgentWalletStore = <DB extends AnyPgDatabase>(
  db: DB,
  options: { namespace?: string } = {},
): AgentWalletStore => {
  const { agentAllowances, spendMandates } = walletDrizzleSchema(
    options.namespace,
  );
  const context = new AsyncLocalStorage<AnyPgDatabase>();
  const current = () => context.getStore() ?? db;

  return {
    allowance: async (id) =>
      (
        await current()
          .select({ data: agentAllowances.data })
          .from(agentAllowances)
          .where(eq(agentAllowances.allowance_id, id))
          .limit(1)
      )[0]?.data ?? null,
    listAllowances: async (input) => {
      const filters: SQL[] = [];
      if (input.tenantId)
        filters.push(eq(agentAllowances.tenant_id, input.tenantId));
      if (input.ownerId)
        filters.push(eq(agentAllowances.owner_id, input.ownerId));
      if (input.agentId)
        filters.push(eq(agentAllowances.agent_id, input.agentId));
      if (input.status) filters.push(eq(agentAllowances.status, input.status));
      return (
        await current()
          .select({ data: agentAllowances.data })
          .from(agentAllowances)
          .where(and(...filters))
          .orderBy(desc(agentAllowances.updated_at))
          .limit(input.limit)
      ).map(({ data }) => data);
    },
    listMandates: async (input) => {
      const filters: SQL[] = [];
      if (input.tenantId)
        filters.push(eq(agentAllowances.tenant_id, input.tenantId));
      if (input.allowanceId)
        filters.push(eq(spendMandates.allowance_id, input.allowanceId));
      if (input.status) filters.push(eq(spendMandates.status, input.status));
      return (
        await current()
          .select({ data: spendMandates.data })
          .from(spendMandates)
          .innerJoin(
            agentAllowances,
            eq(agentAllowances.allowance_id, spendMandates.allowance_id),
          )
          .where(and(...filters))
          .orderBy(desc(spendMandates.created_at))
          .limit(input.limit)
      ).map(({ data }) => data);
    },
    mandate: async (id) =>
      (
        await current()
          .select({ data: spendMandates.data })
          .from(spendMandates)
          .where(eq(spendMandates.mandate_id, id))
          .limit(1)
      )[0]?.data ?? null,
    mandateByIdempotencyKey: async (allowanceId, key) =>
      (
        await current()
          .select({ data: spendMandates.data })
          .from(spendMandates)
          .where(
            and(
              eq(spendMandates.allowance_id, allowanceId),
              eq(spendMandates.idempotency_key, key),
            ),
          )
          .limit(1)
      )[0]?.data ?? null,
    mandatesForAllowance: async (allowanceId) =>
      (
        await current()
          .select({ data: spendMandates.data })
          .from(spendMandates)
          .where(eq(spendMandates.allowance_id, allowanceId))
          .orderBy(asc(spendMandates.created_at))
      ).map(({ data }) => data),
    saveAllowance: async (allowance) => {
      await current()
        .insert(agentAllowances)
        .values({
          account_id: allowance.accountId,
          agent_id: allowance.agentId,
          allowance_id: allowance.allowanceId,
          currency: allowance.currency,
          data: encodedJsonb(allowance),
          owner_id: allowance.ownerId,
          policy: encodedJsonb(allowance),
          status: allowance.status,
          tenant_id: allowance.tenantId,
          valid_from: date(allowance.validFrom),
          valid_until: date(allowance.validUntil),
        })
        .onConflictDoUpdate({
          set: {
            data: encodedJsonb(allowance),
            policy: encodedJsonb(allowance),
            status: allowance.status,
            updated_at: new Date(),
            valid_from: date(allowance.validFrom),
            valid_until: date(allowance.validUntil),
          },
          target: agentAllowances.allowance_id,
        });
    },
    saveMandate: async (mandate) => {
      await current()
        .insert(spendMandates)
        .values({
          agency_action_id: mandate.agencyActionId ?? null,
          agent_id: mandate.agentId,
          allowance_id: mandate.allowanceId,
          amount_cents: mandate.amountCents,
          binding_digest: mandate.bindingDigest,
          captured_transaction_id: mandate.capturedTransactionId ?? null,
          cart_hash: mandate.cartHash,
          created_at: new Date(mandate.createdAt),
          currency: mandate.currency,
          data: encodedJsonb(mandate),
          expires_at: new Date(mandate.expiresAt),
          idempotency_key: mandate.idempotencyKey,
          mandate_id: mandate.mandateId,
          merchant_id: mandate.merchantId,
          reservation_id: mandate.reservationId,
          signature: mandate.signature,
          status: mandate.status,
        })
        .onConflictDoUpdate({
          set: {
            agency_action_id: mandate.agencyActionId ?? null,
            captured_transaction_id: mandate.capturedTransactionId ?? null,
            data: encodedJsonb(mandate),
            status: mandate.status,
          },
          target: spendMandates.mandate_id,
        });
    },
    withAllowanceLock: (allowanceId, run) =>
      db.transaction(async (transaction) => {
        const locked = await transaction
          .select({ id: agentAllowances.allowance_id })
          .from(agentAllowances)
          .where(eq(agentAllowances.allowance_id, allowanceId))
          .for("update")
          .limit(1);
        if (locked.length !== 1) throw new Error("wallet: allowance not found");
        return context.run(transaction, run);
      }),
  };
};

export const createDrizzleWalletStore = <DB extends AnyPgDatabase>(
  db: DB,
  options: { namespace?: string } = {},
): WalletStore => {
  const { accounts, entries, reservations, transactions } = walletDrizzleSchema(
    options.namespace,
  );
  const loadAccount = async (database: AnyPgDatabase, id: string) => {
    const [row] = await database
      .select()
      .from(accounts)
      .where(eq(accounts.id, id))
      .limit(1);
    return row ? accountOf(row) : null;
  };
  const loadReservation = async (database: AnyPgDatabase, id: string) => {
    const [row] = await database
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1);
    return row ? reservationOf(row) : null;
  };
  const loadTransaction = async (
    database: AnyPgDatabase,
    field: "id" | "idempotency_key",
    value: string,
  ): Promise<WalletTransaction | null> => {
    const [row] = await database
      .select()
      .from(transactions)
      .where(eq(transactions[field], value))
      .limit(1);
    if (!row) return null;
    const transactionEntries = await database
      .select({
        accountId: entries.account_id,
        amountCents: entries.amount_cents,
      })
      .from(entries)
      .where(eq(entries.transaction_id, row.id))
      .orderBy(asc(entries.position));
    return {
      createdAt: iso(row.created_at),
      entries: transactionEntries.map((entry) => ({
        accountId: entry.accountId,
        amountCents: safeCents(entry.amountCents),
      })),
      id: row.id,
      idempotencyKey: row.idempotency_key,
      kind: row.kind,
      metadata: row.metadata,
    };
  };
  const snapshot = async (
    database: AnyPgDatabase,
    id: string,
  ): Promise<WalletSnapshot | null> => {
    const [row] = await database
      .select()
      .from(accounts)
      .where(eq(accounts.id, id))
      .limit(1);
    if (!row) return null;
    const [balance] = await database
      .select({
        value: sql<number>`coalesce(sum(${entries.amount_cents}), 0)::bigint`,
      })
      .from(entries)
      .where(eq(entries.account_id, id));
    const [reserved] = await database
      .select({
        value: sql<number>`coalesce(sum(${reservations.amount_cents}), 0)::bigint`,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.account_id, id),
          eq(reservations.status, "active"),
          or(
            isNull(reservations.expires_at),
            gt(reservations.expires_at, sql`now()`),
          ),
        ),
      );
    const balanceCents = safeCents(balance?.value ?? 0);
    const reservedCents = safeCents(reserved?.value ?? 0);
    return {
      ...accountOf(row),
      availableCents: balanceCents - reservedCents,
      balanceCents,
      reservedCents,
    };
  };
  const insertTransaction = async (
    database: AnyPgDatabase,
    transaction: WalletTransaction,
  ) => {
    await database.insert(transactions).values({
      created_at: new Date(transaction.createdAt),
      id: transaction.id,
      idempotency_key: transaction.idempotencyKey,
      kind: transaction.kind,
      metadata: encodedJsonb(transaction.metadata),
    });
    if (transaction.entries.length > 0)
      await database.insert(entries).values(
        transaction.entries.map((entry, position) => ({
          account_id: entry.accountId,
          amount_cents: entry.amountCents,
          position,
          transaction_id: transaction.id,
        })),
      );
  };

  return {
    account: (id) => loadAccount(db, id),
    applyFundingEvent: (input) =>
      db.transaction(async (transaction) => {
        const retry = await loadTransaction(
          transaction,
          "idempotency_key",
          input.idempotencyKey,
        );
        const credit =
          input.kind === "funding" || input.kind === "dispute-reversal";
        const amount = credit ? input.amountCents : -input.amountCents;
        const transactionKind: WalletTransactionKind =
          input.kind === "dispute"
            ? "chargeback"
            : input.kind === "dispute-reversal"
              ? "adjustment"
              : input.kind;
        if (retry) {
          if (
            retry.kind !== transactionKind ||
            retry.metadata.paymentRef !== input.paymentRef ||
            retry.entries[0]?.accountId !== input.accountId ||
            retry.entries[0]?.amountCents !== amount
          )
            throw new Error(
              "wallet: funding idempotency key was reused with different input",
            );
          const existing = await snapshot(transaction, input.accountId);
          if (!existing) throw new Error("wallet: account not found");
          return { account: existing, transaction: retry };
        }
        const locked = await transaction
          .select()
          .from(accounts)
          .where(
            inArray(accounts.id, [input.accountId, input.clearingAccountId]),
          )
          .for("update");
        const account = locked.find(({ id }) => id === input.accountId);
        const clearing = locked.find(
          ({ id }) => id === input.clearingAccountId,
        );
        if (!account || !clearing) throw new Error("wallet: account not found");
        if (account.status === "closed" || clearing.status !== "active")
          throw new Error("wallet: funding account is unavailable");
        if (input.kind === "funding" && account.status !== "active")
          throw new Error("wallet: funding account is not active");
        const value: WalletTransaction = {
          createdAt: new Date().toISOString(),
          entries: [
            { accountId: input.accountId, amountCents: amount },
            { accountId: input.clearingAccountId, amountCents: -amount },
          ],
          id: `wtx:${crypto.randomUUID()}`,
          idempotencyKey: input.idempotencyKey,
          kind: transactionKind,
          metadata: {
            fundingEventKind: input.kind,
            paymentRef: input.paymentRef,
          },
        };
        await insertTransaction(transaction, value);
        const current = await snapshot(transaction, input.accountId);
        if (!current) throw new Error("wallet: account not found");
        if (input.kind === "dispute" || current.balanceCents < 0)
          await transaction
            .update(accounts)
            .set({ status: "frozen" })
            .where(eq(accounts.id, input.accountId));
        const updated = await snapshot(transaction, input.accountId);
        if (!updated) throw new Error("wallet: account not found");
        return { account: updated, transaction: value };
      }),
    commit: (input) =>
      db.transaction(async (transaction) => {
        const retry = await loadTransaction(
          transaction,
          "idempotency_key",
          input.idempotencyKey,
        );
        if (retry) return retry;
        assertBalanced(input.entries);
        const ids = [
          ...new Set(input.entries.map(({ accountId }) => accountId)),
        ];
        const locked = await transaction
          .select()
          .from(accounts)
          .where(inArray(accounts.id, ids))
          .for("update");
        if (locked.length !== ids.length)
          throw new Error("wallet: account not found");
        const captures = input.captures ?? [];
        for (const entry of input.entries) {
          const row = locked.find(({ id }) => id === entry.accountId);
          if (!row || row.status !== "active")
            throw new Error(`wallet: account ${entry.accountId} is not active`);
          if (entry.amountCents < 0 && !row.allow_negative) {
            const current = await snapshot(transaction, entry.accountId);
            const held =
              captures.length === 0
                ? []
                : await transaction
                    .select({ amount: reservations.amount_cents })
                    .from(reservations)
                    .where(
                      and(
                        inArray(reservations.id, captures),
                        eq(reservations.account_id, entry.accountId),
                        eq(reservations.status, "active"),
                      ),
                    )
                    .for("update");
            if (
              (current?.availableCents ?? 0) +
                held.reduce((sum, value) => sum + safeCents(value.amount), 0) <
              -entry.amountCents
            )
              throw new Error("wallet: insufficient available balance");
          }
        }
        const value: WalletTransaction = {
          ...input,
          createdAt: new Date().toISOString(),
          id: `wtx:${crypto.randomUUID()}`,
        };
        await insertTransaction(transaction, value);
        if (captures.length > 0) {
          const updated = await transaction
            .update(reservations)
            .set({
              capture_transaction_id: value.id,
              status: "captured",
            })
            .where(
              and(
                inArray(reservations.id, captures),
                eq(reservations.status, "active"),
              ),
            )
            .returning({ id: reservations.id });
          if (updated.length !== captures.length)
            throw new Error("wallet: reservation is not active");
        }
        return value;
      }),
    createAccount: async (value) => {
      await db
        .insert(accounts)
        .values({
          allow_negative: value.allowNegative ?? false,
          created_at: new Date(value.createdAt),
          currency: value.currency,
          id: value.id,
          owner_id: value.ownerId,
          status: value.status,
        })
        .onConflictDoNothing();
      const stored = await loadAccount(db, value.id);
      if (!stored) throw new Error("wallet: account creation was lost");
      return stored;
    },
    history: async (id, limit = 100) => {
      const rows = await db
        .select({ id: entries.transaction_id })
        .from(entries)
        .where(eq(entries.account_id, id))
        .orderBy(desc(entries.transaction_id))
        .limit(limit);
      return (
        await Promise.all(
          rows.map(({ id: transactionId }) =>
            loadTransaction(db, "id", transactionId),
          ),
        )
      ).filter((value): value is WalletTransaction => value !== null);
    },
    listAccounts: async ({ limit, prefix }) => {
      const rows = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(prefix ? like(accounts.id, `${prefix}%`) : undefined)
        .orderBy(desc(accounts.created_at))
        .limit(limit);
      return (await Promise.all(rows.map(({ id }) => snapshot(db, id)))).filter(
        (value): value is WalletSnapshot => value !== null,
      );
    },
    release: (id) =>
      db.transaction(async (transaction) => {
        await transaction
          .update(reservations)
          .set({ status: "released" })
          .where(
            and(eq(reservations.id, id), eq(reservations.status, "active")),
          );
        const value = await loadReservation(transaction, id);
        if (!value) throw new Error("wallet: reservation not found");
        return value;
      }),
    reservation: (id) => loadReservation(db, id),
    reserve: (input) =>
      db.transaction(async (transaction) => {
        const [existing] = await transaction
          .select()
          .from(reservations)
          .where(eq(reservations.idempotency_key, input.idempotencyKey))
          .limit(1);
        if (existing) return reservationOf(existing);
        await transaction
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.id, input.accountId))
          .for("update");
        const current = await snapshot(transaction, input.accountId);
        if (!current || current.status !== "active")
          throw new Error("wallet: active account not found");
        if (current.availableCents < input.amountCents)
          throw new Error("wallet: insufficient available balance");
        const value: WalletReservation = {
          accountId: input.accountId,
          amountCents: input.amountCents,
          createdAt: new Date().toISOString(),
          expiresAt: input.expiresAt,
          id: `wrsv:${crypto.randomUUID()}`,
          purpose: input.purpose,
          status: "active",
        };
        await transaction.insert(reservations).values({
          account_id: value.accountId,
          amount_cents: value.amountCents,
          created_at: new Date(value.createdAt),
          expires_at: date(value.expiresAt),
          id: value.id,
          idempotency_key: input.idempotencyKey,
          purpose: value.purpose,
          status: value.status,
        });
        return value;
      }),
    reviewAccountStatus: ({ accountId, status }) =>
      db.transaction(async (transaction) => {
        await transaction
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .for("update");
        const current = await snapshot(transaction, accountId);
        if (!current) throw new Error("wallet: account not found");
        if (current.status === "closed")
          throw new Error("wallet: closed account cannot be reviewed");
        if (status === "active" && current.balanceCents < 0)
          throw new Error("wallet: negative account cannot be reactivated");
        await transaction
          .update(accounts)
          .set({ status })
          .where(eq(accounts.id, accountId));
        const updated = await snapshot(transaction, accountId);
        if (!updated) throw new Error("wallet: account not found");
        return updated;
      }),
    snapshot: (id) => snapshot(db, id),
    transactionByIdempotencyKey: (key) =>
      loadTransaction(db, "idempotency_key", key),
  };
};
