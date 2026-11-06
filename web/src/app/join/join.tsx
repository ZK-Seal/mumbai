"use client";

import { useEffect, useRef, useState } from "react";
import { IDKitRequestWidget, proofOfHuman, selfieCheck, type IDKitResult } from "@worldcoin/idkit";
import { joinLink } from "@/lib/app-return";
import { post, readReady, type Ready } from "../authorise/authorise";

/** Where the person's name stands on chain. */
type Ens = "pending" | "done";

type Registered = { held: string; label: string; ens: Ens };

type Phase =
  | { name: "idle" }
  | { name: "asking" }
  | { name: "open"; ready: Ready; label: string; signal: string }
  | ({ name: "registered" } & Registered)
  | { name: "taken"; label: string }
  | { name: "denied" }
  | { name: "not-set-up" };

const RESERVED = new Set(["users", "events", "www", "admin"]);

/** How often, and for how long, the page asks whether the name is on chain yet. */
const POLL_MS = 5000;
const POLL_FOR_MS = 120000;

/** Why a label cannot be taken, or null when it can. */
function labelProblem(label: string): string | null {
  if (label.length < 3) return "At least 3 characters.";
  if (label.length > 20) return "At most 20 characters.";
  if (!/^[a-z0-9-]+$/.test(label)) return "Only lowercase letters, digits and dashes.";
  if (label.startsWith("-")) return "Starts with a letter or a digit.";
  if (RESERVED.has(label)) return "This name is kept for the site.";
  return null;
}

/** The registered parts of a server answer. Null unless it has a name and a known state. */
function readRegistered(answer: unknown): Registered | null {
  const a = answer as { state?: unknown; name?: unknown; ens?: unknown } | null;
  if (a?.state !== "registered" || typeof a.name !== "string") return null;
  if (!/^[a-z0-9][a-z0-9-]{2,19}\.[a-z0-9.-]{3,200}$/.test(a.name)) return null;
  const ens = a.ens === "done" ? "done" : a.ens === "pending" ? "pending" : null;
  if (ens === null) return null;
  return { held: a.name, label: a.name.slice(0, a.name.indexOf(".")), ens };
}

export function Join(props: {
  /** The name every user name is under, for example armanc.eth. */
  root: string;
  /** A label the link suggested, if any. */
  label: string;
  /** The address back to the app, when the app opened this page and the way back is set up. */
  toApp: string | null;
}) {
  const { root, toApp } = props;
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [given, setGiven] = useState(props.label);
  const [late, setLate] = useState(false);
  const answer = useRef<{ registered: Registered | null; reason: unknown }>({
    registered: null,
    reason: null,
  });

  const label = given.trim();
  const problem = label === "" ? null : labelProblem(label);
  const pendingLabel = phase.name === "registered" && phase.ens === "pending" ? phase.label : null;

  // While the name is on its way, ask every few seconds whether it is there, for two minutes.
  useEffect(() => {
    if (pendingLabel === null) return;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > POLL_FOR_MS) {
        clearInterval(timer);
        setLate(true);
        return;
      }
      const listed = await fetch(`/api/user/${encodeURIComponent(pendingLabel)}`)
        .then((response) => response.json())
        .catch(() => null);
      if ((listed as { ens?: { state?: unknown } } | null)?.ens?.state === "done") {
        clearInterval(timer);
        setPhase((now) => (now.name === "registered" ? { ...now, ens: "done" } : now));
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pendingLabel]);

  async function start() {
    if (label === "" || problem) return;
    setPhase({ name: "asking" });
    setLate(false);
    answer.current = { registered: null, reason: null };
    let reply: unknown;
    try {
      reply = await post("/api/user/request", { label });
    } catch {
      setPhase({ name: "denied" });
      return;
    }
    const word = reply as { state?: unknown; reason?: unknown; signal?: unknown } | null;
    if (word?.state === "taken") {
      setPhase({ name: "taken", label });
      return;
    }
    if (word?.reason === "not-set-up") {
      setPhase({ name: "not-set-up" });
      return;
    }
    const ready = readReady(reply);
    const signal = `user:${label}`;
    setPhase(
      ready && word?.signal === signal
        ? { name: "open", ready, label, signal }
        : { name: "denied" },
    );
  }

  async function check(result: IDKitResult) {
    if (phase.name !== "open") throw new Error("not open");
    const reply = (await post("/api/user/register", { label: phase.label, result })) as {
      reason?: unknown;
    } | null;
    const registered = readRegistered(reply);
    answer.current = { registered, reason: reply?.reason ?? null };
    if (registered === null) throw new Error("not registered");
  }

  function done() {
    const { registered, reason } = answer.current;
    if (registered) setPhase({ name: "registered", ...registered });
    else if (reason === "taken" && phase.name === "open")
      setPhase({ name: "taken", label: phase.label });
    else setPhase({ name: "denied" });
  }

  function failed() {
    done();
  }

  function closed(open: boolean) {
    if (!open) setPhase((now) => (now.name === "open" ? { name: "denied" } : now));
  }

  return (
    <>
      {phase.name === "registered" ? (
        <>
          <p className="state good" role="status">
            Your name is <span className="mono">{phase.held}</span>
          </p>
          {phase.ens === "done" ? (
            <p className="state good">The name is on chain.</p>
          ) : late ? (
            <p className="state">
              The name is still being created on chain. It can take a few minutes; look again later.
            </p>
          ) : (
            <p className="state" aria-live="polite">
              The name is being created on chain. This takes up to a minute…
            </p>
          )}
          <p className="soft">
            <a href={`/api/user/${phase.label}`}>Your photos</a>
          </p>
          {toApp && (
            <div className="actions">
              <a className="button" href={joinLink(toApp, "joined", phase.label)}>
                Back to the app
              </a>
            </div>
          )}
        </>
      ) : phase.name === "not-set-up" ? (
        <p className="state" role="status">
          World ID is not set up on this server yet.
        </p>
      ) : (
        <>
          <label className="field">
            <span>Your name (3 to 20 lowercase letters, digits and dashes)</span>
            <input
              type="text"
              name="label"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={20}
              placeholder="yourname"
              value={given}
              onChange={(event) => setGiven(event.target.value.toLowerCase())}
              disabled={phase.name === "asking" || phase.name === "open"}
              aria-invalid={problem !== null}
            />
          </label>
          <p className={problem ? "state bad" : "soft"} aria-live="polite">
            {problem ?? (label ? `${label}.users.${root}` : `yourname.users.${root}`)}
          </p>
          {phase.name === "taken" && (
            <p className="state bad" role="status">
              {phase.label}.users.{root} is taken. Try another name.
            </p>
          )}
          {phase.name === "denied" && (
            <p className="state bad" role="status">
              Human: not verified.
            </p>
          )}
          <button
            type="button"
            onClick={start}
            disabled={
              label === "" || problem !== null || phase.name === "asking" || phase.name === "open"
            }
          >
            Take this name with World ID
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
              ? proofOfHuman({ signal: phase.signal })
              : selfieCheck({ signal: phase.signal })
          }
          handleVerify={check}
          onSuccess={done}
          onError={failed}
        />
      )}

      {toApp && phase.name !== "registered" && (
        <p className="soft">
          <a href={joinLink(toApp, "cancelled")}>Back to the app</a>
        </p>
      )}
    </>
  );
}
