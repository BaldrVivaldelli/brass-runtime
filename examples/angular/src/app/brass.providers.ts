import { InjectionToken, type Provider } from "@angular/core";
import {
  createExampleBrass,
  type ExampleBrass,
} from "../../../shared/src";

export const BRASS = new InjectionToken<ExampleBrass>("BRASS");

export function provideBrass(): Provider {
  return {
    provide: BRASS,
    useFactory: () =>
      createExampleBrass({
        serviceName: "brass-angular-example",
        environment: "browser",
      }),
  };
}

