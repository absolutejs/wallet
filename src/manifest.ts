import { defineManifest, toolFactory } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import { sellerFee, steamLikeWalletPolicy } from "./core";

type WalletRuntime = ReturnType<typeof import("./core").createWallet>;
const tool = toolFactory<WalletRuntime>();

export const manifest = defineManifest<Record<never, never>, WalletRuntime>()({
  contract: 1,
  identity: {
    accent: "#16a34a",
    category: "commerce",
    description: "Double-entry, dollar-denominated wallets with reservations, idempotent settlement, and closed-loop marketplace policy.",
    docsUrl: "https://github.com/absolutejs/wallet",
    name: "@absolutejs/wallet",
    tagline: "Move value without losing a cent—or moving it twice.",
  },
  settings: Type.Object({}),
  slots: {},
  tools: {
    wallet_policy: tool.runtime({
      annotations: { readOnlyHint: true },
      description: "Explain this wallet's currency, deposit and balance limits, marketplace fee, and direct-trade fee.",
      handler: (_input, wallet) => JSON.stringify(wallet.policy),
      input: Type.Object({}),
    }),
    quote_market_sale: tool.runtime({
      annotations: { readOnlyHint: true },
      description: "Quote the seller-paid marketplace fee and net proceeds for a gross price in integer cents.",
      handler: ({ grossCents }) => JSON.stringify(sellerFee(grossCents, steamLikeWalletPolicy.sellerFeeBps)),
      input: Type.Object({ grossCents: Type.Integer({ minimum: 1 }) }),
    }),
  },
  wiring: [],
});
