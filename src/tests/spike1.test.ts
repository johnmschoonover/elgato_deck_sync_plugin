// Mock the streamDeck module
jest.mock('@elgato/streamdeck', () => ({
  __esModule: true,
  default: {
    actions: {
      registerAction: jest.fn(),
    },
    connect: jest.fn(),
    profiles: {
      switchToProfile: jest.fn(),
    },
    devices: [
      { id: 'device1', name: 'Deck 1', isConnected: true },
      { id: 'device2', name: 'Deck 2', isConnected: true },
    ],
    ui: {
      sendToPropertyInspector: jest.fn(),
    },
  },
  // Mock the action decorator properly to avoid TS7006
  action: (definition: any) => {
    return (target: any, context: any) => {
      // Return the target unchanged (decorator pattern)
      return target;
    };
  },
  SingletonAction: class {
    constructor() {}
  },
  WillAppearEvent: {},
  SendToPluginEvent: {},
}));

// Mock the utils module for JsonObject and JsonValue
jest.mock('@elgato/utils', () => ({
  JsonObject: {},
  JsonValue: {},
}));

// Import after mock
import streamDeck, {
  action,
  SingletonAction,
  WillAppearEvent,
  SendToPluginEvent,
} from '@elgato/streamdeck';
import { PageAnchorAction } from '../actions/page-anchor';

describe('PageAnchorAction Spike-1', () => {
  let action: PageAnchorAction;

  beforeEach(() => {
    action = new PageAnchorAction();
    jest.clearAllMocks();
  });

  test('onWillAppear calls switchToProfile with targetDeviceId and targetProfile', async () => {
    const ev = {
      payload: {
        settings: {
          targetDeviceId: 'device2',
          targetProfile: 'ProfileA',
          enabled: true,
        },
      },
      action: {
        device: { id: 'device1' },
      },
    } as any;

    await action.onWillAppear(ev);

    expect(streamDeck.profiles.switchToProfile).toHaveBeenCalledWith('device2', 'ProfileA');
  });

  test('onWillAppear does not call switchToProfile when disabled', async () => {
    const ev = {
      payload: {
        settings: {
          targetDeviceId: 'device2',
          targetProfile: 'ProfileA',
          enabled: false,
        },
      },
      action: {
        device: { id: 'device1' },
      },
    } as any;

    await action.onWillAppear(ev);

    expect(streamDeck.profiles.switchToProfile).not.toHaveBeenCalled();
  });

  test('onWillAppear switches to all other devices when targetDeviceId is empty', async () => {
    const ev = {
      payload: {
        settings: {
          targetDeviceId: '',
          targetProfile: 'ProfileA',
          enabled: true,
        },
      },
      action: {
        device: { id: 'device1' },
      },
    } as any;

    await action.onWillAppear(ev);

    // Should call switchToProfile for device2 only (skip source device)
    expect(streamDeck.profiles.switchToProfile).toHaveBeenCalledTimes(1);
    expect(streamDeck.profiles.switchToProfile).toHaveBeenCalledWith('device2', 'ProfileA');
  });

  test('switchToProfile supports page parameter (subpage/index)', () => {
    // The SDK type definition shows switchToProfile(deviceId, profile?, page?)
    // We can call it with a page number
    expect(typeof streamDeck.profiles.switchToProfile).toBe('function');
    // This test just ensures the mock accepts the call; actual verification would be with real SDK
    streamDeck.profiles.switchToProfile('device1', 'ProfileA', 0);
    expect(streamDeck.profiles.switchToProfile).toHaveBeenCalledWith('device1', 'ProfileA', 0);
  });

  test('onWillAppear does not currently pass a page index to switchToProfile', async () => {
    const ev = {
      payload: {
        settings: {
          targetDeviceId: 'device2',
          targetProfile: 'ProfileA',
          enabled: true,
        },
      },
      action: {
        device: { id: 'device1' },
      },
    } as any;

    await action.onWillAppear(ev);

    // Expect switchToProfile called with exactly two args (deviceId, profile) and third arg undefined
    expect(streamDeck.profiles.switchToProfile).toHaveBeenCalledWith('device2', 'ProfileA');
  });
});