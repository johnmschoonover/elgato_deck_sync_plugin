import streamDeck from "@elgato/streamdeck";
import { PageAnchorAction } from "./actions/page-anchor";
import { createDefaultGlobalSettings, validateGlobalSettings } from "./globalSettings";

// Register all actions before connecting.
streamDeck.actions.registerAction(new PageAnchorAction());

streamDeck.connect();

// Handle global settings requests from the Property Inspector
streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
  // Forward global settings updates to the property inspector
  streamDeck.ui.sendToPropertyInspector({
    event: "globalSettingsUpdate",
    settings: JSON.parse(JSON.stringify(ev.settings)),
  } as any);
});

// Handle getGlobalSettings requests from the Property Inspector
streamDeck.ui.onSendToPlugin((ev) => {
  const payload = ev.payload as any;
  if (payload && typeof payload === "object" && "event" in payload) {
    if (payload.event === "getGlobalSettings") {
      (async () => {
        let settings: any;
        try {
          const json = await streamDeck.settings.getGlobalSettings();
          settings = validateGlobalSettings(json);
        } catch (error) {
          // If there's an error (e.g., no settings yet), use default
          settings = createDefaultGlobalSettings();
        }
        streamDeck.ui.sendToPropertyInspector({ event: "globalSettingsUpdate", settings } as any);
      })();
    } else if (payload.event === "setGlobalSettings") {
      (async () => {
        try {
          // Validate by validating
          validateGlobalSettings(payload);
          // If valid, save
          await streamDeck.settings.setGlobalSettings(payload);
          // Then get the updated settings and send back to PI to confirm
          const json = await streamDeck.settings.getGlobalSettings();
          const settings = validateGlobalSettings(json);
          streamDeck.ui.sendToPropertyInspector({ event: "globalSettingsUpdate", settings } as any);
        } catch (error) {
          streamDeck.ui.sendToPropertyInspector({ event: "globalSettingsError", error: (error as Error).message } as any);
        }
      })();
    }
  }
});
