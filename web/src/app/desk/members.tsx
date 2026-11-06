"use client";

import { useCallback, useEffect, useState } from "react";

type Member = { name: string; label: string; pass: string | null; account: string | null };

type List =
  | { name: "reading" }
  | { name: "listed"; members: Member[] }
  | { name: "desk-not-ready" }
  | { name: "unreachable" };

type Word =
  | "added"
  | "removed"
  | "label"
  | "pass"
  | "account"
  | "taken"
  | "not-a-member"
  | "desk-not-ready"
  | "bot-unfunded"
  | "unreachable"
  | "failed"
  | "word"
  | "not-set-up";

const WORDS: Word[] = [
  "added",
  "removed",
  "label",
  "pass",
  "account",
  "taken",
  "not-a-member",
  "desk-not-ready",
  "bot-unfunded",
  "unreachable",
  "failed",
  "word",
  "not-set-up",
];

function sentence(word: Word, name: string, desk: string): string {
  switch (word) {
    case "added":
      return `${name} is now a member of ${desk}.`;
    case "removed":
      return `${name} is no longer a member of ${desk}.`;
    case "label":
      return `That label cannot be a name under ${desk}.`;
    case "pass":
      return "The pass must be a number, in decimal or 0x hex.";
    case "account":
      return "The account must be 16 lowercase hex characters, or left empty.";
    case "taken":
      return "That name is already taken in the member list.";
    case "not-a-member":
      return "That name is not a member.";
    case "desk-not-ready":
      return "The member list is not set up yet.";
    case "bot-unfunded":
      return "The desk's bot has too little ETH to pay for this.";
    case "unreachable":
      return "The chain cannot be read just now. Try again later.";
    case "failed":
      return "The transaction did not go through.";
    case "word":
      return "The admin word is not right.";
    case "not-set-up":
      return "This server cannot add or remove members.";
  }
}

function readWord(answer: unknown): Word {
  const a = answer as { state?: unknown; reason?: unknown } | null;
  const word = a?.state === "refused" ? a.reason : a?.state;
  return WORDS.find((w) => w === word) ?? "failed";
}

function readList(answer: unknown): List {
  const a = answer as { state?: unknown; members?: unknown } | null;
  if (a?.state === "desk-not-ready") return { name: "desk-not-ready" };
  if (a?.state !== "listed" || !Array.isArray(a.members)) return { name: "unreachable" };
  const members: Member[] = [];
  for (const m of a.members as Partial<Record<keyof Member, unknown>>[]) {
    if (typeof m?.name !== "string" || typeof m.label !== "string") return { name: "unreachable" };
    members.push({
      name: m.name,
      label: m.label,
      pass: typeof m.pass === "string" ? m.pass : null,
      account: typeof m.account === "string" ? m.account : null,
    });
  }
  return { name: "listed", members };
}

function short(value: string): string {
  return value.length <= 24 ? value : `${value.slice(0, 12)}…${value.slice(-8)}`;
}

/** The desk's members, read from the chain, and the form its staff add and remove them with. */
export function Members({ desk }: { desk: string }) {
  const [list, setList] = useState<List>({ name: "reading" });
  const [word, setWord] = useState("");
  const [label, setLabel] = useState("");
  const [pass, setPass] = useState("");
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ word: Word; name: string } | null>(null);

  const refresh = useCallback(async () => {
    const answer = await fetch("/api/desk/members", { cache: "no-store" })
      .then((response) => response.json())
      .catch(() => null);
    setList(readList(answer));
  }, []);

  useEffect(() => {
    let live = true;
    fetch("/api/desk/members", { cache: "no-store" })
      .then((response) => response.json())
      .catch(() => null)
      .then((answer) => {
        if (live) setList(readList(answer));
      });
    return () => {
      live = false;
    };
  }, []);

  async function ask(method: "POST" | "DELETE", body: Record<string, string>, name: string) {
    setBusy(true);
    setSaid(null);
    const answer = await fetch("/api/desk/reporter", {
      method,
      headers: { "content-type": "application/json", "x-desk-word": word },
      body: JSON.stringify(body),
    })
      .then((response) => response.json())
      .catch(() => null);
    const got = readWord(answer);
    setSaid({ word: got, name });
    setBusy(false);
    if (got === "added") {
      setLabel("");
      setPass("");
      setAccount("");
    }
    if (got === "added" || got === "removed") await refresh();
  }

  function add(event: React.FormEvent) {
    event.preventDefault();
    const body: Record<string, string> = { label: label.trim(), pass: pass.trim() };
    if (account.trim() !== "") body.account = account.trim();
    void ask("POST", body, `${label.trim().toLowerCase()}.${desk}`);
  }

  const good = said?.word === "added" || said?.word === "removed";

  return (
    <section className="others" aria-live="polite">
      <h2>Members of {desk}</h2>
      {list.name === "reading" ? (
        <p className="soft">Reading the member list…</p>
      ) : list.name === "desk-not-ready" ? (
        <p className="soft">The member list is not set up yet.</p>
      ) : list.name === "unreachable" ? (
        <p className="soft">The member list cannot be read just now.</p>
      ) : list.members.length === 0 ? (
        <p className="soft">No one is a member yet.</p>
      ) : (
        <ol>
          {list.members.map((member) => (
            <li key={member.label}>
              <span>
                <strong>{member.name}</strong>
                <br />
                <span className="mono soft" title={member.pass ?? undefined}>
                  Pass {member.pass ? short(member.pass) : "none"}
                  {member.account ? `, account ${member.account}` : ""}
                </span>
              </span>
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => ask("DELETE", { label: member.label }, member.name)}
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}

      <form className="add" onSubmit={add}>
        <h2>Add a reporter</h2>
        <label className="field">
          <span>Admin word</span>
          <input
            type="password"
            autoComplete="off"
            value={word}
            onChange={(event) => setWord(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Label (the name will be label.{desk})</span>
          <input
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Pass (their World ID pass)</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            required
            value={pass}
            onChange={(event) => setPass(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Account (optional: their signed-in World account)</span>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={account}
            onChange={(event) => setAccount(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Waiting for the chain…" : "Add"}
        </button>
      </form>
      {said && (
        <p className={good ? "state good" : "state bad"} role="status">
          {sentence(said.word, said.name, desk)}
        </p>
      )}
    </section>
  );
}
