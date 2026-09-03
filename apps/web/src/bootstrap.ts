// FILE: bootstrap.ts
// Purpose: Completes synchronous renderer storage migration, and settles the display language,
//          before the app module graph loads.

import "./storageOriginMigration";

import { initLocale } from "@synara/i18n/runtime";

import { bootstrapSignedOutScreen } from "./authSignedOut";
import { bootstrapPairingSession } from "./pairingBootstrap";

if (!bootstrapSignedOutScreen()) {
  void bootstrapPairingSession().then(async (result) => {
    if (result !== "not-pairing") return;
    // The catalogue has to be in place before ./main's module graph evaluates, not merely
    // before the first render: the transform rewrites module-scope literals too, and those
    // `t` calls run once at import time and keep whatever they got. settingsNavigation.ts
    // and settingsSearchIndex.ts are the largest such tables, which is why the settings
    // sidebar stayed English while component bodies translated.
    await initLocale();
    return import("./main");
  });
}
