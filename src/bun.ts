import { AsyncLocalStorage } from "node:async_hooks";
import type { SQL } from "bun";
import type { WalletSqlClient, WalletSqlResult } from "./postgres";

type BunSqlConnection = Pick<SQL, "unsafe">;

const query = async <Row>(
  connection: BunSqlConnection,
  text: string,
  parameters: ReadonlyArray<unknown> = [],
): Promise<WalletSqlResult<Row>> => {
  const rows = Array.from(
    (await connection.unsafe(text, [...parameters])) as Row[],
  );

  return { rowCount: rows.length, rows };
};

/**
 * Adapt Bun SQL once for both the core and agent Wallet stores. Transactions
 * are reentrant within one async call chain, so an allowance lock and its core
 * reservation/commit share the same database transaction and cannot deadlock a
 * one-connection pool.
 */
export const createBunSqlWalletClient = (sql: SQL): WalletSqlClient => {
  const context = new AsyncLocalStorage<WalletSqlClient>();
  const transactionClient = (
    connection: BunSqlConnection,
  ): WalletSqlClient => {
    const client: WalletSqlClient = {
      query: (text, parameters) => query(connection, text, parameters),
      transaction: (run) => run(client),
    };

    return client;
  };
  const root: WalletSqlClient = {
    query: (text, parameters) => {
      const current = context.getStore();

      return current
        ? current.query(text, parameters)
        : query(sql, text, parameters);
    },
    transaction: async (run) => {
      const current = context.getStore();
      if (current) return run(current);

      return sql.begin((transaction) => {
        const client = transactionClient(transaction);

        return context.run(client, () => run(client));
      });
    },
  };

  return root;
};
