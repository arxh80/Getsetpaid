"use client";

import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { CAPTCHA_FAILED } from "@/lib/auth/captcha";

export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<void> | null = null;

function loadTurnstile(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    // The request's nonce, copied off a script Next already stamped. 'strict-dynamic'
    // admits this insert either way; Cloudflare passes the nonce on to what api.js loads.
    script.nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce ?? "";
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error("Turnstile failed to load"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Cloudflare Turnstile, rendered inside an auth form so its hidden
 * `cf-turnstile-response` field is posted with it (lib/auth/captcha.ts).
 * Renders nothing unless NEXT_PUBLIC_TURNSTILE_SITE_KEY is set, so local dev,
 * CI and e2e run without it. `resetKey` changes after every submission: a
 * token is single-use, so a refused attempt needs a fresh one.
 */
export function Turnstile({ resetKey }: { resetKey?: unknown }) {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    loadTurnstile().then(
      () => {
        if (cancelled || !container.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(container.current, {
          sitekey: siteKey,
          theme: "dark",
          size: "flexible",
          callback: () => setFailed(false),
          "error-callback": () => setFailed(true),
        });
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (widgetId.current) window.turnstile?.reset(widgetId.current);
  }, [resetKey]);

  if (!siteKey) return null;
  return (
    <div className="flex flex-col gap-3">
      {/* 65px is the widget's own height; reserving it stops the submit button jumping when it loads. */}
      <div ref={container} className="min-h-[65px]" />
      {failed ? <Alert tone="error">{CAPTCHA_FAILED}</Alert> : null}
    </div>
  );
}
