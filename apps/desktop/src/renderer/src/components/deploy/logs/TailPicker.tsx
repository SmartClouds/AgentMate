import { Combobox } from '@/components/ui/combobox';
import { TAIL_CHOICES } from '@/lib/deploy/containers/logs';

/** How many of a log's last lines to start with; `max` leaves out the larger choices. */
export function TailPicker({
  value,
  onChange,
  max = Number.POSITIVE_INFINITY,
}: {
  value: number;
  onChange: (tail: number) => void;
  max?: number;
}): React.JSX.Element {
  const options = TAIL_CHOICES.filter((count) => count <= max).map((count) => ({
    value: String(count),
    label: `Last ${count.toLocaleString('en-US')} lines`,
  }));
  return (
    <Combobox
      className="h-8 w-40 text-xs"
      value={String(Math.min(value, max))}
      onChange={(next) => onChange(Number(next))}
      options={options}
      searchable={false}
      ariaLabel="Lines to read"
    />
  );
}
