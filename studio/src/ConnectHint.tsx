import { useI18n } from './i18n';

/** Shown when loose blocks sit on the canvas — wiring is the blocker. */
export default function ConnectHint({
  looseCount,
  onLoadExample,
  onRemoveLoose,
  onDismiss,
}: {
  looseCount: number;
  onLoadExample: () => void;
  onRemoveLoose: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  if (looseCount === 0) return null;

  return (
    <div className="connect-hint" role="alert">
      <div className="connect-hint-head">
        <strong>{t('connect_hint_title')}</strong>
        <button type="button" className="canvas-guide-close" onClick={onDismiss} aria-label={t('guide_dismiss')}>
          ×
        </button>
      </div>
      <p>{t('connect_hint_body', { n: looseCount })}</p>
      <ol>
        <li>{t('connect_hint_drag')}</li>
        <li>{t('connect_hint_click')}</li>
      </ol>
      <div className="connect-hint-actions">
        <button type="button" className="primary" onClick={onRemoveLoose}>
          {t('checks_remove_loose')}
        </button>
        <button type="button" onClick={onLoadExample}>
          {t('checks_load_example')}
        </button>
      </div>
    </div>
  );
}
