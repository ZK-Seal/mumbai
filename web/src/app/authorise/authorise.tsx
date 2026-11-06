"use client";

import { useRef, useState } from "react";
import {
  IDKitRequestWidget,
  proofOfHuman,
  selfieCheck,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";
import { OtherSeals } from "./other-seals";

export type Edit = "blank" | "blur";

/** The word a sign-in came back with. */
export type SigninWord = "denied" | "expired" | "failed" | "class";

/** Where the person stands with Sign in with World when the page opens. */
export type SigninNow = {
  standing: "not-set-up" | "out" | "fresh" | "stale" | "other";
  /** A short name for the signed-in account; never the account's subject. */
  account: string | null;
};

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

const WORD_SENTENCES: Record<SigninWord, string> = {
  denied: "Sign-in was cancelled.",
  expired: "Sign in again to continue.",
  failed: "Sign-in did not work. Try again.",
  class: "This account does not have the required verification.",
};

const STANDING_SENTENCES: Partial<Record<SigninNow["standing"], string>> = {
  stale: "Sign in again to continue.",
  other: "This account does not have the required verification.",
};

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

export function Authorise(props: {
  hash: string;
  edit: Edit;
  width: number;
  height: number;
  /** The pass already on record for this seal, if a person authorised it before. */
  pass: string | null;
  signin: SigninNow;
  word: SigninWord | null;
}) {
  const { hash } = props;
  const [signin, setSignin] = useState<SigninNow>(props.signin);
  const [word, setWord] = useState<SigninWord | null>(props.word);
  const signinRefused = useRef(false);
  const back = `/authorise?hash=${hash}&edit=${props.edit}&w=${props.width}&h=${props.height}`;
  const startUrl = `/api/auth/start?return=${encodeURIComponent(back)}`;

  /** The server said the sign-in is missing, too old or of the wrong class. */
  function needSignin() {
    setSignin((now) => (now.standing === "fresh" ? { ...now, standing: "stale" } : now));
    setWord(null);
    setPhase({ name: "idle" });
  }

  async function signOut() {
    await fetch("/api/auth/signout", { method: "POST" }).catch(() => null);
    setSignin({ standing: "out", account: null });
    setWord(null);
    setPhase((now) => (now.name === "verified" ? now : { name: "idle" }));
  }
  const [phase, setPhase] = useState<Phase>(() => {
    const kept = readPass(props.pass);
    return kept ? { name: "verified", pass: kept } : { name: "idle" };
  });
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
    const word = answer as { state?: unknown; reason?: unknown; pass?: unknown } | null;
    const kept = word?.state === "authorised" ? readPass(word.pass) : null;
    if (kept) {
      setPhase({ name: "verified", pass: kept });
      return;
    }
    if (word?.reason === "sign-in") {
      needSignin();
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
    const answer = (await post("/api/world/verify", { hash, result })) as {
      state?: unknown;
      reason?: unknown;
      pass?: unknown;
    } | null;
    signinRefused.current = answer?.reason === "sign-in";
    const verified = answer?.state === "verified" ? readPass(answer.pass) : null;
    if (verified === null) throw new Error("not verified");
    pass.current = verified;
  }

  function done() {
    if (pass.current) setPhase({ name: "verified", pass: pass.current });
    else if (signinRefused.current) needSignin();
    else setPhase({ name: "denied" });
  }

  function failed() {
    if (signinRefused.current) needSignin();
    else setPhase({ name: "denied" });
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

      {signin.standing !== "not-set-up" && phase.name !== "verified" && (
        <SigninPart signin={signin} word={word} startUrl={startUrl} onSignOut={signOut} />
      )}

      {phase.name === "verified" ? (
        <>
          <p className="state good" role="status">
            A verified human authorised this seal. Pass:{" "}
            <span className="mono" title={phase.pass}>
              {shorten(phase.pass)}
            </span>
          </p>
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
      ) : signin.standing === "not-set-up" || signin.standing === "fresh" ? (
        <button type="button" onClick={start} disabled={phase.name !== "idle"}>
          Authorise with World ID
        </button>
      ) : null}

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
    </>
  );
}

/** Sign in with World: shown first, before a seal can be authorised. */
function SigninPart(props: {
  signin: SigninNow;
  word: SigninWord | null;
  startUrl: string;
  onSignOut: () => void;
}) {
  const { standing, account } = props.signin;
  const fromWord = standing === "out" && props.word ? WORD_SENTENCES[props.word] : null;
  const sentence = STANDING_SENTENCES[standing] ?? fromWord;
  return (
    <div className="signin">
      {standing !== "out" && account && (
        <p className="soft">
          Signed in with World as account <span className="mono">{account}</span>.
        </p>
      )}
      {sentence && (
        <p className="state bad" role="status">
          {sentence}
        </p>
      )}
      <div className="actions">
        {standing !== "fresh" && (
          <a className="button" href={props.startUrl}>
            Sign in with World
          </a>
        )}
        {standing !== "out" && (
          <button type="button" className="quiet" onClick={props.onSignOut}>
            Sign out
          </button>
        )}
      </div>
    </div>
  );
}
