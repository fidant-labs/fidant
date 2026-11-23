import { render } from "preact";

function App() {
  return (
    <main>
      <h1>Sigill</h1>
      <p>Secure file transfer. Nothing to send yet.</p>
    </main>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
