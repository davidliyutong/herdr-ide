// The desktop app's word, which its shell's main process gives with the key
// of the launch (the verify key of its hello, desktop/src/verify.ts and
// relay.ts) after a prompt of the system the user answered:
//
//   - a proof: HMAC-SHA256 of a nonce and its purpose under the verify key;
//   - a relay: what makes an unlock entry's KEK, sealed for the hub with
//     AES-256-GCM under HKDF-SHA256(verify key, no salt, "vault-relay v1")
//     and bound by its additional data to its purpose, nonce and entry
//     (iv ‖ ciphertext ‖ tag). The page carries it and can read neither.
//
// Both are taken only from the desktop client (the routes check), and not
// at all without a verify key. Vectors: spec/vectors/vault-unlock/relay.json.
import { createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { hkdf } from './crypto.ts';

export interface Desktop {
  /** Whether mac is the shell's MAC of msg. */
  proof(msg: Uint8Array, mac: Uint8Array): boolean;
  /** What the shell sealed for ad; null when it does not open. */
  relay(ad: string, relay: Uint8Array): Buffer | null;
}

/** The relays' key of a verify key (its text, as the hello carries it). */
export const relayKey = (verifyKey: string) => hkdf(Buffer.from(verifyKey), Buffer.alloc(0), 'vault-relay v1');

/** The desktop app's proofs and relays under verifyKey; none without one. */
export function desktopOf(verifyKey: string): Desktop | undefined {
  if (!verifyKey) return undefined;
  return {
    proof(msg, mac) {
      const want = createHmac('sha256', verifyKey).update(msg).digest();
      return mac.length === want.length && timingSafeEqual(want, mac);
    },
    relay(ad, relay) {
      if (relay.length < 12 + 16) return null;
      const key = relayKey(verifyKey);
      try {
        const d = createDecipheriv('aes-256-gcm', key, relay.subarray(0, 12));
        d.setAAD(Buffer.from(ad));
        d.setAuthTag(relay.subarray(relay.length - 16));
        return Buffer.concat([d.update(relay.subarray(12, relay.length - 16)), d.final()]);
      } catch {
        return null;
      } finally {
        key.fill(0);
      }
    },
  };
}

/** What the shell signs for a proof: the nonce with its purpose. */
export const proofMessage = (nonce: string, p: { for: string; request?: string; answer?: string }) =>
  Buffer.from(`vault-proof\n${nonce}\n${p.for}\n${p.request ?? ''}\n${p.answer ?? ''}`);

/** A relay's additional data: its purpose, the nonce and the entry ("" for
 * a registration). */
export const relayAD = (purpose: string, nonce: string, id: string) => `vault-relay\n${purpose}\n${nonce}\n${id}`;
