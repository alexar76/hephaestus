import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { useI18n } from './i18n';

export interface NodePayload extends Record<string, unknown> {
  label: string;
  kind: 'trigger' | 'capability' | 'output';
  priceUsd: number | null;
  latencyMs: number | null;
  reputation: string;
  invalid: boolean;
  needsWire: boolean;
  onSelect?: () => void;
}

export type StudioFlowNode = Node<NodePayload, 'studio'>;

/**
 * A node shows cost, latency, and reliability evidence. Handles are large on purpose —
 * visitors could not find the 7px dots that wire the graph.
 */
export default function CapabilityNode({ data, selected }: NodeProps<StudioFlowNode>) {
  const { t } = useI18n();
  const className = [
    'node',
    selected ? 'selected' : '',
    data.invalid ? 'invalid' : '',
    data.needsWire ? 'needs-wire' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      onClick={(e) => {
        e.stopPropagation();
        data.onSelect?.();
      }}
    >
      {data.kind !== 'trigger' && (
        <Handle
          type="target"
          position={Position.Top}
          className="handle-in"
          title={t('handle_in')}
        />
      )}
      <div className="kind">{data.kind}</div>
      <div className="label">{data.label}</div>
      {data.kind === 'capability' && (
        <div className="foot">
          <span className="p">
            {data.priceUsd === null ? 'unpriced' : `$${data.priceUsd.toFixed(4)}`}
          </span>
          {data.latencyMs !== null && <span>{data.latencyMs} ms</span>}
          <span title="reliability evidence">{data.reputation}</span>
        </div>
      )}
      {data.needsWire && <div className="wire-badge">{t('needs_wire')}</div>}
      {data.kind !== 'output' && (
        <Handle
          type="source"
          position={Position.Bottom}
          className="handle-out"
          title={t('handle_out')}
        />
      )}
    </div>
  );
}
