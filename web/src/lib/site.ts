import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  namehash,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { packetToBytes } from "viem/ens";
import { readPlan } from "@/lib/desk-setup";

/**
 * The root name's own site: its contenthash points at a page on Swarm, and its `url` text record
 * at the same page through a gateway, so https://<root>.limo opens that page. Both records sit on
 * the root's own resolver and are written by the wallet that holds the root, never by the bot.
 * Every transaction is built here, by the server and again by the page, and passes `guardSite`.
 */

export const siteResolverAbi = parseAbi([
  "function setContenthash(bytes name, bytes hash)",
  "function setText(bytes name, string key, string value)",
  "function multicall(bytes[] data) returns (bytes[])",
]);

const profileAbi = parseAbi([
  "function text(bytes32 node, string key) view returns (string)",
  "function contenthash(bytes32 node) view returns (bytes)",
]);

const universalAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes, address)",
  "function findResolver(bytes name) view returns (address, bytes32, uint256)",
]);

export const UNIVERSAL_RESOLVER: Address = "0xeeeeeeee14d718c2b47d9923deab1335e144eeee";

/** ENSIP-7 prefix of a Swarm contenthash: swarm-ns, CIDv1, swarm-manifest, keccak-256. */
const SWARM_PREFIX = "0xe40101fa011b20";

export const URL_KEY = "url";

/** A Swarm reference in normal form (64 lowercase hex), or null. Takes a bzz link too. */
export function readRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const link = /^https:\/\/[^/]+\/bzz\/([0-9a-fA-F]{64})\/?$/.exec(text);
  const bare = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(text);
  const hex = link?.[1] ?? bare?.[1];
  return hex ? hex.toLowerCase() : null;
}

export function siteContenthash(ref: string): Hex {
  return `${SWARM_PREFIX}${ref}`;
}

/** The Swarm reference in a contenthash, or null if it is not one. */
export function siteRef(contenthash: Hex | null): string | null {
  if (!contenthash) return null;
  const match = /^0xe40101fa011b20([0-9a-f]{64})$/i.exec(contenthash);
  return match ? match[1].toLowerCase() : null;
}

export function siteUrl(ref: string): string {
  return `https://bzz.limo/bzz/${ref}/`;
}

export type SiteTx = { to: Address; data: Hex; value: bigint; title: string };

function writes(root: string, ref: string): Hex[] {
  const name = toHex(packetToBytes(root));
  return [
    encodeFunctionData({
      abi: siteResolverAbi,
      functionName: "setContenthash",
      args: [name, siteContenthash(ref)],
    }),
    encodeFunctionData({
      abi: siteResolverAbi,
      functionName: "setText",
      args: [name, URL_KEY, siteUrl(ref)],
    }),
  ];
}

/**
 * The holder's transactions that point the root at a Swarm page: one multicall on the root's
 * resolver when it takes one, else the two writes one after the other.
 */
export function buildSite(input: {
  root: string;
  resolver: Address;
  ref: string;
  multicall: boolean;
}): SiteTx[] {
  const ref = readRef(input.ref);
  if (!ref) throw new Error("refused: not a Swarm reference");
  const [hash, url] = writes(input.root, ref);
  const txs: SiteTx[] = input.multicall
    ? [
        {
          to: input.resolver,
          data: encodeFunctionData({
            abi: siteResolverAbi,
            functionName: "multicall",
            args: [[hash, url]],
          }),
          value: BigInt(0),
          title: `Point ${input.root} at the page`,
        },
      ]
    : [
        { to: input.resolver, data: hash, value: BigInt(0), title: `Set the page of ${input.root}` },
        { to: input.resolver, data: url, value: BigInt(0), title: `Set the link of ${input.root}` },
      ];
  for (const tx of txs) guardSite(tx, input.root, input.resolver);
  return txs;
}

/**
 * Refuses anything but the root's own contenthash, as a Swarm page, and its `url` text, on the
 * root's own resolver, with no ETH.
 */
export function guardSite(tx: SiteTx, root: string, resolver: Address): void {
  const refuse = (why: string): never => {
    throw new Error(`refused: ${why}`);
  };
  if (!isAddressEqual(tx.to, resolver)) refuse("not the root's resolver");
  if (tx.value !== BigInt(0)) refuse("value");
  const name = toHex(packetToBytes(root));
  const one = (data: Hex) => {
    const call = decodeFunctionData({ abi: siteResolverAbi, data });
    if (call.functionName === "setContenthash") {
      const [node, hash] = call.args;
      if (node !== name || !siteRef(hash)) refuse("setContenthash");
      return;
    }
    if (call.functionName === "setText") {
      const [node, key, value] = call.args;
      if (node !== name || key !== URL_KEY || !/^https:\/\/bzz\.limo\/bzz\/[0-9a-f]{64}\/$/.test(value)) {
        refuse("setText");
      }
      return;
    }
    refuse("call");
  };
  const call = decodeFunctionData({ abi: siteResolverAbi, data: tx.data });
  if (call.functionName === "multicall") {
    const inner = call.args[0];
    if (inner.length === 0 || inner.length > 2) refuse("multicall");
    inner.forEach(one);
  } else {
    one(tx.data);
  }
}

export type Site = {
  root: string;
  holder: Address;
  /** The resolver the Universal Resolver finds for the root, so the one whose records are served. */
  resolver: Address;
  /** The resolver set on the root in its registry. */
  registryResolver: Address;
  contenthash: Hex | null;
  ref: string | null;
  url: string | null;
  /** Whether the root's resolver takes both writes in one multicall. */
  multicall: boolean;
  /** Whether the holder may write both records: a dry run from the holder's address. */
  holderMaySet: boolean;
};

async function universal(client: PublicClient, root: string, data: Hex): Promise<Hex | null> {
  try {
    const [out] = await client.readContract({
      address: UNIVERSAL_RESOLVER,
      abi: universalAbi,
      functionName: "resolve",
      args: [toHex(packetToBytes(root)), data],
    });
    return out;
  } catch {
    return null;
  }
}

async function dryRun(client: PublicClient, from: Address, to: Address, data: Hex) {
  try {
    await client.call({ account: from, to, data });
    return true;
  } catch {
    return false;
  }
}

/** Whether `from` may point the root at a page, and in one multicall or two writes. */
export async function canSet(
  client: PublicClient,
  root: string,
  resolver: Address,
  from: Address,
): Promise<{ maySet: boolean; multicall: boolean }> {
  const probe = "00".repeat(32);
  const [one] = buildSite({ root, resolver, ref: probe, multicall: true });
  if (await dryRun(client, from, resolver, one.data)) return { maySet: true, multicall: true };
  const two = buildSite({ root, resolver, ref: probe, multicall: false });
  const each = await Promise.all(two.map((tx) => dryRun(client, from, resolver, tx.data)));
  return { maySet: each.every(Boolean), multicall: false };
}

/** Reads the root's site from the chain. Null when the root is not a registered name. */
export async function readSite(client: PublicClient, root: string): Promise<Site | null> {
  const plan = await readPlan(client, root, null);
  if (plan === "not-a-desk") return null;
  if (plan === "unreachable") throw new Error("unreachable");
  const [found] = await client.readContract({
    address: UNIVERSAL_RESOLVER,
    abi: universalAbi,
    functionName: "findResolver",
    args: [toHex(packetToBytes(root))],
  });
  const resolver = found === zeroAddress ? plan.deskResolver : getAddress(found);
  const node = namehash(root);
  const [hashOut, urlOut, can] = await Promise.all([
    universal(
      client,
      root,
      encodeFunctionData({ abi: profileAbi, functionName: "contenthash", args: [node] }),
    ),
    universal(
      client,
      root,
      encodeFunctionData({ abi: profileAbi, functionName: "text", args: [node, URL_KEY] }),
    ),
    canSet(client, root, resolver, plan.owner),
  ]);
  const raw = hashOut ? (decodeAbiParameters([{ type: "bytes" }], hashOut)[0] as Hex) : null;
  const contenthash = raw && raw !== "0x" ? raw : null;
  const url = urlOut ? (decodeAbiParameters([{ type: "string" }], urlOut)[0] as string) : "";
  return {
    root,
    holder: plan.owner,
    resolver,
    registryResolver: plan.deskResolver,
    contenthash,
    ref: siteRef(contenthash),
    url: url === "" ? null : url,
    multicall: can.multicall,
    holderMaySet: can.maySet,
  };
}
