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

`walletPostgresSchemaSql()` supplies a production PostgreSQL journal with a
deferred database constraint that rejects unbalanced transactions at commit.
