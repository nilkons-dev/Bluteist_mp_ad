/**
 * @supabase/supabase-js loaded on first use.
 *
 * supabase-js 2.x declares Node >= 22, while the Node embedded in Android (nodejs-mobile) is older.
 * Accounts are off by default (src/lib/config.ts ACCOUNTS_ENABLED = false), so nothing here runs in a
 * normal build; loading lazily means a runtime that dislikes the library can never stop the backend
 * from starting. `supabase-real` is resolved to the real package by scripts/android/build-backend.mjs.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const createClient = (...args: any[]): any => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require("supabase-real");
  return real.createClient(...args);
};
export type Session = any;
export type SupabaseClient = any;
export type RealtimeChannel = any;
