// Reports charts — WEB build: recharts, with the exact props the old web
// admin's ReportsPage uses, so the PC rendering is pixel-faithful (axes,
// rounded bar tops, donut radii, padding angles, tooltips). Native resolves
// reportCharts.tsx (lightweight View bars) until the mobile pass.
import React from "react";
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { colors } from "../theme";
import { formatMoney } from "../lib/format";
import type { MonthlyRow } from "../types";

export const PIE_COLORS = [colors.blue, colors.yellow, colors.green, colors.orange, "#9333ea", "#0891b2"];

export function IncentiveBarChart({ months }: { months: MonthlyRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={250}>
      <BarChart data={months} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: colors.textMuted }} tickFormatter={(l: string) => l.split(" ")[0]} />
        <YAxis tick={{ fontSize: 12, fill: colors.textMuted }} tickFormatter={(v: number) => `RM${v}`} />
        <RTooltip formatter={(v) => formatMoney(v as number)} />
        <Bar dataKey="incentive" fill={colors.blue} radius={[6, 6, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function RouteSplitDonut({ data }: { data: { name: string; value: number }[] }) {
  return (
    <ResponsiveContainer width="55%" height={180}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={2}>
          {data.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
          ))}
        </Pie>
        <RTooltip />
      </PieChart>
    </ResponsiveContainer>
  );
}
