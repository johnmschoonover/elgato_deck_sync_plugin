import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import { normalizeAnchorSettings, type AnchorSettings } from "../settings";
import type { AppearInput, SyncEngine } from "../syncEngine";

/**
 * The Page Anchor: a per-page marker (PRD §6.2). It stores only its page
 * identity and an enabled flag (PRD §6.5) and reports appear/disappear to the
 * sync engine, which decides whether a page change is a SEND or a RECEIVE.
 */
@action({ UUID: "com.johnmschoonover.decksync.anchor" })
export class PageAnchorAction extends SingletonAction<AnchorSettings> {
  constructor(private readonly engine: SyncEngine) {
    super();
  }

  /** The page containing this anchor became active (human navigation, plugin switch, startup, reconnect). */
  override async onWillAppear(ev: WillAppearEvent<AnchorSettings>): Promise<void> {
    await this.engine.onAppear(toInput(ev));
  }

  /** The page containing this anchor was left. */
  override onWillDisappear(ev: WillDisappearEvent<AnchorSettings>): void {
    this.engine.onDisappear(toInput(ev));
  }
}

export function toInput(ev: WillAppearEvent<AnchorSettings> | WillDisappearEvent<AnchorSettings>): AppearInput {
  const { pageIndex, enabled } = normalizeAnchorSettings(ev.payload.settings);
  return {
    deviceId: ev.action.device.id,
    actionId: ev.action.id,
    pageIndex,
    enabled,
    isInMultiAction: ev.payload.isInMultiAction,
  };
}
