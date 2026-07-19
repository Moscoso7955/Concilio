/* ============================================================
   Vanilla date-range picker — Monday-first, continuous scroll,
   presets + typed inputs. Same behavior as the React spec; colors
   inherit the portal theme via CSS variables (terminal green).
   Usage:
     const p = window.createDateRangePicker({
       mount, onChange(start,end), initialStart, initialEnd,
       presets, minDate, maxDate   // maxDate undefined → today is the cap
     });
   ============================================================ */
(function () {
  const norm = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const addDays = (d, n) => { const x = norm(d); x.setDate(x.getDate() + n); return x; };
  const sameDay = (a, b) => !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const mondayOf = (d) => addDays(d, -(((norm(d).getDay() + 6) % 7)));
  const pad2 = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const fmtInput = (d) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
  const longLabel = (d) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const parseInput = (s) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s || "").trim());
    if (!m) return null;
    const mo = +m[1], da = +m[2], yr = +m[3];
    const d = new Date(yr, mo - 1, da); d.setHours(0, 0, 0, 0);
    return d.getFullYear() === yr && d.getMonth() === mo - 1 && d.getDate() === da ? d : null;
  };
  const clampDay = (d, min, max) => (min && d < min ? norm(min) : max && d > max ? norm(max) : norm(d));

  const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const DOW = ["M", "T", "W", "T", "F", "S", "S"];
  const DEFAULT_PRESETS = ["today", "yesterday", "thisWeek", "lastWeek", "thisMonth", "lastMonth"];
  const PRESET_LABEL = { today: "Today", yesterday: "Yesterday", thisWeek: "This Week", lastWeek: "Last Week", thisMonth: "This Month", lastMonth: "Last Month", last3Months: "Last 3 Months", thisYear: "This Year" };
  const presetRange = (p, today) => {
    const y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
    switch (p) {
      case "today": return [today, today];
      case "yesterday": { const x = addDays(today, -1); return [x, x]; }
      case "thisWeek": return [mondayOf(today), today];
      case "lastWeek": { const mo = addDays(mondayOf(today), -7); return [mo, addDays(mo, 6)]; }
      case "thisMonth": return [norm(new Date(y, m, 1)), today];
      case "lastMonth": return [norm(new Date(y, m - 1, 1)), norm(new Date(y, m, 0))];
      case "last3Months": return [norm(new Date(y, m - 3, d)), today];
      case "thisYear": return [norm(new Date(y, 0, 1)), today];
      default: return [today, today];
    }
  };

  function injectCss() {
    if (document.getElementById("drp-css")) return;
    const s = document.createElement("style");
    s.id = "drp-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  window.createDateRangePicker = function (opts) {
    injectCss();
    const mount = opts.mount;
    const onChange = opts.onChange || function () {};
    const presets = opts.presets || DEFAULT_PRESETS;
    const weeksToRender = opts.weeksToRender || 61;
    const minDate = opts.minDate ? norm(opts.minDate) : null;
    const today = norm(new Date());
    const effMax = opts.maxDate === undefined ? today : (opts.maxDate ? norm(opts.maxDate) : null);
    const effMin = minDate;

    let cStart = opts.initialStart ? norm(opts.initialStart) : today;
    let cEnd = opts.initialEnd ? norm(opts.initialEnd) : today;
    if (cStart > cEnd) { const t = cStart; cStart = cEnd; cEnd = t; }
    let open = false, selecting = false, draftStart = null, hoverDay = null;

    // ---- DOM ----
    const root = document.createElement("div"); root.className = "drp-root";
    const trigger = document.createElement("button"); trigger.type = "button"; trigger.className = "drp-trigger";
    const label = document.createElement("span"); label.className = "drp-label";
    trigger.appendChild(label);
    trigger.insertAdjacentHTML("beforeend",
      `<svg class="drp-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`);
    root.appendChild(trigger);
    const pop = document.createElement("div"); pop.className = "drp-pop drp-hidden";
    root.appendChild(pop);
    mount.appendChild(root);

    trigger.addEventListener("click", () => { open ? close() : openPop(); });

    function activeRange() {
      if (selecting && draftStart) {
        const h = hoverDay || draftStart;
        return draftStart <= h ? { start: draftStart, end: h } : { start: h, end: draftStart };
      }
      return { start: cStart, end: cEnd };
    }

    function renderLabel() {
      if (selecting && draftStart) {
        label.innerHTML = `${longLabel(draftStart)} to <span style="opacity:.5">pick end</span>`;
      } else {
        label.textContent = `${longLabel(cStart)} to ${longLabel(cEnd)}`;
      }
    }

    const scroll = document.createElement("div");
    const cells = []; // {el, date, disabled}
    const half = Math.floor(weeksToRender / 2);
    const firstWeek = addDays(mondayOf(today), -half * 7);

    function buildPopover() {
      pop.innerHTML = "";
      // calendar
      const cal = document.createElement("div"); cal.className = "drp-cal";
      const dowRow = document.createElement("div"); dowRow.className = "drp-dow-row";
      dowRow.innerHTML = `<span class="drp-gutter"></span>` + DOW.map((l, i) => `<span class="drp-dow${i >= 5 ? " drp-dow-weekend" : ""}">${l}</span>`).join("");
      cal.appendChild(dowRow);
      scroll.className = "drp-scroll"; scroll.innerHTML = ""; cells.length = 0;
      for (let w = 0; w < weeksToRender; w++) {
        const wkStart = addDays(firstWeek, w * 7);
        const row = document.createElement("div"); row.className = "drp-week";
        let gutter = "";
        for (let j = 0; j < 7; j++) { const day = addDays(wkStart, j); if (day.getDate() === 1) { gutter = MONTH_ABBR[day.getMonth()]; break; } }
        const g = document.createElement("span"); g.className = "drp-gutter drp-gutter-month"; g.textContent = gutter; row.appendChild(g);
        for (let j = 0; j < 7; j++) {
          const day = addDays(wkStart, j);
          const disabled = !!(effMin && day < effMin) || !!(effMax && day > effMax);
          const cell = document.createElement("span"); cell.className = "drp-day"; if (disabled) cell.classList.add("is-disabled");
          cell.innerHTML = `<span class="drp-halfL"></span><span class="drp-halfR"></span><span class="drp-pill"></span><span class="drp-num">${day.getDate()}</span>${sameDay(day, today) ? '<span class="drp-dot"></span>' : ""}`;
          if (!disabled) {
            cell.addEventListener("click", () => onDayClick(day));
            cell.addEventListener("mouseenter", () => { if (selecting) { hoverDay = day; paint(); renderLabel(); } });
          }
          row.appendChild(cell);
          cells.push({ el: cell, date: day, disabled });
        }
        scroll.appendChild(row);
      }
      cal.appendChild(scroll);
      pop.appendChild(cal);

      // right panel
      const right = document.createElement("div"); right.className = "drp-right";
      if (presets.length) {
        const pl = document.createElement("div"); pl.className = "drp-presets";
        presets.forEach((p) => {
          const b = document.createElement("button"); b.type = "button"; b.className = "drp-preset"; b.textContent = PRESET_LABEL[p] || p;
          b.addEventListener("click", () => { const [s, e] = presetRange(p, today); commit(s, e, false); });
          pl.appendChild(b);
        });
        right.appendChild(pl);
      }
      const inputs = document.createElement("div"); inputs.className = "drp-inputs";
      const si = document.createElement("input"); si.className = "drp-input"; si.placeholder = "MM/DD/YYYY";
      const to = document.createElement("div"); to.className = "drp-to"; to.textContent = "TO:";
      const ei = document.createElement("input"); ei.className = "drp-input"; ei.placeholder = "MM/DD/YYYY";
      const apply = document.createElement("button"); apply.type = "button"; apply.className = "drp-apply"; apply.textContent = "Apply";
      inputs.append(si, to, ei, apply);
      right.appendChild(inputs);
      pop.appendChild(right);

      si.value = fmtInput(cStart); ei.value = fmtInput(cEnd);
      si.addEventListener("input", () => { const p = parseInput(si.value); if (p) { selecting = false; cStart = p; paint(); renderLabel(); } });
      ei.addEventListener("input", () => { const p = parseInput(ei.value); if (p) { selecting = false; cEnd = p; paint(); renderLabel(); } });
      apply.addEventListener("click", () => {
        const s = parseInput(si.value) || cStart, e = parseInput(ei.value) || cEnd;
        commit(s, e, true);
      });
      pop._inputs = { si, ei };
    }

    function paint() {
      const { start, end } = activeRange();
      for (const c of cells) {
        const d = c.date;
        const inRange = start && end && d >= start && d <= end;
        const isStart = sameDay(d, start), isEnd = sameDay(d, end), isSingle = isStart && isEnd;
        c.el.classList.toggle("in-range", !!inRange);
        c.el.classList.toggle("is-start", !!isStart);
        c.el.classList.toggle("is-end", !!isEnd);
        c.el.classList.toggle("is-single", !!isSingle);
        c.el.querySelector(".drp-halfL").classList.toggle("filled", !!(inRange && !isStart));
        c.el.querySelector(".drp-halfR").classList.toggle("filled", !!(inRange && !isEnd));
      }
    }

    function onDayClick(day) {
      if (!selecting) { selecting = true; draftStart = day; hoverDay = day; paint(); renderLabel(); }
      else { commit(draftStart, day, false); }
    }

    function commit(s, e, doClose) {
      let cs = clampDay(s, effMin, effMax), ce = clampDay(e, effMin, effMax);
      if (cs > ce) { const t = cs; cs = ce; ce = t; }
      cStart = cs; cEnd = ce; selecting = false; draftStart = null; hoverDay = null;
      if (pop._inputs) { pop._inputs.si.value = fmtInput(cStart); pop._inputs.ei.value = fmtInput(cEnd); }
      paint(); renderLabel();
      onChange(new Date(cStart), new Date(cEnd));
      if (doClose) close();
    }

    function openPop() {
      open = true; selecting = false; draftStart = null; hoverDay = null;
      buildPopover(); paint(); renderLabel();
      pop.classList.remove("drp-hidden");
      const idx = half; // today's week index
      requestAnimationFrame(() => { scroll.scrollTop = idx * 32 - 380 / 3; });
      document.addEventListener("mousedown", onOutside);
      document.addEventListener("keydown", onKey);
    }
    function close() {
      open = false; pop.classList.add("drp-hidden");
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    }
    const onOutside = (e) => { if (!root.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === "Escape") close(); };

    renderLabel();
    return {
      getRange: () => ({ start: new Date(cStart), end: new Date(cEnd) }),
      setRange: (s, e) => { cStart = norm(s); cEnd = norm(e); if (cStart > cEnd) { const t = cStart; cStart = cEnd; cEnd = t; } renderLabel(); if (open) paint(); },
      open: openPop, close,
    };
  };

  // ---- Single-date picker (month-paged, Monday-first) ----
  window.createDatePicker = function (opts) {
    injectCss();
    const mount = opts.mount;
    const onChange = opts.onChange || function () {};
    let value = opts.initial || ""; // YYYY-MM-DD
    let openp = false;
    const today = norm(new Date());
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const DOW3 = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const fromYMD = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); if (!m) return null; const d = new Date(+m[1], +m[2] - 1, +m[3]); d.setHours(0, 0, 0, 0); return (d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3]) ? d : null; };
    let view = (() => { const d = fromYMD(value) || today; return new Date(d.getFullYear(), d.getMonth(), 1); })();

    const root = document.createElement("div"); root.className = "dp2-root";
    const trig = document.createElement("button"); trig.type = "button"; trig.className = "dp2-trigger"; root.appendChild(trig);
    const pop = document.createElement("div"); pop.className = "dp2-pop dp2-hidden"; root.appendChild(pop);
    mount.appendChild(root);

    function label() { const d = fromYMD(value); trig.textContent = d ? `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : "Select date"; }
    function build() {
      pop.innerHTML = "";
      const head = document.createElement("div"); head.className = "dp2-head";
      const prev = document.createElement("button"); prev.type = "button"; prev.className = "dp2-nav"; prev.textContent = "‹";
      const title = document.createElement("span"); title.className = "dp2-title"; title.textContent = `${MONTHS[view.getMonth()]} ${view.getFullYear()}`;
      const next = document.createElement("button"); next.type = "button"; next.className = "dp2-nav"; next.textContent = "›";
      prev.addEventListener("click", () => { view = new Date(view.getFullYear(), view.getMonth() - 1, 1); build(); });
      next.addEventListener("click", () => { view = new Date(view.getFullYear(), view.getMonth() + 1, 1); build(); });
      head.append(prev, title, next); pop.appendChild(head);
      const dow = document.createElement("div"); dow.className = "dp2-dow"; dow.innerHTML = DOW3.map((d) => `<span>${d}</span>`).join(""); pop.appendChild(dow);
      const grid = document.createElement("div"); grid.className = "dp2-grid";
      const y = view.getFullYear(), m = view.getMonth();
      const lead = (new Date(y, m, 1).getDay() + 6) % 7, days = new Date(y, m + 1, 0).getDate();
      for (let i = 0; i < lead; i++) grid.appendChild(document.createElement("span"));
      const sel = fromYMD(value);
      for (let d = 1; d <= days; d++) {
        const dt = new Date(y, m, d);
        const btn = document.createElement("button"); btn.type = "button"; btn.className = "dp2-day"; btn.textContent = d;
        if (sameDay(dt, sel)) btn.classList.add("is-selected"); else if (sameDay(dt, today)) btn.classList.add("is-today");
        btn.addEventListener("click", () => { value = iso(dt); label(); onChange(value); close(); });
        grid.appendChild(btn);
      }
      pop.appendChild(grid);
    }
    function openp_() { openp = true; const d = fromYMD(value) || today; view = new Date(d.getFullYear(), d.getMonth(), 1); build(); pop.classList.remove("dp2-hidden"); document.addEventListener("mousedown", out); document.addEventListener("keydown", key); }
    function close() { openp = false; pop.classList.add("dp2-hidden"); document.removeEventListener("mousedown", out); document.removeEventListener("keydown", key); }
    const out = (e) => { if (!root.contains(e.target)) close(); };
    const key = (e) => { if (e.key === "Escape") close(); };
    trig.addEventListener("click", () => { openp ? close() : openp_(); });
    label();
    return { getValue: () => value, setValue: (v) => { value = v || ""; label(); if (openp) build(); }, open: openp_, close };
  };

  // Colors inherit the portal theme via CSS variables; layout matches the spec.
  const CSS = `
.drp-root{position:relative;display:inline-block;font-variant-numeric:tabular-nums;color:var(--text,#e5e7eb);}
.drp-root *{box-sizing:border-box;}
.drp-hidden{display:none !important;}
.drp-trigger{display:inline-flex;align-items:center;gap:14px;padding:10px 16px;background:var(--panel-2,#2a2a2a);
  border:1px solid var(--border,#3a3a3a);border-radius:10px;font-size:14px;font-weight:500;color:var(--text,#e5e7eb);
  cursor:pointer;font-family:inherit;}
.drp-trigger:hover{border-color:var(--accent,#22c55e);}
.drp-label{display:inline-block;width:290px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;}
.drp-ico{color:var(--accent,#22c55e);flex:0 0 auto;}
.drp-pop{position:absolute;top:calc(100% + 8px);left:0;z-index:1000;display:flex;flex-direction:row;width:420px;height:402px;
  background:var(--panel,#1a1a1a);border:1px solid var(--border,#3a3a3a);border-radius:12px;box-shadow:rgba(0,0,0,0.45) 0 12px 32px;overflow:hidden;}
.drp-cal{width:256px;padding:8px 0 0 8px;}
.drp-dow-row{height:20px;}
.drp-dow-row .drp-gutter,.drp-dow-row .drp-dow{float:left;}
.drp-gutter{display:inline-block;width:32px;height:20px;text-align:center;}
.drp-dow{width:30px;height:20px;line-height:20px;text-align:center;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted,#6b7280);}
.drp-dow-weekend{color:#4b5563;}
.drp-scroll{height:371px;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:#404040 transparent;}
.drp-scroll::-webkit-scrollbar{width:6px;}
.drp-scroll::-webkit-scrollbar-track{background:transparent;}
.drp-scroll::-webkit-scrollbar-thumb{background:#404040;border-radius:3px;}
.drp-scroll::-webkit-scrollbar-thumb:hover{background:#525252;}
.drp-week{height:32px;display:flex;align-items:center;}
.drp-gutter-month{width:32px;height:32px;line-height:32px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:var(--accent,#22c55e);text-align:center;flex:0 0 auto;}
.drp-day{position:relative;width:30px;height:30px;flex:0 0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;}
.drp-day.is-disabled{cursor:not-allowed;}
.drp-halfL,.drp-halfR{position:absolute;top:0;bottom:0;width:15px;z-index:0;pointer-events:none;}
.drp-halfL{left:0;} .drp-halfR{right:0;}
.drp-halfL.filled,.drp-halfR.filled{background:rgba(34,197,94,0.18);}
.drp-pill{position:absolute;inset:0;z-index:1;background:var(--accent,#22c55e);pointer-events:none;display:none;}
.drp-day.is-start .drp-pill,.drp-day.is-end .drp-pill{display:block;}
.drp-day.is-start .drp-pill{border-radius:15px 0 0 15px;}
.drp-day.is-end .drp-pill{border-radius:0 15px 15px 0;}
.drp-day.is-single .drp-pill{border-radius:15px;}
.drp-num{position:relative;z-index:2;font-size:13px;color:var(--text,#d1d5db);line-height:1;}
.drp-day.in-range .drp-num{color:#86efac;font-weight:600;}
.drp-day.is-start .drp-num,.drp-day.is-end .drp-num{color:#0b0b0b;font-weight:700;}
.drp-day.is-disabled .drp-num{color:#4b5563;}
.drp-day:not(.is-disabled):not(.is-start):not(.is-end):hover .drp-num{color:#ffffff;}
.drp-dot{position:relative;z-index:2;width:4px;height:4px;border-radius:50%;background:var(--accent,#22c55e);margin:-6px auto 0;}
.drp-day.is-start .drp-dot,.drp-day.is-end .drp-dot{background:#0b0b0b;}
.drp-right{width:164px;background:var(--bg,#1f1f1f);border-left:1px solid var(--border,#2a2a2a);display:flex;flex-direction:column;}
.drp-presets{height:228px;padding:10px 0 12px;overflow-y:auto;}
.drp-preset{display:block;width:134px;height:28px;margin:4px auto;padding:0;font-size:12px;font-weight:500;text-align:center;background:var(--panel-2,#2a2a2a);color:var(--text,#d1d5db);border:1px solid var(--border,#3a3a3a);border-radius:6px;cursor:pointer;font-family:inherit;}
.drp-preset:hover{background:rgba(34,197,94,0.12);color:#86efac;border-color:var(--accent,#22c55e);}
.drp-inputs{flex:1;background:#141414;border-top:1px solid var(--border,#2a2a2a);padding-top:12px;display:flex;flex-direction:column;align-items:center;}
.drp-input{width:134px;padding:7px 8px;font-size:13px;text-align:center;font-variant-numeric:tabular-nums;color:var(--text,#e5e7eb);background:var(--panel-2,#2a2a2a);border:1px solid var(--border,#3a3a3a);border-radius:6px;font-family:inherit;}
.drp-input::placeholder{color:#4b5563;}
.drp-input:focus{outline:none;border-color:var(--accent,#22c55e);box-shadow:0 0 0 2px rgba(34,197,94,0.20);}
.drp-to{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.12em;color:var(--muted,#6b7280);margin:8px 0;}
.drp-apply{width:134px;height:36px;margin-top:8px;background:var(--accent,#22c55e);color:#0b0b0b;font-size:13px;font-weight:600;border:1px solid var(--accent-hover,#16a34a);border-radius:6px;cursor:pointer;font-family:inherit;}
.drp-apply:hover{background:var(--accent-hover,#16a34a);}
.drp-apply:active{transform:translateY(1px);}
.dp2-root{position:relative;display:inline-block;font-variant-numeric:tabular-nums;}
.dp2-trigger{min-width:150px;width:100%;padding:0.6rem 0.7rem;font-size:14px;text-align:left;color:var(--text,#e5e7eb);background:var(--panel-2,#2a2a2a);border:1px solid var(--border,#3a3a3a);border-radius:9px;cursor:pointer;font-family:inherit;}
.dp2-trigger:hover{border-color:var(--accent,#22c55e);}
.dp2-pop{position:absolute;margin-top:4px;left:0;z-index:1000;width:300px;padding:12px;background:var(--panel,#1a1a1a);border:1px solid var(--border,#3a3a3a);border-radius:12px;box-shadow:rgba(0,0,0,0.45) 0 12px 32px;}
.dp2-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
.dp2-nav{min-width:36px;min-height:36px;font-size:20px;color:#9ca3af;background:none;border:none;cursor:pointer;font-family:inherit;line-height:1;}
.dp2-nav:hover{color:#fff;}
.dp2-title{font-size:14px;font-weight:600;color:var(--text,#e5e7eb);}
.dp2-dow{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px;}
.dp2-dow span{text-align:center;font-size:10px;color:var(--muted,#6b7280);padding:2px 0;}
.dp2-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;}
.dp2-day{padding:9px 0;font-size:12px;color:var(--text,#d1d5db);background:none;border:none;border-radius:6px;cursor:pointer;font-family:inherit;}
.dp2-day:hover{background:var(--panel-2,#2a2a2a);}
.dp2-day.is-today{color:#4ade80;font-weight:600;background:var(--panel-2,#2a2a2a);}
.dp2-day.is-selected{background:var(--accent,#22c55e);color:#0b0b0b;font-weight:700;}
.dp2-hidden{display:none !important;}
`;
})();
