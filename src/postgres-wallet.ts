import {
  assertBalanced,
  type WalletAccount,
  type WalletReservation,
  type WalletSnapshot,
  type WalletStore,
  type WalletTransaction,
} from "./core";
import { walletPostgresSnapshotSql, type WalletSqlClient } from "./postgres";

const safe = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/i.test(value))
    throw new Error("wallet: PostgreSQL namespace must be a simple identifier");
  return value;
};
const placeholders = (count: number, start = 1) =>
  Array.from({ length: count }, (_, index) => `$${start + index}`).join(",");
const iso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const cents = (value: bigint | number | string) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error("wallet: PostgreSQL amount exceeds safe integer cents");
  return result;
};
type AccountRow = {
  id: string;
  owner_id: string | null;
  currency: string;
  status: WalletAccount["status"];
  allow_negative: boolean;
  created_at: Date | string;
};
type ReservationRow = {
  id: string;
  account_id: string;
  amount_cents: bigint | number | string;
  status: WalletReservation["status"];
  purpose: string;
  expires_at: Date | string | null;
  created_at: Date | string;
};
type SnapshotRow = AccountRow & {
  balance_cents: bigint | number | string;
  reserved_cents: bigint | number | string;
};
const account = (row: AccountRow): WalletAccount => ({
  id: row.id,
  ownerId: row.owner_id,
  currency: row.currency,
  status: row.status,
  ...(row.allow_negative ? { allowNegative: true } : {}),
  createdAt: iso(row.created_at),
});
const reservation = (row: ReservationRow): WalletReservation => ({
  id: row.id,
  accountId: row.account_id,
  amountCents: cents(row.amount_cents),
  status: row.status,
  purpose: row.purpose,
  expiresAt: row.expires_at ? iso(row.expires_at) : null,
  createdAt: iso(row.created_at),
});

export const createPostgresWalletStore = ({
  client,
  namespace = "wallet",
}: {
  client: WalletSqlClient;
  namespace?: string;
}): WalletStore => {
  const n = safe(namespace);
  const loadAccount = async (db: WalletSqlClient, id: string) => {
    const row = (
      await db.query<AccountRow>(
        `SELECT id,owner_id,currency,status,allow_negative,created_at FROM ${n}.accounts WHERE id=$1`,
        [id],
      )
    ).rows[0];
    return row ? account(row) : null;
  };
  const loadReservation = async (db: WalletSqlClient, id: string) => {
    const row = (
      await db.query<ReservationRow>(
        `SELECT id,account_id,amount_cents,status,purpose,expires_at,created_at FROM ${n}.reservations WHERE id=$1`,
        [id],
      )
    ).rows[0];
    return row ? reservation(row) : null;
  };
  const loadTransaction = async (
    db: WalletSqlClient,
    field: "id" | "idempotency_key",
    value: string,
  ) => {
    const row = (
      await db.query<{
        id: string;
        idempotency_key: string;
        kind: WalletTransaction["kind"];
        metadata: Record<string, string>;
        created_at: Date | string;
      }>(
        `SELECT id,idempotency_key,kind,metadata,created_at FROM ${n}.transactions WHERE ${field}=$1`,
        [value],
      )
    ).rows[0];
    if (!row) return null;
    const entries = await db.query<{
      account_id: string;
      amount_cents: bigint | number | string;
    }>(
      `SELECT account_id,amount_cents FROM ${n}.entries WHERE transaction_id=$1 ORDER BY position`,
      [row.id],
    );
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      kind: row.kind,
      metadata: row.metadata,
      createdAt: iso(row.created_at),
      entries: entries.rows.map((entry) => ({
        accountId: entry.account_id,
        amountCents: cents(entry.amount_cents),
      })),
    } satisfies WalletTransaction;
  };
  const snapshot = async (
    db: WalletSqlClient,
    id: string,
  ): Promise<WalletSnapshot | null> => {
    const row = (
      await db.query<SnapshotRow>(walletPostgresSnapshotSql(n), [id])
    ).rows[0];
    if (!row) return null;
    const balanceCents = cents(row.balance_cents);
    const reservedCents = cents(row.reserved_cents);
    return {
      ...account(row),
      balanceCents,
      reservedCents,
      availableCents: balanceCents - reservedCents,
    };
  };
  return {
    applyFundingEvent: (input) =>
      client.transaction(async (db) => {
        const retry = await loadTransaction(db, "idempotency_key", input.idempotencyKey);
        const credit = input.kind === "funding" || input.kind === "dispute-reversal";
        const amount = credit ? input.amountCents : -input.amountCents;
        const transactionKind: WalletTransaction["kind"] = input.kind === "dispute" ? "chargeback" : input.kind === "dispute-reversal" ? "adjustment" : input.kind;
        if (retry) {
          if (retry.kind !== transactionKind || retry.metadata.paymentRef !== input.paymentRef || retry.entries[0]?.accountId !== input.accountId || retry.entries[0]?.amountCents !== amount)
            throw new Error("wallet: funding idempotency key was reused with different input");
          const account = await snapshot(db, input.accountId);
          if (!account) throw new Error("wallet: account not found");
          return { account, transaction: retry };
        }
        const accountIds = [input.accountId, input.clearingAccountId];
        const locked = await db.query<AccountRow>(
          `SELECT id,owner_id,currency,status,allow_negative,created_at FROM ${n}.accounts WHERE id IN (${placeholders(accountIds.length)}) FOR UPDATE`,
          accountIds,
        );
        const account = locked.rows.find((row) => row.id === input.accountId);
        const clearing = locked.rows.find((row) => row.id === input.clearingAccountId);
        if (!account || !clearing) throw new Error("wallet: account not found");
        if (account.status === "closed" || clearing.status !== "active")
          throw new Error("wallet: funding account is unavailable");
        if (input.kind === "funding" && account.status !== "active")
          throw new Error("wallet: funding account is not active");
        const transaction: WalletTransaction = {
          createdAt: new Date().toISOString(),
          entries: [
            { accountId: input.accountId, amountCents: amount },
            { accountId: input.clearingAccountId, amountCents: -amount },
          ],
          id: `wtx:${crypto.randomUUID()}`,
          idempotencyKey: input.idempotencyKey,
          kind: transactionKind,
          metadata: { fundingEventKind: input.kind, paymentRef: input.paymentRef },
        };
        await db.query(
          `INSERT INTO ${n}.transactions (id,idempotency_key,kind,metadata,created_at) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)`,
          [transaction.id, transaction.idempotencyKey, transaction.kind, JSON.stringify(transaction.metadata), transaction.createdAt],
        );
        for (const [position, entry] of transaction.entries.entries())
          await db.query(
            `INSERT INTO ${n}.entries (transaction_id,position,account_id,amount_cents) VALUES ($1,$2,$3,$4)`,
            [transaction.id, position, entry.accountId, entry.amountCents],
          );
        const current = await snapshot(db, input.accountId);
        if (!current) throw new Error("wallet: account not found");
        if (input.kind === "dispute" || current.balanceCents < 0)
          await db.query(`UPDATE ${n}.accounts SET status='frozen' WHERE id=$1`, [input.accountId]);
        const updated = await snapshot(db, input.accountId);
        if (!updated) throw new Error("wallet: account not found");
        return { account: updated, transaction };
      }),
    createAccount: async (value) => {
      await client.query(
        `INSERT INTO ${n}.accounts (id,owner_id,currency,status,allow_negative,created_at) VALUES ($1,$2,$3,$4,$5,$6::timestamptz) ON CONFLICT (id) DO NOTHING`,
        [
          value.id,
          value.ownerId,
          value.currency,
          value.status,
          value.allowNegative ?? false,
          value.createdAt,
        ],
      );
      const stored = await loadAccount(client, value.id);
      if (!stored) throw new Error("wallet: account creation was lost");
      return stored;
    },
    account: (id) => loadAccount(client, id),
    snapshot: (id) => snapshot(client, id),
    history: async (id, limit = 100) => {
      const rows = await client.query<{ transaction_id: string }>(
        `SELECT transaction_id FROM ${n}.entries WHERE account_id=$1 ORDER BY transaction_id DESC LIMIT $2`,
        [id, limit],
      );
      return (
        await Promise.all(
          rows.rows.map((row) =>
            loadTransaction(client, "id", row.transaction_id),
          ),
        )
      ).filter((value): value is WalletTransaction => value !== null);
    },
    transactionByIdempotencyKey: (key) =>
      loadTransaction(client, "idempotency_key", key),
    reservation: (id) => loadReservation(client, id),
    commit: (input) =>
      client.transaction(async (db) => {
        const retry = await loadTransaction(
          db,
          "idempotency_key",
          input.idempotencyKey,
        );
        if (retry) return retry;
        assertBalanced(input.entries);
        const ids = [...new Set(input.entries.map((entry) => entry.accountId))];
        const locked = await db.query<AccountRow>(
          `SELECT id,owner_id,currency,status,allow_negative,created_at FROM ${n}.accounts WHERE id IN (${placeholders(ids.length)}) FOR UPDATE`,
          ids,
        );
        if (locked.rows.length !== ids.length)
          throw new Error("wallet: account not found");
        const captures = input.captures ?? [];
        for (const entry of input.entries) {
          const row = locked.rows.find(
            (candidate) => candidate.id === entry.accountId,
          );
          if (!row || row.status !== "active")
            throw new Error(`wallet: account ${entry.accountId} is not active`);
          if (entry.amountCents < 0 && !row.allow_negative) {
            const current = await snapshot(db, entry.accountId);
            const held = captures.length
              ? await db.query<{ amount_cents: bigint | number | string }>(
                  `SELECT amount_cents FROM ${n}.reservations WHERE id IN (${placeholders(captures.length)}) AND account_id=$${captures.length + 1} AND status='active' FOR UPDATE`,
                  [...captures, entry.accountId],
                )
              : { rowCount: 0, rows: [] };
            if (
              (current?.availableCents ?? 0) +
                held.rows.reduce(
                  (sum, value) => sum + cents(value.amount_cents),
                  0,
                ) <
              -entry.amountCents
            )
              throw new Error("wallet: insufficient available balance");
          }
        }
        const value: WalletTransaction = {
          ...input,
          id: `wtx:${crypto.randomUUID()}`,
          createdAt: new Date().toISOString(),
        };
        await db.query(
          `INSERT INTO ${n}.transactions (id,idempotency_key,kind,metadata,created_at) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)`,
          [
            value.id,
            value.idempotencyKey,
            value.kind,
            JSON.stringify(value.metadata),
            value.createdAt,
          ],
        );
        for (const [position, entry] of value.entries.entries())
          await db.query(
            `INSERT INTO ${n}.entries (transaction_id,position,account_id,amount_cents) VALUES ($1,$2,$3,$4)`,
            [value.id, position, entry.accountId, entry.amountCents],
          );
        if (captures.length) {
          const updated = await db.query(
            `UPDATE ${n}.reservations SET status='captured',capture_transaction_id=$1 WHERE id IN (${placeholders(captures.length, 2)}) AND status='active' RETURNING id`,
            [value.id, ...captures],
          );
          if (updated.rowCount !== captures.length)
            throw new Error("wallet: reservation is not active");
        }
        return value;
      }),
    reserve: (input) =>
      client.transaction(async (db) => {
        const existing = (
          await db.query<ReservationRow>(
            `SELECT id,account_id,amount_cents,status,purpose,expires_at,created_at FROM ${n}.reservations WHERE idempotency_key=$1`,
            [input.idempotencyKey],
          )
        ).rows[0];
        if (existing) return reservation(existing);
        await db.query(`SELECT id FROM ${n}.accounts WHERE id=$1 FOR UPDATE`, [
          input.accountId,
        ]);
        const current = await snapshot(db, input.accountId);
        if (!current || current.status !== "active")
          throw new Error("wallet: active account not found");
        if (current.availableCents < input.amountCents)
          throw new Error("wallet: insufficient available balance");
        const value: WalletReservation = {
          id: `wrsv:${crypto.randomUUID()}`,
          accountId: input.accountId,
          amountCents: input.amountCents,
          status: "active",
          purpose: input.purpose,
          expiresAt: input.expiresAt,
          createdAt: new Date().toISOString(),
        };
        await db.query(
          `INSERT INTO ${n}.reservations (id,idempotency_key,account_id,amount_cents,status,purpose,expires_at,created_at) VALUES ($1,$2,$3,$4,'active',$5,$6::timestamptz,$7::timestamptz)`,
          [
            value.id,
            input.idempotencyKey,
            value.accountId,
            value.amountCents,
            value.purpose,
            value.expiresAt,
            value.createdAt,
          ],
        );
        return value;
      }),
    release: (id) =>
      client.transaction(async (db) => {
        await db.query(
          `UPDATE ${n}.reservations SET status='released' WHERE id=$1 AND status='active'`,
          [id],
        );
        const value = await loadReservation(db, id);
        if (!value) throw new Error("wallet: reservation not found");
        return value;
      }),
    reviewAccountStatus: ({ accountId, status }) =>
      client.transaction(async (db) => {
        await db.query(`SELECT id FROM ${n}.accounts WHERE id=$1 FOR UPDATE`, [accountId]);
        const current = await snapshot(db, accountId);
        if (!current) throw new Error("wallet: account not found");
        if (current.status === "closed") throw new Error("wallet: closed account cannot be reviewed");
        if (status === "active" && current.balanceCents < 0)
          throw new Error("wallet: negative account cannot be reactivated");
        await db.query(`UPDATE ${n}.accounts SET status=$2 WHERE id=$1`, [accountId, status]);
        const updated = await snapshot(db, accountId);
        if (!updated) throw new Error("wallet: account not found");
        return updated;
      }),
  };
};
