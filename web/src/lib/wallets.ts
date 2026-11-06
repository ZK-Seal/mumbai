"use client";

import { useEffect, useState } from "react";

/** The few parts of an EIP-1193 provider this site uses. */
export type Provider = {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  isBraveWallet?: boolean;
  isMetaMask?: boolean;
};

/** What a wallet says about itself in an EIP-6963 announcement. */
export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string };

export type Wallet = { info: WalletInfo; provider: Provider; brave: boolean };

type Announcement = CustomEvent<{ info?: Partial<WalletInfo>; provider?: Provider }>;

declare global {
  interface Window {
    ethereum?: Provider;
  }
  interface WindowEventMap {
    "eip6963:announceProvider": Announcement;
  }
}

const BRAVE = "com.brave.wallet";
const METAMASK = "io.metamask";

function legacyName(provider: Provider): string {
  if (provider.isBraveWallet) return "Brave Wallet";
  if (provider.isMetaMask) return "MetaMask";
  return "Browser wallet";
}

/**
 * The page's wallet list: every wallet that answers an EIP-6963 request, and the older
 * `window.ethereum` when it is not one of those. Brave Wallet comes first.
 */
function list(announced: Map<string, Wallet>): Wallet[] {
  const wallets = [...announced.values()];
  const legacy = typeof window !== "undefined" ? window.ethereum : undefined;
  if (legacy && typeof legacy.request === "function") {
    const same = wallets.some(
      (wallet) =>
        wallet.provider === legacy ||
        (legacy.isBraveWallet && wallet.info.rdns === BRAVE) ||
        (legacy.isMetaMask && !legacy.isBraveWallet && wallet.info.rdns === METAMASK),
    );
    if (!same) {
      wallets.push({
        info: { uuid: "window.ethereum", name: legacyName(legacy), icon: "", rdns: "" },
        provider: legacy,
        brave: legacy.isBraveWallet === true,
      });
    }
  }
  return wallets.sort((a, b) => Number(b.brave) - Number(a.brave));
}

/** Gives back the wallets found so far, and whether the page has waited long enough to say none. */
export function useWallets(): { wallets: Wallet[]; looked: boolean } {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [looked, setLooked] = useState(false);

  useEffect(() => {
    const announced = new Map<string, Wallet>();
    const update = () => setWallets(list(announced));
    const onAnnounce = (event: Announcement) => {
      const info = event.detail?.info;
      const provider = event.detail?.provider;
      if (!provider || typeof provider.request !== "function") return;
      if (typeof info?.uuid !== "string" || typeof info.name !== "string") return;
      const icon = typeof info.icon === "string" && info.icon.startsWith("data:image/") ? info.icon : "";
      const rdns = typeof info.rdns === "string" ? info.rdns : "";
      announced.set(info.uuid, {
        info: { uuid: info.uuid, name: info.name, icon, rdns },
        provider,
        brave: rdns === BRAVE || provider.isBraveWallet === true,
      });
      update();
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    update();
    const timer = window.setTimeout(() => {
      update();
      setLooked(true);
    }, 500);
    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      window.clearTimeout(timer);
    };
  }, []);

  return { wallets, looked };
}

/** Finds the EIP-1193 error code in an error, or in what it wraps. */
export function errorCode(error: unknown): number | null {
  let now: unknown = error;
  for (let depth = 0; depth < 8 && now && typeof now === "object"; depth++) {
    const code = (now as { code?: unknown }).code;
    if (typeof code === "number") return code;
    now = (now as { cause?: unknown }).cause;
  }
  return null;
}

/** The fixed sentence for a usual wallet error, or null when it is not one of those. */
export function walletSentence(error: unknown): string | null {
  const code = errorCode(error);
  if (code === 4001) return "You declined in the wallet.";
  if (code === -32002) return "The wallet is waiting for you. Open it.";
  if (code === 4100) return "Unlock the wallet and try again.";
  return null;
}
