import { defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";

type WalletRuntime = ReturnType<typeof import("./core").createWallet>;

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
  tools: {},
  wiring: [],
});
