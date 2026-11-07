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
import { useWallets, walletSentence, type Provider, type Wallet } from "@/lib/wallets";
import { Members } from "./members";
import { Site } from "./site";

const NO_WALLET =
  "No wallet found in this browser. In Brave, open Settings, Web3, and set the default Ethereum wallet to Brave Wallet, then reload.";
const LOCKED = "Unlock the wallet and try again.";

function transport(provider: Provider) {
  return custom(provider as unknown as EIP1193Provider);
}

function readChainId(value: unknown): number | null {
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return Number.parseInt(value, 16);
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return null;
}

function firstAccount(value: unknown): Address | null {
  const first = Array.isArray(value) ? value[0] : undefined;
  return typeof first === "string" && isAddress(first) ? getAddress(first) : null;
}

function chainWords(chainId: number): string {
  return chainId === 1 ? "Ethereum mainnet" : `chain ${chainId}`;
}

type Config = { desk: string; bot: Address | null; chainId: number };

type Read =
  | { name: "reading" }
  | { name: "read"; plan: Plan; steps: Record<StepId, { state: StepState; reason: string | null }> }
  | { name: "not-a-desk" }
  | { name: "unreachable" };

export type Sent = { hash: Hex; state: "sent" | "confirmed" | "failed"; block: bigint | null };

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

export function explorer(chainId: number, hash: Hex): string | null {
  return chainId === 1 ? `https://etherscan.io/tx/${hash}` : null;
}

export function short(value: string): string {
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
  const { wallets, looked } = useWallets();
  const [chosen, setChosen] = useState<Wallet | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);

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

  useEffect(() => {
    const provider = chosen?.provider;
    if (!provider?.on) return;
    const onAccounts = (value: unknown) => setAccount(firstAccount(value));
    const onChain = (value: unknown) => setChainId(readChainId(value));
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, [chosen]);

  async function connect(wallet: Wallet) {
    setSentence(null);
    setBusy(true);
    try {
      const accounts = await wallet.provider.request({ method: "eth_requestAccounts" });
      const first = firstAccount(accounts);
      if (!first) {
        setSentence(LOCKED);
        return;
      }
      const chain = readChainId(await wallet.provider.request({ method: "eth_chainId" }));
      setChosen(wallet);
      setAccount(first);
      setChainId(chain);
    } catch (error) {
      setSentence(walletSentence(error) ?? "The wallet did not connect.");
    } finally {
      setBusy(false);
    }
  }

  /** Asks the chosen wallet to move to the desk's chain. Gives back whether it is there now. */
  async function switchChain(provider: Provider, want: number): Promise<boolean> {
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${want.toString(16)}` }],
      });
      const now = readChainId(await provider.request({ method: "eth_chainId" }));
      setChainId(now);
      if (now === want) return true;
    } catch (error) {
      const known = walletSentence(error);
      if (known) {
        setSentence(known);
        return false;
      }
    }
    setSentence(`Switch the wallet to ${chainWords(want)}, then try again.`);
    return false;
  }

  async function onSwitch() {
    if (!chosen || typeof config !== "object" || !config) return;
    setSentence(null);
    setBusy(true);
    try {
      await switchChain(chosen.provider, config.chainId);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Sends one transaction from the chosen wallet, on the desk's chain, and follows it to its
   * block. Gives back whether it went through.
   */
  async function sendFromWallet(
    tx: { to: Address; data: Hex },
    track: (sent: Sent) => void,
  ): Promise<boolean> {
    const provider = chosen?.provider;
    if (!provider || !account || typeof config !== "object" || !config) return false;
    let now: number | null;
    try {
      now = readChainId(await provider.request({ method: "eth_chainId" }));
    } catch (error) {
      setSentence(walletSentence(error) ?? "The wallet cannot be reached. Try again.");
      return false;
    }
    setChainId(now);
    if (now !== config.chainId && !(await switchChain(provider, config.chainId))) return false;
    const wallet = createWalletClient({ transport: transport(provider) });
    let hash: Hex;
    try {
      hash = await wallet.sendTransaction({ account, chain: null, to: tx.to, data: tx.data });
    } catch (error) {
      setSentence(walletSentence(error) ?? "The transaction was not sent.");
      return false;
    }
    track({ hash, state: "sent", block: null });
    const reader = createPublicClient({ transport: transport(provider) });
    const receipt = await reader.waitForTransactionReceipt({ hash }).catch(() => null);
    const state = receipt?.status === "success" ? "confirmed" : "failed";
    track({ hash, state, block: receipt?.blockNumber ?? null });
    if (state === "failed") setSentence("The transaction did not go through.");
    return state === "confirmed";
  }

  async function send(id: StepId) {
    if (!chosen || !account || typeof config !== "object" || !config) return;
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
      await sendFromWallet(tx, (mine) => setSent((was) => ({ ...was, [id]: mine })));
      await refresh(config);
    } finally {
      setBusy(false);
    }
  }

  /** Sends the site's transactions one after the other, as long as each goes through. */
  async function sendSite(
    txs: { to: Address; data: Hex }[],
    track: (index: number, sent: Sent) => void,
  ): Promise<void> {
    setSentence(null);
    setBusy(true);
    try {
      for (const [index, tx] of txs.entries()) {
        if (!(await sendFromWallet(tx, (mine) => track(index, mine)))) return;
      }
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
        <dd className="mono">
          {account ? (chosen ? `${account} (${chosen.info.name})` : account) : "Not connected"}
        </dd>
      </dl>

      {!account &&
        (wallets.length === 0 ? (
          looked && <p className="state bad">{NO_WALLET}</p>
        ) : (
          <div className="actions">
            {wallets.map((wallet) => (
              <button
                type="button"
                key={wallet.info.uuid}
                className="wallet"
                onClick={() => connect(wallet)}
                disabled={busy}
              >
                {wallets.length > 1 && wallet.info.icon && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={wallet.info.icon} alt="" width={20} height={20} />
                )}
                {wallets.length === 1 ? `Connect ${wallet.info.name}` : wallet.info.name}
              </button>
            ))}
          </div>
        ))}
      {account && chainId !== null && chainId !== config.chainId && (
        <div className="actions">
          <p className="state bad">This wallet is on {chainWords(chainId)}, not {chainWords(config.chainId)}.</p>
          <button type="button" onClick={onSwitch} disabled={busy}>
            Switch to {chainWords(config.chainId)}
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

      <Site
        account={account}
        chainId={config.chainId}
        busy={busy}
        connected={chosen !== null}
        send={sendSite}
      />

      <Members desk={config.desk} />
    </>
  );
}
