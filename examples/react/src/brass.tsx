import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type PropsWithChildren,
} from "react";
import {
  createExampleBrass,
  type ExampleBrass,
} from "../../shared/src";

const BrassContext = createContext<ExampleBrass | undefined>(undefined);

export function BrassProvider({ children }: PropsWithChildren) {
  const brass = useMemo(() => createExampleBrass({
    serviceName: "brass-react-example",
    environment: "browser",
  }), []);

  useEffect(() => {
    return () => {
      void brass.shutdown();
    };
  }, [brass]);

  return (
    <BrassContext.Provider value={brass}>
      {children}
    </BrassContext.Provider>
  );
}

export function useBrass(): ExampleBrass {
  const brass = useContext(BrassContext);
  if (!brass) throw new Error("BrassProvider is missing");
  return brass;
}

