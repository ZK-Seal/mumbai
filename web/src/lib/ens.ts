import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";

/**
 * A desk is an ENS name. The people it vouches for are the names in its own member list: the
 * registry attached under the desk's name. Each member carries two text records, named after the
 * desk: the pass of the World ID check they authorise with, and the short name of their World
 * account. A name is a member only while the member list says it is registered.
 */

/** The top of the name tree. Every lookup walks down from here, one label at a time. */
export const ROOT_REGISTRY: Address = "0x2553c09bE6447BeFfdB86FA622ad41fB8f77A91e";

export const registryAbi = parseAbi([
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function getStatus(uint256 anyId) view returns (uint8)",
  "function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))",
  "function getParent() view returns (address parent, string label)",
]);

/** The registry's word for a name that has an owner and has not expired. */
export const REGISTERED = 2;

export const DEFAULT_DESK = "armanc.eth";
export const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";

/** Where a name stands with a desk. */
export type NameState = "member" | "not-a-member" | "no-desk-registry" | "unreachable";

export type NameReading = {
  state: NameState;
  /** The name as read, normalised; null when it is not a name under the desk. */
  name: string | null;
  desk: string;
  member: boolean;
  /** The records stored on the name; null unless the name is a member and has them. */
  pass: string | null;
  account: string | null;
};

export function labelHash(label: string): bigint {
  return BigInt(keccak256(stringToHex(label)));
}

/** A name in normal form, or null if it cannot be one. */
export function normalName(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return null;
  let name: string;
  try {
    name = normalize(value.trim());
  } catch {
    return null;
  }
  const labels = name.split(".");
  if (labels.length < 2 || labels.some((label) => label === "" || label.length > 63)) return null;
  // A label written as its hash is not something a person types.
  if (labels.some((label) => label.startsWith("[") && label.endsWith("]"))) return null;
  return name;
}

/** The desk this server speaks for: DESK_NAME, or the default. Null if it is not a name. */
export function deskName(): string | null {
  return normalName(process.env.DESK_NAME || DEFAULT_DESK);
}

/** The client every chain read goes through: ETH_RPC_URL, or a public mainnet node. */
export function ethClient(): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: http(process.env.ETH_RPC_URL || DEFAULT_RPC, { timeout: 15000, retryCount: 1 }),
  });
}

/**
 * The two text record keys a desk writes on its members, named by the desk itself in reverse
 * order, so they cannot be mistaken for another desk's: armanc.eth gives eth.armanc.pass.
 */
export function textKeys(desk: string): { pass: string; account: string } {
  const prefix = desk.split(".").reverse().join(".");
  return { pass: `${prefix}.pass`, account: `${prefix}.account` };
}

/**
 * A member's name: exactly one label under the desk, in normal form. Anything else, the desk
 * itself or a name two levels down included, is null.
 */
export function memberName(value: unknown, desk: string): { name: string; label: string } | null {
  const name = normalName(value);
  if (!name || !name.endsWith(`.${desk}`)) return null;
  const label = name.slice(0, -(desk.length + 1));
  if (label === "" || label.includes(".")) return null;
  return { name, label };
}

/** The desk a member's name belongs to: everything after its first label. */
export function deskOf(name: string): string {
  return name.slice(name.indexOf(".") + 1);
}

export type DeskPlace = {
  /** The registry that holds the desk's own name. */
  parent: Address;
  /** The desk's first label, as the parent registry knows it. */
  label: string;
  /** The desk's member list, or null if none is attached. */
  registry: Address | null;
};

/**
 * Walks from the root to the registry that holds the desk's name, and reads what is attached
 * under it. Null if some part of the desk's name has no registry. Throws if the chain cannot be
 * read.
 */
export async function deskPlace(client: PublicClient, desk: string): Promise<DeskPlace | null> {
  const labels = desk.split(".");
  let registry: Address = ROOT_REGISTRY;
  for (let i = labels.length - 1; i >= 1; i--) {
    const next = await client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getSubregistry",
      args: [labels[i]],
    });
    if (next === zeroAddress) return null;
    registry = getAddress(next);
  }
  const attached = await client.readContract({
    address: registry,
    abi: registryAbi,
    functionName: "getSubregistry",
    args: [labels[0]],
  });
  return {
    parent: registry,
    label: labels[0],
    registry: attached === zeroAddress ? null : getAddress(attached),
  };
}

/** A text record, read the way any client reads it: through the universal resolver. */
async function text(client: PublicClient, name: string, key: string): Promise<string | null> {
  const value = await client.getEnsText({ name, key });
  return value === null || value === "" ? null : value;
}

/**
 * Reads where a name stands with the desk. A name that is not exactly one label under the desk
 * reads as not a member. A chain that cannot be read gives "unreachable", never a "no".
 */
export async function readName(
  client: PublicClient,
  desk: string,
  value: unknown,
): Promise<NameReading> {
  const asked = memberName(value, desk);
  const none = { name: asked?.name ?? null, desk, member: false, pass: null, account: null };
  if (!asked) return { state: "not-a-member", ...none };
  try {
    const place = await deskPlace(client, desk);
    if (!place?.registry) return { state: "no-desk-registry", ...none };
    const status = await client.readContract({
      address: place.registry,
      abi: registryAbi,
      functionName: "getStatus",
      args: [labelHash(asked.label)],
    });
    if (status !== REGISTERED) return { state: "not-a-member", ...none };
    const keys = textKeys(desk);
    const [pass, account] = await Promise.all([
      text(client, asked.name, keys.pass),
      text(client, asked.name, keys.account),
    ]);
    return { state: "member", name: asked.name, desk, member: true, pass, account };
  } catch {
    return { state: "unreachable", ...none };
  }
}

/** Two passes are the same number, however each is written. */
export function samePass(a: string | null, b: string | null): boolean {
  const pass = /^(0x[0-9a-f]{1,124}|[0-9]{1,126})$/i;
  if (a === null || b === null || !pass.test(a) || !pass.test(b)) return false;
  return BigInt(a) === BigInt(b);
}

/** What the desk says about a name a person gave while authorising. */
export type Vouch = "vouched" | "not-vouched" | "unreachable";

/**
 * Whether the desk vouches for this name on this authorisation: the name must be a member now,
 * and its pass record must be this authorisation's pass, or its account record the account
 * given (callers now give none).
 */
export async function vouch(
  client: PublicClient,
  desk: string,
  value: unknown,
  pass: string,
  account: string | null,
): Promise<{ vouch: Vouch; name: string | null }> {
  const reading = await readName(client, desk, value);
  if (reading.state === "unreachable") return { vouch: "unreachable", name: null };
  if (reading.state !== "member" || !reading.name) return { vouch: "not-vouched", name: null };
  const byPass = samePass(reading.pass, pass);
  const byAccount = account !== null && reading.account !== null && reading.account === account;
  return byPass || byAccount
    ? { vouch: "vouched", name: reading.name }
    : { vouch: "not-vouched", name: null };
}
