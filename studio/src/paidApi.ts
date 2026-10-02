import type { PipelineRequest } from '@core/types';
import type { RunResult } from './api';

export interface PaymentTerms {
  chain_id: number;
  token: string;
  token_contract: string;
  decimals: number;
  pay_to: string;
  offer_to: string;
  amount_units: string;
  seller_units: string;
  fee_units: string;
  fee_to: string;
  eip712_name: string;
  eip712_version: string;
  min_confirmations: number;
}

export interface PaidStep {
  id: string;
  capability_id: string;
  source_hub: string;
  quoted_usd: number;
  price_usd?: number;
  status: string;
  terms: PaymentTerms | null;
  invoice?: { nonce: string; expires_at: number };
  tx_hash?: string;
  payment?: unknown;
  error?: string;
}

export interface Preflight {
  ready: boolean;
  blockers: { id?: string; capability_id?: string; detail: string }[];
  total_usd: number;
  total_units: string;
  steps: PaidStep[];
  run_id?: string;
  access_token?: string;
  expires_at?: number;
}

export interface PaidRun extends RunResult {
  status: string;
  busy: boolean;
  next_step: PaidStep | null;
}

export interface RunSession {
  run_id: string;
  access_token: string;
  wallet: string;
  // Written before opening the wallet. An unknown broadcast is never sent again.
  pending?: { step_id: string; tx_hash?: string };
}

export const SESSION_KEY = 'hephaestus.paid-run.v1';

export function saveSession(session: RunSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function loadSession(): RunSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as RunSession | null;
    return value?.run_id && value.access_token ? value : null;
  } catch { return null; }
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `HTTP ${response.status}`);
  return body as T;
}

export async function paymentPreflight(request: PipelineRequest): Promise<Preflight> {
  return jsonResponse(await fetch('/studio/preflight', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodes: request.nodes }),
  }));
}

export async function readPaidRun(session: RunSession): Promise<PaidRun> {
  return jsonResponse(await fetch(`/studio/paid-runs/${encodeURIComponent(session.run_id)}`, {
    headers: { 'X-Studio-Run-Token': session.access_token }, cache: 'no-store',
  }));
}

export async function advancePaidRun(session: RunSession, stepId: string, txHash?: string): Promise<PaidRun> {
  return jsonResponse(await fetch(`/studio/paid-runs/${encodeURIComponent(session.run_id)}/advance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Studio-Run-Token': session.access_token },
    body: JSON.stringify({ step_id: stepId, wallet: session.wallet, ...(txHash ? { tx_hash: txHash } : {}) }),
  }));
}

export interface WalletProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export function walletProvider(): WalletProvider {
  const ethereum = (window as unknown as { ethereum?: WalletProvider }).ethereum;
  if (!ethereum) throw new Error('Connect an EVM browser wallet to pay for this run.');
  return ethereum;
}

const ADDRESS = /^0x[\da-f]{40}$/i;
const HEX32 = /^0x[\da-f]{64}$/i;
const word = (hex: string): string => hex.replace(/^0x/, '').padStart(64, '0');
const uint = (value: string | number): string => {
  const n = BigInt(value);
  if (n < 0n || n >= 2n ** 256n) throw new Error('Invalid payment quantity');
  return n.toString(16).padStart(64, '0');
};

export async function connectWallet(terms: PaymentTerms): Promise<{ wallet: string; balance: bigint }> {
  const provider = walletProvider();
  const accounts = await provider.request({ method: 'eth_requestAccounts' }) as string[];
  const wallet = accounts[0];
  if (!wallet || !ADDRESS.test(wallet)) throw new Error('No wallet account selected');
  const chainId = `0x${terms.chain_id.toString(16)}`;
  const current = await provider.request({ method: 'eth_chainId' });
  if (BigInt(String(current)) !== BigInt(terms.chain_id)) {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  }
  const balance = await tokenBalance(provider, wallet, terms);
  return { wallet: wallet.toLowerCase(), balance };
}

async function tokenBalance(provider: WalletProvider, wallet: string, terms: PaymentTerms): Promise<bigint> {
  if (!ADDRESS.test(terms.token_contract)) throw new Error('Invalid payment token');
  const value = await provider.request({ method: 'eth_call', params: [{
    to: terms.token_contract, data: `0x70a08231${word(wallet)}`,
  }, 'latest'] });
  return BigInt(String(value));
}

export function authorizationData(step: PaidStep, wallet: string) {
  const t = step.terms;
  if (!t || !step.invoice || !ADDRESS.test(wallet) || !ADDRESS.test(t.pay_to) ||
      !ADDRESS.test(t.offer_to) || !ADDRESS.test(t.token_contract) || !HEX32.test(step.invoice.nonce)) {
    throw new Error('Invalid payment offer');
  }
  const split = BigInt(t.fee_units) > 0n;
  const primaryType = split ? 'ReceiveWithAuthorization' : 'TransferWithAuthorization';
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
      ],
      [primaryType]: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    }, primaryType,
    domain: { name: t.eip712_name, version: t.eip712_version, chainId: t.chain_id, verifyingContract: t.token_contract },
    message: { from: wallet, to: t.offer_to, value: t.amount_units, validAfter: '0',
      validBefore: String(Math.floor(step.invoice.expires_at)), nonce: step.invoice.nonce },
  };
}

/** ABI from IERC3009 and contracts/evm/src/MarketSplitter.sol; all arguments are static. */
export function paymentTransaction(step: PaidStep, wallet: string, signature: string) {
  const auth = authorizationData(step, wallet);
  const t = step.terms!;
  if (!/^0x[\da-f]{130}$/i.test(signature)) throw new Error('Wallet returned an invalid signature');
  const r = signature.slice(2, 66), s = signature.slice(66, 130);
  const rawV = parseInt(signature.slice(130), 16), v = rawV < 27 ? rawV + 27 : rawV;
  if (v !== 27 && v !== 28) throw new Error('Wallet returned an invalid recovery id');
  const tail = [uint(t.amount_units), uint(0), uint(auth.message.validBefore), word(auth.message.nonce), uint(v), r, s];
  const split = BigInt(t.fee_units) > 0n;
  // capabilityId is informational in the splitter, not a payment-binding field.
  const data = split
    ? `0x6e92be7a${[word(t.token_contract), word(t.pay_to), ...tail, '0'.repeat(64)].join('')}`
    : `0xe3ee160e${[word(wallet), word(t.pay_to), ...tail].join('')}`;
  return { from: wallet, to: split ? t.offer_to : t.token_contract, data, value: '0x0' };
}

export async function payStep(step: PaidStep, session: RunSession): Promise<string> {
  if (session.pending) throw new Error('Reconcile the existing payment before broadcasting another transaction.');
  const t = step.terms!;
  const provider = walletProvider();
  const accounts = await provider.request({ method: 'eth_accounts' }) as string[];
  const chain = await provider.request({ method: 'eth_chainId' });
  if (accounts[0]?.toLowerCase() !== session.wallet || BigInt(String(chain)) !== BigInt(t.chain_id)) {
    throw new Error('Wallet or network changed. Reconnect before continuing.');
  }
  if (await tokenBalance(provider, session.wallet, t) < BigInt(t.amount_units)) throw new Error('Insufficient token balance');
  if (!step.invoice || step.invoice.expires_at * 1000 - Date.now() < 20_000) throw new Error('Payment offer expired. Refresh the payment preflight.');
  const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [
    session.wallet, JSON.stringify(authorizationData(step, session.wallet)),
  ] }) as string;
  if (step.invoice.expires_at * 1000 - Date.now() < 10_000) throw new Error('Payment offer expired before broadcast');
  const signedAccounts = await provider.request({ method: 'eth_accounts' }) as string[];
  const signedChain = await provider.request({ method: 'eth_chainId' });
  if (signedAccounts[0]?.toLowerCase() !== session.wallet || BigInt(String(signedChain)) !== BigInt(t.chain_id)) {
    throw new Error('Wallet or network changed before broadcast.');
  }
  const transaction = paymentTransaction(step, session.wallet, signature);
  const pending = { step_id: step.id };
  saveSession({ ...session, pending }); // A storage failure must stop BEFORE broadcast.
  session.pending = pending;
  let hash: unknown;
  try {
    hash = await provider.request({ method: 'eth_sendTransaction', params: [transaction] });
  } catch (error) {
    if ((error as { code?: number }).code === 4001) {
      delete session.pending;
      saveSession(session);
    }
    throw error;
  }
  if (typeof hash !== 'string' || !HEX32.test(hash)) throw new Error('Broadcast status unknown. Check your wallet before continuing.');
  session.pending.tx_hash = hash;
  saveSession(session);
  return hash;
}

/**
 * After a wallet error that left the broadcast status unknown, ask the chain instead of the user.
 * The step's EIP-3009 authorization either was used (the token's authorizationState says so, and
 * its AuthorizationUsed event names the transaction) or was not. Unused and past the invoice expiry,
 * it can never move funds, so the pending marker can be cleared without risking a double payment.
 */
export type ChainAnswer = { used: true; tx_hash?: string } | { used: false; expired: boolean };
export async function pendingOnChain(step: PaidStep, session: RunSession): Promise<ChainAnswer> {
  const t = step.terms, invoice = step.invoice;
  if (!t || !invoice) throw new Error('This step has no payment to check.');
  const provider = walletProvider();
  const chain = await provider.request({ method: 'eth_chainId' });
  if (BigInt(String(chain)) !== BigInt(t.chain_id)) throw new Error('Switch the wallet to the payment network to check.');
  const state = await provider.request({ method: 'eth_call', params: [{
    to: t.token_contract, data: '0xe94a0102' + word(session.wallet) + word(invoice.nonce) }, 'latest'] }) as string;
  if (BigInt(state) === 0n) return { used: false, expired: invoice.expires_at * 1000 < Date.now() };
  let txHash: string | undefined;
  try {
    const head = BigInt(String(await provider.request({ method: 'eth_blockNumber' })));
    const logs = await provider.request({ method: 'eth_getLogs', params: [{
      address: t.token_contract, fromBlock: '0x' + (head > 20_000n ? head - 20_000n : 0n).toString(16), toBlock: 'latest',
      topics: ['0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5', '0x' + word(session.wallet), invoice.nonce],
    }] }) as Array<{ transactionHash?: string }>;
    txHash = logs.map((l) => l.transactionHash ?? '').find((h) => HEX32.test(h));
  } catch {
    // Some wallets limit log ranges; the authorization is still known to be used.
  }
  return { used: true, tx_hash: txHash };
}

export function clearPending(session: RunSession): void {
  delete session.pending;
  saveSession(session);
}

export function downloadBill(run: PaidRun): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(run.bill_of_materials, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${run.trace_id ?? 'pipeline'}-bill.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
