/**
 * Demo — mounts both pickers so you can verify against the spec.
 * Drop into any React app (Vite/Next/CRA) and render <Demo />.
 */
import React, { useState } from "react";
import DateRangePicker from "./DateRangePicker";
import DatePicker from "./DatePicker";

export const Demo: React.FC = () => {
  const [range, setRange] = useState<{ start: Date; end: Date } | null>(null);
  const [single, setSingle] = useState<string>("");

  return (
    <div style={{ minHeight: "100vh", background: "#1a1a1a", color: "#e5e7eb", padding: 48,
      fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>Terminal-green date pickers</h1>
      <p style={{ color: "#6b7280", fontSize: 13, marginBottom: 32 }}>Weeks start Monday. Zero dependencies.</p>

      <section style={{ marginBottom: 48 }}>
        <h2 style={{ fontSize: 13, color: "#86efac", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
          DateRangePicker
        </h2>
        <DateRangePicker
          presets={["today", "yesterday", "thisWeek", "lastWeek", "thisMonth", "lastMonth", "last3Months", "thisYear"]}
          onChange={(start, end) => setRange({ start, end })}
        />
        <p style={{ color: "#6b7280", fontSize: 12, marginTop: 12 }}>
          committed: {range ? `${range.start.toDateString()} → ${range.end.toDateString()}` : "—"}
        </p>
      </section>

      <section>
        <h2 style={{ fontSize: 13, color: "#86efac", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
          DatePicker
        </h2>
        <DatePicker value={single} onChange={setSingle} />
        <p style={{ color: "#6b7280", fontSize: 12, marginTop: 12 }}>value: {single || "—"}</p>
      </section>
    </div>
  );
};

export default Demo;
