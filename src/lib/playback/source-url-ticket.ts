import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Long enough for a sitting, short enough that a leaked ticket dies. */
export const SOURCE_URL_TICKET_TTL_MS = 30 * 60 * 1000;

interface TicketPayload {
  u: string;
  s: string;
  v: string;
  e: number;
}

function ticketKey(): Buffer {
  const secret =
    process.env.SOURCE_TICKET_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "";
  return createHash("sha256").update(`cinehome-remux-ticket:v1:${secret}`).digest();
}

export function issueSourceUrlTicket(args: {
  url: string;
  sourceId: string;
  userId: string;
  now?: number;
}): string {
  const payload: TicketPayload = {
    u: args.url,
    s: args.sourceId,
    v: args.userId,
    e: (args.now ?? Date.now()) + SOURCE_URL_TICKET_TTL_MS,
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ticketKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function redeemSourceUrlTicket(
  ticket: string,
  args: { sourceId: string; userId: string; now?: number }
): string | null {
  try {
    const raw = Buffer.from(ticket, "base64url");
    if (raw.length < 29) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", ticketKey(), iv);
    decipher.setAuthTag(tag);
    const parsed = JSON.parse(
      Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
    ) as Partial<TicketPayload>;
    if (parsed.s !== args.sourceId || parsed.v !== args.userId) return null;
    if (typeof parsed.e !== "number" || parsed.e < (args.now ?? Date.now())) {
      return null;
    }
    if (
      typeof parsed.u !== "string" ||
      !(parsed.u.startsWith("http") || parsed.u.startsWith("/api/"))
    ) {
      return null;
    }
    return parsed.u;
  } catch {
    return null;
  }
}

export function stampSourceUrlTickets<T extends { id: string; url: string }>(
  sources: readonly T[],
  userId: string
): Array<T & { remuxTicket: string }> {
  return sources.map((source) => ({
    ...source,
    remuxTicket: issueSourceUrlTicket({
      url: source.url,
      sourceId: source.id,
      userId,
    }),
  }));
}
