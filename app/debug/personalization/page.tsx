import { notFound } from "next/navigation";

import { STYLE_DIMENSIONS } from "@/lib/personalization/constants";
import { resolveActor } from "@/lib/personalization/server/actor";
import { loadProfile } from "@/lib/personalization/server/recompute";
import { loadRecentEventRows, type DebugEventRow } from "@/lib/personalization/server/debug";
import { PERSONA_LABELS, listPersonaKeys } from "@/lib/personalization/server/persona-seeds";
import { getPersonalizationCapability } from "@/lib/personalization/capability";

import DebugControls from "./debug-controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isDebugAvailable(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const raw = process.env.NEXT_PUBLIC_ENABLE_PERSONALIZATION_DEBUG;
  return raw === "1" || raw === "true";
}

export default async function PersonalizationDebugPage() {
  if (!isDebugAvailable()) notFound();

  const actor = await resolveActor();
  const capability = getPersonalizationCapability(actor);
  const profile = await loadProfile(actor);

  const events: DebugEventRow[] = await loadRecentEventRows(actor, 50);
  const personaOptions = listPersonaKeys().map((key) => ({
    key,
    label: PERSONA_LABELS[key],
  }));

  const scoreEntries = profile
    ? STYLE_DIMENSIONS.map((dim) => ({
        dim,
        value: Number(profile.scores?.[dim] ?? 0),
      })).sort((a, b) => b.value - a.value)
    : [];

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 text-white">
      <header className="mb-6">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Personalization debug</h1>
        <p className="mt-1 text-[13px] text-white/60">
          Local-only surface for inspecting your current actor, seeding personas, and forcing
          recompute. Hidden in production unless <code>NEXT_PUBLIC_ENABLE_PERSONALIZATION_DEBUG=1</code>.
        </p>
      </header>

      <section className="mb-6 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
        <h2 className="text-[14px] font-semibold text-white">Actor</h2>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          <dt className="text-white/55">actor_key</dt>
          <dd className="font-mono text-white/90">{actor.actor_key}</dd>
          <dt className="text-white/55">clerk_user_id</dt>
          <dd className="font-mono text-white/90">{actor.clerk_user_id ?? "—"}</dd>
          <dt className="text-white/55">claimed guest keys</dt>
          <dd className="font-mono text-white/90">
            {actor.claimed_guest_keys.length > 0 ? actor.claimed_guest_keys.join(", ") : "—"}
          </dd>
          <dt className="text-white/55">capability</dt>
          <dd className="text-white/90">
            {capability.enabled ? `enabled · ${capability.mode}` : `disabled (${capability.reason ?? "unknown"})`}
          </dd>
        </dl>
      </section>

      <section className="mb-6">
        <DebugControls personaOptions={personaOptions} />
      </section>

      <section className="mb-6 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
        <h2 className="text-[14px] font-semibold text-white">Style profile</h2>
        {profile ? (
          <div className="mt-2 space-y-2 text-[13px]">
            <p className="text-white/90">
              <span className="font-semibold">{profile.dominant_style_label}</span> ·{" "}
              confidence {Math.round(profile.confidence * 100)}% · {profile.event_count} events · v
              {profile.version}
            </p>
            <p className="text-white/70">{profile.summary}</p>
            {profile.supporting_traits.length > 0 ? (
              <p className="text-white/60">
                Supporting traits: {profile.supporting_traits.join(", ")}
              </p>
            ) : null}
            <div className="mt-3">
              <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-white/50">
                Dimension scores
              </h3>
              <table className="w-full text-[12px]">
                <tbody>
                  {scoreEntries.map((entry) => (
                    <tr key={entry.dim} className="border-b border-white/[0.04] last:border-b-0">
                      <td className="py-1 pr-4 text-white/70">{entry.dim}</td>
                      <td className="py-1 text-right font-mono text-white/85">
                        {entry.value.toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="mt-2 text-[13px] text-white/55">
            No profile yet. Seed a persona or browse a few cards to populate.
          </p>
        )}
      </section>

      <section className="mb-6 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
        <h2 className="text-[14px] font-semibold text-white">
          Recent behavior events ({events.length})
        </h2>
        {events.length === 0 ? (
          <p className="mt-2 text-[13px] text-white/55">No events.</p>
        ) : (
          <table className="mt-2 w-full text-[12px]">
            <thead>
              <tr className="border-b border-white/[0.08] text-left text-white/55">
                <th className="py-1 pr-4">Type</th>
                <th className="py-1 pr-4">Slug</th>
                <th className="py-1 pr-4">Variant</th>
                <th className="py-1 pr-4">When</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b border-white/[0.04] last:border-b-0">
                  <td className="py-1 pr-4 text-white/80">{e.event_type}</td>
                  <td className="py-1 pr-4 font-mono text-white/70">{e.canonical_slug ?? "—"}</td>
                  <td className="py-1 pr-4 font-mono text-white/55">{e.variant_ref ?? "—"}</td>
                  <td className="py-1 pr-4 text-white/55">{new Date(e.occurred_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
