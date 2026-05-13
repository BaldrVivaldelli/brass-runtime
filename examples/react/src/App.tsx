import { useEffect, useState } from "react";
import type { ExampleUser } from "../../shared/src";
import { useBrass } from "./brass";

export function App() {
  const brass = useBrass();
  const [user, setUser] = useState<ExampleUser | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;

    brass.getUser("42")
      .then((nextUser) => {
        if (alive) setUser(nextUser);
      })
      .catch((nextError) => {
        if (alive) setError(nextError instanceof Error ? nextError.message : String(nextError));
      });

    return () => {
      alive = false;
    };
  }, [brass]);

  return (
    <main>
      <h1>Brass React example</h1>
      <p>React context owns the Brass HTTP client, runtime, and observability instance.</p>
      {error ? <pre>{error}</pre> : <pre>{JSON.stringify(user ?? { loading: true }, null, 2)}</pre>}
      <button type="button" onClick={() => void brass.getUser("1").then(setUser)}>
        Load admin user
      </button>
    </main>
  );
}

