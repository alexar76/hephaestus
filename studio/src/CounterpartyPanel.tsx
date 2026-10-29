import { useEffect, useMemo, useRef, useState } from 'react';
import { buildCounterpartyReport, planCounterparty, type CounterpartyInput,
  type CounterpartyPlan, type CounterpartyReport } from '@core/counterparty';
import { toPipelineRequest } from '@core/blueprint';
import { estimateBlueprint, formatEstimate } from '@core/estimate';
import type { Blueprint, Capability } from '@core/types';
import { runBlueprint, type RunResult } from './api';
import { useI18n } from './i18n';

interface Props {
  open: boolean;
  capabilities: Capability[];
  onClose: () => void;
  onGraph: (blueprint: Blueprint, plan: CounterpartyPlan) => void;
  onPaid: (plan: CounterpartyPlan) => void;
  paidRecord?: { plan: CounterpartyPlan; run: RunResult; at: number } | null;
  onResult: (result: RunResult) => void;
}

function safeSourceUrl(value: string | undefined): string | undefined {
  try {
    const url = new URL(value ?? '');
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

function download(report: CounterpartyReport): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `counterparty-${report.traceId?.replace(/[^a-z0-9_-]/gi, '') || 'report'}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function CounterpartyPanel({ open, capabilities, onClose, onGraph, onPaid, paidRecord, onResult }: Props) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [input, setInput] = useState<CounterpartyInput>({ legalName: '' });
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<{ plan: CounterpartyPlan; run: RunResult; at: number } | null>(null);
  const plan = useMemo(() => planCounterparty(input, capabilities), [input, capabilities]);
  const estimate = useMemo(() => plan.blueprint ? estimateBlueprint(plan.blueprint, capabilities) : null,
    [plan.blueprint, capabilities]);
  const conversion = useMemo(() => plan.blueprint ? toPipelineRequest(plan.blueprint, capabilities) : null,
    [plan.blueprint, capabilities]);
  const report = useMemo(() => last ? buildCounterpartyReport(last.plan, last.run, last.at) : null, [last]);

  useEffect(() => {
    const el = dialog.current;
    if (open && el && !el.open) el.showModal();
    else if (!open && el?.open) el.close();
  }, [open]);

  useEffect(() => {
    if (paidRecord) { setLast(paidRecord); setInput(paidRecord.plan.input); }
  }, [paidRecord]);

  const field = (name: keyof CounterpartyInput, label: string, required = false) => (
    <label className="cp-field" key={name}>
      <span>{t(label)}{required && ' *'}</span>
      <input name={name} value={input[name] ?? ''} required={required} autoFocus={required}
        autoComplete="off" spellCheck={false} maxLength={name === 'legalName' ? 120 : name === 'country' ? 2 :
          name === 'wallet' ? 128 : name === 'domain' ? 253 : name === 'lei' ? 24 : 20}
        onChange={(e) => setInput((previous) => ({ ...previous, [name]: e.target.value }))} />
    </label>
  );

  async function submit() {
    if (!conversion?.ok || plan.errors.length || running) return;
    const snapshot = plan;
    if (snapshot.blueprint) onGraph(snapshot.blueprint, snapshot);
    setRunning(true);
    setLast(null);
    try {
      const result = await runBlueprint({ ...conversion.request, continue_on_error: true });
      setLast({ plan: snapshot, run: result, at: Date.now() });
      onResult(result);
    } catch (error) {
      const result = { error: 'request_failed', detail: error instanceof Error ? error.message : String(error) };
      setLast({ plan: snapshot, run: result, at: Date.now() });
    } finally { setRunning(false); }
  }

  return (
    <dialog ref={dialog} className="counterparty-panel" aria-labelledby="cp-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="cp-heading">
        <div><div className="cp-eyebrow">HEPHAESTUS / SYMMARTYS</div><h2 id="cp-title">{t('cp_title')}</h2></div>
        <button type="button" onClick={onClose}>{t('cp_close')}</button>
      </div>
      <p className="cp-lead">{t('cp_goal')}</p>
      <div className="cp-layout">
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <fieldset disabled={running}>
            {field('legalName', 'cp_name', true)}
            <div className="cp-form-grid">{field('country', 'cp_country')}{field('registrationNumber', 'cp_number')}</div>
            <p className="cp-hint">{t('cp_identity_hint')}</p>
            <details className="cp-optional" open>
              <summary>{t('cp_optional')}</summary>
              <p className="cp-hint">{t('cp_optional_hint')}</p>
              <div className="cp-form-grid">
                {field('vat', 'cp_vat')}{field('requesterVat', 'cp_requester')}
                {field('lei', 'cp_lei')}{field('domain', 'cp_domain')}
                {field('wallet', 'cp_wallet')}{field('eori', 'cp_eori')}
              </div>
            </details>
          </fieldset>
          <div className="cp-actions">
            <button type="submit" className="primary" disabled={running || !conversion?.ok || plan.errors.length > 0}>
              {t(running ? 'cp_running' : 'cp_run')}
            </button>
            <button type="button" disabled={running || !conversion?.ok || plan.errors.length > 0}
              onClick={() => { onPaid(plan); onClose(); }}>{t('paid_check')}</button>
            <button type="button" disabled={!plan.blueprint || running} onClick={() => {
              if (plan.blueprint) { onGraph(plan.blueprint, plan); onClose(); }
            }}>{t('cp_graph')}</button>
          </div>
        </form>
        <section className="cp-preview" aria-label={t('cp_preview')}>
          <h3>{t('cp_preview')}</h3>
          <div className="cp-price">{estimate ? t('cp_price', { amount: formatEstimate(estimate) }) : '—'}</div>
          {!input.legalName.trim() ? <p className="cp-hint">{t('cp_no_input')}</p> :
            <ul>{plan.checks.map((check) => <li key={check.id}>
              <span>{t(`cp_check_${check.id}`)}</span>
              <small className={check.status === 'unavailable' ? 'cp-warning' : ''}>{t(`cp_${check.status}`)}</small>
            </li>)}</ul>}
          {input.legalName.trim() && plan.errors.length > 0 && <div role="alert" className="cp-warning">
            {plan.errors.map((error) => <p key={error}>{error}</p>)}
          </div>}
          {conversion && !conversion.ok && <div role="alert" className="cp-warning">
            {conversion.errors.map((error) => <p key={error}>{error}</p>)}
          </div>}
        </section>
      </div>

      {report && <section className="cp-report" aria-label={t('cp_report')} aria-live="polite">
        <div className="cp-heading">
          <div><h3>{t('cp_report')}</h3><strong>{report.input.legalName}</strong></div>
          <button type="button" onClick={() => download(report)}>{t('cp_download')}</button>
        </div>
        <p className={report.status === 'complete' ? 'cp-status' : 'cp-warning'}>
          {t(report.status === 'complete' ? 'cp_complete' : 'cp_incomplete')}
        </p>
        {report.checks.some((check) => check.findingCodes.some((code) => code !== 'signature_not_verified')) &&
          <p className="cp-warning">{t('cp_attention')}</p>}
        {last?.run.error && <p className="cp-warning">{last.run.error}: {last.run.detail}</p>}
        <p className="cp-hint">{report.generatedAt} · {report.traceId ?? '—'}</p>
        <p className="cp-hint">{t('cp_policy')}</p>
        <div className="cp-report-checks">
          {report.checks.map((check) => <article className={`cp-check cp-${check.status}`} key={check.id}>
            <h4>{t(`cp_check_${check.id}`)}</h4>
            <p>{t(`cp_summary_${check.summaryCode}`)}</p>
            {check.detail && check.status === 'failed' && <p className="cp-warning">{check.detail}</p>}
            {check.facts.length > 0 && <dl className="cp-facts">{check.facts.map((fact, i) =>
              <div key={`${fact.key}-${i}`}><dt>{t(`cp_fact_${fact.key}`)}</dt><dd>{fact.value}</dd></div>)}</dl>}
            {check.findingCodes.filter((code) => code !== 'signature_not_verified').map((code) =>
              <p className="cp-warning cp-hint" key={code}>{t(`cp_finding_${code}`)}</p>)}
            {check.status !== 'skipped' && check.status !== 'unavailable' && <p className="cp-receipt">
              {t(check.receiptHasSignature ? 'cp_receipt_attached' : check.receiptStatus === 'attached' ? 'cp_receipt_unsigned' : 'cp_receipt_missing')}
            </p>}
            {check.sources.length === 0 && check.status === 'completed' && <p className="cp-warning">{t('cp_source_missing')}</p>}
            {check.sources.map((source, i) => <div className="cp-source" key={`${source.name}-${i}`}>
              <strong>{source.name}</strong>
              {safeSourceUrl(source.url) && <a href={safeSourceUrl(source.url)} target="_blank" rel="noopener noreferrer">{source.url}</a>}
              <span>{t('cp_fetched')}: {source.fetchedAt ?? '—'}</span>
              {source.publishedAt && <span>{t('cp_published')}: {source.publishedAt}</span>}
              <span className={source.freshness !== 'fresh' ? 'cp-warning' : ''}>{t(`cp_${source.freshness}`)}
                {source.ageHours !== null && ` · ${t('cp_age', { hours: source.ageHours.toFixed(1) })}`}</span>
              {source.sha256.map((hash, j) => <code key={`${hash}-${j}`}>SHA-256: {hash}</code>)}
            </div>)}
            {check.result !== undefined && <details><summary>{t('cp_raw')}</summary><pre>{JSON.stringify(check.result, null, 2)}</pre></details>}
          </article>)}
        </div>
        <p className="cp-hint">{t(report.billOfMaterials && typeof report.billOfMaterials === 'object' &&
          'signature' in report.billOfMaterials && report.billOfMaterials.signature ? 'cp_bill_attached' : 'cp_bill_missing')}</p>
        <p className="cp-hint">{t('cp_signatures')}</p>
      </section>}
      <p className="cp-footer">{t('cp_note')}</p>
    </dialog>
  );
}
