/** The Page Anchor adapter: SDK events → engine inputs. */
jest.mock("@elgato/streamdeck", () => ({
  __esModule: true,
  action: () => (target: unknown) => target,
  SingletonAction: class {},
}));

import { PageAnchorAction, toInput } from "../actions/page-anchor";

const event = (settings: unknown, extra: Record<string, unknown> = {}) => ({
  action: { id: "ctx-1", device: { id: "P" } },
  payload: { settings, isInMultiAction: false, ...extra },
}) as never;

describe("toInput", () => {
  test("normalizes anchor settings and carries device, action and multi-action flags", () => {
    expect(toInput(event({ pageIndex: 3, enabled: true }))).toEqual({ deviceId: "P", actionId: "ctx-1", pageIndex: 3, enabled: true, isInMultiAction: false });
    expect(toInput(event({ pageIndex: "2", enabled: false }, { isInMultiAction: true }))).toEqual({ deviceId: "P", actionId: "ctx-1", pageIndex: 2, enabled: false, isInMultiAction: true });
    expect(toInput(event({}))).toEqual({ deviceId: "P", actionId: "ctx-1", pageIndex: undefined, enabled: true, isInMultiAction: false });
    expect(toInput(event({ targetDeviceId: "legacy", targetProfile: "Default" }))).toMatchObject({ pageIndex: undefined, enabled: true });
  });
});

describe("PageAnchorAction", () => {
  test("forwards appear and disappear to the engine", async () => {
    const engine = { onAppear: jest.fn(async () => ({ classification: "SEND", issued: [], skipped: [] })), onDisappear: jest.fn() };
    const anchor = new PageAnchorAction(engine as never);
    await anchor.onWillAppear(event({ pageIndex: 1 }));
    anchor.onWillDisappear(event({ pageIndex: 1 }));
    const expected = { deviceId: "P", actionId: "ctx-1", pageIndex: 1, enabled: true, isInMultiAction: false };
    expect(engine.onAppear).toHaveBeenCalledWith(expected);
    expect(engine.onDisappear).toHaveBeenCalledWith(expected);
  });
});
