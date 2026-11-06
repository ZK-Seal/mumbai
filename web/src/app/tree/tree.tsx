"use client";

import { useCallback, useEffect, useState } from "react";

type Step = { id: string; title: string; fn: string; state: "done" | "not-done" | "blocked" };

type Branch = { name: string; registry: string; registered: boolean; deployed: boolean; placed: boolean };

type Status = {
  state: "ready" | "partial" | "not-configured" | "unreachable";
  root: string | null;
  bot: string | null;
  botBalance: string | null;
  owner: string | null;
  rootRegistry: string | null;
  resolver: { address: string; deployed: boolean; botWrites: boolean } | null;
  users: Branch | null;
  events: Branch | null;
  steps: Step[];
  gasPrice: string | null;
  setupCostLeft: string | null;
  writeCost: { user: string; firstImage: string; image: string; eventPage: string } | null;
};

const SAID: Record<string, string> = {
  done: "The tree is built.",
  word: "The admin word is not right.",
  "not-set-up": "This server cannot build the tree, or a branch points somewhere else.",
  funds: "The bot has too little ETH to pay for this.",
  chain: "The chain did not take it. Read the status and try again.",
  taken: "Something is in the way on the chain.",
};

function eth(value: string | null): string {
  if (value === null) return "…";
  const n = Number(value);
  return `${n < 0.0001 && n > 0 ? n.toExponential(2) : n.toFixed(6)} ETH`;
}

function branchWords(branch: Branch | null) {
  if (!branch) return "…";
  const parts = [
    branch.deployed ? "registry deployed" : "no registry yet",
    branch.registered ? "name registered" : "name not registered",
    branch.placed ? "placed" : "not placed",
  ];
  return parts.join(", ");
}

export function TreeSetup() {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/tree/status", { cache: "no-store" });
      setStatus((await response.json()) as Status);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    let live = true;
    fetch("/api/tree/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((answer) => {
        if (live) setStatus(answer as Status);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  async function build(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaid(null);
    try {
      const response = await fetch("/api/tree/setup", {
        method: "POST",
        headers: { "x-desk-word": word },
      });
      const answer = (await response.json().catch(() => null)) as {
        state?: string;
        reason?: string;
      } | null;
      const key = answer?.state === "done" ? "done" : (answer?.reason ?? "chain");
      setSaid(key);
    } catch {
      setSaid("chain");
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  if (failed) return <p className="state bad">The status cannot be read just now.</p>;
  if (status === null) return <p className="soft">Reading the tree…</p>;
  if (status.state === "not-configured") {
    return <p className="state bad">This server has no tree set up: it needs a root name and a bot.</p>;
  }
  if (status.state === "unreachable") {
    return <p className="state bad">The chain cannot be read just now. Try again later.</p>;
  }

  return (
    <>
      <dl className="seal">
        <dt>Root</dt>
        <dd className="mono">{status.root}</dd>
        <dt>Owner</dt>
        <dd className="mono">{status.owner}</dd>
        <dt>Bot</dt>
        <dd className="mono">{status.bot}</dd>
        <dt>Bot balance</dt>
        <dd className="mono">{eth(status.botBalance)}</dd>
        <dt>Resolver</dt>
        <dd className="mono">
          {status.resolver?.address}
          {status.resolver && !status.resolver.deployed ? " (not deployed yet)" : ""}
        </dd>
        <dt>{status.users?.name ?? "users"}</dt>
        <dd className="mono">{branchWords(status.users)}</dd>
        <dt>{status.events?.name ?? "events"}</dt>
        <dd className="mono">{branchWords(status.events)}</dd>
        <dt>Gas price</dt>
        <dd className="mono">{status.gasPrice ? `${Number(status.gasPrice).toFixed(3)} gwei` : "…"}</dd>
        <dt>Setup left</dt>
        <dd className="mono">{eth(status.setupCostLeft)}</dd>
        {status.writeCost && (
          <>
            <dt>Each write</dt>
            <dd className="mono">
              person {eth(status.writeCost.user)}, first picture of an event{" "}
              {eth(status.writeCost.firstImage)}, later picture {eth(status.writeCost.image)},
              event page {eth(status.writeCost.eventPage)}
            </dd>
          </>
        )}
      </dl>

      <section className="others" aria-live="polite">
        <h2>{status.state === "ready" ? "The tree is built" : "Building the tree"}</h2>
        <ol className="steps">
          {status.steps.map((step) => (
            <li key={step.id}>
              <div className="step-head">
                <strong>{step.title}</strong>
                <span className={step.state === "done" ? "state good" : "soft"}>
                  {step.state === "done" ? "Done" : step.state === "blocked" ? "Blocked" : "To do"}
                </span>
              </div>
              <p className="mono soft">{step.fn}</p>
            </li>
          ))}
        </ol>

        {status.state !== "ready" && (
          <form className="add" onSubmit={build}>
            <label className="field">
              <span>Admin word</span>
              <input
                type="password"
                autoComplete="off"
                value={word}
                onChange={(event) => setWord(event.target.value)}
              />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? "Waiting for the chain…" : "Set up"}
            </button>
          </form>
        )}
        {said && (
          <p className={said === "done" ? "state good" : "state bad"} role="status">
            {SAID[said] ?? SAID.chain}
          </p>
        )}
      </section>
    </>
  );
}
