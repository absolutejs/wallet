import { defineManifest, toolFactory } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { AgentWallet } from "./allowances";

const tool = toolFactory<AgentWallet>();

export const manifest = defineManifest<Record<never, never>, AgentWallet>()({
  contract: 2,
  discovery: {
    audiences: ["agent-hosts", "commerce-platforms"],
    intents: [
      "give an agent a spending allowance",
      "authorize agent purchases",
      "audit agent spending",
    ],
    keywords: [
      "agents",
      "wallet",
      "allowances",
      "mandates",
      "budgets",
      "payments",
    ],
    protocols: ["AbsoluteJS Agency"],
  },
  identity: {
    accent: "#16a34a",
    category: "commerce",
    description:
      "Double-entry wallets with bounded agent allowances, signed spend mandates, exact reservations, approval thresholds, idempotent capture, refunds, and AP2/UCP adapters.",
    docsUrl: "https://github.com/absolutejs/wallet",
    name: "@absolutejs/wallet",
    tagline: "Move value without losing a cent—or moving it twice.",
  },
  settings: Type.Object({}),
  slots: {},
  tools: {
    wallet_policy: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: { effects: ["read"], requiredScopes: ["wallet:read"] },
      description:
        "Explain this wallet's currency, deposit and balance limits, marketplace fee, and direct-trade fee.",
      handler: (_input, agentWallet) =>
        JSON.stringify(agentWallet.wallet.policy),
      input: Type.Object({}),
    }),
    quote_spend: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: { effects: ["read"], requiredScopes: ["wallet:read"] },
      description:
        "Check an agent spend against its allowance without reserving or moving funds.",
      handler: async (input, agentWallet) =>
        JSON.stringify(await agentWallet.quoteSpend(input)),
      input: Type.Object({
        action: Type.String(),
        agentId: Type.String(),
        allowanceId: Type.String(),
        amountCents: Type.Integer({ minimum: 1 }),
        cartHash: Type.String(),
        category: Type.Optional(Type.String()),
        currency: Type.String(),
        expiresAt: Type.String(),
        idempotencyKey: Type.String(),
        merchantId: Type.String(),
        refundable: Type.Optional(Type.Boolean()),
      }),
    }),
    request_spend: tool.runtime({
      authorization: {
        approval: "policy",
        effects: ["purchase"],
        idempotencyKeyField: "idempotencyKey",
        requiredScopes: ["wallet:spend"],
        spend: { amountMinorField: "amountCents", currencyField: "currency" },
      },
      description:
        "Reserve funds and create a signed, exact merchant/cart/amount spend mandate under an agent allowance.",
      handler: async (input, agentWallet) =>
        JSON.stringify(await agentWallet.requestSpend(input)),
      input: Type.Object({
        action: Type.String(),
        agentId: Type.String(),
        allowanceId: Type.String(),
        amountCents: Type.Integer({ minimum: 1 }),
        cartHash: Type.String(),
        category: Type.Optional(Type.String()),
        currency: Type.String(),
        expiresAt: Type.String(),
        idempotencyKey: Type.String(),
        merchantId: Type.String(),
        refundable: Type.Optional(Type.Boolean()),
      }),
    }),
    execute_approved_spend: tool.runtime({
      authorization: {
        approval: "policy",
        effects: ["purchase", "transfer", "external-network"],
        requiredScopes: ["wallet:spend"],
        spend: { amountMinorField: "amountCents", currencyField: "currency" },
      },
      description:
        "Capture an active or approved signed mandate. Merchant, cart, currency, and amount must match exactly.",
      handler: async (input, agentWallet) =>
        JSON.stringify(await agentWallet.captureSpend(input)),
      input: Type.Object({
        amountCents: Type.Integer({ minimum: 1 }),
        assetId: Type.String(),
        cartHash: Type.String(),
        currency: Type.String(),
        mandateId: Type.String(),
        merchantId: Type.String(),
      }),
    }),
    cancel_spend: tool.runtime({
      authorization: {
        effects: ["write"],
        requiredScopes: ["wallet:spend"],
        reversible: true,
      },
      description:
        "Cancel an unused spend mandate and release its exact reservation.",
      handler: async ({ mandateId }, agentWallet) =>
        JSON.stringify(await agentWallet.cancelSpend(mandateId)),
      input: Type.Object({ mandateId: Type.String() }),
    }),
  },
  wiring: [],
});
