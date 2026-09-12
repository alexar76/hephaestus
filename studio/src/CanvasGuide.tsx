import { useI18n } from './i18n';

export default function CanvasGuide({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  if (!visible) return null;

  return (
    <div className="canvas-guide" role="note">
      <div className="canvas-guide-head">
        <strong>{t('guide_title')}</strong>
        <button
          type="button"
          className="canvas-guide-close"
          onClick={onDismiss}
          aria-label={t('guide_dismiss')}
        >
          ×
        </button>
      </div>
      <p className="canvas-guide-lead">{t('guide_lead')}</p>
      <ul className="canvas-guide-steps">
        <li>{t('guide_step1')}</li>
        <li>{t('guide_step2')}</li>
        <li>{t('guide_step3')}</li>
      </ul>
      <p className="canvas-guide-foot">{t('guide_foot')}</p>
    </div>
  );
}
