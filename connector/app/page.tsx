export default function Home() {
  return (
    <main style={{ maxWidth: 560, margin: "48px auto", padding: "0 20px", fontFamily: "Georgia, serif", color: "#2b2620" }}>
      <h1>WFUMC Sermons connector</h1>
      <p>
        Private Claude connector for the WFUMC Sermons app. Add <code>/api/mcp</code> on this site as a custom connector in Claude.
      </p>
      <p>
        <a href="/authorize">Disconnect all Claude connections</a>
      </p>
    </main>
  );
}
