import { STAGE_LABEL, STAGES } from '@/lib/format';

/** Where a VAT period is in its life: open → in review → signed off → filed → paid → closed. */
export function StageTrack({ status }: { status: string | null }) {
  const at = status ? STAGES.indexOf(status as (typeof STAGES)[number]) : -1;
  return (
    <div>
      <div className="track" aria-hidden>
        {STAGES.map((s, i) => <span key={s} className={i <= at ? 'done' : ''} />)}
      </div>
      <span className="track-label">{status ? STAGE_LABEL[status] : 'No period'}</span>
    </div>
  );
}
