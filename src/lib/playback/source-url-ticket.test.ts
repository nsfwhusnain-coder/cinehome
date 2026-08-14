/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import {
  SOURCE_URL_TICKET_TTL_MS,
  issueSourceUrlTicket,
  redeemSourceUrlTicket,
} from "./source-url-ticket";

const args = {
  url: "https://download.example/movie.mkv",
  sourceId: "debrid-tt1-movie-0-0-safari-2160",
  userId: "user-1",
};

describe("source URL remux ticket", () => {
  it("round-trips the resolved URL without putting it in plaintext", () => {
    const ticket = issueSourceUrlTicket(args);
    expect(ticket).not.toContain("download.example");
    expect(redeemSourceUrlTicket(ticket, args)).toBe(args.url);
  });

  it("rejects another user or another source id", () => {
    const ticket = issueSourceUrlTicket(args);
    expect(
      redeemSourceUrlTicket(ticket, { ...args, userId: "user-2" })
    ).toBeNull();
    expect(
      redeemSourceUrlTicket(ticket, { ...args, sourceId: "other" })
    ).toBeNull();
  });

  it("expires after the remux sitting window", () => {
    const now = 1_700_000_000_000;
    const ticket = issueSourceUrlTicket({ ...args, now });
    expect(
      redeemSourceUrlTicket(ticket, {
        ...args,
        now: now + SOURCE_URL_TICKET_TTL_MS + 1,
      })
    ).toBeNull();
  });
});
