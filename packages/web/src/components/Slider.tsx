/**
 * A styled range slider with a trailing value badge. The native range input
 * is themed through the shared tokens (track, thumb, focus halo), so it sits
 * beside the other controls instead of reading as a browser default.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  ariaLabel,
  format,
  disabled = false,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  ariaLabel?: string;
  /** Renders the trailing value badge (defaults to the raw number). */
  format?: (value: number) => string;
  disabled?: boolean;
}) {
  return (
    <div className={disabled ? "slider disabled" : "slider"}>
      <input
        type="range"
        className="slider-input"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider-value">{format !== undefined ? format(value) : value}</span>
    </div>
  );
}
