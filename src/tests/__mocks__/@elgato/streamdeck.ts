// Mock for @elgato/streamdeck
const mockStreamDeck = {
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
};

export default mockStreamDeck;