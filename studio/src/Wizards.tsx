/**
 * The wizard menu: goals, not capability ids.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { estimateBlueprint, formatEstimate } from '@core/estimate';
import { planWizards } from '@core/wizards';
import type { Blueprint, Capability } from '@core/types';
import { useI18n } from './i18n';

interface Props {
  capabilities: Capability[];
  onPick: (blueprint: Blueprint, note: string) => void;
  forceOpen?: boolean;
  onForceOpenHandled?: () => void;
}

export default function Wizards({
  capabilities,
  onPick,
  forceOpen,
  onForceOpenHandled,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const plans = useMemo(() => planWizards(capabilities), [capabilities]);

  useEffect(() => {
    if (!forceOpen) return;
    setOpen(true);
    onForceOpenHandled?.();
  }, [forceOpen, onForceOpenHandled]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const ready = plans.filter((p) => p.available).length;

  return (
    <div className="wizards" ref={wrapRef}>
      <button
        type="button"
        className={open ? 'open' : undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={capabilities.length === 0}
      >
        {t('wizards')}
        {ready > 0 && <span className="count">{ready}</span>}
      </button>

      {open && (
        <div className="sheet" role="menu">
          <div className="head">{t('wizards_head')}</div>

          {plans.map((plan) => {
            if (!plan.available) {
              return (
                <div className="wiz unavailable" key={plan.wizard.id}>
                  <div className="title">{plan.wizard.title}</div>
                  <div className="goal">{plan.wizard.goal}</div>
                  <div className="why">{plan.reason}</div>
                </div>
              );
            }
            const estimate = estimateBlueprint(plan.blueprint, capabilities);
            return (
              <button
                type="button"
                className="wiz"
                key={plan.wizard.id}
                role="menuitem"
                onClick={() => {
                  onPick(plan.blueprint, plan.note);
                  setOpen(false);
                }}
              >
                <div className="title">{plan.wizard.title}</div>
                <div className="goal">{plan.wizard.goal}</div>
                <div className="chain">
                  {plan.picks.map((pick) => pick.capability.capabilityId).join(' → ')}
                </div>
                <div className="figures">
                  <span className="price">{formatEstimate(estimate)}</span>
                  <span className="note">{plan.note}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
