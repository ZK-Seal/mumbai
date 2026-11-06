import { type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

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
