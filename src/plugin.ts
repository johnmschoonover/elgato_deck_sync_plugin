import streamDeck from "@elgato/streamdeck";
import { PageAnchorAction } from "./actions/page-anchor";
import { registerPropertyInspectorBridge } from "./piBridge";

const log = streamDeck.logger.createScope("DeckSync");

// Register all actions before connecting.
streamDeck.actions.registerAction(new PageAnchorAction());

// Property Inspector: device list + global settings load/save.
registerPropertyInspectorBridge({
  log,
  onSettingsSaved: () => {
    // The sync engine is re-pointed at the saved settings once it lands (Epic C / B3).
  },
});

streamDeck.connect();
