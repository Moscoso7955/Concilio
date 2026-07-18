/**
 * DatePicker — compact, month-paged single-date picker for form fields.
 * Zero dependencies, dark "terminal green" theme, Monday-first weeks.
 * value / onChange use "YYYY-MM-DD" strings.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";

export interface DatePickerProps {
  value: string;                          // "YYYY-MM-DD" (or "")
  onChange: (date: string) => void;       // emits "YYYY-MM-DD"
  className?: string;
  disabled?: boolean;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // Monday-first
const pad2 = (n: number): string => String(n).padStart(2, "0");
const toYMD = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** Parse "YYYY-MM-DD" as a local date (avoids the UTC shift of new Date("YYYY-MM-DD")). */
const fromYMD = (s: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]); d.setHours(0, 0, 0, 0);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null;
};
const triggerLabel = (s: string): string => {
  const d = fromYMD(s);
  return d ? `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : "Select date";
};

export const DatePicker: React.FC<DatePickerProps> = ({ value, onChange, className, disabled }) => {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [today, setToday] = useState<Date | null>(null);
  // Month currently shown in the popover (first-of-month).
  const [view, setView] = useState<Date>(() => new Date(2000, 0, 1));
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    setToday(t);
    const sel = fromYMD(value);
    setView(new Date((sel || t).getFullYear(), (sel || t).getMonth(), 1));
    setMounted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-anchor the view when opening.
  useEffect(() => {
    if (!open) return;
    const sel = fromYMD(value) || today;
    if (sel) setView(new Date(sel.getFullYear(), sel.getMonth(), 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const grid = useMemo(() => {
    const y = view.getFullYear(), m = view.getMonth();
    const first = new Date(y, m, 1);
    const lead = (first.getDay() + 6) % 7; // Monday-based leading blanks
    const days = new Date(y, m + 1, 0).getDate();
    const cells: (Date | null)[] = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(new Date(y, m, d));
    return cells;
  }, [view]);

  const selected = fromYMD(value);
  const sameDay = (a: Date | null, b: Date | null) =>
    !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  const pick = (d: Date) => { onChange(toYMD(d)); setOpen(false); };

  return (
    <div className={"dp-root" + (className ? " " + className : "")} ref={rootRef}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <button type="button" className="dp-trigger" disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}>
        {mounted ? triggerLabel(value) : "Select date"}
      </button>

      {open && mounted && (
        <div className="dp-pop">
          <div className="dp-head">
            <button type="button" className="dp-nav" aria-label="Previous month"
              onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}>‹</button>
            <span className="dp-title">{MONTHS_SHORT[view.getMonth()]} {view.getFullYear()}</span>
            <button type="button" className="dp-nav" aria-label="Next month"
              onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}>›</button>
          </div>
          <div className="dp-dow">{DOW_SHORT.map((d) => <span key={d} className="dp-dow-cell">{d}</span>)}</div>
          <div className="dp-grid">
            {grid.map((d, i) => d === null ? <span key={i} className="dp-blank" /> : (
              <button key={i} type="button"
                className={"dp-day" + (sameDay(d, selected) ? " is-selected" : sameDay(d, today) ? " is-today" : "")}
                onClick={() => pick(d)}>{d.getDate()}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const CSS = `
.dp-root{position:relative;display:inline-block;font-variant-numeric:tabular-nums;}
.dp-root *{box-sizing:border-box;}
.dp-trigger{min-width:140px;padding:8px 12px;font-size:14px;text-align:left;color:#e5e7eb;background:#2a2a2a;
  border:1px solid #3a3a3a;border-radius:8px;cursor:pointer;font-family:inherit;}
.dp-trigger:disabled{opacity:0.4;cursor:not-allowed;}
.dp-pop{position:absolute;margin-top:4px;left:0;z-index:50;width:min(320px,calc(100vw - 32px));padding:12px;
  background:#2a2a2a;border:1px solid #3a3a3a;border-radius:12px;box-shadow:rgba(0,0,0,0.45) 0 12px 32px;}
.dp-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
.dp-nav{min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;font-size:20px;
  color:#9ca3af;background:none;border:none;cursor:pointer;font-family:inherit;line-height:1;}
.dp-nav:hover{color:#ffffff;}
.dp-title{font-size:14px;font-weight:600;color:#e5e7eb;}
.dp-dow{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px;}
.dp-dow-cell{text-align:center;font-size:10px;color:#6b7280;padding:2px 0;}
.dp-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;}
.dp-blank{}
.dp-day{padding:10px 0;font-size:12px;color:#d1d5db;background:none;border:none;border-radius:6px;cursor:pointer;
  font-family:inherit;font-variant-numeric:tabular-nums;}
.dp-day:hover{background:#2a2a2a;}
.dp-day.is-today{color:#4ade80;font-weight:600;background:#2a2a2a;}
.dp-day.is-selected{background:#22c55e;color:#0b0b0b;font-weight:700;}
`;

export default DatePicker;
