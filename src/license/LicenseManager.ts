import * as nacl from "tweetnacl";
import { LICENSE_PUBLIC_KEY } from "./publicKey";

export interface LicensePayload {
  product: string;
  email: string;
  issued: string;
}

/**
 * Keys that must stop working.
 *
 * Verification is offline by design — no account, no server, no phone-home — so
 * there is no way to tell an installed copy that a key was refunded or posted
 * publicly. The only lever is a list shipped inside the plugin and updated with
 * a release. Rotating the signing key would work too, and would break every
 * paying customer at once, so it is not the answer.
 *
 * Entries are the base64url payload segment of the key (the part before the
 * dot), so nothing identifying has to be embedded here.
 */
const REVOKED_PAYLOADS = new Set<string>([]);

export class LicenseManager {
  private static readonly PRODUCT = "task-calendar-bridge";

  static verify(licenseKey: string): { valid: boolean; email?: string; error?: string } {
    const trimmed = licenseKey.trim();
    if (!trimmed) return { valid: false, error: "No license key provided." };

    const parts = trimmed.split(".");
    if (parts.length !== 2) return { valid: false, error: "Invalid license format." };

    // Checked before the signature: a revoked key is correctly signed.
    if (REVOKED_PAYLOADS.has(parts[0])) {
      return { valid: false, error: "This license key has been revoked. Contact support if you believe that is a mistake." };
    }

    try {
      const payloadBytes = base64ToBytes(parts[0]);
      const signature = base64ToBytes(parts[1]);
      const publicKey = base64ToBytes(LICENSE_PUBLIC_KEY);

      if (!nacl.sign.detached.verify(payloadBytes, signature, publicKey)) {
        return { valid: false, error: "Invalid license signature." };
      }

      const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as LicensePayload;
      if (payload.product !== LicenseManager.PRODUCT) {
        return { valid: false, error: "License is for a different product." };
      }

      return { valid: true, email: payload.email };
    } catch {
      return { valid: false, error: "Could not parse license key." };
    }
  }
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
