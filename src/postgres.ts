const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/i.test(value))
    throw new Error("wallet: PostgreSQL namespace must be a simple identifier");
  return value;
};

/** Production append-only journal schema. PostgreSQL refuses to commit an unbalanced transaction. */
export const walletPostgresSchemaSql = (namespace = "wallet") => {
  const n = identifier(namespace);
  return `
CREATE SCHEMA IF NOT EXISTS ${n};
CREATE TABLE IF NOT EXISTS ${n}.accounts (
  id text PRIMARY KEY, owner_id text, currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  allow_negative boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${n}.transactions (
  id text PRIMARY KEY, idempotency_key text NOT NULL UNIQUE, kind text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${n}.entries (
  transaction_id text NOT NULL REFERENCES ${n}.transactions(id) ON DELETE RESTRICT,
  position smallint NOT NULL CHECK (position >= 0),
  account_id text NOT NULL REFERENCES ${n}.accounts(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0), PRIMARY KEY (transaction_id, position)
);
CREATE INDEX IF NOT EXISTS wallet_entries_account_idx ON ${n}.entries(account_id, transaction_id);
CREATE TABLE IF NOT EXISTS ${n}.reservations (
  id text PRIMARY KEY, idempotency_key text NOT NULL UNIQUE,
  account_id text NOT NULL REFERENCES ${n}.accounts(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'captured', 'released', 'expired')),
  purpose text NOT NULL, capture_transaction_id text REFERENCES ${n}.transactions(id) ON DELETE RESTRICT,
  expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_reservations_active_idx ON ${n}.reservations(account_id, expires_at) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS ${n}.agent_allowances (
  allowance_id text PRIMARY KEY, agent_id text NOT NULL, owner_id text NOT NULL,
  account_id text NOT NULL REFERENCES ${n}.accounts(id) ON DELETE RESTRICT,
  currency text NOT NULL, status text NOT NULL CHECK (status IN ('active', 'paused', 'revoked')),
  policy jsonb NOT NULL, data jsonb NOT NULL DEFAULT '{}'::jsonb, valid_from timestamptz, valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_agent_allowances_agent_idx ON ${n}.agent_allowances(agent_id, status);
CREATE TABLE IF NOT EXISTS ${n}.spend_mandates (
  mandate_id text PRIMARY KEY, allowance_id text NOT NULL REFERENCES ${n}.agent_allowances(allowance_id) ON DELETE RESTRICT,
  reservation_id text NOT NULL UNIQUE REFERENCES ${n}.reservations(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL, agent_id text NOT NULL, merchant_id text NOT NULL,
  cart_hash text NOT NULL, amount_cents bigint NOT NULL CHECK (amount_cents > 0), currency text NOT NULL,
  binding_digest text NOT NULL, signature text NOT NULL, agency_action_id text,
  status text NOT NULL CHECK (status IN ('active', 'pending_approval', 'captured', 'cancelled', 'expired', 'refunded')),
  captured_transaction_id text REFERENCES ${n}.transactions(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), data jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE ${n}.agent_allowances ADD COLUMN IF NOT EXISTS data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ${n}.spend_mandates ADD COLUMN IF NOT EXISTS data jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS wallet_spend_mandates_idempotency_idx ON ${n}.spend_mandates(allowance_id, idempotency_key);
CREATE INDEX IF NOT EXISTS wallet_spend_mandates_allowance_idx ON ${n}.spend_mandates(allowance_id, created_at);
CREATE OR REPLACE FUNCTION ${n}.assert_transaction_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_total bigint;
BEGIN
  SELECT COALESCE(SUM(amount_cents), 0) INTO entry_total FROM ${n}.entries
    WHERE transaction_id = COALESCE(NEW.transaction_id, OLD.transaction_id);
  IF entry_total <> 0 THEN
    RAISE EXCEPTION 'wallet transaction % is unbalanced by % cents', COALESCE(NEW.transaction_id, OLD.transaction_id), entry_total;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS wallet_entries_balanced ON ${n}.entries;
CREATE CONSTRAINT TRIGGER wallet_entries_balanced AFTER INSERT OR UPDATE OR DELETE ON ${n}.entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${n}.assert_transaction_balanced();
`.trim();
};

/** Add tenant-fenced agent wallet inventory without changing the stable base migration. */
export const walletAgentTenantInventoryPostgresSchemaSql = (
  namespace = "wallet",
) => {
  const n = identifier(namespace);
  return `ALTER TABLE ${n}.agent_allowances ADD COLUMN IF NOT EXISTS tenant_id text;
CREATE INDEX IF NOT EXISTS wallet_agent_allowances_tenant_idx ON ${n}.agent_allowances(tenant_id, status, updated_at);
CREATE INDEX IF NOT EXISTS wallet_spend_mandates_status_idx ON ${n}.spend_mandates(status, created_at);`;
};

type DataRow<Value> = { data: Value };

export const createPostgresAgentWalletStore = ({
  client,
  namespace = "wallet",
}: {
  client: WalletSqlClient;
  namespace?: string;
}): AgentWalletStore => {
  const n = identifier(namespace);
  const transactionContext = new AsyncLocalStorage<WalletSqlClient>();
  const current = () => transactionContext.getStore() ?? client;
  const one = async <Value>(sql: string, parameters: ReadonlyArray<unknown>) =>
    (await current().query<DataRow<Value>>(sql, parameters)).rows[0]?.data ??
    null;

  return {
    allowance: (id) =>
      one<AgentAllowance>(
        `SELECT data FROM ${n}.agent_allowances WHERE allowance_id = $1`,
        [id],
      ),
    listAllowances: async (input) => {
      const rows = await current().query<DataRow<AgentAllowance>>(
        `SELECT data FROM ${n}.agent_allowances
         WHERE ($1::text IS NULL OR tenant_id = $1)
           AND ($2::text IS NULL OR owner_id = $2)
           AND ($3::text IS NULL OR agent_id = $3)
           AND ($4::text IS NULL OR status = $4)
         ORDER BY updated_at DESC LIMIT $5`,
        [
          input.tenantId ?? null,
          input.ownerId ?? null,
          input.agentId ?? null,
          input.status ?? null,
          input.limit,
        ],
      );
      return rows.rows.map(({ data }) => data);
    },
    listMandates: async (input) => {
      const rows = await current().query<DataRow<SpendMandate>>(
        `SELECT m.data FROM ${n}.spend_mandates m
         JOIN ${n}.agent_allowances a ON a.allowance_id = m.allowance_id
         WHERE ($1::text IS NULL OR a.tenant_id = $1)
           AND ($2::text IS NULL OR m.allowance_id = $2)
           AND ($3::text IS NULL OR m.status = $3)
         ORDER BY m.created_at DESC LIMIT $4`,
        [
          input.tenantId ?? null,
          input.allowanceId ?? null,
          input.status ?? null,
          input.limit,
        ],
      );
      return rows.rows.map(({ data }) => data);
    },
    mandate: (id) =>
      one<SpendMandate>(
        `SELECT data FROM ${n}.spend_mandates WHERE mandate_id = $1`,
        [id],
      ),
    mandateByIdempotencyKey: (allowanceId, key) =>
      one<SpendMandate>(
        `SELECT data FROM ${n}.spend_mandates WHERE allowance_id = $1 AND idempotency_key = $2`,
        [allowanceId, key],
      ),
    mandatesForAllowance: async (allowanceId) =>
      (
        await current().query<DataRow<SpendMandate>>(
          `SELECT data FROM ${n}.spend_mandates WHERE allowance_id = $1 ORDER BY created_at`,
          [allowanceId],
        )
      ).rows.map(({ data }) => data),
    saveAllowance: async (allowance) => {
      await current().query(
        `INSERT INTO ${n}.agent_allowances (allowance_id, agent_id, owner_id, tenant_id, account_id, currency, status, policy, data, valid_from, valid_until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$8::jsonb,$9::timestamptz,$10::timestamptz) ON CONFLICT (allowance_id) DO UPDATE SET status=EXCLUDED.status, policy=EXCLUDED.policy, data=EXCLUDED.data, valid_from=EXCLUDED.valid_from, valid_until=EXCLUDED.valid_until, updated_at=now()`,
        [
          allowance.allowanceId,
          allowance.agentId,
          allowance.ownerId,
          allowance.tenantId,
          allowance.accountId,
          allowance.currency,
          allowance.status,
          JSON.stringify(allowance),
          allowance.validFrom ?? null,
          allowance.validUntil ?? null,
        ],
      );
    },
    saveMandate: async (mandate) => {
      await current().query(
        `INSERT INTO ${n}.spend_mandates (mandate_id, allowance_id, reservation_id, idempotency_key, agent_id, merchant_id, cart_hash, amount_cents, currency, binding_digest, signature, agency_action_id, status, captured_transaction_id, expires_at, created_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz,$16::timestamptz,$17::jsonb) ON CONFLICT (mandate_id) DO UPDATE SET status=EXCLUDED.status, captured_transaction_id=EXCLUDED.captured_transaction_id, agency_action_id=EXCLUDED.agency_action_id, data=EXCLUDED.data`,
        [
          mandate.mandateId,
          mandate.allowanceId,
          mandate.reservationId,
          mandate.idempotencyKey,
          mandate.agentId,
          mandate.merchantId,
          mandate.cartHash,
          mandate.amountCents,
          mandate.currency,
          mandate.bindingDigest,
          mandate.signature,
          mandate.agencyActionId ?? null,
          mandate.status,
          mandate.capturedTransactionId ?? null,
          mandate.expiresAt,
          mandate.createdAt,
          JSON.stringify(mandate),
        ],
      );
    },
    withAllowanceLock: (allowanceId, run) =>
      client.transaction(async (transaction) => {
        await transaction.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [allowanceId],
        );
        return transactionContext.run(transaction, run);
      }),
  };
};

/** Parameterized snapshot query; bind the account id as $1. */
export const walletPostgresSnapshotSql = (namespace = "wallet") => {
  const n = identifier(namespace);
  return `SELECT a.*,
  COALESCE((SELECT SUM(e.amount_cents) FROM ${n}.entries e WHERE e.account_id = a.id), 0)::bigint AS balance_cents,
  COALESCE((SELECT SUM(r.amount_cents) FROM ${n}.reservations r WHERE r.account_id = a.id AND r.status = 'active' AND (r.expires_at IS NULL OR r.expires_at > now())), 0)::bigint AS reserved_cents
FROM ${n}.accounts a WHERE a.id = $1`.trim();
};
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentAllowance,
  AgentWalletStore,
  SpendMandate,
} from "./allowances";

export type WalletSqlResult<Row> = {
  rowCount: number;
  rows: ReadonlyArray<Row>;
};
export type WalletSqlClient = {
  query: <Row = Record<string, unknown>>(
    sql: string,
    parameters?: ReadonlyArray<unknown>,
  ) => Promise<WalletSqlResult<Row>>;
  transaction: <Value>(
    run: (client: WalletSqlClient) => Promise<Value>,
  ) => Promise<Value>;
};
