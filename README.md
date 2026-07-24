# @absolutejs/wallet

Closed-loop, dollar-denominated wallets for AbsoluteJS applications. Balances are
integer cents, every movement is a balanced journal transaction, retries are
idempotent, and bids/auctions reserve funds before settlement.

```ts
import { createMemoryWalletStore, createWallet } from "@absolutejs/wallet";

const wallet = createWallet(createMemoryWalletStore());
await wallet.createAccount("user_123");
```

The bundled policy starts with the AbsoluteJS marketplace decisions: USD display,
$5 minimum funding, $2,000 maximum balance, $1,800 maximum transaction, 10%
seller-paid market fee, and a $0.25 fee per direct-trade participant.

The package does not process cards, custody crypto, or promise cash redemption.
Payment adapters fund the clearing side of a journal entry after a verified webhook;
applications provide a transactional persistent `WalletStore` for production.
For Bun/PostgreSQL hosts, pass one `createBunSqlWalletClient(sql)` instance to
both PostgreSQL stores. Its async transaction context makes nested core Wallet
operations join the allowance transaction, including with a one-connection
pool.

## Agent allowances

`createAgentWallet` grants an agent narrowly bounded spend authority: per-item,
daily, weekly, and lifetime caps; merchant/category/action allowlists; expiry;
refundability; and a maximum number of open reservations. Requests reserve the
exact amount and produce a signed mandate bound to the merchant, cart hash,
currency, amount, agent, allowance, reservation, and expiration.

Amounts above `autoApproveUpToCents` become an `@absolutejs/agency` action.
Capture cannot proceed until current policy accepts the approval, and it then
executes through a single-use agency lease. The model never receives a raw
balance mutation tool.

Agency is a required host peer (`>=0.7.1 <0.8.0`) and is externalized from the
Wallet build. Allowances and every other agent surface therefore share the
host's one approval ledger. This package tests against exactly `0.7.1`; a new
Agency minor requires an explicit compatibility release.

External provider effects use `captureExternalSpend()` only after the provider
has succeeded or conclusive reconciliation evidence proves it succeeded. The
purchase atomically captures the exact reservation into a provider clearing
account and binds retries to the provider and payment reference. A successfully
compensated provider effect uses `refundExternalSpend()` to reverse that exact
journal boundary; both operations are safe to retry after a host crash.

The package also exports structural AP2 intent/payment mandate adapters and a
UCP extension payload. Those evolving protocols remain adapters; the wallet's
allowance and accounting contracts do not depend on them.

`walletPostgresSchemaSql()` supplies a production PostgreSQL journal with a
deferred database constraint that rejects unbalanced transactions at commit.
