import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require";
import { ensureAppUser, updateAppProfile } from "@/lib/data/app-user";

export const runtime = "nodejs";

function toSettingsPayload(user: Awaited<ReturnType<typeof ensureAppUser>>) {
  return {
    handle: user.handle,
    notify_price_alerts: user.notify_price_alerts,
    notify_weekly_digest: user.notify_weekly_digest,
    notify_product_updates: user.notify_product_updates,
    notification_delivery_hour: user.notification_delivery_hour,
    notification_delivery_minute: user.notification_delivery_minute,
    notification_delivery_timezone: user.notification_delivery_timezone,
    profile_visibility: user.profile_visibility,
  };
}

// Reject arbitrary strings passed as timezone — Node's Intl.DateTimeFormat
// returns a stable set of IANA zone names. If the client hands us
// something else we drop it rather than storing junk.
function isValidIanaTimezone(value: string): boolean {
  try {
    // Using formatToParts to exercise the timezone — throws RangeError
    // when the zone isn't recognized by the ICU database.
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  try {
    const user = await ensureAppUser(auth.userId);
    return NextResponse.json({ ok: true, settings: toSettingsPayload(user) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const updates: Parameters<typeof updateAppProfile>[1] = {};

  if ("notifyPriceAlerts" in body) {
    if (typeof body.notifyPriceAlerts !== "boolean") {
      return NextResponse.json({ ok: false, error: "notifyPriceAlerts must be a boolean." }, { status: 400 });
    }
    updates.notifyPriceAlerts = body.notifyPriceAlerts;
  }

  if ("notifyWeeklyDigest" in body) {
    if (typeof body.notifyWeeklyDigest !== "boolean") {
      return NextResponse.json({ ok: false, error: "notifyWeeklyDigest must be a boolean." }, { status: 400 });
    }
    updates.notifyWeeklyDigest = body.notifyWeeklyDigest;
  }

  if ("notifyProductUpdates" in body) {
    if (typeof body.notifyProductUpdates !== "boolean") {
      return NextResponse.json({ ok: false, error: "notifyProductUpdates must be a boolean." }, { status: 400 });
    }
    updates.notifyProductUpdates = body.notifyProductUpdates;
  }

  if ("notificationDeliveryHour" in body) {
    if (typeof body.notificationDeliveryHour !== "number" || !Number.isInteger(body.notificationDeliveryHour) || body.notificationDeliveryHour < 0 || body.notificationDeliveryHour > 23) {
      return NextResponse.json(
        { ok: false, error: "notificationDeliveryHour must be an integer 0–23." },
        { status: 400 },
      );
    }
    updates.notificationDeliveryHour = body.notificationDeliveryHour;
  }

  if ("notificationDeliveryMinute" in body) {
    if (typeof body.notificationDeliveryMinute !== "number" || !Number.isInteger(body.notificationDeliveryMinute) || body.notificationDeliveryMinute < 0 || body.notificationDeliveryMinute > 59) {
      return NextResponse.json(
        { ok: false, error: "notificationDeliveryMinute must be an integer 0–59." },
        { status: 400 },
      );
    }
    updates.notificationDeliveryMinute = body.notificationDeliveryMinute;
  }

  if ("notificationDeliveryTimezone" in body) {
    if (typeof body.notificationDeliveryTimezone !== "string" || body.notificationDeliveryTimezone.trim().length === 0) {
      return NextResponse.json(
        { ok: false, error: "notificationDeliveryTimezone must be a non-empty string." },
        { status: 400 },
      );
    }
    const tz = body.notificationDeliveryTimezone.trim().slice(0, 64);
    if (!isValidIanaTimezone(tz)) {
      return NextResponse.json(
        { ok: false, error: "notificationDeliveryTimezone must be a valid IANA timezone name." },
        { status: 400 },
      );
    }
    updates.notificationDeliveryTimezone = tz;
  }

  if ("profileVisibility" in body) {
    if (body.profileVisibility !== "PUBLIC" && body.profileVisibility !== "PRIVATE") {
      return NextResponse.json({ ok: false, error: "profileVisibility must be PUBLIC or PRIVATE." }, { status: 400 });
    }
    updates.profileVisibility = body.profileVisibility;
  }

  try {
    const updated = await updateAppProfile(auth.userId, updates);
    if (!updated) {
      return NextResponse.json({ ok: false, error: "Could not update settings." }, { status: 409 });
    }
    return NextResponse.json({ ok: true, settings: toSettingsPayload(updated) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
