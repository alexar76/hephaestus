import { forwardRef, useState } from 'react';
import { findCapability, reputationLabel } from '@core/catalog';
import type { BlueprintNode, Capability, FieldSpec } from '@core/types';
import type { RunResult } from './api';
import { summarizeChecks } from './checkSummary';
import { useI18n } from './i18n';

function coerce(field: FieldSpec, raw: string): unknown {
  if (raw === '') return '';
  if (field.type.includes('number') || field.type.includes('integer')) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (field.type.includes('boolean')) return raw === 'true';
  if (field.type.includes('object') || field.type.includes('array')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

const display = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

export default forwardRef<HTMLElement, {
  node: BlueprintNode | null;
  capabilities: Capability[];
  errors: string[];
  warnings: string[];
  run: RunResult | null;
  note?: string | null;
  onInput: (nodeId: string, field: string, value: unknown) => void;
  onRemoveLoose: () => void;
  onLoadExample: () => void;
}>(function Inspector({
  node,
  capabilities,
  errors,
  warnings,
  run,
  note,
  onInput,
  onRemoveLoose,
  onLoadExample,
}, ref) {
  const { t } = useI18n();
  const [showTech, setShowTech] = useState(false);
  const capability =
    node?.capabilityKey ? findCapability(capabilities, node.capabilityKey) : undefined;
  const summary = summarizeChecks(errors);
  const looseCount = summary.disconnected.length;
  const missingEntries = Object.entries(summary.missingByNode).filter(
    ([label]) => !summary.disconnected.includes(label),
  );

  return (
    <aside className="pane right" ref={ref}>
      <h2>{t('params_title')}</h2>
      <div className="body">
        {!node && (
          <>
            <div className="empty">{t('params_select')}</div>
            <div className="msg note" style={{ marginTop: 8 }}>{t('params_select_hint')}</div>
          </>
        )}

        {node && (
          <div className="params-editing">
            {t('params_editing', { name: node.label || node.id })}
          </div>
        )}

        {node && node.kind !== 'capability' && (
          <div className="msg note">
            {node.kind === 'trigger' ? t('trigger_note') : t('output_note')}
            <div className="hint" style={{ marginTop: 6 }}>{t('params_click_capability')}</div>
          </div>
        )}

        {node && node.kind === 'capability' && !capability && (
          <div className="msg warn">{t('params_stale_capability')}</div>
        )}

        {node && capability && (
          <>
            <div className="msg note">
              <strong>{capability.capabilityId}</strong>
              <br />
              {capability.description || t('no_description')}
              <br />
              {t('reliability')}: {reputationLabel(capability.reputation)}
            </div>

            {capability.inputFields.length === 0 && (
              <div className="msg note">
                {capability.composable.takesNoInput ? t('takes_no_input') : t('no_input_schema')}
              </div>
            )}

            {capability.inputFields.length > 0 && (
              <div className="msg note">{t('ref_hint')}</div>
            )}

            {capability.inputFields.map((field) => (
              <div className="field" key={field.name}>
                <label htmlFor={`f-${field.name}`}>
                  {field.name} <span className="hint">({field.type})</span>
                  {field.required && <span className="req"> *</span>}
                </label>
                <input
                  id={`f-${field.name}`}
                  value={display(node.input[field.name])}
                  placeholder={field.default !== undefined ? display(field.default) : ''}
                  onChange={(e) => onInput(node.id, field.name, coerce(field, e.target.value))}
                />
                {field.description && <div className="hint">{field.description}</div>}
              </div>
            ))}
          </>
        )}
      </div>

      <h2>{t('checks_title')}</h2>
      <div className="body">
        {note && <div className="msg note">{note}</div>}

        {errors.length === 0 && warnings.length === 0 && (
          <div className="msg ok">{t('checks_ok')}</div>
        )}

        {looseCount > 0 && (
          <div className="msg err">
            {looseCount === 1
              ? t('checks_disconnected_one')
              : t('checks_disconnected_many', { n: looseCount })}
            <div className="hint" style={{ marginTop: 6 }}>
              {t('checks_disconnected_hint')}
            </div>
            <div className="check-actions">
              <button type="button" className="primary" onClick={onRemoveLoose}>
                {t('checks_remove_loose')}
              </button>
              <button type="button" onClick={onLoadExample}>
                {t('checks_load_example')}
              </button>
            </div>
          </div>
        )}

        {missingEntries.map(([nodeLabel, fields]) => (
          <div className="msg err" key={nodeLabel}>
            {t('checks_missing_one', { node: nodeLabel, fields: fields.join(', ') })}
          </div>
        ))}

        {summary.other.map((e) => (
          <div className="msg err" key={e}>
            {e}
          </div>
        ))}

        {warnings.map((w) => (
          <div className="msg warn" key={w}>
            {w}
          </div>
        ))}

        {errors.length > 0 && (
          <>
            <button
              type="button"
              className="expert-toggle"
              onClick={() => setShowTech((v) => !v)}
            >
              {showTech
                ? t('checks_hide_details')
                : t('checks_show_details', { n: errors.length })}
            </button>
            {showTech &&
              errors.map((e) => (
                <div className="msg note" key={e}>
                  {e}
                </div>
              ))}
          </>
        )}
      </div>

      {run && (
        <>
          <h2>{t('last_run')}</h2>
          <div className="body trace">
            {run.error ? (
              <div className="msg err">
                {run.error}
                {run.detail ? <> — {run.detail}</> : null}
              </div>
            ) : (
              <>
                <div className="tid">{run.trace_id}</div>
                <div style={{ marginTop: 4 }}>
                  {typeof run.bill_of_materials?.total_usd === 'number'
                    ? `$${run.bill_of_materials.total_usd.toFixed(4)}`
                    : '—'}{' '}
                  · {run.bill_of_materials?.steps?.length ?? 0} hops
                  {typeof run.bill_of_materials?.duration_ms === 'number'
                    ? ` · ${run.bill_of_materials.duration_ms} ms`
                    : ''}
                </div>
                <ul>
                  {(run.bill_of_materials?.steps ?? []).map((s, i) => (
                    <li key={`${s.id ?? i}`}>
                      {s.success ? '✓' : '✗'} {s.capability_id ?? s.id}
                      {typeof s.price_usd === 'number' ? ` · $${s.price_usd.toFixed(4)}` : ''}
                    </li>
                  ))}
                </ul>
                {run.bill_of_materials?.blame?.at_fault?.capability_id && (
                  <div className="msg err" style={{ marginTop: 6 }}>
                    {t('at_fault')}: {run.bill_of_materials.blame.at_fault.capability_id}
                    {typeof run.bill_of_materials.blame.at_fault.status_code === 'number'
                      ? ` (HTTP ${run.bill_of_materials.blame.at_fault.status_code})`
                      : ''}
                    {(run.bill_of_materials.blame.not_at_fault?.length ?? 0) > 0 && (
                      <>
                        {' '}
                        · {t('cleared')}: {run.bill_of_materials.blame.not_at_fault!.join(', ')}
                      </>
                    )}
                  </div>
                )}
                {run.trace_url && (
                  <div style={{ marginTop: 6 }}>
                    <a href={run.trace_url} target="_blank" rel="noreferrer noopener">
                      {t('trace_link')}
                    </a>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
});
