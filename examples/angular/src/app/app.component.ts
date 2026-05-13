import { CommonModule } from "@angular/common";
import { Component, OnDestroy, OnInit, inject } from "@angular/core";
import type { ExampleUser } from "../../../shared/src";
import { BRASS } from "./brass.providers";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [CommonModule],
  template: `
    <main>
      <h1>Brass Angular example</h1>
      <p>Angular injects Brass with an InjectionToken provider.</p>

      <pre *ngIf="user; else loading">{{ user | json }}</pre>
      <ng-template #loading>
        <pre>{{ error || "loading" }}</pre>
      </ng-template>

      <button type="button" (click)="loadAdmin()">Load admin user</button>
    </main>
  `,
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly brass = inject(BRASS);

  user?: ExampleUser;
  error?: string;

  async ngOnInit() {
    await this.loadUser("42");
  }

  ngOnDestroy() {
    void this.brass.shutdown();
  }

  async loadAdmin() {
    await this.loadUser("1");
  }

  private async loadUser(id: string) {
    try {
      this.error = undefined;
      this.user = await this.brass.getUser(id);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
}

