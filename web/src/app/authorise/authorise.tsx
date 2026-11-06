"use client";

import { useRef, useState } from "react";
import {
  IDKitRequestWidget,
  proofOfHuman,
  selfieCheck,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";

export type Edit = "blank" | "blur";

type Ready = {
  app_id: `app_${string}`;
  action: string;
  environment: "production" | "staging" | "sandbox";
  credential: "human" | "selfie";
  rp_context: RpContext;
};

type Phase =
  | { name: "idle" }
  | { name: "asking" }
  | { name: "open"; ready: Ready }
  | { name: "verified"; pass: string }
  | { name: "denied" }
  | { name: "not-set-up" };

const EDIT_WORDS: Record<Edit, string> = {
  blank: "Blank: one area is covered with a plain box.",
  blur: "Blur: one area is blurred.",
};

const ENVIRONMENTS = ["production", "staging", "sandbox"];

/** Takes the server's start answer apart. Null unless it has every piece the World app needs. */
function readReady(answer: unknown): Ready | null {
  const a = answer as Partial<Record<keyof Ready, unknown>> & { state?: unknown };
  const rp = a?.rp_context as Partial<Record<keyof RpContext, unknown>> | undefined;
  if (a?.state !== "ready") return null;
  if (typeof a.app_id !== "string" || !a.app_id.startsWith("app_")) return null;
  if (typeof a.action !== "string" || a.action === "") return null;
  if (typeof a.environment !== "string" || !ENVIRONMENTS.includes(a.environment)) return null;
  if (a.credential !== "human" && a.credential !== "selfie") return null;
  if (
    typeof rp?.rp_id !== "string" ||
    typeof rp.nonce !== "string" ||
    typeof rp.created_at !== "number" ||
    typeof rp.expires_at !== "number" ||
    typeof rp.signature !== "string"
  ) {
    return null;
  }
  return a as Ready;
}

/** A pass is a number, in decimal or 0x hex. Anything else is not shown. */
function readPass(value: unknown): string | null {
  return typeof value === "string" && /^(0x[0-9a-f]{1,128}|[0-9]{1,128})$/i.test(value)
    ? value
    : null;
}

function shorten(pass: string): string {
  return pass.length <= 24 ? pass : `${pass.slice(0, 12)}…${pass.slice(-8)}`;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json().catch(() => null);
}

export function Authorise(props: { hash: string; edit: Edit; width: number; height: number }) {
  const { hash } = props;
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const pass = useRef<string | null>(null);

  async function start() {
    setPhase({ name: "asking" });
    pass.current = null;
    let answer: unknown;
    try {
      answer = await post("/api/world/request", { hash });
    } catch {
      setPhase({ name: "denied" });
      return;
    }
    if ((answer as { reason?: unknown })?.reason === "not-set-up") {
      setPhase({ name: "not-set-up" });
      return;
    }
    const ready = readReady(answer);
    setPhase(ready ? { name: "open", ready } : { name: "denied" });
  }

  async function check(result: IDKitResult) {
    const answer = (await post("/api/world/verify", { hash, result })) as {
      state?: unknown;
      pass?: unknown;
    } | null;
    const verified = answer?.state === "verified" ? readPass(answer.pass) : null;
    if (verified === null) throw new Error("not verified");
    pass.current = verified;
  }

  function done() {
    setPhase(pass.current ? { name: "verified", pass: pass.current } : { name: "denied" });
  }

  function closed(open: boolean) {
    if (!open) setPhase((now) => (now.name === "open" ? { name: "denied" } : now));
  }

  return (
    <>
      <dl className="seal">
        <dt>Edit</dt>
        <dd>{EDIT_WORDS[props.edit]}</dd>
        <dt>Size</dt>
        <dd>
          {props.width} × {props.height} pixels
        </dd>
        <dt>Seal</dt>
        <dd className="mono">{hash}</dd>
      </dl>

      {phase.name === "verified" ? (
        <p className="state good" role="status">
          A verified human authorised this seal. Pass:{" "}
          <span className="mono" title={phase.pass}>
            {shorten(phase.pass)}
          </span>
        </p>
      ) : phase.name === "denied" ? (
        <div role="status">
          <p className="state bad">Human: not verified.</p>
          <button type="button" onClick={start}>
            Try again
          </button>
        </div>
      ) : phase.name === "not-set-up" ? (
        <p className="state" role="status">
          World ID is not set up on this server yet.
        </p>
      ) : (
        <button type="button" onClick={start} disabled={phase.name !== "idle"}>
          Authorise with World ID
        </button>
      )}

      {phase.name === "open" && (
        <IDKitRequestWidget
          open
          onOpenChange={closed}
          app_id={phase.ready.app_id}
          action={phase.ready.action}
          rp_context={phase.ready.rp_context}
          environment={phase.ready.environment}
          allow_legacy_proofs={phase.ready.credential === "human"}
          preset={
            phase.ready.credential === "human"
              ? proofOfHuman({ signal: hash })
              : selfieCheck({ signal: hash })
          }
          handleVerify={check}
          onSuccess={done}
          onError={() => setPhase({ name: "denied" })}
        />
      )}
    </>
  );
}
