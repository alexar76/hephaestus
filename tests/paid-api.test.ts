import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizationData, payStep, paymentPreflight, paymentTransaction, pendingOnChain,
  type PaidStep, type RunSession,
} from '../studio/src/paidApi';

const wallet = `0x${'12'.repeat(20)}`;
const seller = `0x${'34'.repeat(20)}`;
const token = `0x${'56'.repeat(20)}`;
const signature = `0x${'78'.repeat(64)}1b`;
const hash = `0x${'90'.repeat(32)}`;
const step = (): PaidStep => ({
  id: 'read', capability_id: 'read@v1', source_hub: 'local', quoted_usd: 0.004, status: 'awaiting_payment',
  terms: { chain_id: 8453, token: 'USDC', token_contract: token, decimals: 6, pay_to: seller,
    offer_to: seller, amount_units: '4000', seller_units: '4000', fee_units: '0', fee_to: '',
    eip712_name: 'USD Coin', eip712_version: '2', min_confirmations: 1 },
  invoice: { nonce: `0x${'ab'.repeat(32)}`, expires_at: Date.now() / 1000 + 300 },
});
const session = (): RunSession => ({ run_id: 'paid_test', access_token: 'test-secret', wallet });

function provider(send: () => unknown = () => hash) {
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_accounts') return [wallet];
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_call') return '0x100000';
    if (method === 'eth_signTypedData_v4') return signature;
    if (method === 'eth_sendTransaction') return send();
    throw new Error(method);
  });
  vi.stubGlobal('window', { ethereum: { request } });
  vi.stubGlobal('localStorage', { setItem: vi.fn() });
  return request;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('wallet-funded payment isolation', () => {
  it('preflight sends only the graph, without a payment channel or trial identity', async () => {
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => ({ ready: false, blockers: [] }) }));
    vi.stubGlobal('fetch', fetch);
    await paymentPreflight({ nodes: [], channel_id: 'not-for-paid-runs' });
    expect(fetch.mock.calls[0]?.[0]).toBe('/studio/preflight');
    const options = fetch.mock.calls[0]?.[1] as unknown as RequestInit;
    expect(JSON.parse(options.body as string)).toEqual({ nodes: [] });
    expect(options.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('binds exact token amount, seller, chain and nonce to the authorization', () => {
    const offer = step();
    const auth = authorizationData(offer, wallet);
    expect(auth.domain).toMatchObject({ chainId: 8453, verifyingContract: token });
    expect(auth.message).toMatchObject({ from: wallet, to: seller, value: '4000', nonce: offer.invoice!.nonce });
    const tx = paymentTransaction(offer, wallet, signature);
    expect(tx.to).toBe(token);
    expect(tx.data.slice(0, 10)).toBe('0xe3ee160e');
    expect(tx.data.length).toBe(10 + 9 * 64);
  });

  it('uses receive authorization for a splitter and pays exactly one gross amount', () => {
    const offer = step();
    offer.terms = { ...offer.terms!, offer_to: `0x${'cd'.repeat(20)}`, fee_units: '100', seller_units: '3900' };
    expect(authorizationData(offer, wallet).primaryType).toBe('ReceiveWithAuthorization');
    const tx = paymentTransaction(offer, wallet, signature);
    expect(tx.to).toBe(offer.terms.offer_to);
    expect(tx.data.slice(0, 10)).toBe('0x6e92be7a');
    expect(tx.data.length).toBe(10 + 10 * 64);
  });

  it('stores the broadcast marker before sending and records the returned hash', async () => {
    const active = session();
    provider(() => {
      expect(active.pending).toEqual({ step_id: 'read' });
      expect(localStorage.setItem).toHaveBeenCalled();
      return hash;
    });
    expect(await payStep(step(), active)).toBe(hash);
    expect(active.pending?.tx_hash).toBe(hash);
  });

  it('never broadcasts again after an ambiguous wallet failure', async () => {
    const active = session();
    const request = provider(() => { throw new Error('transport lost'); });
    await expect(payStep(step(), active)).rejects.toThrow('transport lost');
    await expect(payStep(step(), active)).rejects.toThrow('Reconcile');
    expect(request.mock.calls.filter(([r]) => r.method === 'eth_sendTransaction')).toHaveLength(1);
  });

  it('does not broadcast when safe recovery cannot be saved', async () => {
    const request = provider();
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('storage unavailable'); } });
    await expect(payStep(step(), session())).rejects.toThrow('storage unavailable');
    expect(request.mock.calls.some(([r]) => r.method === 'eth_sendTransaction')).toBe(false);
  });

  it('an explicit wallet rejection permits another user-approved attempt', async () => {
    const active = session();
    provider(() => { throw Object.assign(new Error('rejected'), { code: 4001 }); });
    await expect(payStep(step(), active)).rejects.toThrow('rejected');
    expect(active.pending).toBeUndefined();
  });
});


describe('unknown broadcast is settled by the chain, not by the user typing a hash', () => {
  function chain(used: boolean, logs: unknown[] = []) {
    const request = vi.fn(async ({ method, params }: { method: string; params?: any[] }) => {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_call') {
        expect(params?.[0].data.startsWith('0xe94a0102')).toBe(true);  // authorizationState(wallet, nonce)
        return '0x' + (used ? '1' : '0').padStart(64, '0');
      }
      if (method === 'eth_blockNumber') return '0x100000';
      if (method === 'eth_getLogs') return logs;
      throw new Error(method);
    });
    vi.stubGlobal('window', { ethereum: { request } });
  }

  it('finds the transaction of a used authorization', async () => {
    chain(true, [{ transactionHash: hash }]);
    expect(await pendingOnChain(step(), session())).toEqual({ used: true, tx_hash: hash });
  });

  it('reports an unused authorization, expired only after the invoice', async () => {
    chain(false);
    expect(await pendingOnChain(step(), session())).toEqual({ used: false, expired: false });
    const old = { ...step(), invoice: { nonce: `0x${'ab'.repeat(32)}`, expires_at: Date.now() / 1000 - 5 } };
    expect(await pendingOnChain(old, session())).toEqual({ used: false, expired: true });
  });
});
