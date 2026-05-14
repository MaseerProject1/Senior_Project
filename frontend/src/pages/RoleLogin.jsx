import { useState } from "react";
import brandLogo from "../assets/maseer-logo.jpg";
import { authenticatePrototype, persistSession } from "../lib/roleAccess";
import GlassButton from "../components/GlassButton";

export default function RoleLogin({ onEntered }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  function handleLogin() {
    setError("");
    const session = authenticatePrototype(username, password);
    if (!session) {
      setError("Invalid prototype username or password.");
      return;
    }
    persistSession(session);
    onEntered(session);
  }

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-br from-[#002B24] via-[#003C35] to-[#021e19] antialiased">
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md rounded-2xl border border-white/15 bg-white/95 p-8 shadow-soft backdrop-blur-sm">
          <div className="flex flex-col items-center text-center">
            <img
              src={brandLogo}
              alt="MASEER"
              className="h-16 w-16 rounded-xl object-cover ring-2 ring-[#008B78]/30"
            />
            <h1 className="mt-4 text-2xl font-bold tracking-tight text-brand-deep">MASEER</h1>
            <p className="mt-1 text-xs font-medium text-brand-muted">NYC demand intelligence prototype</p>
          </div>
          <p className="mt-6 text-center text-sm leading-relaxed text-brand-text">
            Sign in with a prototype account to open the stakeholder dashboard view.
          </p>
          <div className="mt-6 space-y-4">
            {error ? (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-center text-xs font-medium text-rose-800">
                {error}
              </p>
            ) : null}
            <label className="block text-left">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-brand-muted">Username</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                className="w-full rounded-xl border border-brand-border bg-white px-3 py-2.5 text-sm text-brand-text shadow-sm outline-none ring-brand-primary/20 placeholder:text-brand-muted/70 focus:ring-2"
                placeholder="Prototype username"
              />
            </label>
            <label className="block text-left">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-brand-muted">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleLogin();
                }}
                className="w-full rounded-xl border border-brand-border bg-white px-3 py-2.5 text-sm text-brand-text shadow-sm outline-none ring-brand-primary/20 placeholder:text-brand-muted/70 focus:ring-2"
                placeholder="Prototype password"
              />
            </label>
          </div>
          <div className="mt-8">
            <GlassButton type="button" variant="primary" className="w-full justify-center py-3 text-sm" onClick={handleLogin}>
              Log in
            </GlassButton>
          </div>
          <p className="mt-4 text-center text-[10px] leading-relaxed text-brand-muted">
            Presentation prototype only — demo credentials are used for stakeholder access.
          </p>
        </div>
      </div>
    </div>
  );
}
