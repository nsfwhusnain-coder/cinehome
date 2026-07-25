/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { checkRegistrationGate, REGISTRATION_CLOSED_MESSAGE } from "./registration-gate";

describe("checkRegistrationGate", () => {
  it("rejects everyone when REGISTRATION_INVITE_CODE is unset, even with a code guess", () => {
    const result = checkRegistrationGate({
      isAdminCreating: false,
      requiredCode: undefined,
      providedCode: "anything",
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toBe(REGISTRATION_CLOSED_MESSAGE);
  });

  it("rejects an empty-string env value the same as unset", () => {
    const result = checkRegistrationGate({
      isAdminCreating: false,
      requiredCode: "",
      providedCode: "",
    });
    expect(result.allowed).toBe(false);
  });

  it("rejects a missing invite code when one is required", () => {
    const result = checkRegistrationGate({
      isAdminCreating: false,
      requiredCode: "letmein2026",
      providedCode: undefined,
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toBe(REGISTRATION_CLOSED_MESSAGE);
  });

  it("rejects a mismatched invite code", () => {
    const result = checkRegistrationGate({
      isAdminCreating: false,
      requiredCode: "letmein2026",
      providedCode: "wrong-code",
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toBe(REGISTRATION_CLOSED_MESSAGE);
  });

  it("allows a matching invite code", () => {
    const result = checkRegistrationGate({
      isAdminCreating: false,
      requiredCode: "letmein2026",
      providedCode: "letmein2026",
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("invite_ok");
  });

  it("is case-sensitive on the invite code (no fuzzy matching)", () => {
    const result = checkRegistrationGate({
      isAdminCreating: false,
      requiredCode: "letmein2026",
      providedCode: "LetMeIn2026",
    });
    expect(result.allowed).toBe(false);
  });

  it("always allows an authenticated admin, regardless of invite code state", () => {
    const withNoCodeConfigured = checkRegistrationGate({
      isAdminCreating: true,
      requiredCode: undefined,
      providedCode: undefined,
    });
    expect(withNoCodeConfigured.allowed).toBe(true);
    expect(withNoCodeConfigured.reason).toBe("admin");

    const withWrongCodeProvided = checkRegistrationGate({
      isAdminCreating: true,
      requiredCode: "letmein2026",
      providedCode: "wrong-code",
    });
    expect(withWrongCodeProvided.allowed).toBe(true);
    expect(withWrongCodeProvided.reason).toBe("admin");
  });
});
