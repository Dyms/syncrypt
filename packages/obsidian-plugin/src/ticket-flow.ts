// Pure ticket→settings application (ADR-0020, ADR-0033). Called ONLY after the
// ticket decrypted and validated successfully — a failed open must leave
// settings untouched (fail-closed), which is trivially true because this
// function is never reached in that case and returns a NEW object either way.

import type { ConnectionTicketPayload } from "@syncrypt/crypto";

import type { SyncryptSettings } from "./settings.js";

export function applyTicketToSettings(
  settings: SyncryptSettings,
  ticket: ConnectionTicketPayload,
): SyncryptSettings {
  if (ticket.provider === "webdav") {
    return {
      ...settings,
      provider: "webdav",
      webdav: {
        url: ticket.url,
        username: ticket.username ?? "",
        password: ticket.password ?? "",
        prefix: ticket.prefix,
      },
    };
  }
  return {
    ...settings,
    provider: "s3",
    s3: {
      endpoint: ticket.endpoint,
      region: ticket.region,
      bucket: ticket.bucket,
      prefix: ticket.prefix,
      forcePathStyle: ticket.forcePathStyle,
      accessKeyId: ticket.accessKeyId ?? "",
      secretAccessKey: ticket.secretAccessKey ?? "",
    },
  };
}

/**
 * True when the ticket carried no credentials (the cautious export mode).
 * The importing device gets a working configuration and has to type the
 * secrets in by hand — which is the point of that mode.
 */
export function ticketIsCredsLess(ticket: ConnectionTicketPayload): boolean {
  if (ticket.provider === "webdav") {
    return ticket.username === undefined || ticket.password === undefined;
  }
  return ticket.accessKeyId === undefined || ticket.secretAccessKey === undefined;
}
