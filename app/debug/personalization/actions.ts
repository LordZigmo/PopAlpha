"use server";

import { revalidatePath } from "next/cache";

import { resolveActor } from "@/lib/personalization/server/actor";
import { clearActorData, recomputeProfile } from "@/lib/personalization/server/recompute";
import {
  listPersonaKeys,
  seedPersonaEvents,
  type PersonaKey,
} from "@/lib/personalization/server/persona-seeds";

function assertDevOrDebugEnabled(): void {
  if (process.env.NODE_ENV === "production") {
    const enabled = process.env.NEXT_PUBLIC_ENABLE_PERSONALIZATION_DEBUG;
    if (enabled !== "1" && enabled !== "true") {
      throw new Error("Personalization debug actions are disabled in production.");
    }
  }
}

function assertValidPersona(value: string): PersonaKey {
  if ((listPersonaKeys() as string[]).includes(value)) {
    return value as PersonaKey;
  }
  throw new Error(`Unknown persona: ${value}`);
}

export async function actionSeedPersona(rawPersona: string): Promise<{ inserted: number }> {
  assertDevOrDebugEnabled();
  const persona = assertValidPersona(rawPersona);
  const actor = await resolveActor();
  const result = await seedPersonaEvents(actor, persona);
  await recomputeProfile(actor);
  revalidatePath("/debug/personalization");
  return result;
}

export async function actionForceRecompute(): Promise<{ ok: boolean }> {
  assertDevOrDebugEnabled();
  const actor = await resolveActor();
  await recomputeProfile(actor);
  revalidatePath("/debug/personalization");
  return { ok: true };
}

export async function actionClearActor(): Promise<{ ok: boolean }> {
  assertDevOrDebugEnabled();
  const actor = await resolveActor();
  await clearActorData(actor);
  revalidatePath("/debug/personalization");
  return { ok: true };
}
