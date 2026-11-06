import { TreeSetup } from "./tree";

export default function TreePage() {
  return (
    <main>
      <h1>The tree</h1>
      <p className="soft">
        People and events live on ENS as branches under one name: each person at
        label.users, each event at event.events, each sealed picture inside its event. The
        server&rsquo;s bot builds the branches once and then adds every name.
      </p>
      <TreeSetup />
      <footer className="notes">
        <p>Every state on this page is read from the chain, not kept by this server.</p>
        <p>The bot pays for every transaction. Your wallet is not asked for anything.</p>
      </footer>
    </main>
  );
}
