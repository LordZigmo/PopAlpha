"use client";

import type { RadarProfile } from "@/lib/data/portfolio";

// Order matters — opposite vertices read as conceptual contrasts:
//   Nostalgia ↔ Current (old vs new era)
//   Slab Focus ↔ Taste (technical/condition vs aesthetic)
//   Market Heat ↔ Depth (chase vs binder-builder)
const AXES: { key: keyof RadarProfile; label: string }[] = [
  { key: "nostalgia",       label: "Nostalgia" },
  { key: "slabFocus",       label: "Slab" },
  { key: "marketHeat",      label: "Heat" },
  { key: "currentEra",      label: "Current" },
  { key: "tasteProfile",    label: "Taste" },
  { key: "collectionDepth", label: "Depth" },
];

const N = AXES.length;
const SIZE = 240;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 88;
const LABEL_R = R + 22;
const RINGS = 4;

function polarToXY(angleDeg: number, radius: number): [number, number] {
  const rad = (angleDeg - 90) * (Math.PI / 180);
  return [CX + radius * Math.cos(rad), CY + radius * Math.sin(rad)];
}

function ringPoints(radius: number): string {
  return Array.from({ length: N }, (_, i) => {
    const [x, y] = polarToXY((i * 360) / N, radius);
    return `${x},${y}`;
  }).join(" ");
}

function textAnchor(angleDeg: number): "middle" | "start" | "end" {
  if (angleDeg < 30 || angleDeg > 330) return "middle";
  if (angleDeg < 150) return "start";
  if (angleDeg > 210) return "end";
  return "middle";
}

// Sparse profiles (e.g. user with 4 cards) produce tiny raw axis values
// that read as a near-invisible polygon. A sqrt curve lifts low values
// disproportionately so the shape feels populated without distorting
// relative emphasis. Mirrors the iOS CollectorRadarView display() helper.
function displayValue(raw: number): number {
  return Math.sqrt(Math.max(0, raw));
}

export function CollectorRadar({ profile }: { profile: RadarProfile }) {
  const dataPoints = AXES.map(({ key }, i) =>
    polarToXY((i * 360) / N, displayValue(profile[key]) * R),
  );

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      width={SIZE}
      height={SIZE}
      className="overflow-visible"
      aria-label="Collector profile radar chart"
    >
      {/* Grid rings */}
      {Array.from({ length: RINGS }, (_, i) => (
        <polygon
          key={i}
          points={ringPoints(R * ((i + 1) / RINGS))}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={1}
        />
      ))}

      {/* Axis spokes */}
      {AXES.map((_, i) => {
        const [x, y] = polarToXY((i * 360) / N, R);
        return (
          <line
            key={i}
            x1={CX} y1={CY}
            x2={x}  y2={y}
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={1}
          />
        );
      })}

      {/* Filled data polygon */}
      <polygon
        points={dataPoints.map(([x, y]) => `${x},${y}`).join(" ")}
        fill="rgba(0,180,216,0.25)"
        stroke="#00B4D8"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />

      {/* Data-point dots */}
      {dataPoints.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={3} fill="#00B4D8" />
      ))}

      {/* Axis labels */}
      {AXES.map(({ label }, i) => {
        const angle = (i * 360) / N;
        const [x, y] = polarToXY(angle, LABEL_R);
        return (
          <text
            key={label}
            x={x}
            y={y}
            textAnchor={textAnchor(angle)}
            dominantBaseline="middle"
            fontSize={10}
            fill="rgba(255,255,255,0.55)"
            fontFamily="system-ui, sans-serif"
          >
            {label}
          </text>
        );
      })}
    </svg>
  );
}
