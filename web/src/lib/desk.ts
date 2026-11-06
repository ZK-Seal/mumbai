import { createHash, timingSafeEqual } from "node:crypto";
import {
  BaseError,
  createWalletClient,
  http,
  InsufficientFundsError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import {
  buildRecords,
  buildRegister,
  buildUnregister,
  memberListAbi,
  readSetup,
  type Plan,
  type Tx,
} from "@/lib/desk-setup";
import { DEFAULT_RPC, labelHash, memberName, readName, registryAbi, REGISTERED } from "@/lib/ens";
import { isAccount, isPass } from "@/lib/records";

/** The desk bot's key: DESK_BOT_KEY, when it is a well formed key. Never leaves the server. */
export function botKey(): Hex | null {
  const key = process.env.DESK_BOT_KEY ?? "";
  return /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as Hex) : null;
}

/** The desk bot's address, derived from its key. Null when no bot is set up. */
export function botAddress(): Address | null {
  const key = botKey();
  return key ? privateKeyToAccount(key).address : null;
}

function isLocalRpc(): boolean {
  try {
    const host = new URL(process.env.ETH_RPC_URL ?? "").hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * The chain the desk's wallet must be on: Ethereum mainnet. DESK_CHAIN_ID may name another chain
 * only while ETH_RPC_URL points at this machine, which is how a local fork is tried out.
 */
export function deskChainId(): number {
  const override = Number(process.env.DESK_CHAIN_ID);
  return Number.isSafeInteger(override) && override > 0 && isLocalRpc() ? override : 1;
}

/**
 * Whether a request carries the desk's admin word, compared in constant time. Always false when
 * DESK_ADMIN_WORD is not set, so the routes that need it refuse everyone.
 */
export function adminWordMatches(given: string | null): boolean {
  const word = process.env.DESK_ADMIN_WORD ?? "";
  if (word === "" || given === null) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(word).digest();
  return timingSafeEqual(a, b);
}

/** What the bot answered. Every answer is one word from this list. */
export type BotWord =
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
  | "failed";

// One bot, one nonce: its transactions are sent one after another, never side by side. The tree's
// writes take their turn in the same queue.
let queue: Promise<unknown> = Promise.resolve();

export function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

function isFundsError(error: unknown): boolean {
  return (
    error instanceof BaseError && error.walk((e) => e instanceof InsufficientFundsError) !== null
  );
}

/**
 * Reads the desk's setup and checks the bot can act: every one of the seven steps is done. Gives
 * the plan, or the word to answer with.
 */
async function readyPlan(client: PublicClient, desk: string): Promise<Plan | BotWord> {
  const setup = await readSetup(client, desk, botAddress());
  if (setup === "unreachable") return "unreachable";
  if (setup === "not-a-desk") return "desk-not-ready";
  return setup.steps.every((step) => step.state === "done") ? setup.plan : "desk-not-ready";
}

async function status(client: PublicClient, plan: Plan, label: string) {
  return client.readContract({
    address: plan.registry,
    abi: registryAbi,
    functionName: "getStatus",
    args: [labelHash(label)],
  });
}

/**
 * Sends the bot's transactions in order and waits for each. Before the first is sent, the whole
 * cost is estimated and checked against the bot's balance, so a bot that cannot pay for all of
 * them sends none.
 */
async function sendAll(client: PublicClient, txs: Tx[]): Promise<BotWord | null> {
  const key = botKey();
  if (!key) return "desk-not-ready";
  const account = privateKeyToAccount(key);
  const chain = { ...mainnet, id: deskChainId() };
  const wallet = createWalletClient({
    account,
    chain,
    transport: http(process.env.ETH_RPC_URL || DEFAULT_RPC, { timeout: 30000, retryCount: 1 }),
  });
  try {
    const [fees, balance, ...gas] = await Promise.all([
      client.estimateFeesPerGas(),
      client.getBalance({ address: account.address }),
      ...txs.map((tx) =>
        client.estimateGas({ account: account.address, to: tx.to, data: tx.data }),
      ),
    ]);
    const cost = gas.reduce((sum, g) => sum + g, BigInt(0)) * fees.maxFeePerGas;
    if (balance < cost) return "bot-unfunded";
    for (const [i, tx] of txs.entries()) {
      const hash = await wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        gas: (gas[i] * BigInt(12)) / BigInt(10),
      });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180000 });
      if (receipt.status !== "success") return "failed";
    }
    return null;
  } catch (error) {
    return isFundsError(error) ? "bot-unfunded" : "failed";
  }
}

/**
 * Adds a reporter to the desk: writes the name's two records on the members resolver, then
 * registers the label in the member list. The records go first, so the name is never a member
 * without them.
 */
export function addReporter(
  client: PublicClient,
  desk: string,
  input: { label?: unknown; pass?: unknown; account?: unknown },
): Promise<BotWord> {
  const asked = typeof input.label === "string" ? memberName(`${input.label}.${desk}`, desk) : null;
  if (!asked) return Promise.resolve("label");
  if (!isPass(input.pass)) return Promise.resolve("pass");
  const account =
    input.account === undefined || input.account === null || input.account === ""
      ? null
      : input.account;
  if (account !== null && !isAccount(account)) return Promise.resolve("account");
  const pass = input.pass;
  return inTurn(async () => {
    const plan = await readyPlan(client, desk);
    if (typeof plan === "string") return plan;
    let now: number;
    try {
      now = await status(client, plan, asked.label);
    } catch {
      return "unreachable";
    }
    if (now !== 0) return "taken";
    const word = await sendAll(client, [
      buildRecords(plan, asked.name, pass, account),
      buildRegister(plan, asked.label),
    ]);
    if (word) return word;
    remember(plan.registry, asked.label);
    return "added";
  });
}

/** Removes a reporter from the desk's member list. Their records then no longer resolve. */
export function removeReporter(
  client: PublicClient,
  desk: string,
  input: { label?: unknown },
): Promise<BotWord> {
  const asked = typeof input.label === "string" ? memberName(`${input.label}.${desk}`, desk) : null;
  if (!asked) return Promise.resolve("label");
  return inTurn(async () => {
    const plan = await readyPlan(client, desk);
    if (typeof plan === "string") return plan;
    let now: number;
    try {
      now = await status(client, plan, asked.label);
    } catch {
      return "unreachable";
    }
    if (now !== REGISTERED) return "not-a-member";
    const word = await sendAll(client, [buildUnregister(plan, asked.label)]);
    return word ?? "removed";
  });
}

/**
 * The first block a member list can have been written in: when the factory that deploys them
 * appeared. DESK_FROM_BLOCK may move it later, to the block the desk's member list was deployed
 * in, so a node that keeps only recent logs can still list the members.
 */
const FIRST_BLOCK = BigInt(26105299);
const LOG_SPAN = BigInt(5000);

function fromBlock(): bigint {
  const value = process.env.DESK_FROM_BLOCK ?? "";
  return /^[0-9]{1,12}$/.test(value) && BigInt(value) > FIRST_BLOCK ? BigInt(value) : FIRST_BLOCK;
}

/** Every label each member list was seen to register, and how far its logs were read. */
const seen = new Map<Address, { labels: Set<string>; next: bigint }>();

function remember(registry: Address, label: string) {
  const known = seen.get(registry);
  if (known) known.labels.add(label);
}

export type Member = { name: string; label: string; pass: string | null; account: string | null };

/**
 * The desk's current members. Every label the member list ever registered is found in its logs;
 * each is then asked of the chain, and only those registered now are listed.
 */
export async function listMembers(
  client: PublicClient,
  desk: string,
): Promise<Member[] | "desk-not-ready" | "unreachable"> {
  const setup = await readSetup(client, desk, botAddress());
  if (setup === "unreachable") return "unreachable";
  if (setup === "not-a-desk" || setup.steps.find((s) => s.id === "attach")?.state !== "done") {
    return "desk-not-ready";
  }
  const { plan } = setup;
  try {
    const known = seen.get(plan.registry) ?? { labels: new Set<string>(), next: fromBlock() };
    const head = await client.getBlockNumber();
    while (known.next <= head) {
      const to =
        known.next + LOG_SPAN - BigInt(1) < head ? known.next + LOG_SPAN - BigInt(1) : head;
      const logs = await client.getContractEvents({
        address: plan.registry,
        abi: memberListAbi,
        eventName: "LabelRegistered",
        fromBlock: known.next,
        toBlock: to,
        strict: true,
      });
      for (const log of logs) if (log.args.label) known.labels.add(log.args.label);
      known.next = to + BigInt(1);
      seen.set(plan.registry, known);
    }
    const members: Member[] = [];
    for (const label of [...known.labels].sort()) {
      const reading = await readName(client, desk, `${label}.${desk}`);
      if (reading.state === "unreachable") return "unreachable";
      if (reading.state === "member" && reading.name) {
        members.push({ name: reading.name, label, pass: reading.pass, account: reading.account });
      }
    }
    return members;
  } catch {
    return "unreachable";
  }
}
