import type { MediaParamSpec, MediaParamValue } from "@bai/shared";
import { Field, TextInput } from "./field";
import { Select } from "./Select";
import { ToggleRow } from "./toggle";

/**
 * The generic media-parameter form: renders a capability spec (enum pickers,
 * toggles, ranges with min/max, numbers, text) and reports the whole value
 * map on every change. Shared by the image workbench page and the Image
 * Generation settings (default parameters), so both stay in lockstep.
 */
export function MediaParamsForm({
  specs,
  value,
  onChange,
}: {
  specs: MediaParamSpec[];
  value: Record<string, MediaParamValue>;
  onChange: (next: Record<string, MediaParamValue>) => void;
}) {
  if (specs.length === 0) return null;
  const set = (key: string, v: MediaParamValue): void => onChange({ ...value, [key]: v });
  return (
    <div className="media-params">
      {specs.map((spec) => {
        if (spec.kind === "enum") {
          return (
            <Field key={spec.key} label={spec.label} hint={spec.hint}>
              <Select
                value={String(value[spec.key] ?? spec.default ?? spec.options[0]?.value ?? "")}
                onChange={(v) => set(spec.key, v)}
                ariaLabel={spec.label}
                options={spec.options}
              />
            </Field>
          );
        }
        if (spec.kind === "toggle") {
          return (
            <ToggleRow
              key={spec.key}
              checked={Boolean(value[spec.key] ?? spec.default ?? false)}
              onChange={(next) => set(spec.key, next)}
              title={spec.label}
              description={spec.hint}
            />
          );
        }
        if (spec.kind === "range") {
          const current =
            typeof value[spec.key] === "number" ? (value[spec.key] as number) : (spec.default ?? spec.min);
          return (
            <Field key={spec.key} label={spec.label} hint={spec.hint}>
              <div className="param-range">
                <input
                  type="range"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step ?? 1}
                  value={current}
                  aria-label={spec.label}
                  onChange={(e) => set(spec.key, Number(e.target.value))}
                />
                <span className="param-range-value">
                  {current}
                  {spec.unit ?? ""}
                </span>
              </div>
            </Field>
          );
        }
        if (spec.kind === "number") {
          const current = typeof value[spec.key] === "number" ? (value[spec.key] as number) : spec.default;
          return (
            <Field key={spec.key} label={spec.label} hint={spec.hint}>
              <TextInput
                type="number"
                min={spec.min}
                max={spec.max}
                value={current ?? ""}
                aria-label={spec.label}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  set(spec.key, Number.isFinite(n) ? n : 0);
                }}
              />
            </Field>
          );
        }
        return (
          <Field key={spec.key} label={spec.label} hint={spec.hint}>
            <TextInput
              type="text"
              value={String(value[spec.key] ?? spec.default ?? "")}
              placeholder={spec.placeholder}
              aria-label={spec.label}
              onChange={(e) => set(spec.key, e.target.value)}
            />
          </Field>
        );
      })}
    </div>
  );
}
