import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  const expected = Deno.env.get("CRON_SECRET");
  if (!expected || req.headers.get("x-cron-secret") !== expected) return json({ error: "Unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!supabaseUrl || !serviceKey || !vapidPublic || !vapidPrivate) return json({ error: "Required server secrets are missing" }, 500);

  const supabase = createClient(supabaseUrl, serviceKey);
  webpush.setVapidDetails("https://dogdashride.github.io/dog-dash-care/", vapidPublic, vapidPrivate);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const today = `${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}-${parts.find(p => p.type === "day")!.value}`;
  const d = new Date(`${today}T12:00:00+07:00`); d.setDate(d.getDate() + 3);
  const aheadParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const threeDays = `${aheadParts.find(p => p.type === "year")!.value}-${aheadParts.find(p => p.type === "month")!.value}-${aheadParts.find(p => p.type === "day")!.value}`;

  const { data: reminders, error: reminderError } = await supabase.from("reminders").select("id,user_id,dog_id,title,due_date,notify_3_days_before,notify_on_due,is_active").eq("is_active", true).in("due_date", [today, threeDays]);
  if (reminderError) return json({ error: reminderError.message }, 500);
  let sent = 0, failed = 0, skipped = 0;
  for (const r of reminders || []) {
    const kind = r.due_date === today && r.notify_on_due ? "due_date" : r.due_date === threeDays && r.notify_3_days_before ? "three_days_before" : null;
    if (!kind) { skipped++; continue; }
    const { data: existing, error: logCheckError } = await supabase.from("notification_logs").select("id").eq("reminder_id", r.id).eq("notification_type", kind).eq("due_date", r.due_date).maybeSingle();
    if (logCheckError) { failed++; continue; }
    if (existing) { skipped++; continue; }
    const { data: dog } = await supabase.from("dogs").select("name").eq("id", r.dog_id).maybeSingle();
    const { data: subscriptions, error: subError } = await supabase.from("push_subscriptions").select("id,endpoint,subscription").eq("user_id", r.user_id);
    if (subError || !subscriptions?.length) { skipped++; continue; }
    const isDue = kind === "due_date";
    const payload = JSON.stringify({ title: isDue ? "Dog care reminder is due today" : "Dog care reminder in 3 days", body: `${r.title} for ${dog?.name || "your dog"}${isDue ? " is due today." : " is due in 3 days."}`, tag: `care-${r.id}-${kind}-${r.due_date}`, url: "./" });
    let delivered = false;
    for (const sub of subscriptions) {
      try { await webpush.sendNotification(sub.subscription, payload); delivered = true; sent++; }
      catch (e) {
        failed++;
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await supabase.from("push_subscriptions").delete().eq("id", sub.id);
      }
    }
    if (delivered) {
      const { error: logError } = await supabase.from("notification_logs").insert({ user_id: r.user_id, reminder_id: r.id, notification_type: kind, due_date: r.due_date });
      if (logError && !String(logError.message).includes("duplicate key")) console.error("Could not write notification log", logError.message);
    }
  }
  return json({ ok: true, date: today, checked: reminders?.length || 0, sent, failed, skipped });
});
