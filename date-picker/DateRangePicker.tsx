/**
 * DateRangePicker — a zero-dependency, dark "terminal green" range picker.
 * Plain React + TypeScript + component-scoped inline CSS. No date libs.
 * Weeks ALWAYS start on Monday (hardcoded — no prop for it).
 */
import React, { useEffect, useMemo, useRef, useState } from "react";

export type DateRangePreset =
  | "today" | "yesterday" | "thisWeek" | "lastWeek"
  | "thisMonth" | "lastMonth" | "last3Months" | "thisYear";

export interface DateRangePickerProps {
  initialStartDate?: Date | null;
  initialEndDate?: Date | null;
  onChange?: (start: Date, end: Date) => void;
  weeksToRender?: number;
  minDate?: Date | null;
  /** undefined → today is the max (future blocked); null → no cap; Date → that cap. */
  maxDate?: Date | null;
  presets?: DateRangePreset[];
}

/* ─────────────── date helpers (all day-granularity) ─────────────── */
const norm = (d: Date): Date => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d: Date, n: number): Date => { const x = norm(d); x.setDate(x.getDate() + n); return x; };
const sameDay = (a: Date | null, b: Date | null): boolean =>
  !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** Monday-based start of week. getDay(): 0=Sun..6=Sat → Monday offset = (day+6)%7. */
const mondayOf = (d: Date): Date => addDays(d, -(((norm(d).getDay() + 6) % 7)));
const clampDay = (d: Date, min: Date | null, max: Date | null): Date =>
  min && d < min ? norm(min) : max && d > max ? norm(max) : norm(d);
const longLabel = (d: Date): string =>
  d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const pad2 = (n: number): string => String(n).padStart(2, "0");
const fmtInput = (d: Date): string => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
/** Strict MM/DD/YYYY — rejects impossible dates via round-trip. */
const parseInput = (s: string): Date | null => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const mo = +m[1], da = +m[2], yr = +m[3];
  const d = new Date(yr, mo - 1, da); d.setHours(0, 0, 0, 0);
  return d.getFullYear() === yr && d.getMonth() === mo - 1 && d.getDate() === da ? d : null;
};

const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DOW_LETTERS = ["M", "T", "W", "T", "F", "S", "S"]; // Monday-first
const DEFAULT_PRESETS: DateRangePreset[] = ["today", "yesterday", "thisWeek", "lastWeek", "thisMonth", "lastMonth"];
const PRESET_LABEL: Record<DateRangePreset, string> = {
  today: "Today", yesterday: "Yesterday", thisWeek: "This Week", lastWeek: "Last Week",
  thisMonth: "This Month", lastMonth: "Last Month", last3Months: "Last 3 Months", thisYear: "This Year",
};

const presetRange = (p: DateRangePreset, today: Date): [Date, Date] => {
  const y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
  switch (p) {
    case "today": return [today, today];
    case "yesterday": { const x = addDays(today, -1); return [x, x]; }
    case "thisWeek": return [mondayOf(today), today];
    case "lastWeek": { const mon = addDays(mondayOf(today), -7); return [mon, addDays(mon, 6)]; }
    case "thisMonth": return [norm(new Date(y, m, 1)), today];
    case "lastMonth": return [norm(new Date(y, m - 1, 1)), norm(new Date(y, m, 0))];
    case "last3Months": return [norm(new Date(y, m - 3, d)), today];
    case "thisYear": return [norm(new Date(y, 0, 1)), today];
  }
};

export const DateRangePicker: React.FC<DateRangePickerProps> = ({
  initialStartDate = null, initialEndDate = null, onChange,
  weeksToRender = 61, minDate = null, maxDate, presets = DEFAULT_PRESETS,
}) => {
  const [mounted, setMounted] = useState(false);
  const [today, setToday] = useState<Date | null>(null);
  const [open, setOpen] = useState(false);

  // Committed range (source of truth for the trigger label).
  const [cStart, setCStart] = useState<Date | null>(null);
  const [cEnd, setCEnd] = useState<Date | null>(null);

  // In-progress click selection.
  const [selecting, setSelecting] = useState(false);
  const [draftStart, setDraftStart] = useState<Date | null>(null);
  const [hoverDay, setHoverDay] = useState<Date | null>(null);

  // Typed inputs.
  const [startInput, setStartInput] = useState("");
  const [endInput, setEndInput] = useState("");

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const maxUndefined = maxDate === undefined;
  const effMin = minDate ? norm(minDate) : null;
  const effMax = maxUndefined ? today : maxDate ? norm(maxDate) : null;

  // SSR-safe: seed `today` and defaults after mount (new Date() differs server/client).
  useEffect(() => {
    const t = norm(new Date());
    setToday(t);
    const s = initialStartDate ? norm(initialStartDate) : t;
    const e = initialEndDate ? norm(initialEndDate) : t;
    const os = s <= e ? s : e, oe = s <= e ? e : s;
    setCStart(os); setCEnd(oe);
    setStartInput(fmtInput(os)); setEndInput(fmtInput(oe));
    setMounted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Weeks generated centered on today.
  const weeks = useMemo(() => {
    if (!today) return [] as { start: Date; gutter: string }[];
    const half = Math.floor(weeksToRender / 2);
    const first = addDays(mondayOf(today), -half * 7);
    const out: { start: Date; gutter: string }[] = [];
    for (let i = 0; i < weeksToRender; i++) {
      const start = addDays(first, i * 7);
      let gutter = "";
      for (let j = 0; j < 7; j++) { const day = addDays(start, j); if (day.getDate() === 1) { gutter = MONTH_ABBR[day.getMonth()]; break; } }
      out.push({ start, gutter });
    }
    return out;
  }, [today, weeksToRender]);
  const todayWeekIndex = Math.floor(weeksToRender / 2);

  // On open: scroll today ~a third down, and reset any half-finished selection.
  useEffect(() => {
    if (!open) return;
    setSelecting(false); setDraftStart(null); setHoverDay(null);
    if (cStart) setStartInput(fmtInput(cStart));
    if (cEnd) setEndInput(fmtInput(cEnd));
    const id = requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = todayWeekIndex * 32 - 380 / 3;
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Outside-click + Escape close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const commit = (s: Date, e: Date, fire = true, close = false) => {
    const cs = clampDay(s, effMin, effMax), ce = clampDay(e, effMin, effMax);
    const os = cs <= ce ? cs : ce, oe = cs <= ce ? ce : cs;
    setCStart(os); setCEnd(oe);
    setStartInput(fmtInput(os)); setEndInput(fmtInput(oe));
    setSelecting(false); setDraftStart(null); setHoverDay(null);
    if (fire) onChange?.(os, oe);
    if (close) setOpen(false);
  };

  const isDisabled = (day: Date): boolean => !!(effMin && day < effMin) || !!(effMax && day > effMax);

  // The range currently painted on the calendar (preview while selecting, else committed).
  const paint = ((): { start: Date | null; end: Date | null } => {
    if (selecting && draftStart) {
      const h = hoverDay || draftStart;
      return draftStart <= h ? { start: draftStart, end: h } : { start: h, end: draftStart };
    }
    return { start: cStart, end: cEnd };
  })();

  const onDayClick = (day: Date) => {
    if (isDisabled(day)) return;
    if (!selecting) { setSelecting(true); setDraftStart(day); setHoverDay(day); }
    else { commit(draftStart!, day, true, false); } // stays open
  };

  const applyPreset = (p: DateRangePreset) => { const [s, e] = presetRange(p, today!); commit(s, e, true, false); };

  const onApply = () => {
    const ps = parseInput(startInput), pe = parseInput(endInput);
    const s = ps || cStart || today!, e = pe || cEnd || today!;
    commit(s, e, true, true); // fires + closes
  };

  const onTypeStart = (v: string) => { setStartInput(v); const p = parseInput(v); if (p) { setSelecting(false); setCStart(p); } };
  const onTypeEnd = (v: string) => { setEndInput(v); const p = parseInput(v); if (p) { setSelecting(false); setCEnd(p); } };

  /* ─────────────── render ─────────────── */
  return (
    <div className="drp-root" ref={rootRef}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <button type="button" className="drp-trigger" onClick={() => setOpen((o) => !o)}>
        <span className="drp-label">
          {!mounted ? (
            <span style={{ display: "inline-block", minWidth: 230 }} />
          ) : selecting && draftStart ? (
            <>{longLabel(draftStart)} to <span style={{ opacity: 0.5 }}>pick end</span></>
          ) : cStart && cEnd ? (
            `${longLabel(cStart)} to ${longLabel(cEnd)}`
          ) : (
            <span style={{ display: "inline-block", minWidth: 230 }} />
          )}
        </span>
        <svg className="drp-ico" width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      </button>

      {open && mounted && (
        <div className="drp-pop">
          {/* LEFT: continuously scrollable calendar */}
          <div className="drp-cal">
            <div className="drp-dow-row">
              <span className="drp-gutter" />
              {DOW_LETTERS.map((l, i) => (
                <span key={i} className={"drp-dow" + (i >= 5 ? " drp-dow-weekend" : "")}>{l}</span>
              ))}
            </div>
            <div className="drp-scroll" ref={scrollRef}>
              {weeks.map((wk, wi) => (
                <div className="drp-week" key={wi}>
                  <span className="drp-gutter drp-gutter-month">{wk.gutter}</span>
                  {Array.from({ length: 7 }, (_, j) => {
                    const day = addDays(wk.start, j);
                    const disabled = isDisabled(day);
                    const inRange = !!paint.start && !!paint.end && day >= paint.start && day <= paint.end;
                    const isStart = sameDay(day, paint.start);
                    const isEnd = sameDay(day, paint.end);
                    const isSingle = isStart && isEnd;
                    const isToday = sameDay(day, today);
                    const cls = ["drp-day"];
                    if (disabled) cls.push("is-disabled");
                    if (inRange) cls.push("in-range");
                    if (isStart) cls.push("is-start");
                    if (isEnd) cls.push("is-end");
                    if (isSingle) cls.push("is-single");
                    if (isToday) cls.push("is-today");
                    return (
                      <span key={j} className={cls.join(" ")}
                        onClick={() => onDayClick(day)}
                        onMouseEnter={() => { if (selecting) setHoverDay(day); }}>
                        <span className={"drp-halfL" + (inRange && !isStart ? " filled" : "")} />
                        <span className={"drp-halfR" + (inRange && !isEnd ? " filled" : "")} />
                        {(isStart || isEnd) && <span className="drp-pill" />}
                        <span className="drp-num">{day.getDate()}</span>
                        {isToday && <span className="drp-dot" />}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* RIGHT: presets + inputs */}
          <div className="drp-right">
            {presets.length > 0 && (
              <div className="drp-presets">
                {presets.map((p) => (
                  <button key={p} type="button" className="drp-preset" onClick={() => applyPreset(p)}>
                    {PRESET_LABEL[p]}
                  </button>
                ))}
              </div>
            )}
            <div className="drp-inputs">
              <input className="drp-input" value={startInput} placeholder="MM/DD/YYYY"
                onChange={(e) => onTypeStart(e.target.value)} />
              <div className="drp-to">TO:</div>
              <input className="drp-input" value={endInput} placeholder="MM/DD/YYYY"
                onChange={(e) => onTypeEnd(e.target.value)} />
              <button type="button" className="drp-apply" onClick={onApply}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* ─────────────── component-scoped CSS ─────────────── */
const CSS = `
.drp-root{position:relative;display:inline-block;font-variant-numeric:tabular-nums;color:#e5e7eb;}
.drp-root *{box-sizing:border-box;}
.drp-trigger{display:inline-flex;align-items:center;gap:14px;padding:10px 16px;background:#2a2a2a;
  border:1px solid #3a3a3a;border-radius:10px;font-size:14px;font-weight:500;color:#e5e7eb;cursor:pointer;
  font-family:inherit;}
.drp-trigger:hover{border-color:#22c55e;background:#2f2f2f;}
.drp-label{display:inline-block;width:290px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;}
.drp-ico{color:#22c55e;flex:0 0 auto;}

.drp-pop{position:absolute;top:calc(100% + 8px);left:0;z-index:1000;display:flex;flex-direction:row;
  width:420px;height:402px;background:#1a1a1a;border:1px solid #3a3a3a;border-radius:12px;
  box-shadow:rgba(0,0,0,0.45) 0 12px 32px;overflow:hidden;}

.drp-cal{width:256px;padding:8px 0 0 8px;}
.drp-dow-row{height:20px;}
.drp-dow-row .drp-gutter,.drp-dow-row .drp-dow{float:left;}
.drp-gutter{display:inline-block;width:32px;height:20px;text-align:center;}
.drp-dow{width:30px;height:20px;line-height:20px;text-align:center;font-size:9px;font-weight:600;
  text-transform:uppercase;letter-spacing:0.08em;color:#6b7280;}
.drp-dow-weekend{color:#4b5563;}

.drp-scroll{height:371px;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:#404040 transparent;}
.drp-scroll::-webkit-scrollbar{width:6px;}
.drp-scroll::-webkit-scrollbar-track{background:transparent;}
.drp-scroll::-webkit-scrollbar-thumb{background:#404040;border-radius:3px;}
.drp-scroll::-webkit-scrollbar-thumb:hover{background:#525252;}

.drp-week{height:32px;display:flex;align-items:center;}
.drp-gutter-month{width:32px;height:32px;line-height:32px;font-size:9px;font-weight:700;text-transform:uppercase;
  letter-spacing:0.12em;color:#22c55e;text-align:center;flex:0 0 auto;}

.drp-day{position:relative;width:30px;height:30px;flex:0 0 auto;display:flex;flex-direction:column;
  align-items:center;justify-content:center;cursor:pointer;}
.drp-day.is-disabled{cursor:not-allowed;}
.drp-halfL,.drp-halfR{position:absolute;top:0;bottom:0;width:15px;z-index:0;pointer-events:none;}
.drp-halfL{left:0;} .drp-halfR{right:0;}
.drp-halfL.filled,.drp-halfR.filled{background:rgba(34,197,94,0.18);}
.drp-pill{position:absolute;inset:0;z-index:1;background:#22c55e;pointer-events:none;}
.drp-day.is-start .drp-pill{border-radius:15px 0 0 15px;}
.drp-day.is-end .drp-pill{border-radius:0 15px 15px 0;}
.drp-day.is-single .drp-pill{border-radius:15px;}
.drp-num{position:relative;z-index:2;font-size:13px;color:#d1d5db;line-height:1;}
.drp-day.in-range .drp-num{color:#86efac;font-weight:600;}
.drp-day.is-start .drp-num,.drp-day.is-end .drp-num{color:#0b0b0b;font-weight:700;}
.drp-day.is-disabled .drp-num{color:#4b5563;}
.drp-day:not(.is-disabled):not(.is-start):not(.is-end):hover .drp-num{color:#ffffff;}
.drp-dot{position:relative;z-index:2;width:4px;height:4px;border-radius:50%;background:#22c55e;margin:-6px auto 0;}
.drp-day.is-start .drp-dot,.drp-day.is-end .drp-dot{background:#0b0b0b;}

.drp-right{width:164px;background:#1f1f1f;border-left:1px solid #2a2a2a;display:flex;flex-direction:column;}
.drp-presets{height:228px;padding:10px 0 12px;overflow-y:auto;}
.drp-preset{display:block;width:134px;height:28px;margin:4px auto;padding:0;font-size:12px;font-weight:500;
  text-align:center;background:#2a2a2a;color:#d1d5db;border:1px solid #3a3a3a;border-radius:6px;cursor:pointer;
  font-family:inherit;}
.drp-preset:hover{background:rgba(34,197,94,0.12);color:#86efac;border-color:#22c55e;}

.drp-inputs{flex:1;background:#181818;border-top:1px solid #2a2a2a;padding-top:12px;display:flex;flex-direction:column;
  align-items:center;}
.drp-input{width:134px;padding:7px 8px;font-size:13px;text-align:center;font-variant-numeric:tabular-nums;
  color:#e5e7eb;background:#2a2a2a;border:1px solid #3a3a3a;border-radius:6px;font-family:inherit;}
.drp-input::placeholder{color:#4b5563;}
.drp-input:focus{outline:none;border-color:#22c55e;box-shadow:0 0 0 2px rgba(34,197,94,0.20);}
.drp-to{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.12em;color:#6b7280;margin:8px 0;}
.drp-apply{width:134px;height:36px;margin-top:8px;background:#22c55e;color:#0b0b0b;font-size:13px;font-weight:600;
  border:1px solid #16a34a;border-radius:6px;cursor:pointer;font-family:inherit;}
.drp-apply:hover{background:#16a34a;}
.drp-apply:active{transform:translateY(1px);}
`;

export default DateRangePicker;
