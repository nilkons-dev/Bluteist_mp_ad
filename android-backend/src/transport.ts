/**
 * Transports for the backend.
 *
 *  - bridgeTransport(): the nodejs-mobile message bridge that capacitor-nodejs injects as require("bridge").
 *  - stdioTransport():  newline-delimited JSON on stdin/stdout, so the backend can be driven from a desktop
 *                       shell (`node dist/nodejs/index.js --stdio`) when debugging without a phone.
 */
import { MSG_EVENT } from "./protocol";
import type { Transport } from "./rpc";

/** The bridge may hand a listener the raw string, or a wrapper object with an `args` array. */
function unwrap(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    const inner = (first as { args?: unknown[] }).args;
    if (Array.isArray(inner) && typeof inner[0] === "string") return inner[0];
  }
  return null;
}

export function bridgeTransport(): Transport | null {
  let bridge: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    bridge = require("bridge");
  } catch {
    return null;
  }
  const channel = bridge?.channel ?? bridge;
  if (!channel) return null;
  const add: ((ev: string, cb: (...a: unknown[]) => void) => void) | undefined = channel.addListener ?? channel.on;
  const send: ((ev: string, ...a: unknown[]) => void) | undefined = channel.send ?? channel.post;
  if (typeof add !== "function" || typeof send !== "function") return null;
  return {
    send: (json) => send.call(channel, MSG_EVENT, json),
    onMessage: (cb) =>
      add.call(channel, MSG_EVENT, (...a: unknown[]) => {
        const json = unwrap(a);
        if (json !== null) cb(json);
      }),
  };
}

export function stdioTransport(): Transport {
  return {
    send: (json) => {
      process.stdout.write(json + "\n");
    },
    onMessage: (cb) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) cb(line);
        }
      });
    },
  };
}
