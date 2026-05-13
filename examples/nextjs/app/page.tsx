import { readExampleUser } from "./lib/brass.server";

export default async function Page() {
  const user = await readExampleUser("42");

  return (
    <main style={{ fontFamily: "system-ui", padding: 32 }}>
      <h1>Brass Next.js example</h1>
      <p>Server Route Handlers use a Brass singleton with HTTP policy and observability.</p>
      <pre>{JSON.stringify(user, null, 2)}</pre>
      <p>
        Try <code>/api/users/42</code> for the route handler version.
      </p>
    </main>
  );
}

