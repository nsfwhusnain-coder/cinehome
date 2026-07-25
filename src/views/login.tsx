"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { useSession, signIn, signOut } from "next-auth/react";
import { useNavigate } from "@/hooks/use-navigate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Loader2, KeyRound, User } from "lucide-react";
import { transitionEnter } from "@/lib/motion";
import { BrandMark } from "@/components/brand-mark";

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

export function LoginView() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [loading, setLoading] = useState(false);

  // sign-in state
  const [signinName, setSigninName] = useState("");
  const [signinPin, setSigninPin] = useState("");

  // sign-up state
  const [signupName, setSignupName] = useState("");
  const [signupPin, setSignupPin] = useState("");
  const [signupPinConfirm, setSignupPinConfirm] = useState("");
  const [signupInviteCode, setSignupInviteCode] = useState("");

  if (session) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <Card className="max-w-md w-full rounded-2xl">
          <CardHeader>
            <CardTitle className="font-display">Already signed in</CardTitle>
            <CardDescription>You're signed in as {session.user?.name}.</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button onClick={() => navigate("/")} className="flex-1 rounded-full">
              Go home
            </Button>
            <Button onClick={() => signOut({ callbackUrl: "/login" })} variant="outline" className="rounded-full">
              Sign out
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

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
      toast.success("Signed in");
      navigate("/");
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
      // Auto sign in
      const r2 = await signIn("credentials", {
        name: signupName,
        pin: signupPin,
        redirect: false,
      });
      setLoading(false);
      if (r2?.error) {
        toast.error("Account created — please sign in.");
        setMode("signin");
        setSigninName(signupName);
      } else {
        toast.success(json.user?.isAdmin ? "Admin account created" : "Account created");
        navigate("/");
      }
    } catch (e: any) {
      setLoading(false);
      toast.error(e.message || "Something went wrong");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transitionEnter}
        className="w-full max-w-md"
      >
      <Card className="w-full rounded-2xl border-white/10">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3 flex justify-center">
            <BrandMark size="lg" />
          </div>
          <CardTitle className="font-display text-2xl tracking-tight">Absolute Cinema</CardTitle>
          <CardDescription>
            Your personal streaming experience. Pick a name and a PIN — that&apos;s it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={mode} onValueChange={(v) => setMode(v as any)}>
            <TabsList className="grid w-full grid-cols-2 rounded-full">
              <TabsTrigger value="signin" className="rounded-full">Sign in</TabsTrigger>
              <TabsTrigger value="signup" className="rounded-full">Sign up</TabsTrigger>
            </TabsList>

            <TabsContent value="signin">
              <form onSubmit={handleSignIn} className="space-y-3 mt-4">
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
                  <Label htmlFor="signin-pin">PIN</Label>
                  <div className="relative">
                    <KeyRound className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="signin-pin"
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
              </form>
            </TabsContent>

            <TabsContent value="signup">
              <form onSubmit={handleSignUp} className="space-y-3 mt-4">
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
                <p className="text-xs text-muted-foreground text-center">
                  Registration is invite-only. The first account created becomes the admin.
                </p>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      </motion.div>
    </div>
  );
}
