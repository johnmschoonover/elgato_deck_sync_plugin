import streamDeck from "@elgato/streamdeck";
import { PageAnchorAction } from "./actions/page-anchor.js";

// Register all actions before connecting.
streamDeck.actions.registerAction(new PageAnchorAction());

streamDeck.connect();
