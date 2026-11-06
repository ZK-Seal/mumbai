"use client";

import { useEffect, useRef, useState } from "react";
import { IDKitRequestWidget, proofOfHuman, selfieCheck, type IDKitResult } from "@worldcoin/idkit";
import { joinLink } from "@/lib/app-return";
import { post, readReady, type Ready } from "../authorise/authorise";

/** Where the person's name stands on chain. */
type Ens = "pending" | "done";

type Registered = { held: string; label: string; address: string | null; ens: Ens };

/** An address cut to its first and last characters, as wallets show one. */
function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

type Phase =
  | { name: "idle" }
  | { name: "asking" }
  | { name: "open"; ready: Ready; label: string; signal: string }
  | ({ name: "registered" } & Registered)
  | { name: "taken"; label: string }
  | { name: "refused"; text: string }
  | { name: "denied" }
  | { name: "not-set-up" };

/** How often, and for how long, the page asks whether the name is on chain yet. */
const POLL_MS = 5000;
const POLL_FOR_MS = 120000;

/**
 * Why a label cannot be taken, as far as the page can tell, or null. The server has the whole
 * rule (any one ENS label once normalised, see readUserLabel) and says why when it refuses.
 */
function labelProblem(label: string): string | null {
  if (label.includes(".")) return "No dots: a name is one part.";
  if (/^(0x)?[0-9a-fA-F]{40,}$/.test(label)) return "A wallet address cannot be a name.";
  return null;
}

/** The registered parts of a server answer. Null unless it has a name and a known state. */
function readRegistered(answer: unknown): Registered | null {
  const a = answer as { state?: unknown; name?: unknown; address?: unknown; ens?: unknown } | null;
  if (a?.state !== "registered" || typeof a.name !== "string") return null;
  if (a.name.length > 255 || a.name.indexOf(".") < 1 || /\s/.test(a.name)) return null;
  const ens = a.ens === "done" ? "done" : a.ens === "pending" ? "pending" : null;
  if (ens === null) return null;
  const address =
    typeof a.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(a.address) ? a.address : null;
  return { held: a.name, label: a.name.slice(0, a.name.indexOf(".")), address, ens };
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
    const word = reply as {
      state?: unknown;
      reason?: unknown;
      text?: unknown;
      label?: unknown;
      signal?: unknown;
    } | null;
    // From here on the label is the server's normal form of what was typed.
    const held = typeof word?.label === "string" && word.label !== "" ? word.label : label;
    if (word?.state === "taken") {
      setPhase({ name: "taken", label: held });
      return;
    }
    if (word?.reason === "label" && typeof word.text === "string") {
      setPhase({ name: "refused", text: word.text });
      return;
    }
    if (word?.reason === "not-set-up") {
      setPhase({ name: "not-set-up" });
      return;
    }
    const ready = readReady(reply);
    const signal = `user:${held}`;
    setPhase(
      ready && word?.signal === signal
        ? { name: "open", ready, label: held, signal }
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
          {phase.address && (
            <p className="soft">
              Held by your own address{" "}
              <span className="mono" title={phase.address}>
                {shortAddress(phase.address)}
              </span>
            </p>
          )}
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
            <a href={`/api/user/${encodeURIComponent(phase.label)}`}>Your photos</a>
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
            <span>Your name (any name ENS allows, one part, no spaces)</span>
            <input
              type="text"
              name="label"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={100}
              placeholder="yourname"
              value={given}
              onChange={(event) => {
                setGiven(event.target.value);
                if (phase.name === "refused") setPhase({ name: "idle" });
              }}
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
          {phase.name === "refused" && (
            <p className="state bad" role="status">
              {phase.text}
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
