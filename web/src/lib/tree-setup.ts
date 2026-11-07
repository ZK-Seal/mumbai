import { formatEther, type Address, type PublicClient } from "viem";
import { ethClient } from "@/lib/ens";
import {
  branchRoles,
  deployRegistry,
  deployResolver,
  inTurn,
  LATER_GAS,
  readTree,
  register,
  sendWave,
  setParent,
  treeRoot,
  treeSigner,
  TreeError,
  type Step,
  type Tree,
} from "@/lib/tree";

/**
 * The tree's one-time setup, all of it sent by the bot (no transaction from the owner's wallet):
 *
 * 1. resolver   deploy the tree's resolver; the bot and the owner hold every role on it
 * 2. users      deploy the registry for people; the bot and the owner hold every role on it
 * 3. events     deploy the registry for events; likewise
 * 4. users      register `users` in the root registry, held by the bot, pointing at 2 and 1
 * 5. events     register `events` in the root registry, likewise
 * 6. users      tell the people registry where it sits (`users` under the root registry)
 * 7. events     tell the events registry where it sits
 *
 * 1 to 5 go out in one wave, 6 and 7 in a second once the registries exist: about two blocks.
 * Running it again sends only what is still missing, and nothing once all of it is done.
 */

export type TreeStepId =
  | "resolver"
  | "users-registry"
  | "events-registry"
  | "users-name"
  | "events-name"
  | "users-parent"
  | "events-parent";

export type TreeStepState = "done" | "not-done" | "blocked";

export const TREE_STEPS: { id: TreeStepId; title: string; fn: string }[] = [
  { id: "resolver", title: "Deploy the tree's resolver", fn: "VerifiableFactory.deployProxy(PermissionedResolver)" },
  { id: "users-registry", title: "Deploy the people registry", fn: "VerifiableFactory.deployProxy(UserRegistry)" },
  { id: "events-registry", title: "Deploy the events registry", fn: "VerifiableFactory.deployProxy(UserRegistry)" },
  { id: "users-name", title: "Register users under the root", fn: "RootRegistry.register(users)" },
  { id: "events-name", title: "Register events under the root", fn: "RootRegistry.register(events)" },
  { id: "users-parent", title: "Place the people registry", fn: "UsersRegistry.setParent" },
  { id: "events-parent", title: "Place the events registry", fn: "EventsRegistry.setParent" },
];

/** Gas each step used on a mainnet fork, rounded up: what the status page prices the rest with. */
const STEP_GAS: Record<TreeStepId, bigint> = {
  resolver: BigInt(230000),
  "users-registry": BigInt(260000),
  "events-registry": BigInt(260000),
  "users-name": BigInt(190000),
  "events-name": BigInt(190000),
  "users-parent": LATER_GAS.setParent,
  "events-parent": LATER_GAS.setParent,
};

/** What one later write costs in gas, from the same fork runs. */
export const WRITE_GAS = {
  user: BigInt(420000),
  firstImage: BigInt(980000),
  image: BigInt(460000),
  eventPage: BigInt(250000),
};

type Planned = { id: TreeStepId; state: TreeStepState; step: Step | null; wave: 1 | 2 };

function plan(tree: Tree): Planned[] {
  const { bot, owner, root } = tree;
  const out: Planned[] = [];
  const add = (id: TreeStepId, done: boolean, step: Step, wave: 1 | 2, blocked = false) =>
    out.push({ id, state: done ? "done" : blocked ? "blocked" : "not-done", step: done ? null : step, wave });
  add("resolver", tree.resolverDeployed, deployResolver(bot, owner, root), 1);
  for (const b of [tree.users, tree.events]) {
    const id = b.label as "users" | "events";
    add(`${id}-registry`, b.deployed, deployRegistry(bot, owner, b.name), 1, b.foreign);
  }
  for (const b of [tree.users, tree.events]) {
    const id = b.label as "users" | "events";
    add(
      `${id}-name`,
      b.registered,
      register(tree.rootRegistry, b.label, bot, b.registry, tree.resolver, branchRoles, b.name),
      1,
    );
  }
  for (const b of [tree.users, tree.events]) {
    const id = b.label as "users" | "events";
    add(`${id}-parent`, b.parentSet, setParent(b.registry, tree.rootRegistry, b.label, b.name), 2, b.foreign);
  }
  return out;
}

export type TreeStatus = {
  state: "ready" | "partial" | "not-configured" | "unreachable";
  root: string | null;
  bot: Address | null;
  botBalance: string | null;
  owner: Address | null;
  rootRegistry: Address | null;
  resolver: { address: Address; deployed: boolean; botWrites: boolean } | null;
  users: { name: string; registry: Address; registered: boolean; deployed: boolean; placed: boolean } | null;
  events: { name: string; registry: Address; registered: boolean; deployed: boolean; placed: boolean } | null;
  steps: { id: TreeStepId; title: string; fn: string; state: TreeStepState }[];
  gasPrice: string | null;
  /** ETH the rest of the setup is estimated to cost at the current gas price. */
  setupCostLeft: string | null;
  /** ETH one write is estimated to cost at the current gas price. */
  writeCost: Record<keyof typeof WRITE_GAS, string> | null;
};

function empty(state: TreeStatus["state"], root: string | null, bot: Address | null): TreeStatus {
  return {
    state,
    root,
    bot,
    botBalance: null,
    owner: null,
    rootRegistry: null,
    resolver: null,
    users: null,
    events: null,
    steps: [],
    gasPrice: null,
    setupCostLeft: null,
    writeCost: null,
  };
}

/** Reads which pieces of the tree exist, and what the rest would cost. Never sends anything. */
export async function treeStatus(client: PublicClient = ethClient()): Promise<TreeStatus> {
  const root = treeRoot();
  const bot = treeSigner()?.address ?? null;
  if (!root || !bot) return empty("not-configured", root, bot);
  let tree: Tree;
  let balance: bigint;
  let fee: bigint;
  try {
    [tree, balance, fee] = await Promise.all([
      readTree(client, bot),
      client.getBalance({ address: bot }),
      client.estimateFeesPerGas().then((f) => f.maxFeePerGas),
    ]);
  } catch (error) {
    if (error instanceof TreeError && error.reason === "not-set-up") {
      return empty("not-configured", root, bot);
    }
    return empty("unreachable", root, bot);
  }
  const steps = plan(tree);
  const left = steps
    .filter((s) => s.state !== "done")
    .reduce((sum, s) => sum + STEP_GAS[s.id], BigInt(0));
  const branch = (b: Tree["users"]) => ({
    name: b.name,
    registry: b.registry,
    registered: b.registered,
    deployed: b.deployed,
    placed: b.parentSet,
  });
  return {
    state: tree.ready ? "ready" : "partial",
    root,
    bot,
    botBalance: formatEther(balance),
    owner: tree.owner,
    rootRegistry: tree.rootRegistry,
    resolver: { address: tree.resolver, deployed: tree.resolverDeployed, botWrites: tree.resolverOurs },
    users: branch(tree.users),
    events: branch(tree.events),
    steps: TREE_STEPS.map((s) => ({ ...s, state: steps.find((p) => p.id === s.id)!.state })),
    gasPrice: formatEther(fee, "gwei"),
    setupCostLeft: formatEther(left * fee),
    writeCost: {
      user: formatEther(WRITE_GAS.user * fee),
      firstImage: formatEther(WRITE_GAS.firstImage * fee),
      image: formatEther(WRITE_GAS.image * fee),
      eventPage: formatEther(WRITE_GAS.eventPage * fee),
    },
  };
}

/**
 * Builds whatever of the tree is still missing, in at most two waves, and gives the status
 * after. Throws a TreeError when it cannot ("not-set-up": no root or bot here, or a branch is
 * attached to a registry the tree did not make; "funds"; "chain").
 */
export function setupTree(client: PublicClient = ethClient()): Promise<TreeStatus> {
  return inTurn(async () => {
    const deadline = Date.now() + 50000;
    const signer = treeSigner();
    if (!signer || !treeRoot()) throw new TreeError("not-set-up");
    const tree = await readTree(client, signer.address);
    const steps = plan(tree);
    if (steps.some((s) => s.state === "blocked")) {
      throw new TreeError("not-set-up", "a branch points to a registry the tree did not make");
    }
    const todo = steps.filter((s) => s.step);
    const first = todo.filter((s) => s.wave === 1).map((s) => s.step as Step);
    const second = todo.filter((s) => s.wave === 2).map((s) => s.step as Step);
    // A registry that already exists can be placed in the first wave.
    const placeNow = second.filter((s) =>
      [tree.users, tree.events].some((b) => b.deployed && s.to === b.registry),
    );
    const placeLater = second.filter((s) => !placeNow.includes(s));
    await sendWave(
      client,
      signer,
      [...first, ...placeNow],
      deadline,
      LATER_GAS.setParent * BigInt(placeLater.length),
    );
    await sendWave(client, signer, placeLater, deadline);
    return treeStatus(client);
  });
}
