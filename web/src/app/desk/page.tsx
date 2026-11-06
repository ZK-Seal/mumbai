import { Desk } from "./desk";

export default function DeskPage() {
  return (
    <main>
      <h1>The desk</h1>
      <p className="soft">
        A desk vouches for its reporters by name. Its member list lives on ENS, under the
        desk&rsquo;s own name, and is set up once from the wallet that holds that name.
      </p>
      <Desk />
      <footer className="notes">
        <p>Every state on this page is read from the chain, not kept by this server.</p>
        <p>Each button sends one transaction from your wallet, after your wallet asks you.</p>
      </footer>
    </main>
  );
}
