# Wallet-funded Studio runs

Studio has an optional **Check payment** action beside **Run**. The existing Run
action, `/studio/run`, free/trial identity and factory pipeline API keep their
existing contracts. Building, estimating and running ordinary chains does not
require connecting a payment source.

## Buyer flow

1. Build the graph, then choose **Check payment**. The hub validates dependencies,
   field references, input schemas, exact catalogue origins, prices and settlement
   routes before preparing any invoice or invoking a capability.
2. Review the total budget, sellers and included marketplace commission. Connect
   an EVM browser wallet containing the quoted token. The panel shows the balance
   and any shortfall. Gas is additional and is shown by the wallet.
3. Choose **Confirm budget and run**. Confirm each payment in the wallet. The
   browser signs an EIP-3009 authorization and broadcasts the transfer; the hub
   verifies the transaction before dispatching that step through its ordinary
   `/ai-market/v2/invoke` route. Zero-price steps need no payment.
4. Download the signed bill. It includes the graph digest, every step and origin,
   quoted and confirmed amounts, seller and fee terms, transaction hashes,
   provider receipts, failure details and the unused budget.

The budget is a spending ceiling, not a deposit or a balance reservation. Money
stays in the buyer's wallet until each payment to the seller (or the configured
MarketSplitter). The hub holds neither buyer funds nor private keys. This path
does not use hub credits, a credit line, a payment channel or trial credentials.
If all steps are free, use the ordinary Run action without a wallet.

## Supported settlement routes

The first release supports a graph of at most sixteen nodes using one chain and
one token supported by the hub's existing seller-direct EIP-3009 rail. It accepts
third-party listings with a supported payout, including local external sellers,
peers for which this hub sells, and peer resale without a separate routing fee.
`product_id`, `capability_id` and `source_hub` jointly identify each purchase.

A peer that invoices independently, or requires a separate routing-fee rail, is
reported as a blocker before the first payment. A catalogue entry alone does not
establish a compatible settlement route. This release is a buyer-side pipeline;
it does not give third-party providers credit. Agents can also execute this same
preflighted graph through the new root SKU
[`pipeline.run@v1`](https://github.com/alexar76/aimarket-hub/blob/main/examples/pipeline-run/README.md), using a
bundle of buyer-signed transactions and SUB/1 job linkage.

## Recovery and billing

Preflight fixes the graph and payment terms for 15 minutes. Each step's invoice
uses the existing settlement invoice TTL. The hub rechecks the whole plan before
execution and each step's current terms before preparing its payment. Resolved
upstream values are validated before paying for the dependent step. Schemas may
use embedded definitions; remote schema references are never fetched.

The browser retains the run ID, its scoped access token, wallet address and pending
transaction marker in local storage, so reopening the panel can resume the run.
No payment signature or wallet key is stored there. Treat the run token as a
credential: it grants access to this run's outputs and the ability to advance it.

Before broadcast, the browser saves a pending marker. If broadcast succeeds but
the response is lost, the panel asks for the **existing** transaction hash from
the wallet. It never sends a replacement payment automatically. An explicit
wallet rejection permits retry; an unknown broadcast requires reconciliation.
RPC timeouts or missing confirmations keep the original transaction pending,
including after quote expiry. They do not authorize a second payment.

The hub stores run state in `studio_paid_runs` (migration 42) and uses an atomic
claim before payment verification and provider dispatch. Repeated requests return
the stored outcome. A process interruption during dispatch keeps the run locked
for operator reconciliation: inspect the stored invoice, transaction and provider
receipt before changing state. There is intentionally no automatic lock timeout
that could execute paid work twice.

Confirmed payments remain in the bill when a provider or later step fails. Later
steps are not purchased. Unspent funds remain in the wallet; completed external
payments require a separate seller refund. `payment_unresolved` identifies hashes
whose payment is not yet verified, so `remaining_budget_usd` must not be read as a
confirmed wallet balance. Gas is not included in the bill's capability subtotal.
Bills use the hub's `Signer.sign_object` canonical format; verify against a pinned
hub key with `Signer.verify_object_signature`.

## HTTP contract

All requests are same-origin. No run endpoint forwards browser credit credentials.

| Request | Purpose |
|---|---|
| `POST /studio/preflight` with `{nodes, max_budget_usd?}` | Returns blockers or a fixed quote, `run_id`, `access_token`, expiry and graph digest. No charge or invoke. |
| `GET /studio/paid-runs/{run_id}` | Returns saved status, next step, final output and signed `bill_of_materials`. |
| `POST /studio/paid-runs/{run_id}/advance` with `{step_id, wallet, tx_hash?}` | Prepares the next invoice or verifies its existing transaction and invokes once. |

Read and advance require `X-Studio-Run-Token: <access_token>`. Before paying, call
advance without a hash to get the invoice nonce and expiry. After broadcast,
submit its transaction hash. Poll/resume using that same hash. A different wallet
or replacement hash receives HTTP 409 without terminating the pending run.
Responses use `Cache-Control: no-store`.

## Configuration and verification

Use the hub's existing x402 acceptance, RPC, token, seller payout and optional
MarketSplitter settings. The new migration runs with the existing hub migrations.
Build `hephaestus/studio` and serve it through the hub as usual. The ordinary Run
route still uses its existing `AIMARKET_PIPELINE_EXECUTOR_URL` configuration;
wallet-funded execution runs through the hub itself.

In the AICOM monorepo (the Hub half lives in [alexar76/aimarket-hub](https://github.com/alexar76/aimarket-hub) on its own):

```bash
cd hephaestus
npm run check
npm --prefix studio run build
cd ../aimarket-hub
.venv/bin/python -m pytest tests/test_studio_paid.py tests/test_studio_run.py -q
.venv/bin/python -m pytest tests/test_studio_paid_chain.py -q
```

The chain tests require Foundry/Anvil and a Node TypeScript installation from
Hephaestus. They run the actual browser typed-data and calldata helpers against a
local token and MarketSplitter, with real signatures and transfers of test tokens.
They never use a funded production wallet.
