import { createHandler } from "./handler.ts";

// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase добавляет автоматически.
// TELEGRAM_BOT_TOKEN, WEBHOOK_SECRET и APP_URL задаются в Secrets вручную.
const runtime = (globalThis as typeof globalThis & {
  EdgeRuntime?: { waitUntil(task: Promise<void>): void };
}).EdgeRuntime;
Deno.serve(createHandler({
  env: (name) => Deno.env.get(name),
  fetch,
  defer: runtime?.waitUntil ? (task) => runtime.waitUntil(task) : undefined,
}));
