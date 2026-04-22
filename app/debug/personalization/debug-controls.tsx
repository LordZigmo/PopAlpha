"use client";

import { useState, useTransition } from "react";

import {
  actionClearActor,
  actionForceRecompute,
  actionSeedPersona,
} from "./actions";

type PersonaOption = { key: string; label: string };

type Props = {
  personaOptions: PersonaOption[];
};

export default function DebugControls({ personaOptions }: Props) {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<string>("");

  function run(fn: () => Promise<unknown>, label: string) {
    startTransition(async () => {
      setStatus(`${label}…`);
      try {
        await fn();
        setStatus(`${label} — done.`);
      } catch (err) {
        setStatus(`${label} — failed: ${err instanceof Error ? err.message : "error"}`);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
      <div>
        <h3 className="text-[14px] font-semibold text-white">Seed persona</h3>
        <p className="text-[12px] text-white/55">
          Insert a scripted event stream for your current actor, then recompute.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {personaOptions.map((p) => (
            <button
              key={p.key}
              type="button"
              disabled={pending}
              className="rounded-full border border-white/[0.1] bg-white/[0.04] px-3 py-1.5 text-[12px] text-white hover:bg-white/[0.1] disabled:opacity-50"
              onClick={() => run(() => actionSeedPersona(p.key), `Seeded ${p.label}`)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          className="rounded-full border border-white/[0.1] bg-white/[0.04] px-3 py-1.5 text-[12px] text-white hover:bg-white/[0.1] disabled:opacity-50"
          onClick={() => run(actionForceRecompute, "Recomputed profile")}
        >
          Force recompute
        </button>
        <button
          type="button"
          disabled={pending}
          className="rounded-full border border-red-400/20 bg-red-500/[0.1] px-3 py-1.5 text-[12px] text-red-200 hover:bg-red-500/[0.18] disabled:opacity-50"
          onClick={() => run(actionClearActor, "Cleared actor data")}
        >
          Clear actor data
        </button>
      </div>
      {status ? <div className="text-[12px] text-white/70">{status}</div> : null}
    </div>
  );
}
