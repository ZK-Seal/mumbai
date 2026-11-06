"use client";

import { useRef, useState } from "react";
import {
  IDKitRequestWidget,
  proofOfHuman,
  selfieCheck,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";
import type { AppReturn } from "@/lib/app-return";
import { OtherSeals } from "./other-seals";

export type Edit = "blank" | "blur";

export type Ready = {
  app_id: `app_${string}`;
  action: string;
  environment: "production" | "staging" | "sandbox";
  credential: "human" | "selfie";
  rp_context: RpContext;
};

/** What the desk answered about the name given with this authorisation. */
type Vouch = "vouched" | "not-vouched" | "unreachable";

/** A verified authorisation, with the person's name at a desk when the desk vouched for it. */
type Verified = {
  pass: string;
  member: string | null;
  vouch: Vouch | null;
  /** The desk that was asked, or the one the kept name belongs to. */
  desk: string | null;
};

type Phase =
  | { name: "idle" }
  | { name: "asking" }
  | { name: "open"; ready: Ready }
  | ({ name: "verified" } & Verified)
  | { name: "denied" }
  | { name: "not-set-up" };

const EDIT_WORDS: Record<Edit, string> = {
  blank: "Blank: one area is covered with a plain box.",
  blur: "Blur: one area is blurred.",
};

const ENVIRONMENTS = ["production", "staging", "sandbox"];

/** Takes the server's start answer apart. Null unless it has every piece the World app needs. */
export function readReady(answer: unknown): Ready | null {
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

/** A name as the server sent it back; only ever shown as text. */
function readText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 255 ? value : null;
}

function readVouch(value: unknown): Vouch | null {
  return value === "vouched" || value === "not-vouched" || value === "unreachable" ? value : null;
}

/** The verified parts of a server answer that carries a pass; null if it has no good pass. */
function readVerified(answer: unknown, pass: unknown): Verified | null {
  const a = answer as { name?: unknown; desk?: unknown; vouch?: unknown } | null;
  const kept = readPass(pass);
  if (!kept) return null;
  const member = readText(a?.name);
  return {
    pass: kept,
    member,
    vouch: member ? "vouched" : readVouch(a?.vouch),
    desk: readText(a?.desk),
  };
}

/** The desk a name belongs to: everything after its first label. */
function deskOf(name: string): string {
  return name.slice(name.indexOf(".") + 1);
}

function shorten(pass: string): string {
  return pass.length <= 24 ? pass : `${pass.slice(0, 12)}…${pass.slice(-8)}`;
}

export async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json().catch(() => null);
}

export function Authorise(props: {
  hash: string;
  edit: Edit;
  width: number;
  height: number;
  /** The event the photo was sealed at, if the link named one. */
  event: string | null;
  /** The pass already on record for this seal, if a person authorised it before. */
  pass: string | null;
  /** The name kept with that record, if a desk vouched for it. */
  member: string | null;
  /** The desk this server asks about names, if one is set up. */
  desk: string | null;
  /** The links back to the app, when the app opened this page and the way back is set up. */
  toApp: AppReturn | null;
}) {
  const { hash, event, toApp } = props;
  const [phase, setPhase] = useState<Phase>(() => {
    const kept = readPass(props.pass);
    const member = readText(props.member);
    return kept
      ? {
          name: "verified",
          pass: kept,
          member,
          vouch: member ? "vouched" : null,
          desk: member ? deskOf(member) : null,
        }
      : { name: "idle" };
  });
  const [given, setGiven] = useState("");
  const pass = useRef<Verified | null>(null);

  /** The seal is on record now: show it, and hand the person back to the app if it asked. */
  function authorised(verified: Verified) {
    setPhase({ name: "verified", ...verified });
    if (toApp) window.location.assign(toApp.authorised);
  }

  async function start() {
    setPhase({ name: "asking" });
    pass.current = null;
    let answer: unknown;
    try {
      answer = await post("/api/world/request", event ? { hash, event } : { hash });
    } catch {
      setPhase({ name: "denied" });
      return;
    }
    const word = answer as { state?: unknown; reason?: unknown; pass?: unknown } | null;
    const kept = word?.state === "authorised" ? readVerified(word, word.pass) : null;
    if (kept) {
      authorised(kept);
      return;
    }
    if (word?.reason === "not-set-up") {
      setPhase({ name: "not-set-up" });
      return;
    }
    const ready = readReady(answer);
    setPhase(ready ? { name: "open", ready } : { name: "denied" });
  }

  async function check(result: IDKitResult) {
    const name = given.trim();
    const body = { hash, result, ...(name ? { name } : {}), ...(event ? { event } : {}) };
    const answer = (await post("/api/world/verify", body)) as {
      state?: unknown;
      reason?: unknown;
      pass?: unknown;
    } | null;
    const verified = answer?.state === "verified" ? readVerified(answer, answer.pass) : null;
    if (verified === null) throw new Error("not verified");
    pass.current = verified;
  }

  function done() {
    if (pass.current) authorised(pass.current);
    else setPhase({ name: "denied" });
  }

  function failed() {
    setPhase({ name: "denied" });
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
        {event && (
          <>
            <dt>Event</dt>
            <dd>
              <a href={`/event/${event}`} className="mono">
                {event}
              </a>
            </dd>
          </>
        )}
      </dl>

      {phase.name === "verified" ? (
        <>
          <p className="state good" role="status">
            A verified human authorised this seal. Pass:{" "}
            <span className="mono" title={phase.pass}>
              {shorten(phase.pass)}
            </span>
          </p>
          <DeskLine verified={phase} />
          {toApp && (
            <div className="actions">
              <a className="button" href={toApp.authorised}>
                Back to the app
              </a>
            </div>
          )}
          <OtherSeals key={phase.pass} pass={phase.pass} hash={hash} />
        </>
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
        <>
          {props.desk && (
            <label className="field">
              <span>Your name at the desk (for example reporter.{props.desk})</span>
              <input
                type="text"
                name="desk-name"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={255}
                placeholder={`reporter.${props.desk}`}
                value={given}
                onChange={(event) => setGiven(event.target.value)}
                disabled={phase.name !== "idle"}
              />
            </label>
          )}
          <button type="button" onClick={start} disabled={phase.name !== "idle"}>
            Authorise with World ID
          </button>
        </>
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
          onError={failed}
        />
      )}

      {toApp && phase.name !== "verified" && (
        <p className="soft">
          <a href={toApp.cancelled}>Back to the app</a>
        </p>
      )}
    </>
  );
}

/** One fixed sentence about the person's name at the desk, when a name was kept or asked for. */
function DeskLine({ verified }: { verified: Verified }) {
  const desk = verified.desk ?? "the desk";
  if (verified.member) {
    return (
      <p className="state good">
        Sealed by {verified.member}, a member of {deskOf(verified.member)}.
      </p>
    );
  }
  if (verified.vouch === "not-vouched") {
    return <p className="state bad">This name is not vouched for by {desk}.</p>;
  }
  if (verified.vouch === "unreachable") {
    return (
      <p className="state bad">
        The member list of {desk} cannot be read just now, so no name was kept.
      </p>
    );
  }
  return null;
}
