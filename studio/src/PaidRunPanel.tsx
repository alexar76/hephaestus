import { useEffect, useState } from 'react';
import type { PipelineRequest } from '@core/types';
import type { RunResult } from './api';
import { useI18n } from './i18n';
import {
  advancePaidRun, clearPending, connectWallet, downloadBill, loadSession, payStep, paymentPreflight,
  pendingOnChain, readPaidRun, saveSession, SESSION_KEY,
  type PaidRun, type Preflight, type RunSession,
} from './paidApi';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const pause = () => new Promise((resolve) => setTimeout(resolve, 2000));

export default function PaidRunPanel({ open, request, onClose, onResult }: {
  open: boolean; request: PipelineRequest | null; onClose: () => void; onResult: (run: RunResult) => void;
}) {
  const { t } = useI18n();
  const [quote, setQuote] = useState<Preflight | null>(null);
  const [run, setRun] = useState<PaidRun | null>(null);
  const [session, setSession] = useState<RunSession | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [wallet, setWallet] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recoveryHash, setRecoveryHash] = useState('');
  const requestKey = JSON.stringify(request);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBusy(true); setError(''); setBalance(null); setWallet('');
    setQuote(null); setRun(null); setSession(null); setRecoveryHash('');
    const saved = loadSession();
    const load = saved
      ? readPaidRun(saved).then((value) => {
        if (alive) { setSession(saved); setRun(value); setQuote(null); setWallet(saved.wallet); }
      })
      : request ? paymentPreflight(request).then((value) => {
        if (alive) { setQuote(value); setRun(null); setSession(null); }
      }) : Promise.resolve();
    load.catch((e: unknown) => { if (alive) setError(message(e)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
    // Input changes invalidate the displayed quote, never the stored in-flight run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, requestKey]);

  const terms = quote?.steps.find((s) => s.terms)?.terms ?? run?.next_step?.terms;
  const terminal = run?.status === 'completed' || run?.status === 'failed';
  const unknownBroadcast = Boolean(session?.pending && !session.pending.tx_hash &&
    run?.next_step?.id === session.pending.step_id && !run.next_step.tx_hash);

  const connect = async () => {
    if (!terms) return;
    setBusy(true); setError('');
    try {
      const connected = await connectWallet(terms);
      if (session && connected.wallet !== session.wallet) throw new Error(t('paid_wallet_changed'));
      setWallet(connected.wallet); setBalance(connected.balance);
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };

  // A wallet error other than "rejected" leaves the broadcast status unknown. Without a hash the
  // run could not continue; the chain knows whether the step's authorization was used.
  const checkChain = async () => {
    if (!session || !run?.next_step) return;
    setBusy(true); setError('');
    try {
      const answer = await pendingOnChain(run.next_step, session);
      if (answer.used && answer.tx_hash) { setRecoveryHash(answer.tx_hash); setError(t('paid_chain_found')); }
      else if (answer.used) setError(t('paid_chain_used'));
      else if (answer.expired) { clearPending(session); setSession({ ...session }); setError(t('paid_chain_cleared')); }
      else setError(t('paid_chain_wait'));
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };

  const execute = async () => {
    if (!wallet) return;
    setBusy(true); setError('');
    const active = session ?? (quote?.run_id && quote.access_token ? {
      run_id: quote.run_id, access_token: quote.access_token, wallet,
    } : null);
    if (!active) { setBusy(false); return; }
    try {
      saveSession(active); setSession(active);
      if (unknownBroadcast) {
        if (!/^0x[\da-f]{64}$/i.test(recoveryHash)) throw new Error(t('paid_unknown'));
        active.pending!.tx_hash = recoveryHash;
        saveSession(active);
      }
      let current = await readPaidRun(active);
      // The quote fixes at most sixteen steps. Pending chain settlement is bounded;
      // resume always submits the SAME transaction, never opens another payment.
      let polls = 0;
      while (current.next_step && current.status !== 'failed' && current.status !== 'completed') {
        setRun(current); onResult(current);
        if (current.busy) { setError(t('paid_busy')); break; }
        let step = current.next_step;
        let tx = step.tx_hash ?? (active.pending?.step_id === step.id ? active.pending.tx_hash : undefined);
        if (step.terms && step.invoice && !tx) {
          if (active.pending?.step_id === step.id) throw new Error(t('paid_unknown'));
          // Revalidate before opening the wallet, even when resuming an old tab.
          current = await advancePaidRun(active, step.id);
          setRun(current);
          if (!current.next_step || current.busy || current.status === 'failed') continue;
          step = current.next_step;
          tx = await payStep(step, active);
        }
        current = await advancePaidRun(active, step.id, tx);
        if (current.next_step?.status === 'payment_pending') {
          if (++polls >= 30) { setError(t('paid_pending')); break; }
          await pause();
        } else {
          polls = 0;
        }
        if (active.pending && current.next_step?.id !== active.pending.step_id) {
          delete active.pending; saveSession(active);
        }
      }
      setRun(current); onResult(current);
    } catch (e) {
      setError(message(e));
      // Keep the bill visible even if a later wallet prompt or HTTP request fails.
      try { const latest = await readPaidRun(active); setRun(latest); onResult(latest); } catch { /* saved session can resume */ }
    } finally { setBusy(false); }
  };

  const newQuote = async () => {
    if (!request) return;
    setBusy(true); setError('');
    try {
      localStorage.removeItem(SESSION_KEY);
      setSession(null); setRun(null); setQuote(null); setWallet(''); setBalance(null);
      setQuote(await paymentPreflight(request));
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };

  if (!open) return null;
  const shortage = quote && balance !== null ? BigInt(quote.total_units) - balance : 0n;
  const units = (n: bigint) => (Number(n) / 10 ** (terms?.decimals ?? 6)).toFixed(6);

  return <div className="paid-overlay">
    <section className="paid-panel" role="dialog" aria-modal="true" aria-labelledby="paid-title">
      <div className="paid-heading">
        <h2 id="paid-title">{t('paid_title')}</h2>
        <button type="button" onClick={onClose} disabled={busy}>{t('paid_close')}</button>
      </div>
      <p>{t('paid_explain', { run: t('run') })}</p>
      {error && <div className="msg err" role="alert">{error}</div>}
      {quote && <>
        <div className="paid-total">{t(quote.ready ? 'paid_maximum' : 'paid_known', { amount: quote.total_usd?.toFixed(6) ?? '—' })}</div>
        <ul>{quote.steps.map((s) => <li key={s.id}>
          <strong>{s.capability_id}</strong> · ${s.quoted_usd.toFixed(6)}
          <div className="paid-address">{s.source_hub}</div>
          {s.terms && <><div className="paid-address">{t('paid_seller')}: {s.terms.pay_to}</div>
            {BigInt(s.terms.fee_units) > 0n && <div className="paid-address">
              {t('paid_fee')}: {units(BigInt(s.terms.fee_units))} {s.terms.token} → {s.terms.fee_to}
            </div>}</>}
        </li>)}</ul>
        {quote.blockers.map((b, i) => <div className="msg err" key={i}>{b.capability_id ?? b.id}: {b.detail}</div>)}
        {quote.ready && quote.total_units === '0' && <div className="msg ok">{t('paid_free', { run: t('run') })}</div>}
      </>}
      {wallet && <div className="paid-address">{t('paid_wallet')}: {wallet}</div>}
      {balance !== null && <p>{t('paid_balance', { amount: units(balance), token: terms?.token ?? '' })}</p>}
      {shortage > 0n && <div className="msg warn">{t('paid_shortage', { amount: units(shortage), token: terms?.token ?? '' })}</div>}
      {terms && <p className="hint">{t('paid_gas')}</p>}
      {run && <>
        <p>{t('paid_status')}: {run.status} · {run.trace_id}</p>
        <div className="msg note">{t('paid_spent', { amount: run.bill_of_materials?.total_usd?.toFixed(6) ?? '0' })}</div>
        <ul>{run.bill_of_materials?.steps?.map((s) => <li key={s.id}>
          {s.capability_id} · {s.status} · ${(s.price_usd ?? 0).toFixed(6)}
          {s.error && <div className="msg err">{s.error}</div>}
          {s.tx_hash && <div className="paid-address">{s.tx_hash}</div>}
        </li>)}</ul>
        {run.detail && <p>{run.detail}</p>}
        <button type="button" onClick={() => downloadBill(run)}>{t('paid_download')}</button>
      </>}
      {unknownBroadcast && <label className="field">{t('paid_recovery')}
        <input value={recoveryHash} onChange={(e) => setRecoveryHash(e.target.value)} placeholder="0x…" />
      </label>}
      {unknownBroadcast && <button type="button" onClick={checkChain} disabled={busy}>{t('paid_check_chain')}</button>}
      <div className="paid-actions">
        {terms && !terminal && <button type="button" onClick={connect} disabled={busy}>{t('paid_connect')}</button>}
        {!terminal && <button type="button" className="primary" onClick={execute}
          disabled={busy || !wallet || shortage > 0n || (!session && (!quote?.ready || quote.total_units === '0'))}>
          {busy ? t('running') : session ? t('paid_resume') : t('paid_confirm')}
        </button>}
        {(!session || terminal) && <button type="button" onClick={newQuote} disabled={busy}>{t('paid_recheck')}</button>}
      </div>
      <p className="hint">{t('paid_failure')}</p>
    </section>
  </div>;
}
