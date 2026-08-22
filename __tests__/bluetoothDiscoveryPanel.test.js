import React from 'react';
import renderer, { act } from 'react-test-renderer';
import {
  BLUETOOTH_CONNECT_UI_TIMEOUT_MS,
  BluetoothDiscoveryPanel,
} from '../src/components/discovery/BluetoothDiscoveryPanel';

jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  StyleSheet: {
    create: styles => styles,
    hairlineWidth: 1,
  },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

jest.mock('../src/components/common/Avatar', () => ({ Avatar: 'Avatar' }));

const darkTheme = {
  accent: '#00A884',
  border: '#2A3942',
  error: '#F25244',
  info: '#4285F4',
  primary: '#00A884',
  success: '#00A884',
  surfaceSubtle: '#182229',
  surfaceVariant: '#2A3942',
  text: '#E9EDEF',
  textMuted: '#667781',
  textSecondary: '#8696A0',
  warning: '#FBC02D',
};

function renderPanel(overrides = {}) {
  const props = {
    devices: [],
    isScanning: false,
    onScan: jest.fn(),
    onSelectDevice: jest.fn(),
    scanButtonTitle: 'بحث Bluetooth',
    theme: darkTheme,
    ...overrides,
  };
  let tree;
  act(() => {
    tree = renderer.create(<BluetoothDiscoveryPanel {...props} />);
  });
  return { props, tree };
}

function flattenedStyle(style) {
  return (Array.isArray(style) ? style.flat(Infinity) : [style])
    .filter(Boolean)
    .reduce((result, entry) => ({ ...result, ...entry }), {});
}

function renderedText(instance) {
  return instance.findAllByType('Text')
    .map(node => node.children.join(''))
    .join(' ');
}

describe('BluetoothDiscoveryPanel', () => {
  beforeEach(() => jest.useFakeTimers());

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('explains the two-phone flow and exposes honest scan states', async () => {
    const onScan = jest.fn().mockResolvedValue(false);
    const { tree } = renderPanel({ onScan });
    const root = tree.root;

    expect(renderedText(root.findByProps({ testID: 'bluetooth-discovery-panel' })))
      .toContain('على الهاتفين:');
    expect(renderedText(root.findByProps({ testID: 'bluetooth-discovery-panel' })))
      .toContain('Bluetooth هنا للرسائل النصية');
    expect(root.findByProps({ testID: 'bluetooth-discovery-state' }).props.accessibilityLabel)
      .toContain('لم يبدأ البحث بعد');

    const scanAction = root.findByProps({ testID: 'bluetooth-scan-action' });
    expect(scanAction.props.accessibilityRole).toBe('button');
    expect(scanAction.props.accessibilityLabel).toContain('وإظهار هذا الهاتف');
    expect(scanAction.props.accessibilityHint).toContain('الهاتفين');
    expect(flattenedStyle(scanAction.props.style).minHeight).toBeGreaterThanOrEqual(44);

    await act(async () => {
      await scanAction.props.onPress();
    });

    expect(onScan).toHaveBeenCalledTimes(1);
    expect(root.findByProps({ testID: 'bluetooth-discovery-state' }).props.accessibilityLabel)
      .toContain('تعذّر بدء البحث');

    act(() => {
      tree.update(
        <BluetoothDiscoveryPanel
          devices={[]}
          isScanning
          onScan={onScan}
          onSelectDevice={jest.fn()}
          scanButtonTitle="جاري البحث…"
          theme={darkTheme}
        />
      );
    });

    expect(root.findByProps({ testID: 'bluetooth-discovery-state' }).props.accessibilityLabel)
      .toContain('هذا الهاتف ظاهر ويبحث الآن');
    expect(root.findByProps({ testID: 'bluetooth-scan-action' }).props.accessibilityState)
      .toEqual({ busy: true, disabled: true });
    expect(flattenedStyle(root.findByProps({ testID: 'bluetooth-discovery-state' }).props.style))
      .toEqual(expect.objectContaining({ backgroundColor: darkTheme.surfaceVariant }));

    act(() => tree.unmount());
  });

  test('honors an explicit successful scan result while the parent scanning prop catches up', async () => {
    const onScan = jest.fn().mockResolvedValue(true);
    const { tree } = renderPanel({ onScan });
    const root = tree.root;

    await act(async () => {
      await root.findByProps({ testID: 'bluetooth-scan-action' }).props.onPress();
    });

    expect(onScan).toHaveBeenCalledTimes(1);
    expect(root.findByProps({ testID: 'bluetooth-discovery-state' }).props.accessibilityLabel)
      .not.toContain('تعذّر بدء البحث');

    act(() => tree.unmount());
  });

  test('distinguishes discovered from connected and blocks duplicate taps during one attempt', async () => {
    const neverResolves = new Promise(() => {});
    const onSelectDevice = jest.fn(() => neverResolves);
    const devices = [
      { address: 'AA:BB:CC:DD:EE:01', name: 'هاتف ألف', bonded: true },
      { address: 'AA:BB:CC:DD:EE:02', name: 'هاتف باء', bonded: false },
    ];
    const { tree } = renderPanel({ devices, onSelectDevice });
    const root = tree.root;

    expect(root.findByProps({ testID: 'bluetooth-discovery-state' }).props.accessibilityLabel)
      .toContain('ظهور الجهاز لا يعني أنه متصل بعد');
    expect(renderedText(root.findByProps({ testID: 'bluetooth-device-AA:BB:CC:DD:EE:01' })))
      .toContain('مقترن في Android');
    expect(renderedText(root.findByProps({ testID: 'bluetooth-device-AA:BB:CC:DD:EE:02' })))
      .toContain('غير مقترن');

    const firstAction = root.findByProps({ testID: 'bluetooth-connect-AA:BB:CC:DD:EE:01' });
    expect(firstAction.props.accessibilityRole).toBe('button');
    expect(flattenedStyle(firstAction.props.style).minHeight).toBeGreaterThanOrEqual(44);

    await act(async () => {
      firstAction.props.onPress();
      await Promise.resolve();
    });

    expect(onSelectDevice).toHaveBeenCalledTimes(1);
    expect(root.findByProps({ testID: 'bluetooth-connect-state' }).props.accessibilityLabel)
      .toContain('جاري الاتصال');
    expect(root.findByProps({ testID: 'bluetooth-connect-AA:BB:CC:DD:EE:01' }).props.disabled)
      .toBe(true);
    expect(root.findByProps({ testID: 'bluetooth-connect-AA:BB:CC:DD:EE:02' }).props.disabled)
      .toBe(true);

    act(() => {
      jest.advanceTimersByTime(BLUETOOTH_CONNECT_UI_TIMEOUT_MS);
    });

    expect(root.findByProps({ testID: 'bluetooth-connect-state' }).props.accessibilityLabel)
      .toContain('لم يكتمل الاتصال');
    expect(renderedText(root.findByProps({ testID: 'bluetooth-connect-AA:BB:CC:DD:EE:01' })))
      .toContain('إعادة المحاولة');
    expect(root.findByProps({ testID: 'bluetooth-connect-AA:BB:CC:DD:EE:01' }).props.disabled)
      .toBe(false);

    act(() => tree.unmount());
  });

  test('announces a confirmed connector result without treating pairing as connection', async () => {
    const device = { address: 'AA:BB:CC:DD:EE:03', name: 'هاتف جيم', bonded: true };
    const onSelectDevice = jest.fn().mockResolvedValue(true);
    const { tree } = renderPanel({ devices: [device], onSelectDevice });
    const root = tree.root;

    await act(async () => {
      root.findByProps({ testID: 'bluetooth-connect-AA:BB:CC:DD:EE:03' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSelectDevice).toHaveBeenCalledWith(device);
    expect(root.findByProps({ testID: 'bluetooth-connect-state' }).props.accessibilityLabel)
      .toContain('تم الاتصال');
    expect(renderedText(root.findByProps({ testID: 'bluetooth-connect-AA:BB:CC:DD:EE:03' })))
      .toContain('تم الاتصال');
    expect(root.findByProps({ testID: 'bluetooth-connect-AA:BB:CC:DD:EE:03' }).props.disabled)
      .toBe(true);

    act(() => tree.unmount());
  });
});
