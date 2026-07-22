import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createBunSqlWalletClient } from "../src";

describe("Bun SQL Wallet client", () => {
  test("joins nested transactions on one async transaction context", async () => {
    let begins = 0;
    const queries: string[] = [];
    const connection = {
      unsafe: async (text: string) => {
        queries.push(text);

        return [];
      },
    };
    const sql = {
      ...connection,
      begin: async <Value>(
        run: (transaction: typeof connection) => Promise<Value>,
      ) => {
        begins += 1;

        return run(connection);
      },
    } as unknown as SQL;
    const client = createBunSqlWalletClient(sql);
    await client.transaction(async () => {
      await client.query("outer");
      await client.transaction(async (nested) => {
        await nested.query("inner");
      });
    });
    expect(begins).toBe(1);
    expect(queries).toEqual(["outer", "inner"]);
  });
});
