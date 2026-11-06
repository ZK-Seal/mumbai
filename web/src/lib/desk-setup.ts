import {
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getCreate2Address,
  isAddressEqual,
  keccak256,
  namehash,
  parseAbi,
  stringToHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { packetToBytes } from "viem/ens";
import { deskPlace, labelHash, registryAbi, REGISTERED, textKeys } from "@/lib/ens";

/**
 * The desk's one-time setup, as seven transactions sent from the wallet that holds the desk's
 * name. Every transaction is built here and nowhere else, so the page and the tests send the
 * same calldata, and every one passes `guard` before it is handed to a wallet.
 *
 * 1. A resolver of the desk's own for its members' records, apart from the desk's resolver.
 * 2. The member list: a registry for the names under the desk.
 * 3. The desk's name points to that member list (the one call made on the desk's name).
 * 4. The member list records where it sits: under the desk's label in the parent registry.
 * 5. The desk's bot may add and remove members, and do nothing else on the member list.
 * 6. The bot may write the pass record on the members resolver, and no other record.
 * 7. The bot may write the account record on the members resolver, and no other record.
 */

/** The factory every resolver and registry here is deployed through, and what it deploys. */
export const FACTORY: Address = "0x77510ba162dfea3d8989e3f0928a691b345730d2";
export const PROXY_LOGIC: Address = "0x8E77da0dAb32EfCc1C75e0Bd0e17680EBe0b1414";
export const RESOLVER_IMPL: Address = "0x565b0f456a04ac9b48758190e90030623cff57c5";
export const REGISTRY_IMPL: Address = "0xfaa23592aca10a6d8875b18ea86954e8eb6d8d72";

/**
 * Every role and every admin role: what the desk's own wallet holds on what it deploys. Each role
 * is one bit at the bottom of its own four-bit slot, the admin roles in the upper half.
 */
export const ALL_ROLES = Array.from(
  { length: 64 },
  (_, slot) => BigInt(1) << BigInt(4 * slot),
).reduce((all, role) => all | role);
export const ROLE_REGISTRAR = BigInt(1) << BigInt(0);
export const ROLE_UNREGISTER = BigInt(1) << BigInt(12);
export const ROLE_SET_TEXT = BigInt(1) << BigInt(4);
/** The bot's roles on the member list: add a name, remove a name. */
export const BOT_REGISTRY_ROLES = ROLE_REGISTRAR | ROLE_UNREGISTER;

const LOW_ROLES = (BigInt(1) << BigInt(128)) - BigInt(1);

export const factoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address)",
  "function verifyContract(address proxy) view returns (address)",
]);

export const memberListAbi = parseAbi([
  "function setSubregistry(uint256 anyId, address registry)",
  "function setParent(address parent, string label)",
  "function grantRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function revokeRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function unregister(uint256 anyId)",
  "event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)",
]);

export const membersResolverAbi = parseAbi([
  "function setText(bytes name, string key, string value)",
  "function multicall(bytes[] data) returns (bytes[])",
  "function grantSetterRoles(bytes setter, address account) returns (bool)",
  "function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function revokeRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)",
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
]);

const resolverInitAbi = parseAbi([
  "function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)",
]);
const registryInitAbi = parseAbi([
  "function initialize((address account, uint256 roleBitmap)[] grants)",
]);

/** Everything the transactions are built from. All of it is read from the chain or derived. */
export type Plan = {
  desk: string;
  /** The registry that holds the desk's name, and the desk's label in it. */
  parent: Address;
  label: string;
  /** The wallet that holds the desk's name, and when the name expires. */
  owner: Address;
  expiry: bigint;
  /** The resolver the desk's own name uses. Nothing here ever writes to it. */
  deskResolver: Address;
  /** Where the members resolver and the member list are, or will be once deployed. */
  membersResolver: Address;
  registry: Address;
  bot: Address | null;
  keys: { pass: string; account: string };
};

function salt(types: { type: string }[], values: unknown[]): bigint {
  return BigInt(keccak256(encodeAbiParameters(types, values)));
}

/** The members resolver is the owner's resolver numbered after the desk, so it is the desk's. */
function resolverSalt(owner: Address, desk: string): bigint {
  return salt(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
    [keccak256(stringToHex("OwnedResolver")), owner, BigInt(namehash(desk))],
  );
}

function registrySalt(desk: string): bigint {
  return salt(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
    [keccak256(stringToHex("UserRegistry")), namehash(desk), BigInt(0)],
  );
}

/** Where the factory puts a proxy that `deployer` deploys with this salt. */
export function proxyAddress(deployer: Address, value: bigint): Address {
  const outer = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [deployer, value]),
  );
  const code = concat([
    "0x3d604d80600a3d3981f3363d3d373d3d3d363d73",
    PROXY_LOGIC,
    "0x5af43d82803e903d91602b57fd5bf3",
    outer,
  ]);
  return getCreate2Address({ from: FACTORY, salt: outer, bytecodeHash: keccak256(code) });
}

/** The plan for a desk, from what the chain says about its name. */
export function planFor(input: {
  desk: string;
  parent: Address;
  label: string;
  owner: Address;
  expiry: bigint;
  deskResolver: Address;
  bot: Address | null;
}): Plan {
  return {
    ...input,
    membersResolver: proxyAddress(input.owner, resolverSalt(input.owner, input.desk)),
    registry: proxyAddress(input.owner, registrySalt(input.desk)),
    keys: textKeys(input.desk),
  };
}

export type StepId =
  | "members-resolver"
  | "member-list"
  | "attach"
  | "parent"
  | "bot-roles"
  | "pass-key"
  | "account-key";

export const STEPS: { id: StepId; title: string; fn: string; purpose: string }[] = [
  {
    id: "members-resolver",
    title: "Deploy the members resolver",
    fn: "VerifiableFactory.deployProxy(PermissionedResolver)",
    purpose: "A resolver of the desk's own that holds only its members' records.",
  },
  {
    id: "member-list",
    title: "Deploy the member list",
    fn: "VerifiableFactory.deployProxy(UserRegistry)",
    purpose: "The registry whose names are the desk's members.",
  },
  {
    id: "attach",
    title: "Attach the member list to the desk's name",
    fn: "ParentRegistry.setSubregistry",
    purpose: "Names under the desk are looked up in the member list.",
  },
  {
    id: "parent",
    title: "Tell the member list where it sits",
    fn: "UserRegistry.setParent",
    purpose: "The member list names the desk as its place in the tree.",
  },
  {
    id: "bot-roles",
    title: "Let the desk's bot add and remove members",
    fn: "UserRegistry.grantRootRoles(REGISTRAR | UNREGISTER)",
    purpose: "The bot can register and unregister names, and nothing else.",
  },
  {
    id: "pass-key",
    title: "Let the bot write the pass record",
    fn: "MembersResolver.grantSetterRoles(setText pass key)",
    purpose: "The bot can write one text key on the members resolver.",
  },
  {
    id: "account-key",
    title: "Let the bot write the account record",
    fn: "MembersResolver.grantSetterRoles(setText account key)",
    purpose: "The bot can write a second text key on the members resolver.",
  },
];

export type Tx = { to: Address; data: Hex };

function setterFor(key: string): Hex {
  return encodeFunctionData({
    abi: membersResolverAbi,
    functionName: "setText",
    args: ["0x", key, ""],
  });
}

/** The one transaction for a step. Throws if the step cannot be built for this plan. */
export function buildStep(id: StepId, plan: Plan): Tx {
  let tx: Tx;
  switch (id) {
    case "members-resolver": {
      const init = encodeFunctionData({
        abi: resolverInitAbi,
        functionName: "initialize",
        args: [[{ account: plan.owner, roleBitmap: ALL_ROLES }], []],
      });
      tx = {
        to: FACTORY,
        data: encodeFunctionData({
          abi: factoryAbi,
          functionName: "deployProxy",
          args: [RESOLVER_IMPL, resolverSalt(plan.owner, plan.desk), init],
        }),
      };
      break;
    }
    case "member-list": {
      const init = encodeFunctionData({
        abi: registryInitAbi,
        functionName: "initialize",
        args: [[{ account: plan.owner, roleBitmap: ALL_ROLES }]],
      });
      tx = {
        to: FACTORY,
        data: encodeFunctionData({
          abi: factoryAbi,
          functionName: "deployProxy",
          args: [REGISTRY_IMPL, registrySalt(plan.desk), init],
        }),
      };
      break;
    }
    case "attach":
      tx = {
        to: plan.parent,
        data: encodeFunctionData({
          abi: memberListAbi,
          functionName: "setSubregistry",
          args: [labelHash(plan.label), plan.registry],
        }),
      };
      break;
    case "parent":
      tx = {
        to: plan.registry,
        data: encodeFunctionData({
          abi: memberListAbi,
          functionName: "setParent",
          args: [plan.parent, plan.label],
        }),
      };
      break;
    case "bot-roles":
      if (!plan.bot) throw new Error("no bot");
      tx = {
        to: plan.registry,
        data: encodeFunctionData({
          abi: memberListAbi,
          functionName: "grantRootRoles",
          args: [BOT_REGISTRY_ROLES, plan.bot],
        }),
      };
      break;
    case "pass-key":
    case "account-key":
      if (!plan.bot) throw new Error("no bot");
      tx = {
        to: plan.membersResolver,
        data: encodeFunctionData({
          abi: membersResolverAbi,
          functionName: "grantSetterRoles",
          args: [setterFor(id === "pass-key" ? plan.keys.pass : plan.keys.account), plan.bot],
        }),
      };
      break;
  }
  guard(tx, plan);
  return tx;
}

/** A bitmap that holds some role together with that role's admin role. */
function roleWithAdmin(bitmap: bigint): boolean {
  return (bitmap & LOW_ROLES & (bitmap >> BigInt(128))) !== BigInt(0);
}

/**
 * Refuses any transaction this page has no business sending. Only these may be sent:
 * - to the factory: a deploy of the resolver or registry implementation, nothing else;
 * - to the desk's parent registry: setSubregistry of the desk's own label to the member list;
 * - to the member list: setParent, the bot's two roles, and the bot's add and remove of a member
 *   (a member always points to the members resolver, and gets no roles of its own);
 * - to the members resolver: the bot's two setter grants, and its writes of those two keys.
 * Nothing is ever sent to the resolver the desk's own name uses, and no transaction may revoke a
 * role together with its admin role.
 */
export function guard(tx: Tx, plan: Plan): void {
  const refuse = (why: string): never => {
    throw new Error(`refused: ${why}`);
  };
  if (isAddressEqual(plan.membersResolver, plan.deskResolver)) refuse("members resolver");
  if (isAddressEqual(tx.to, plan.deskResolver)) refuse("the desk's own resolver");

  if (isAddressEqual(tx.to, FACTORY)) {
    const call = decodeFunctionData({ abi: factoryAbi, data: tx.data });
    if (call.functionName !== "deployProxy") refuse("factory call");
    const [implementation] = call.args as [Address, bigint, Hex];
    if (
      !isAddressEqual(implementation, RESOLVER_IMPL) &&
      !isAddressEqual(implementation, REGISTRY_IMPL)
    ) {
      refuse("implementation");
    }
    return;
  }

  if (isAddressEqual(tx.to, plan.parent)) {
    const call = decodeFunctionData({ abi: memberListAbi, data: tx.data });
    if (call.functionName !== "setSubregistry") refuse("only setSubregistry on the desk's name");
    const [id, registry] = call.args as [bigint, Address];
    if (id !== labelHash(plan.label) || !isAddressEqual(registry, plan.registry)) {
      refuse("setSubregistry arguments");
    }
    return;
  }

  if (isAddressEqual(tx.to, plan.registry)) {
    const call = decodeFunctionData({ abi: memberListAbi, data: tx.data });
    switch (call.functionName) {
      case "setParent": {
        const [parent, label] = call.args as [Address, string];
        if (!isAddressEqual(parent, plan.parent) || label !== plan.label) refuse("setParent");
        return;
      }
      case "grantRootRoles": {
        const [bitmap, account] = call.args as [bigint, Address];
        if (bitmap !== BOT_REGISTRY_ROLES || !plan.bot || !isAddressEqual(account, plan.bot)) {
          refuse("grantRootRoles");
        }
        return;
      }
      case "register": {
        const [, owner, registry, resolver, roles, expiry] = call.args as [
          string,
          Address,
          Address,
          Address,
          bigint,
          bigint,
        ];
        if (
          !isAddressEqual(owner, plan.owner) ||
          registry !== zeroAddress ||
          !isAddressEqual(resolver, plan.membersResolver) ||
          roles !== BigInt(0) ||
          expiry !== plan.expiry
        ) {
          refuse("register");
        }
        return;
      }
      case "unregister":
        return;
      case "revokeRootRoles":
      case "revokeRoles": {
        const bitmap = call.args[call.args.length - 2] as bigint;
        if (roleWithAdmin(bitmap)) refuse("a role together with its admin role");
        return refuse("revoke");
      }
      default:
        return refuse("member list call");
    }
  }

  if (isAddressEqual(tx.to, plan.membersResolver)) {
    const call = decodeFunctionData({ abi: membersResolverAbi, data: tx.data });
    const keys = [plan.keys.pass, plan.keys.account];
    const isKeyWrite = (data: Hex) => {
      const inner = decodeFunctionData({ abi: membersResolverAbi, data });
      return inner.functionName === "setText" && keys.includes(inner.args[1] as string);
    };
    switch (call.functionName) {
      case "grantSetterRoles": {
        const [setter, account] = call.args as [Hex, Address];
        if (!isKeyWrite(setter) || !plan.bot || !isAddressEqual(account, plan.bot)) {
          refuse("grantSetterRoles");
        }
        return;
      }
      case "setText":
        if (!isKeyWrite(tx.data)) refuse("setText key");
        return;
      case "multicall":
        if (!(call.args[0] as readonly Hex[]).every(isKeyWrite)) refuse("multicall");
        return;
      case "revokeRootRoles":
      case "revokeRoles": {
        const bitmap = call.args[call.args.length - 2] as bigint;
        if (roleWithAdmin(bitmap)) refuse("a role together with its admin role");
        return refuse("revoke");
      }
      default:
        return refuse("members resolver call");
    }
  }

  refuse("unknown contract");
}

/**
 * The bot's write of a member's two records, in one multicall on the members resolver. Both keys
 * are always written, an empty account included, so nothing from an earlier holder of the label
 * is left behind.
 */
export function buildRecords(plan: Plan, name: string, pass: string, account: string | null): Tx {
  const dns = toHex(packetToBytes(name));
  const write = (key: string, value: string) =>
    encodeFunctionData({
      abi: membersResolverAbi,
      functionName: "setText",
      args: [dns, key, value],
    });
  const tx: Tx = {
    to: plan.membersResolver,
    data: encodeFunctionData({
      abi: membersResolverAbi,
      functionName: "multicall",
      args: [[write(plan.keys.pass, pass), write(plan.keys.account, account ?? "")]],
    }),
  };
  guard(tx, plan);
  return tx;
}

/**
 * The bot's registration of a member: held by the desk's own wallet, served by the members
 * resolver, with no roles of its own and the desk's own expiry.
 */
export function buildRegister(plan: Plan, label: string): Tx {
  const tx: Tx = {
    to: plan.registry,
    data: encodeFunctionData({
      abi: memberListAbi,
      functionName: "register",
      args: [label, plan.owner, zeroAddress, plan.membersResolver, BigInt(0), plan.expiry],
    }),
  };
  guard(tx, plan);
  return tx;
}

/** The bot's removal of a member from the member list. */
export function buildUnregister(plan: Plan, label: string): Tx {
  const tx: Tx = {
    to: plan.registry,
    data: encodeFunctionData({
      abi: memberListAbi,
      functionName: "unregister",
      args: [labelHash(label)],
    }),
  };
  guard(tx, plan);
  return tx;
}

/** Where a step stands on the chain. "blocked" means it cannot be sent yet, or must not be. */
export type StepState = "done" | "not-done" | "blocked";

export type Setup = {
  plan: Plan;
  steps: { id: StepId; state: StepState; reason: string | null }[];
};

/** Why a desk's setup cannot be read at all. */
export type SetupProblem = "not-a-desk" | "unreachable";

async function deployedAs(client: PublicClient, proxy: Address, implementation: Address) {
  const code = await client.getCode({ address: proxy });
  if (!code || code === "0x") return false;
  const found = await client.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: "verifyContract",
    args: [proxy],
  });
  return isAddressEqual(found, implementation);
}

/** Reads what the desk's name is, and so the plan, from the chain. */
export async function readPlan(
  client: PublicClient,
  desk: string,
  bot: Address | null,
): Promise<Plan | SetupProblem> {
  try {
    const place = await deskPlace(client, desk);
    if (!place) return "not-a-desk";
    const [state, deskResolver] = await Promise.all([
      client.readContract({
        address: place.parent,
        abi: registryAbi,
        functionName: "getState",
        args: [labelHash(place.label)],
      }),
      client.readContract({
        address: place.parent,
        abi: registryAbi,
        functionName: "getResolver",
        args: [place.label],
      }),
    ]);
    if (state.status !== REGISTERED || state.latestOwner === zeroAddress) return "not-a-desk";
    return planFor({
      desk,
      parent: place.parent,
      label: place.label,
      owner: getAddress(state.latestOwner),
      expiry: state.expiry,
      deskResolver: getAddress(deskResolver),
      bot,
    });
  } catch {
    return "unreachable";
  }
}

/** Reads each step's state from the chain. */
export async function readSetup(
  client: PublicClient,
  desk: string,
  bot: Address | null,
): Promise<Setup | SetupProblem> {
  const plan = await readPlan(client, desk, bot);
  if (typeof plan === "string") return plan;
  try {
    const [resolverUp, registryUp, attached] = await Promise.all([
      deployedAs(client, plan.membersResolver, RESOLVER_IMPL),
      deployedAs(client, plan.registry, REGISTRY_IMPL),
      client.readContract({
        address: plan.parent,
        abi: registryAbi,
        functionName: "getSubregistry",
        args: [plan.label],
      }),
    ]);
    const [parent, botRoles, passKey, accountKey] = await Promise.all([
      registryUp
        ? client.readContract({
            address: plan.registry,
            abi: registryAbi,
            functionName: "getParent",
          })
        : null,
      registryUp && plan.bot
        ? client.readContract({
            address: plan.registry,
            abi: memberListAbi,
            functionName: "hasRootRoles",
            args: [BOT_REGISTRY_ROLES, plan.bot],
          })
        : false,
      ...[plan.keys.pass, plan.keys.account].map((key) =>
        resolverUp && plan.bot
          ? client.readContract({
              address: plan.membersResolver,
              abi: membersResolverAbi,
              functionName: "hasRoles",
              args: [BigInt(keccak256(stringToHex(key))), ROLE_SET_TEXT, plan.bot],
            })
          : false,
      ),
    ]);
    const attachedHere = isAddressEqual(attached, plan.registry);
    const attachedElsewhere = !attachedHere && attached !== zeroAddress;
    const parentSet =
      parent !== null && isAddressEqual(parent[0], plan.parent) && parent[1] === plan.label;
    const noBot = plan.bot ? null : "No desk bot is set up on this server.";
    const steps: Setup["steps"] = [
      { id: "members-resolver", state: resolverUp ? "done" : "not-done", reason: null },
      { id: "member-list", state: registryUp ? "done" : "not-done", reason: null },
      attachedElsewhere
        ? {
            id: "attach",
            state: "blocked",
            reason: "The desk's name already points to another member list. It is left as it is.",
          }
        : attachedHere
          ? { id: "attach", state: "done", reason: null }
          : registryUp
            ? { id: "attach", state: "not-done", reason: null }
            : { id: "attach", state: "blocked", reason: "Waits for the member list." },
      parentSet
        ? { id: "parent", state: "done", reason: null }
        : registryUp
          ? { id: "parent", state: "not-done", reason: null }
          : { id: "parent", state: "blocked", reason: "Waits for the member list." },
      botRoles
        ? { id: "bot-roles", state: "done", reason: null }
        : noBot || !registryUp
          ? { id: "bot-roles", state: "blocked", reason: noBot ?? "Waits for the member list." }
          : { id: "bot-roles", state: "not-done", reason: null },
      ...(["pass-key", "account-key"] as const).map((id, i) =>
        [passKey, accountKey][i]
          ? { id, state: "done" as const, reason: null }
          : noBot || !resolverUp
            ? { id, state: "blocked" as const, reason: noBot ?? "Waits for the members resolver." }
            : { id, state: "not-done" as const, reason: null },
      ),
    ];
    return { plan, steps };
  } catch {
    return "unreachable";
  }
}

/** The plan as JSON can carry it: the expiry as a decimal string. */
export function planToJson(plan: Plan) {
  return { ...plan, expiry: plan.expiry.toString() };
}
