"use client";

import { useCallback, useEffect, useState } from "react";
import { getAddress, isAddress, isAddressEqual, isHex, type Address, type Hex } from "viem";
import { buildSite, readRef, siteUrl } from "@/lib/site";
import { explorer, short, type Sent } from "./desk";

type Reading =
  | { name: "reading" }
  | {
      name: "read";
      root: string;
      holder: Address;
      resolver: Address;
      served: boolean;
      ref: string | null;
      url: string | null;
      multicall: boolean;
      holderMaySet: boolean;
    }
  | { name: "unreachable" };

function readAnswer(answer: unknown): Reading {
  const a = answer as Record<string, unknown> | null;
  const address = (value: unknown) =>
    typeof value === "string" && isAddress(value) ? getAddress(value) : null;
  if (a?.state !== "read" || typeof a.root !== "string") return { name: "unreachable" };
  const holder = address(a.holder);
  const resolver = address(a.resolver);
  const registryResolver = address(a.registryResolver);
  if (!holder || !resolver || !registryResolver) return { name: "unreachable" };
  return {
    name: "read",
    root: a.root,
    holder,
    resolver,
    served: isAddressEqual(resolver, registryResolver),
    ref: readRef(a.ref),
    url: typeof a.url === "string" ? a.url : null,
    multicall: a.multicall === true,
    holderMaySet: a.holderMaySet === true,
  };
}

/**
 * The root name's site: which Swarm page https://<root>.limo opens, and a button that points the
 * root at another page from the wallet that holds it. The server builds the transactions; this
 * page builds them again from the reading and sends only when both agree.
 */
export function Site(props: {
  account: Address | null;
  chainId: number;
  busy: boolean;
  connected: boolean;
  send(txs: { to: Address; data: Hex }[], track: (index: number, sent: Sent) => void): Promise<void>;
}) {
  const [reading, setReading] = useState<Reading>({ name: "reading" });
  const [field, setField] = useState("");
  const [sent, setSent] = useState<Sent[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const answer = await fetch("/api/desk/site", { cache: "no-store" })
      .then((response) => response.json())
      .catch(() => null);
    const now = readAnswer(answer);
    setReading(now);
    return now;
  }, []);

  useEffect(() => {
    let live = true;
    fetch("/api/desk/site", { cache: "no-store" })
      .then((response) => response.json())
      .catch(() => null)
      .then((answer) => {
        if (!live) return;
        const now = readAnswer(answer);
        setReading(now);
        if (now.name === "read" && now.ref) setField(now.ref);
      });
    return () => {
      live = false;
    };
  }, []);

  async function point() {
    if (reading.name !== "read") return;
    setProblem(null);
    const ref = readRef(field);
    if (!ref) {
      setProblem("The Swarm reference is 64 hex characters.");
      return;
    }
    const answer = (await fetch("/api/desk/site", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref }),
    })
      .then((response) => response.json())
      .catch(() => null)) as { state?: unknown; txs?: unknown } | null;
    if (answer?.state !== "ready" || !Array.isArray(answer.txs)) {
      setProblem("The server could not prepare the transaction. Try again.");
      return;
    }
    const mine = buildSite({
      root: reading.root,
      resolver: reading.resolver,
      ref,
      multicall: reading.multicall,
    });
    const theirs = answer.txs as { to?: unknown; data?: unknown; value?: unknown }[];
    const same =
      theirs.length === mine.length &&
      theirs.every(
        (tx, i) =>
          typeof tx.to === "string" &&
          isAddress(tx.to) &&
          isAddressEqual(tx.to, mine[i].to) &&
          isHex(tx.data) &&
          tx.data.toLowerCase() === mine[i].data.toLowerCase() &&
          tx.value === "0",
      );
    if (!same) {
      setProblem("The server's transaction is not the one this page expects. Nothing was sent.");
      return;
    }
    setSent([]);
    await props.send(mine, (index, now) =>
      setSent((was) => {
        const next = [...was];
        next[index] = now;
        return next;
      }),
    );
    await refresh();
  }

  const isHolder =
    reading.name === "read" && props.account !== null && isAddressEqual(reading.holder, props.account);

  return (
    <section className="others" aria-live="polite">
      <h2>Site</h2>
      {reading.name === "reading" ? (
        <p className="soft">Reading the chain…</p>
      ) : reading.name === "unreachable" ? (
        <p className="state bad">The chain cannot be read just now. Try again later.</p>
      ) : (
        <>
          <dl className="seal">
            <dt>Name</dt>
            <dd>{reading.root}</dd>
            <dt>Resolver</dt>
            <dd className="mono">{reading.resolver}</dd>
            <dt>Page</dt>
            <dd className="mono">
              {reading.ref ? (
                <a href={siteUrl(reading.ref)} target="_blank" rel="noreferrer">
                  {short(reading.ref)}
                </a>
              ) : (
                "None"
              )}
            </dd>
            <dt>Link</dt>
            <dd className="mono">{reading.url ?? "None"}</dd>
          </dl>
          {!reading.served && (
            <p className="state bad">
              The resolver set on {reading.root} is not the one that answers for it.
            </p>
          )}
          {!reading.holderMaySet && (
            <p className="state bad">
              The holder of {reading.root} may not write these records on its resolver.
            </p>
          )}
          {props.account && !isHolder && (
            <p className="state bad">This wallet does not hold {reading.root}.</p>
          )}
          <label className="field">
            <span>Swarm reference</span>
            <input
              type="text"
              className="mono"
              autoCapitalize="none"
              value={field}
              onChange={(event) => setField(event.target.value)}
              placeholder="64 hex characters"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          {isHolder && reading.holderMaySet && (
            <div className="actions">
              <button type="button" onClick={point} disabled={props.busy || !props.connected}>
                Point {reading.root} at this page
              </button>
            </div>
          )}
          {problem && (
            <p className="state bad" role="status">
              {problem}
            </p>
          )}
          {sent.map((mine, i) => {
            const link = explorer(props.chainId, mine.hash);
            return (
              <p className="mono" key={mine.hash ?? i}>
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
            );
          })}
          <p className="soft">
            Then open{" "}
            <a href={`https://${reading.root}.limo`} target="_blank" rel="noreferrer">
              https://{reading.root}.limo
            </a>{" "}
            (the first open can take a minute)
          </p>
        </>
      )}
    </section>
  );
}
