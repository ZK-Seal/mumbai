"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  isAddress,
  isAddressEqual,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import {
  buildStep,
  planFor,
  STEPS,
  type Plan,
  type StepId,
  type StepState,
} from "@/lib/desk-setup";
import { Members } from "./members";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

type Config = { desk: string; bot: Address | null; chainId: number };

type Read =
  | { name: "reading" }
  | { name: "read"; plan: Plan; steps: Record<StepId, { state: StepState; reason: string | null }> }
  | { name: "not-a-desk" }
  | { name: "unreachable" };

type Sent = { hash: Hex; state: "sent" | "confirmed" | "failed"; block: bigint | null };

function readConfig(answer: unknown): Config | null {
  const a = answer as { desk?: unknown; bot?: unknown; chainId?: unknown } | null;
  if (typeof a?.desk !== "string" || a.desk === "") return null;
  if (!Number.isSafeInteger(a.chainId)) return null;
  const bot = typeof a.bot === "string" && isAddress(a.bot) ? getAddress(a.bot) : null;
  return { desk: a.desk, bot, chainId: a.chainId as number };
}

/**
 * Takes the server's reading apart and builds the plan again here from what the chain said about
 * the desk's name, so the addresses this page sends to are worked out on this page.
 */
function readSetup(answer: unknown, config: Config): Read {
  const a = answer as { state?: unknown; plan?: Record<string, unknown>; steps?: unknown } | null;
  if (a?.state === "not-a-desk") return { name: "not-a-desk" };
  if (a?.state !== "read" || !a.plan || !Array.isArray(a.steps)) return { name: "unreachable" };
  const p = a.plan;
  const address = (value: unknown) =>
    typeof value === "string" && isAddress(value) ? getAddress(value) : null;
  const parent = address(p.parent);
  const owner = address(p.owner);
  const deskResolver = address(p.deskResolver);
  if (!parent || !owner || !deskResolver) return { name: "unreachable" };
  if (typeof p.label !== "string" || typeof p.expiry !== "string" || !/^[0-9]+$/.test(p.expiry)) {
    return { name: "unreachable" };
  }
  const plan = planFor({
    desk: config.desk,
    parent,
    label: p.label,
    owner,
    expiry: BigInt(p.expiry),
    deskResolver,
    bot: config.bot,
  });
  const steps = {} as Record<StepId, { state: StepState; reason: string | null }>;
  for (const step of STEPS) {
    const found = (a.steps as { id?: unknown; state?: unknown; reason?: unknown }[]).find(
      (item) => item?.id === step.id,
    );
    const state =
      found?.state === "done" || found?.state === "not-done" || found?.state === "blocked"
        ? found.state
        : "blocked";
    const reason = typeof found?.reason === "string" ? found.reason : null;
    steps[step.id] = { state, reason };
  }
  return { name: "read", plan, steps };
}

function explorer(chainId: number, hash: Hex): string | null {
  return chainId === 1 ? `https://etherscan.io/tx/${hash}` : null;
}

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

const STATE_WORDS: Record<StepState, string> = {
  done: "Done",
  "not-done": "Not done",
  blocked: "Not yet",
};

export function Desk() {
  const [config, setConfig] = useState<Config | null | "unknown">(null);
  const [read, setRead] = useState<Read>({ name: "reading" });
  const [account, setAccount] = useState<Address | null>(null);
  const [sent, setSent] = useState<Partial<Record<StepId, Sent>>>({});
  const [busy, setBusy] = useState(false);
  const [sentence, setSentence] = useState<string | null>(null);

  const refresh = useCallback(async (now: Config) => {
    const answer = await fetch("/api/desk/setup", { cache: "no-store" })
      .then((response) => response.json())
      .catch(() => null);
    setRead(readSetup(answer, now));
  }, []);

  useEffect(() => {
    let live = true;
    fetch("/api/desk/config", { cache: "no-store" })
      .then((response) => response.json())
      .catch(() => null)
      .then((answer) => {
        if (!live) return;
        const found = readConfig(answer);
        setConfig(found ?? "unknown");
        if (found) void refresh(found);
      });
    return () => {
      live = false;
    };
  }, [refresh]);

  async function connect() {
    setSentence(null);
    if (!window.ethereum) {
      setSentence("No browser wallet was found.");
      return;
    }
    try {
      const wallet = createWalletClient({ transport: custom(window.ethereum) });
      const [first] = await wallet.requestAddresses();
      setAccount(first ? getAddress(first) : null);
    } catch {
      setSentence("The wallet did not connect.");
    }
  }

  async function send(id: StepId) {
    if (!window.ethereum || !account || typeof config !== "object" || !config) return;
    if (read.name !== "read") return;
    setSentence(null);
    let tx;
    try {
      tx = buildStep(id, read.plan);
    } catch {
      setSentence("This step cannot be sent for this desk.");
      return;
    }
    setBusy(true);
    try {
      const wallet = createWalletClient({ transport: custom(window.ethereum) });
      const chainId = await wallet.getChainId();
      if (chainId !== config.chainId) {
        setSentence(
          config.chainId === 1
            ? "Switch the wallet to Ethereum mainnet, then try again."
            : `Switch the wallet to chain ${config.chainId}, then try again.`,
        );
        return;
      }
      let hash: Hex;
      try {
        hash = await wallet.sendTransaction({ account, chain: null, to: tx.to, data: tx.data });
      } catch {
        setSentence("The transaction was not sent.");
        return;
      }
      setSent((now) => ({ ...now, [id]: { hash, state: "sent", block: null } }));
      const reader = createPublicClient({ transport: custom(window.ethereum) });
      const receipt = await reader.waitForTransactionReceipt({ hash }).catch(() => null);
      const state = receipt?.status === "success" ? "confirmed" : "failed";
      setSent((now) => ({ ...now, [id]: { hash, state, block: receipt?.blockNumber ?? null } }));
      if (state === "failed") setSentence("The transaction did not go through.");
      await refresh(config);
    } finally {
      setBusy(false);
    }
  }

  if (config === null) return <p className="soft">Reading the desk…</p>;
  if (config === "unknown") {
    return <p className="state bad">This server has no desk set up.</p>;
  }

  const plan = read.name === "read" ? read.plan : null;
  const isOwner = plan !== null && account !== null && isAddressEqual(plan.owner, account);

  return (
    <>
      <dl className="seal">
        <dt>Desk</dt>
        <dd>{config.desk}</dd>
        <dt>Holder</dt>
        <dd className="mono">{plan ? plan.owner : "…"}</dd>
        <dt>Bot</dt>
        <dd className="mono">{config.bot ?? "None on this server"}</dd>
        <dt>Wallet</dt>
        <dd className="mono">{account ?? "Not connected"}</dd>
      </dl>

      {!account && (
        <div className="actions">
          <button type="button" onClick={connect}>
            Connect wallet
          </button>
        </div>
      )}
      {sentence && (
        <p className="state bad" role="status">
          {sentence}
        </p>
      )}

      <section className="others" aria-live="polite">
        <h2>Setting up the member list</h2>
        {read.name === "reading" ? (
          <p className="soft">Reading the chain…</p>
        ) : read.name === "not-a-desk" ? (
          <p className="state bad">{config.desk} is not a registered name.</p>
        ) : read.name === "unreachable" ? (
          <p className="state bad">The chain cannot be read just now. Try again later.</p>
        ) : (
          <>
            {account && !isOwner && (
              <p className="state bad">
                This wallet does not hold {config.desk}, so the steps are shown read-only.
              </p>
            )}
            <ol className="steps">
              {STEPS.map((step) => {
                const now = read.steps[step.id];
                const mine = sent[step.id];
                const link = mine ? explorer(config.chainId, mine.hash) : null;
                return (
                  <li key={step.id}>
                    <div className="step-head">
                      <strong>{step.title}</strong>
                      <span className={now.state === "done" ? "state good" : "soft"}>
                        {STATE_WORDS[now.state]}
                      </span>
                    </div>
                    <p className="soft">{step.purpose}</p>
                    <p className="mono soft">{step.fn}</p>
                    {now.reason && <p className="soft">{now.reason}</p>}
                    {mine && (
                      <p className="mono">
                        {link ? (
                          <a href={link} target="_blank" rel="noreferrer">
                            {short(mine.hash)}
                          </a>
                        ) : (
                          <span title={mine.hash}>{short(mine.hash)}</span>
                        )}{" "}
                        {mine.state === "sent"
                          ? "sent, waiting for a block"
                          : mine.state === "confirmed"
                            ? `in block ${mine.block}`
                            : "did not go through"}
                      </p>
                    )}
                    {isOwner && now.state === "not-done" && (
                      <button type="button" onClick={() => send(step.id)} disabled={busy}>
                        Send this step
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </section>

      <Members desk={config.desk} />
    </>
  );
}
