import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component";
import { provideBrass } from "./app/brass.providers";

bootstrapApplication(AppComponent, {
  providers: [provideBrass()],
}).catch((error) => console.error(error));

