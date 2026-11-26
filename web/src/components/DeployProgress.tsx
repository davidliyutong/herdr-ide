// What a connecting machine's dial is doing (MachineState.deploy): its step,
// and a bar, filled by an upload's bytes, moving for a step of unknown length.
import { deployPercent, deployText, type MachineDeploy } from '../lib/machine';

export function DeployProgress({ deploy }: { deploy: MachineDeploy }) {
  const pct = deployPercent(deploy);
  const known = pct !== undefined;
  const text = deployText(deploy);
  return (
    <div className="deploy-progress">
      {text && <div className="small">{text}</div>}
      <div
        className={`transfer-bar ${known ? '' : 'indeterminate'}`}
        role="progressbar"
        aria-label={text || undefined}
        aria-valuenow={known ? pct : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div style={known ? { width: `${pct}%` } : undefined} />
      </div>
    </div>
  );
}
