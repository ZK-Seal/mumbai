import { createHmac } from "node:crypto";
import {
  BaseError,
  createWalletClient,
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodePacked,
  encodeFunctionData,
  getAddress,
  http,
  InsufficientFundsError,
  isAddressEqual,
  keccak256,
  namehash,
  parseAbi,
  stringToHex,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { packetToBytes } from "viem/ens";
import {
  ALL_ROLES,
  FACTORY,
  factoryAbi,
  memberListAbi,
  proxyAddress,
  REGISTRY_IMPL,
  RESOLVER_IMPL,
} from "@/lib/desk-setup";
import { botKey, deskChainId, inTurn } from "@/lib/desk";
import {
  DEFAULT_RPC,
  deskName,
  deskPlace,
  ethClient,
  labelHash,
  readLabel,
  registryAbi,
  REGISTERED,
} from "@/lib/ens";

/**
 * The tree: branches of ENS names under the root name (DESK_NAME, armanc.eth by default).
 *
 *   users.<root>                 a registry of people, one name each: <label>.users.<root>
 *   events.<root>                a registry of events, one name each: <event>.events.<root>
 *   <event>.events.<root>        a registry per event, one name per sealed picture
 *
 * Everything below the root is built and run by the bot alone. The bot may register labels in
 * the root's own registry; it registers `users` and `events` there with registries it deployed
 * itself, and it is the only writer of the tree's own resolver. The root's owner wallet is given
 * every role and every admin role on each registry and on the resolver when they are deployed,
 * so it can take any of it over at any time without the bot.
 *
 * Every name in the tree is held by the bot: in this demo the people and pictures do not hold
 * their own names, the server vouches for them (custodial).
 *
 * Nothing here is configured by hand: every address is read from the chain or, before it exists,
 * derived from the bot's address (the factory deploys each piece at a fixed address).
 */

export type TreeName = { name: string; tx: string };

export type TreeReason = "not-set-up" | "taken" | "funds" | "chain";

/**
 * Why a write did not happen. "not-set-up": no root or no bot on this server, or the branches are
 * not built yet. "taken": the label holds something else already, or cannot be a name at all.
 * "funds": the bot cannot pay. "chain": the chain could not be read or a transaction failed.
 */
export class TreeError extends Error {
  reason: TreeReason;
  constructor(reason: TreeReason, message?: string) {
    super(message ?? reason);
    this.name = "TreeError";
    this.reason = reason;
  }
}

/** Names never expire on their own: only the root name's own expiry limits them. */
export const NEVER = BigInt("18446744073709551615");

/** The roles the bot keeps on `users` and `events` in the root registry: repoint and renew. */
const ROLE_RENEW = BigInt(1) << BigInt(16);
const ROLE_SET_SUBREGISTRY = BigInt(1) << BigInt(20);
const ROLE_SET_RESOLVER = BigInt(1) << BigInt(24);
const ROLE_CAN_TRANSFER_ADMIN = (BigInt(1) << BigInt(28)) << BigInt(128);
const BRANCH_ROLES = [ROLE_RENEW, ROLE_SET_SUBREGISTRY, ROLE_SET_RESOLVER].reduce(
  (all, role) => all | role | (role << BigInt(128)),
  ROLE_CAN_TRANSFER_ADMIN,
);

export const treeResolverAbi = parseAbi([
  "function setText(bytes name, string key, string value)",
  "function setContenthash(bytes name, bytes hash)",
  "function setAddress(bytes name, uint256 coinType, bytes addressBytes)",
  "function multicall(bytes[] data) returns (bytes[])",
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
]);

const profileAbi = parseAbi([
  "function text(bytes32 node, string key) view returns (string)",
  "function contenthash(bytes32 node) view returns (bytes)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
]);

/** The coin type of an Ethereum address record (ENSIP-9, SLIP-44). */
const ETH_COIN = BigInt(60);

const universalAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes, address)",
  "function findResolver(bytes name) view returns (address, bytes32, uint256)",
  "function reverse(bytes lookupAddress, uint256 coinType) view returns (string, address, address)",
]);

/**
 * The default reverse registrar (ENSIP-19, default.reverse) on mainnet. It takes a primary name
 * for an address from anyone who brings that address's signature, so the bot can relay it and
 * the address never needs ETH. The Universal Resolver falls back to it when the address has no
 * addr.reverse record.
 */
export const DEFAULT_REVERSE: Address = "0x283F227c4Bd38ecE252C4Ae7ECE650B0e913f1f9";

const defaultReverseAbi = parseAbi([
  "function setNameForAddrWithSignature(address addr, uint256 signatureExpiry, string name, bytes signature)",
  "function nameForAddr(address addr) view returns (string)",
]);

export const UNIVERSAL_RESOLVER: Address = "0xeeeeeeee14d718c2b47d9923deab1335e144eeee";

const resolverInitAbi = parseAbi([
  "function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)",
]);
const registryInitAbi = parseAbi([
  "function initialize((address account, uint256 roleBitmap)[] grants)",
]);

// ---------------------------------------------------------------------------------------------
// Names

/** The root of the tree: DESK_NAME (armanc.eth by default). Null when it is not a name. */
export function treeRoot(): string | null {
  return deskName();
}

function root(): string {
  const name = treeRoot();
  if (!name) throw new TreeError("not-set-up", "no root name");
  return name;
}

export function userName(label: string): string {
  return `${label}.users.${root()}`;
}

export function eventName(event: string): string {
  return `${event}.events.${root()}`;
}

export function imageName(event: string, label: string): string {
  return `${label}.${eventName(event)}`;
}

/** One label in normal form, or a "taken" error: a label that cannot be a name is not free. */
function cleanLabel(value: string): string {
  const read = readLabel(value);
  if (!("label" in read)) throw new TreeError("taken", "not a label");
  return read.label;
}

function dns(name: string): Hex {
  return toHex(packetToBytes(name));
}

/** ENSIP-7 contenthash of a Swarm reference: swarm-ns, CIDv1, swarm-manifest, keccak-256. */
export function swarmContenthash(ref: string): Hex {
  const hex = ref.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new TreeError("taken", "not a Swarm reference");
  return `0xe40101fa011b20${hex}`;
}

/** The Swarm reference in a contenthash, or null if it is not one. */
export function swarmRef(contenthash: Hex | null): string | null {
  if (!contenthash) return null;
  const match = /^0xe40101fa011b20([0-9a-f]{64})$/i.exec(contenthash);
  return match ? match[1].toLowerCase() : null;
}

/** The text keys the tree writes, named after the root in reverse: eth.armanc.pass for armanc.eth. */
export function treeKeys(name = root()): { pass: string; seal: string; by: string; url: string } {
  const prefix = name.split(".").reverse().join(".");
  return { pass: `${prefix}.pass`, seal: `${prefix}.seal`, by: `${prefix}.by`, url: "url" };
}

// ---------------------------------------------------------------------------------------------
// The bot

export type TreeTx = { to: Address; data: Hex };

export type TreeSend = TreeTx & {
  gas: bigint;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

/** Whatever signs and sends the bot's transactions. The server's is DESK_BOT_KEY. */
export type TreeSigner = { address: Address; send(tx: TreeSend): Promise<Hex> };

let injected: TreeSigner | null = null;

/** Replaces the bot's signer (a test on a local fork); null goes back to DESK_BOT_KEY. */
export function setTreeSigner(signer: TreeSigner | null): void {
  injected = signer;
}

export function treeSigner(): TreeSigner | null {
  if (injected) return injected;
  const key = botKey();
  if (!key) return null;
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({
    account,
    chain: { ...mainnet, id: deskChainId() },
    transport: http(process.env.ETH_RPC_URL || DEFAULT_RPC, { timeout: 20000, retryCount: 0 }),
  });
  return {
    address: account.address,
    send: (tx) =>
      wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        gas: tx.gas,
        nonce: tx.nonce,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      }),
  };
}

export { inTurn };

/** How long a write may wait for its receipts, so it ends inside a 60 s serverless function. */
const WRITE_BUDGET_MS = 50000;

/**
 * Gas a step is assumed to take when it cannot be estimated yet, because it waits for an earlier
 * one (measured on a mainnet fork, rounded up). Used only to check the bot can pay for the whole
 * write before the first transaction goes out.
 */
export const LATER_GAS = { setParent: BigInt(100000), register: BigInt(160000) };

function isFunds(error: unknown): boolean {
  return (
    error instanceof BaseError && error.walk((e) => e instanceof InsufficientFundsError) !== null
  );
}

function short(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

export type Step = TreeTx & { what: string };

/**
 * Sends one wave of the bot's transactions: each is estimated (and refused as a whole if any
 * would revert), the bot's balance must cover this wave and the gas still to come, then all are
 * sent with consecutive nonces without waiting in between, and their receipts are awaited
 * together. Gives the last transaction's hash.
 */
export async function sendWave(
  client: PublicClient,
  signer: TreeSigner,
  steps: Step[],
  deadline: number,
  laterGas: bigint = BigInt(0),
): Promise<Hex | null> {
  if (steps.length === 0) return null;
  let gas: bigint[];
  let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  let balance: bigint;
  let nonce: number;
  try {
    [fees, balance, nonce, ...gas] = (await Promise.all([
      client.estimateFeesPerGas(),
      client.getBalance({ address: signer.address }),
      client.getTransactionCount({ address: signer.address, blockTag: "pending" }),
      ...steps.map((step) =>
        client.estimateGas({ account: signer.address, to: step.to, data: step.data }),
      ),
    ])) as [typeof fees, bigint, number, ...bigint[]];
  } catch (error) {
    if (isFunds(error)) throw new TreeError("funds");
    console.log(`tree: refused before sending (${steps.map((s) => s.what).join(", ")}): ${short(error)}`);
    throw new TreeError("chain", short(error));
  }
  const limits = gas.map((g) => (g * BigInt(13)) / BigInt(10) + BigInt(10000));
  const need = (limits.reduce((a, b) => a + b, BigInt(0)) + laterGas) * fees.maxFeePerGas;
  if (balance < need) {
    console.log(`tree: bot has ${balance} wei, needs about ${need} wei`);
    throw new TreeError("funds");
  }
  const hashes: Hex[] = [];
  try {
    for (const [i, step] of steps.entries()) {
      const hash = await signer.send({
        to: step.to,
        data: step.data,
        gas: limits[i],
        nonce: nonce + i,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      console.log(
        `tree: sent ${step.what} to ${step.to} nonce ${nonce + i} gas ${limits[i]} tx ${hash}`,
      );
      hashes.push(hash);
    }
  } catch (error) {
    if (isFunds(error)) throw new TreeError("funds");
    console.log(`tree: send failed: ${short(error)}`);
    throw new TreeError("chain", short(error));
  }
  const timeout = Math.max(5000, deadline - Date.now());
  let receipts;
  try {
    receipts = await Promise.all(
      hashes.map((hash) => client.waitForTransactionReceipt({ hash, timeout, pollingInterval: 1000 })),
    );
  } catch (error) {
    console.log(`tree: no receipt in time: ${short(error)}`);
    throw new TreeError("chain", "no receipt in time");
  }
  for (const [i, receipt] of receipts.entries()) {
    console.log(`tree: mined ${steps[i].what} ${receipt.status} gas used ${receipt.gasUsed}`);
    if (receipt.status !== "success") throw new TreeError("chain", `${steps[i].what} reverted`);
  }
  return hashes[hashes.length - 1];
}

// ---------------------------------------------------------------------------------------------
// The people's own addresses

const CURVE_ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

/**
 * The key of a person's own Ethereum address, derived on this server from their pass and the
 * bot's key: HMAC-SHA256 under a key made from DESK_BOT_KEY with a fixed label, over
 * "user-key:" + pass, brought into the range of secp256k1 keys. The same pass always gives the
 * same address. Never logged, never returned.
 *
 * This is custodial, for the demo only: the server can sign for every person. The intended design
 * keeps this key on the person's phone, and the server never sees it.
 */
function userKey(pass: string): Hex {
  const secret = botKey();
  if (!secret) throw new TreeError("not-set-up", "no bot key");
  const base = createHmac("sha256", Buffer.from(secret.slice(2), "hex"))
    .update("tree user keys")
    .digest();
  const raw = createHmac("sha256", base).update(`user-key:${pass}`).digest("hex");
  const key = (BigInt(`0x${raw}`) % (CURVE_ORDER - BigInt(1))) + BigInt(1);
  return `0x${key.toString(16).padStart(64, "0")}`;
}

/** The person's own address: every name of theirs is held by it and points to it. */
export function userAddress(pass: string): string {
  return privateKeyToAccount(userKey(pass)).address;
}

/**
 * The bot's transaction that makes `name` the primary name of the person's address: the address
 * signs (with its derived key), the bot sends it to the default reverse registrar and pays. The
 * signature is good for 30 minutes.
 */
async function primaryNameStep(client: PublicClient, pass: string, name: string): Promise<Step> {
  const account = privateKeyToAccount(userKey(pass));
  const block = await client.getBlock();
  const expiry = block.timestamp + BigInt(1800);
  const selector = toFunctionSelector(
    "setNameForAddrWithSignature(address,uint256,string,bytes)",
  );
  const message = keccak256(
    encodePacked(
      ["address", "bytes4", "address", "uint256", "string"],
      [DEFAULT_REVERSE, selector, account.address, expiry, name],
    ),
  );
  const signature = await account.signMessage({ message: { raw: message } });
  return {
    what: `primary name of ${account.address}`,
    to: DEFAULT_REVERSE,
    data: encodeFunctionData({
      abi: defaultReverseAbi,
      functionName: "setNameForAddrWithSignature",
      args: [account.address, expiry, name, signature],
    }),
  };
}

async function defaultName(client: PublicClient, address: Address): Promise<string> {
  return client.readContract({
    address: DEFAULT_REVERSE,
    abi: defaultReverseAbi,
    functionName: "nameForAddr",
    args: [address],
  });
}

// ---------------------------------------------------------------------------------------------
// Where everything is

function salt(kind: string, name: string): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
        [keccak256(stringToHex(kind)), namehash(name), BigInt(0)],
      ),
    ),
  );
}

/** Where the bot's registry for the names under `name` is, or will be once deployed. */
export function registryFor(bot: Address, name: string): Address {
  return proxyAddress(bot, salt("TreeRegistry", name));
}

/** Where the bot's resolver for the tree under `name` is, or will be once deployed. */
export function resolverFor(bot: Address, name: string): Address {
  return proxyAddress(bot, salt("TreeResolver", name));
}

export function deployResolver(bot: Address, owner: Address, name: string): Step {
  const init = encodeFunctionData({
    abi: resolverInitAbi,
    functionName: "initialize",
    args: [
      [
        { account: bot, roleBitmap: ALL_ROLES },
        { account: owner, roleBitmap: ALL_ROLES },
      ],
      [],
    ],
  });
  return {
    what: `deploy resolver for ${name}`,
    to: FACTORY,
    data: encodeFunctionData({
      abi: factoryAbi,
      functionName: "deployProxy",
      args: [RESOLVER_IMPL, salt("TreeResolver", name), init],
    }),
  };
}

export function deployRegistry(bot: Address, owner: Address, name: string): Step {
  const init = encodeFunctionData({
    abi: registryInitAbi,
    functionName: "initialize",
    args: [
      [
        { account: bot, roleBitmap: ALL_ROLES },
        { account: owner, roleBitmap: ALL_ROLES },
      ],
    ],
  });
  return {
    what: `deploy registry for ${name}`,
    to: FACTORY,
    data: encodeFunctionData({
      abi: factoryAbi,
      functionName: "deployProxy",
      args: [REGISTRY_IMPL, salt("TreeRegistry", name), init],
    }),
  };
}

export function setParent(registry: Address, parent: Address, label: string, name: string): Step {
  return {
    what: `set parent of ${name}'s registry`,
    to: registry,
    data: encodeFunctionData({
      abi: memberListAbi,
      functionName: "setParent",
      args: [parent, label],
    }),
  };
}

export function register(
  registry: Address,
  label: string,
  owner: Address,
  subregistry: Address,
  resolver: Address,
  roles: bigint,
  name: string,
): Step {
  return {
    what: `register ${name}`,
    to: registry,
    data: encodeFunctionData({
      abi: memberListAbi,
      functionName: "register",
      args: [label, owner, subregistry, resolver, roles, NEVER],
    }),
  };
}

/**
 * One multicall on the tree's resolver: the given text records, the contenthash if any, and the
 * Ethereum address record if any.
 */
export function records(
  resolver: Address,
  name: string,
  texts: Record<string, string>,
  contenthash: Hex | null,
  address: Address | null = null,
): Step {
  const node = dns(name);
  const calls: Hex[] = Object.entries(texts).map(([key, value]) =>
    encodeFunctionData({ abi: treeResolverAbi, functionName: "setText", args: [node, key, value] }),
  );
  if (contenthash) {
    calls.push(
      encodeFunctionData({
        abi: treeResolverAbi,
        functionName: "setContenthash",
        args: [node, contenthash],
      }),
    );
  }
  if (address) {
    calls.push(
      encodeFunctionData({
        abi: treeResolverAbi,
        functionName: "setAddress",
        args: [node, ETH_COIN, address],
      }),
    );
  }
  return {
    what: `records of ${name}`,
    to: resolver,
    data: encodeFunctionData({ abi: treeResolverAbi, functionName: "multicall", args: [calls] }),
  };
}

export const branchRoles = BRANCH_ROLES;

export type Branch = {
  name: string;
  label: string;
  /** Registered in the root registry. */
  registered: boolean;
  /** The registry attached to the branch, or where the bot's would be. */
  registry: Address;
  deployed: boolean;
  parentSet: boolean;
  /** Attached, but not to the bot's registry: the tree leaves it alone. */
  foreign: boolean;
};

export type Tree = {
  root: string;
  rootRegistry: Address;
  owner: Address;
  bot: Address;
  resolver: Address;
  resolverDeployed: boolean;
  /** The bot may write every record on the resolver. */
  resolverOurs: boolean;
  users: Branch;
  events: Branch;
  ready: boolean;
};

async function hasCode(client: PublicClient, address: Address): Promise<boolean> {
  const code = await client.getCode({ address });
  return !!code && code !== "0x";
}

async function parentOf(client: PublicClient, registry: Address) {
  return client.readContract({ address: registry, abi: registryAbi, functionName: "getParent" });
}

/** Reads one registered label in `registry`: whether it is there, and what it points to. */
async function entry(client: PublicClient, registry: Address, label: string) {
  const [status, subregistry, resolver] = await Promise.all([
    client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getStatus",
      args: [labelHash(label)],
    }),
    client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getSubregistry",
      args: [label],
    }),
    client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "getResolver",
      args: [label],
    }),
  ]);
  return {
    registered: status === REGISTERED,
    status,
    subregistry: subregistry === zeroAddress ? null : getAddress(subregistry),
    resolver: resolver === zeroAddress ? null : getAddress(resolver),
  };
}

async function readBranch(
  client: PublicClient,
  rootRegistry: Address,
  bot: Address,
  root: string,
  label: string,
): Promise<Branch> {
  const name = `${label}.${root}`;
  const at = await entry(client, rootRegistry, label);
  const ours = registryFor(bot, name);
  const registry = at.subregistry ?? ours;
  const deployed = await hasCode(client, registry);
  let parentSet = false;
  if (deployed) {
    const [parent, parentLabel] = await parentOf(client, registry);
    parentSet = isAddressEqual(parent, rootRegistry) && parentLabel === label;
  }
  return {
    name,
    label,
    registered: at.registered,
    registry,
    deployed,
    parentSet,
    foreign: at.subregistry !== null && !isAddressEqual(at.subregistry, ours),
  };
}

/** Reads the whole tree's top from the chain. Throws a TreeError when it cannot. */
export async function readTree(client: PublicClient, bot: Address): Promise<Tree> {
  const name = root();
  try {
    const place = await deskPlace(client, name);
    if (!place?.registry) throw new TreeError("not-set-up", `${name} has no registry`);
    const state = await client.readContract({
      address: place.parent,
      abi: registryAbi,
      functionName: "getState",
      args: [labelHash(place.label)],
    });
    const rootRegistry = place.registry;
    const usersAt = await entry(client, rootRegistry, "users");
    const resolver = usersAt.resolver ?? resolverFor(bot, name);
    const [users, events, resolverDeployed] = await Promise.all([
      readBranch(client, rootRegistry, bot, name, "users"),
      readBranch(client, rootRegistry, bot, name, "events"),
      hasCode(client, resolver),
    ]);
    const resolverOurs =
      resolverDeployed &&
      (await client.readContract({
        address: resolver,
        abi: treeResolverAbi,
        functionName: "hasRootRoles",
        args: [ALL_ROLES & ((BigInt(1) << BigInt(128)) - BigInt(1)), bot],
      }));
    const whole = (b: Branch) => b.registered && b.deployed && b.parentSet && !b.foreign;
    return {
      root: name,
      rootRegistry,
      owner: getAddress(state.latestOwner),
      bot,
      resolver,
      resolverDeployed,
      resolverOurs,
      users,
      events,
      ready: resolverOurs && whole(users) && whole(events),
    };
  } catch (error) {
    if (error instanceof TreeError) throw error;
    throw new TreeError("chain", short(error));
  }
}

async function readyTree(client: PublicClient): Promise<{ tree: Tree; signer: TreeSigner }> {
  const signer = treeSigner();
  if (!signer || !treeRoot()) throw new TreeError("not-set-up");
  const tree = await readTree(client, signer.address);
  if (!tree.ready) throw new TreeError("not-set-up", "the tree's branches are not built yet");
  return { tree, signer };
}

// ---------------------------------------------------------------------------------------------
// Records

/** A text record straight from the tree's resolver; "" when unset or unreadable as one. */
async function ownText(client: PublicClient, resolver: Address, name: string, key: string) {
  const data = encodeFunctionData({
    abi: profileAbi,
    functionName: "text",
    args: [namehash(name), key],
  });
  const out = await client.readContract({
    address: resolver,
    abi: treeResolverAbi,
    functionName: "resolve",
    args: [dns(name), data],
  });
  return decodeFunctionResult({ abi: profileAbi, functionName: "text", data: out });
}

async function ownContenthash(client: PublicClient, resolver: Address, name: string) {
  const data = encodeFunctionData({
    abi: profileAbi,
    functionName: "contenthash",
    args: [namehash(name)],
  });
  const out = await client.readContract({
    address: resolver,
    abi: treeResolverAbi,
    functionName: "resolve",
    args: [dns(name), data],
  });
  return decodeFunctionResult({ abi: profileAbi, functionName: "contenthash", data: out });
}

/** The Ethereum address record straight from the tree's resolver; null when unset. */
async function ownAddress(client: PublicClient, resolver: Address, name: string) {
  const data = encodeFunctionData({
    abi: profileAbi,
    functionName: "addr",
    args: [namehash(name), ETH_COIN],
  });
  const out = await client.readContract({
    address: resolver,
    abi: treeResolverAbi,
    functionName: "resolve",
    args: [dns(name), data],
  });
  const bytes = decodeFunctionResult({ abi: profileAbi, functionName: "addr", data: out });
  return bytes.length === 42 ? getAddress(bytes) : null;
}

/** The records a name is missing or has wrong, as one multicall; null when all are already so. */
async function missing(
  client: PublicClient,
  resolver: Address,
  name: string,
  texts: Record<string, string>,
  contenthash: Hex | null,
  address: Address | null = null,
): Promise<Step | null> {
  const keys = Object.keys(texts);
  const [now, hash, addressNow] = await Promise.all([
    Promise.all(keys.map((key) => ownText(client, resolver, name, key))),
    contenthash ? ownContenthash(client, resolver, name) : null,
    address ? ownAddress(client, resolver, name) : null,
  ]);
  const wrong: Record<string, string> = {};
  keys.forEach((key, i) => {
    if (now[i] !== texts[key]) wrong[key] = texts[key];
  });
  const hashWrong = contenthash !== null && (hash ?? "0x").toLowerCase() !== contenthash.toLowerCase();
  const addressWrong = address !== null && (!addressNow || !isAddressEqual(addressNow, address));
  if (Object.keys(wrong).length === 0 && !hashWrong && !addressWrong) return null;
  return records(resolver, name, wrong, hashWrong ? contenthash : null, addressWrong ? address : null);
}

function chainError(error: unknown): never {
  if (error instanceof TreeError) throw error;
  throw new TreeError("chain", short(error));
}

// ---------------------------------------------------------------------------------------------
// Reads

export async function userTaken(label: string): Promise<boolean> {
  const client = ethClient();
  const { tree } = await readyTree(client);
  try {
    return (await entry(client, tree.users.registry, cleanLabel(label))).status !== 0;
  } catch (error) {
    return chainError(error);
  }
}

export async function imageTaken(event: string, label: string): Promise<boolean> {
  const client = ethClient();
  const { tree } = await readyTree(client);
  try {
    const at = await entry(client, tree.events.registry, cleanLabel(event));
    if (!at.registered || !at.subregistry) return false;
    return (await entry(client, at.subregistry, cleanLabel(label))).status !== 0;
  } catch (error) {
    return chainError(error);
  }
}

export type TreeReading = {
  name: string;
  /** The resolver the Universal Resolver finds for the name; null when none. */
  resolver: Address | null;
  /** The Ethereum address record (coin type 60); null when unset. */
  address: Address | null;
  /** Who holds the name in its registry; null when it is not registered. */
  owner: Address | null;
  texts: Record<string, string | null>;
  contenthash: Hex | null;
  /** The Swarm reference in the contenthash, when it is one. */
  swarm: string | null;
};

async function universal(client: PublicClient, name: string, data: Hex) {
  try {
    const [out, resolver] = await client.readContract({
      address: UNIVERSAL_RESOLVER,
      abi: universalAbi,
      functionName: "resolve",
      args: [dns(name), data],
    });
    return { out, resolver: getAddress(resolver) };
  } catch {
    return null;
  }
}

/**
 * Reads a tree name the way anyone else would: through the Universal Resolver, which walks the
 * registries from the top and asks the resolver it finds. Unset records read as null.
 */
export async function readTreeName(
  name: string,
  keys: string[] = Object.values(treeKeys()),
  client: PublicClient = ethClient(),
): Promise<TreeReading> {
  const node = namehash(name);
  const [owner, addr, hash, ...texts] = await Promise.all([
    tokenOwner(client, name),
    universal(
      client,
      name,
      encodeFunctionData({ abi: profileAbi, functionName: "addr", args: [node, ETH_COIN] }),
    ),
    universal(
      client,
      name,
      encodeFunctionData({ abi: profileAbi, functionName: "contenthash", args: [node] }),
    ),
    ...keys.map((key) =>
      universal(
        client,
        name,
        encodeFunctionData({ abi: profileAbi, functionName: "text", args: [node, key] }),
      ),
    ),
  ]);
  const contenthash = hash ? (decodeAbiParameters([{ type: "bytes" }], hash.out)[0] as Hex) : null;
  const read: Record<string, string | null> = {};
  keys.forEach((key, i) => {
    const t = texts[i];
    const value = t ? (decodeAbiParameters([{ type: "string" }], t.out)[0] as string) : "";
    read[key] = value === "" ? null : value;
  });
  let resolver = hash?.resolver ?? texts.find((t) => t)?.resolver ?? null;
  if (!resolver) {
    try {
      const [found] = await client.readContract({
        address: UNIVERSAL_RESOLVER,
        abi: universalAbi,
        functionName: "findResolver",
        args: [dns(name)],
      });
      resolver = found === zeroAddress ? null : getAddress(found);
    } catch {
      resolver = null;
    }
  }
  const ch = contenthash && contenthash !== "0x" ? contenthash : null;
  const bytes = addr ? (decodeAbiParameters([{ type: "bytes" }], addr.out)[0] as Hex) : "0x";
  const address = bytes.length === 42 ? getAddress(bytes) : null;
  return { name, resolver, address, owner, texts: read, contenthash: ch, swarm: swarmRef(ch) };
}

/** Who holds a name: the latest owner in the registry that holds its first label. */
async function tokenOwner(client: PublicClient, name: string): Promise<Address | null> {
  try {
    const dot = name.indexOf(".");
    const place = await deskPlace(client, name.slice(dot + 1));
    if (!place?.registry) return null;
    const state = await client.readContract({
      address: place.registry,
      abi: registryAbi,
      functionName: "getState",
      args: [labelHash(name.slice(0, dot))],
    });
    return state.status === REGISTERED && state.latestOwner !== zeroAddress
      ? getAddress(state.latestOwner)
      : null;
  } catch {
    return null;
  }
}

/**
 * The primary name of an address, the way any wallet or site reads it: reverse resolution
 * through the Universal Resolver (addr.reverse first, then default.reverse), which checks that
 * the name points back to the address. Checked forward once more here. Null when there is none.
 */
export async function primaryName(
  address: string,
  client: PublicClient = ethClient(),
): Promise<string | null> {
  let name: string;
  try {
    [name] = await client.readContract({
      address: UNIVERSAL_RESOLVER,
      abi: universalAbi,
      functionName: "reverse",
      args: [getAddress(address), ETH_COIN],
    });
  } catch {
    return null;
  }
  if (!name) return null;
  const forward = await universal(
    client,
    name,
    encodeFunctionData({ abi: profileAbi, functionName: "addr", args: [namehash(name), ETH_COIN] }),
  );
  if (!forward) return null;
  const bytes = decodeAbiParameters([{ type: "bytes" }], forward.out)[0] as Hex;
  return bytes.length === 42 && isAddressEqual(getAddress(bytes), getAddress(address))
    ? name
    : null;
}

// ---------------------------------------------------------------------------------------------
// Writes

/**
 * Registers a person: <label>.users.<root>, held by the person's own address (userAddress), with
 * their pass as a text record and that address as its address record. The address gets the name
 * as its primary name, signed by the address and sent by the bot through the default reverse
 * registrar. Records, name and primary name go out together in one wave, about one block, ~12 s.
 *
 * The same label with the same pass again sends only what is missing, nothing when all is there.
 * "taken": the label holds another pass, or the pass's address already has another user's name
 * as its primary name (one address, one person's name).
 */
export function registerUser(label: string, pass: string): Promise<TreeName> {
  return inTurn(async () => {
    const deadline = Date.now() + WRITE_BUDGET_MS;
    const client = ethClient();
    const clean = cleanLabel(label);
    if (typeof pass !== "string" || pass === "" || pass.length > 256) {
      throw new TreeError("taken", "not a pass");
    }
    const { tree, signer } = await readyTree(client);
    const name = userName(clean);
    const keys = treeKeys(tree.root);
    try {
      const address = getAddress(userAddress(pass));
      const [at, now, primary] = await Promise.all([
        entry(client, tree.users.registry, clean),
        ownText(client, tree.resolver, name, keys.pass),
        defaultName(client, address),
      ]);
      if (at.status !== 0 && !(at.registered && now === pass)) throw new TreeError("taken");
      if (primary !== "" && primary !== name) throw new TreeError("taken", "address has a name");
      const steps: Step[] = [];
      const fix = await missing(client, tree.resolver, name, { [keys.pass]: pass }, null, address);
      if (fix) steps.push(fix);
      if (at.status === 0) {
        steps.push(
          register(tree.users.registry, clean, address, zeroAddress, tree.resolver, BigInt(0), name),
        );
      }
      if (primary !== name) steps.push(await primaryNameStep(client, pass, name));
      const tx = await sendWave(client, signer, steps, deadline);
      return { name, tx: tx ?? "" };
    } catch (error) {
      return chainError(error);
    }
  });
}

type EventPlan = {
  name: string;
  registry: Address;
  /** The event's registry exists already, so names may be registered in it in the first wave. */
  deployed: boolean;
  first: Step[];
  second: Step[];
};

/**
 * What it takes for an event to exist with its own registry: the registry deployed, the event's
 * name registered in `events` pointing at it, and the registry told where it sits.
 */
async function eventPlan(client: PublicClient, tree: Tree, event: string): Promise<EventPlan> {
  const name = eventName(event);
  const at = await entry(client, tree.events.registry, event);
  if (at.status !== 0 && !at.registered) throw new TreeError("taken", "event label reserved");
  const ours = registryFor(tree.bot, name);
  if (at.registered && (!at.subregistry || !isAddressEqual(at.subregistry, ours))) {
    throw new TreeError("chain", `${name} points to a registry the tree did not make`);
  }
  const registry = ours;
  const deployed = await hasCode(client, registry);
  const first: Step[] = [];
  const second: Step[] = [];
  if (!deployed) first.push(deployRegistry(tree.bot, tree.owner, name));
  if (!at.registered) {
    first.push(
      register(tree.events.registry, event, tree.bot, registry, tree.resolver, BigInt(0), name),
    );
  }
  let parentSet = false;
  if (deployed) {
    const [parent, label] = await parentOf(client, registry);
    parentSet = isAddressEqual(parent, tree.events.registry) && label === event;
  }
  if (!parentSet) {
    (deployed ? first : second).push(setParent(registry, tree.events.registry, event, name));
  }
  return { name, registry, deployed, first, second };
}

/**
 * Registers a sealed picture: <label>.<event>.events.<root>, with the picture's Swarm reference
 * as contenthash and the seal's hash and the sealer's name (`by`, their user name) as text
 * records. The picture's name is held by the sealer's address and points to it: the address
 * record of `by`. "chain" when `by` has no address record.
 *
 * The event's name and registry are made here on first use, if missing. A first picture of an
 * event takes two waves (the event's registry must exist before a name goes in it): about two
 * blocks, ~24 s. Every later picture takes one wave, ~12 s. The same label with the same seal
 * again sends nothing; with another seal it is "taken".
 */
export function registerImage(
  event: string,
  label: string,
  image: { hash: string; by: string; ref: string },
): Promise<TreeName> {
  return inTurn(async () => {
    const deadline = Date.now() + WRITE_BUDGET_MS;
    const client = ethClient();
    const ev = cleanLabel(event);
    const clean = cleanLabel(label);
    const seal = image.hash.replace(/^0x/i, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(seal)) throw new TreeError("taken", "not a seal hash");
    if (typeof image.by !== "string" || image.by.trim() === "" || image.by.length > 256) {
      throw new TreeError("taken", "not a name");
    }
    const contenthash = swarmContenthash(image.ref);
    const { tree, signer } = await readyTree(client);
    const name = imageName(ev, clean);
    const keys = treeKeys(tree.root);
    const texts = { [keys.seal]: seal, [keys.by]: image.by.trim() };
    try {
      const sealer = await universal(
        client,
        texts[keys.by],
        encodeFunctionData({
          abi: profileAbi,
          functionName: "addr",
          args: [namehash(texts[keys.by]), ETH_COIN],
        }),
      );
      const sealerBytes = sealer ? (decodeAbiParameters([{ type: "bytes" }], sealer.out)[0] as Hex) : "0x";
      if (sealerBytes.length !== 42) throw new TreeError("chain", `${texts[keys.by]} has no address`);
      const address = getAddress(sealerBytes);
      const plan = await eventPlan(client, tree, ev);
      let registered = false;
      if (plan.deployed) {
        const at = await entry(client, plan.registry, clean);
        if (at.status !== 0) {
          if (!at.registered) throw new TreeError("taken");
          const now = await ownText(client, tree.resolver, name, keys.seal);
          if (now !== "" && now !== seal) throw new TreeError("taken");
          registered = true;
        }
      }
      const fix = await missing(client, tree.resolver, name, texts, contenthash, address);
      const own = register(plan.registry, clean, address, zeroAddress, tree.resolver, BigInt(0), name);
      const first = [...plan.first, ...(fix ? [fix] : [])];
      const second = [...plan.second];
      if (!registered) (plan.deployed ? first : second).push(own);
      const later = second.reduce(
        (sum, step) => sum + (step === own ? LATER_GAS.register : LATER_GAS.setParent),
        BigInt(0),
      );
      const a = await sendWave(client, signer, first, deadline, later);
      const b = await sendWave(client, signer, second, deadline);
      return { name, tx: b ?? a ?? "" };
    } catch (error) {
      return chainError(error);
    }
  });
}

/**
 * Points an event's name at its gallery page on Swarm (contenthash) and at a plain link (`url`).
 * Makes the event's name and registry too if they are missing. One wave, ~12 s, or two, ~24 s,
 * when the event is new. The same page again sends nothing; another page replaces it.
 */
export function setEventPage(event: string, ref: string, url: string): Promise<TreeName> {
  return inTurn(async () => {
    const deadline = Date.now() + WRITE_BUDGET_MS;
    const client = ethClient();
    const ev = cleanLabel(event);
    const contenthash = swarmContenthash(ref);
    if (typeof url !== "string" || url.length > 2048) throw new TreeError("taken", "not a url");
    const { tree, signer } = await readyTree(client);
    const name = eventName(ev);
    try {
      const plan = await eventPlan(client, tree, ev);
      const fix = await missing(client, tree.resolver, name, { url }, contenthash);
      const first = [...plan.first, ...(fix ? [fix] : [])];
      const later = plan.second.reduce((sum) => sum + LATER_GAS.setParent, BigInt(0));
      const a = await sendWave(client, signer, first, deadline, later);
      const b = await sendWave(client, signer, plan.second, deadline);
      return { name, tx: b ?? a ?? "" };
    } catch (error) {
      return chainError(error);
    }
  });
}
