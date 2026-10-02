import { useMemo, useState } from 'react';
import { reputationLabel } from '@core/catalog';
import type { Capability } from '@core/types';
import { useI18n } from './i18n';

export default function Palette({
  capabilities,
  onAdd,
  onLoadExample,
  onOpenWizards,
  loading,
  error,
}: {
  capabilities: Capability[];
  onAdd: (capability: Capability) => void;
  onLoadExample: () => void;
  onOpenWizards: () => void;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [expert, setExpert] = useState(false);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return capabilities;
    return capabilities.filter(
      (c) =>
        c.capabilityId.toLowerCase().includes(q) ||
        c.productId.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q),
    );
  }, [capabilities, query]);

  const wireable = capabilities.filter((c) => c.composable.inputDeclared && c.composable.outputDeclared);

  return (
    <aside className="pane left">
      <h2>{expert ? t('palette_catalogue') : t('start_title')}</h2>

      {!expert && !loading && !error && (
        <div className="body start-panel">
          <button type="button" className="start-btn primary" onClick={onLoadExample}>
            <span className="start-btn-title">{t('start_example')}</span>
            <span className="start-btn-hint">{t('start_example_hint')}</span>
          </button>
          <button type="button" className="start-btn" onClick={onOpenWizards}>
            <span className="start-btn-title">{t('start_wizards')}</span>
            <span className="start-btn-hint">{t('start_wizards_hint')}</span>
          </button>
          <button type="button" className="expert-toggle" onClick={() => setExpert(true)}>
            {t('expert_show')}
          </button>
        </div>
      )}

      {loading && <div className="empty">{t('palette_loading')}</div>}
      {error && (
        <div className="body">
          <div className="msg err">{t('palette_error', { detail: error })}</div>
        </div>
      )}

      {expert && !loading && !error && (
        <>
          <button type="button" className="expert-toggle top" onClick={() => setExpert(false)}>
            {t('expert_hide')}
          </button>
          <div className="msg warn expert-banner">{t('expert_banner')}</div>
          <div className="empty" style={{ paddingBottom: 4 }}>
            {t('palette_meta', { n: capabilities.length, w: wireable.length })}
          </div>
          <input
            className="search"
            placeholder={t('palette_filter_ph')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="body">
            {rows.length === 0 && <div className="empty">{t('palette_nothing')}</div>}
            {rows.map((c) => {
              const blocked = !c.composable.inputDeclared
                ? t('palette_blocked_input')
                : !c.composable.outputDeclared
                  ? t('palette_blocked_output')
                  : null;
              return (
                <button
                  key={c.key}
                  type="button"
                  className="cap"
                  disabled={Boolean(blocked)}
                  title={c.description}
                  onClick={() => onAdd(c)}
                >
                  <div className="id">{c.capabilityId}</div>
                  <div className="row">
                    <span className="price">
                      {c.routedPriceUsd ?? c.priceUsd ?? null
                        ? `$${(c.routedPriceUsd ?? c.priceUsd)!.toFixed(4)}`
                        : 'unpriced'}
                    </span>
                    <span className="rep">{reputationLabel(c.reputation)}</span>
                  </div>
                  {blocked && <div className="why">{blocked}</div>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </aside>
  );
}
