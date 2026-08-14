"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useSession, signIn, signOut } from "next-auth/react";
import { useNavigate } from "@/hooks/use-navigate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, KeyRound, User } from "lucide-react";
import { transitionEnter } from "@/lib/motion";
import { BrandMark } from "@/components/brand-mark";

export const LAST_PROFILE_KEY = "cinehome:last-profile";

/** Same-origin relative path only. Rejects protocol-relative, login loops, and schemes. */
export function safeCallbackPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  let value = raw.trim();
  if (!value) return "/";
  try {
    value = decodeURIComponent(value);
  } catch {
    return "/";
  }
  value = value.trim();
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  if (value.includes("\\") || value.includes("://")) return "/";
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return "/";
  const pathOnly = value.split(/[?#]/, 1)[0] ?? value;
  const lowered = pathOnly.toLowerCase();
  if (lowered === "/login" || lowered.startsWith("/login/")) return "/";
  return value;
}

export function readLastProfile(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_PROFILE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function writeLastProfile(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    window.localStorage.setItem(LAST_PROFILE_KEY, trimmed);
  } catch {
    // private mode / quota
  }
}

const LOGIN_WASH_HEX =
  "radial-gradient(58% 48% at 22% 18%, rgba(154, 58, 50, 0.42), transparent 62%)," +
  "radial-gradient(52% 44% at 82% 76%, rgba(74, 69, 96, 0.40), transparent 60%)," +
  "radial-gradient(90% 70% at 50% 50%, transparent 30%, rgba(28, 28, 34, 0.85) 100%)";

const LOGIN_WASH_OKLCH =
  "radial-gradient(58% 48% at 22% 18%, oklch(0.42 0.14 25 / 0.42), transparent 62%)," +
  "radial-gradient(52% 44% at 82% 76%, oklch(0.38 0.07 280 / 0.40), transparent 60%)," +
  "radial-gradient(90% 70% at 50% 50%, transparent 30%, oklch(0.13 0.01 280 / 0.85) 100%)";

async function rateLimitMessage(name: string): Promise<string | null> {
  try {
    const res = await fetch("/api/auth/rate-limit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const json = (await res.json()) as { allowed?: boolean; message?: string };
    if (json.allowed === false) {
      return json.message ?? "Too many failed attempts. Try again in a few minutes.";
    }
  } catch {
    // fall through to generic invalid credentials
  }
  return null;
}

interface LoginViewProps {
  callbackUrl?: string;
  error?: string;
}

function profileInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function LoginView({ callbackUrl, error }: LoginViewProps) {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [useOtherProfile, setUseOtherProfile] = useState(false);
  const [lastProfile, setLastProfile] = useState("");
  const [loading, setLoading] = useState(false);
  const nextPath = safeCallbackPath(callbackUrl);
  const sessionExpired = error === "SessionExpired";

  const [signinName, setSigninName] = useState("");
  const [signinPin, setSigninPin] = useState("");

  const [signupName, setSignupName] = useState("");
  const [signupPin, setSignupPin] = useState("");
  const [signupPinConfirm, setSignupPinConfirm] = useState("");
  const [signupInviteCode, setSignupInviteCode] = useState("");

  useEffect(() => {
    const stored = readLastProfile();
    if (!stored) return;
    setLastProfile(stored);
    setSigninName(stored);
  }, []);

  const showReturningTile = Boolean(lastProfile) && !useOtherProfile && mode === "signin";

  if (session) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <Card className="max-w-md w-full rounded-2xl">
          <CardHeader>
            <CardTitle className="font-display">Already signed in</CardTitle>
            <CardDescription>You're signed in as {session.user?.name}.</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button onClick={() => navigate(nextPath)} className="flex-1 rounded-full">
              {nextPath === "/" ? "Go home" : "Continue"}
            </Button>
            <Button onClick={() => signOut({ callbackUrl: "/login" })} variant="outline" className="rounded-full">
              Sign out
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const finishSignedIn = (name: string) => {
    writeLastProfile(name);
    setLastProfile(name);
    toast.success("Signed in");
    navigate(nextPath);
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const lockedBefore = await rateLimitMessage(signinName);
    if (lockedBefore) {
      setLoading(false);
      toast.error(lockedBefore);
      return;
    }

    const res = await signIn("credentials", {
      name: signinName,
      pin: signinPin,
      redirect: false,
    });
    setLoading(false);
    if (res?.error) {
      const lockedAfter = await rateLimitMessage(signinName);
      toast.error(lockedAfter ?? "Invalid name or PIN");
    } else {
      finishSignedIn(signinName);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (signupPin !== signupPinConfirm) {
      toast.error("PINs don't match");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: signupName,
          pin: signupPin,
          inviteCode: signupInviteCode,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to sign up");
        setLoading(false);
        return;
      }
      const r2 = await signIn("credentials", {
        name: signupName,
        pin: signupPin,
        redirect: false,
      });
      setLoading(false);
      if (r2?.error) {
        toast.error("Account created — please sign in.");
        setMode("signin");
        setUseOtherProfile(false);
        setSigninName(signupName);
        writeLastProfile(signupName);
        setLastProfile(signupName);
      } else {
        writeLastProfile(signupName);
        setLastProfile(signupName);
        toast.success(json.user?.isAdmin ? "Admin account created" : "Account created");
        navigate(nextPath);
      }
    } catch (err: unknown) {
      setLoading(false);
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden px-4 py-12">
      {/*
        Hex first (own layer) so Hisense / Chrome 76 still paints a wash when
        the oklch layer is dropped as an invalid declaration.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: LOGIN_WASH_HEX }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{ background: LOGIN_WASH_OKLCH }}
      />
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitionEnter}
        className="w-full max-w-md"
      >
      {sessionExpired ? (
        <div
          role="status"
          className="mb-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/80"
        >
          Your session expired. Sign in again.
        </div>
      ) : null}
      <Card className="w-full rounded-2xl border-white/10">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 flex justify-center">
            <BrandMark size="lg" />
          </div>
          <CardTitle className="font-display text-2xl tracking-tight">Absolute Cinema</CardTitle>
          <CardDescription>
            {showReturningTile
              ? "Enter your PIN to continue."
              : mode === "signup"
                ? "Create a household profile with an invite code."
                : "Pick a profile and enter the PIN."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {mode === "signup" ? (
            <form onSubmit={handleSignUp} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="su-invite">Invite code</Label>
                <div className="relative">
                  <KeyRound className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="su-invite"
                    type="text"
                    required
                    value={signupInviteCode}
                    onChange={(e) => setSignupInviteCode(e.target.value)}
                    placeholder="Ask the owner for an invite code"
                    className="pl-9"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="su-name">Name</Label>
                <div className="relative">
                  <User className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="su-name"
                    type="text"
                    required
                    autoFocus
                    minLength={2}
                    value={signupName}
                    onChange={(e) => setSignupName(e.target.value)}
                    placeholder="e.g. Alex"
                    className="pl-9"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="su-pin">PIN (4-10 digits)</Label>
                <div className="relative">
                  <KeyRound className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="su-pin"
                    type="password"
                    inputMode="numeric"
                    pattern="\d{4,10}"
                    required
                    value={signupPin}
                    onChange={(e) => setSignupPin(e.target.value.replace(/\D/g, ""))}
                    placeholder="Pick a PIN"
                    className="pl-9"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="su-pin2">Confirm PIN</Label>
                <div className="relative">
                  <KeyRound className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="su-pin2"
                    type="password"
                    inputMode="numeric"
                    pattern="\d{4,10}"
                    required
                    value={signupPinConfirm}
                    onChange={(e) => setSignupPinConfirm(e.target.value.replace(/\D/g, ""))}
                    placeholder="Re-enter PIN"
                    className="pl-9"
                  />
                </div>
              </div>
              <Button type="submit" disabled={loading} className="w-full rounded-full">
                {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Create account
              </Button>
              <button
                type="button"
                className="w-full py-2 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setMode("signin")}
              >
                Back to sign in
              </button>
            </form>
          ) : showReturningTile ? (
            <form onSubmit={handleSignIn} className="space-y-4">
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-6">
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary text-2xl font-semibold text-primary-foreground">
                  {profileInitials(lastProfile)}
                </div>
                <div className="font-display text-2xl font-semibold tracking-tight">{lastProfile}</div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signin-pin">PIN</Label>
                <div className="relative">
                  <KeyRound className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="signin-pin"
                    type="password"
                    inputMode="numeric"
                    pattern="\d{4,10}"
                    required
                    autoFocus
                    data-tv-first-focus
                    value={signinPin}
                    onChange={(e) => setSigninPin(e.target.value.replace(/\D/g, ""))}
                    placeholder="4-10 digits"
                    className="pl-9"
                  />
                </div>
              </div>
              <Button type="submit" disabled={loading} className="w-full rounded-full">
                {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Sign in
              </Button>
              <button
                type="button"
                className="w-full py-2 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setUseOtherProfile(true);
                  setSigninName("");
                  setSigninPin("");
                }}
              >
                Use a different profile
              </button>
              <button
                type="button"
                className="w-full py-1 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setMode("signup")}
              >
                Create a household account
              </button>
            </form>
          ) : (
            <form onSubmit={handleSignIn} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="signin-name">Name</Label>
                <div className="relative">
                  <User className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="signin-name"
                    type="text"
                    required
                    autoFocus
                    value={signinName}
                    onChange={(e) => setSigninName(e.target.value)}
                    placeholder="e.g. Alex"
                    className="pl-9"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signin-pin-full">PIN</Label>
                <div className="relative">
                  <KeyRound className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="signin-pin-full"
                    type="password"
                    inputMode="numeric"
                    pattern="\d{4,10}"
                    required
                    value={signinPin}
                    onChange={(e) => setSigninPin(e.target.value.replace(/\D/g, ""))}
                    placeholder="4-10 digits"
                    className="pl-9"
                  />
                </div>
              </div>
              <Button type="submit" disabled={loading} className="w-full rounded-full">
                {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Sign in
              </Button>
              {lastProfile ? (
                <button
                  type="button"
                  className="w-full py-2 text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setUseOtherProfile(false);
                    setSigninName(lastProfile);
                    setSigninPin("");
                  }}
                >
                  Back to {lastProfile}
                </button>
              ) : null}
              <button
                type="button"
                className="w-full py-1 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setMode("signup")}
              >
                Create a household account
              </button>
            </form>
          )}
        </CardContent>
      </Card>
      </motion.div>
    </div>
  );
}
