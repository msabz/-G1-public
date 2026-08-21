import fs from 'fs';
import path from 'path';

describe('Wi-Fi Direct transient peer presentation safety', () => {
  const contactsSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'ContactsScreen.js'),
    'utf8'
  );

  test('retains a missing peer only for a bounded display grace', () => {
    expect(contactsSource).toContain('const P2P_PEER_DISPLAY_GRACE_MS = 6000;');
    expect(contactsSource).toContain('const visibleDiscoveredRef = useRef({});');
    expect(contactsSource).toContain('const peerExpiryTimerRef = useRef(null);');
    expect(contactsSource).toContain('const newScanStarted = scanning && !previousScanningRef.current;');
    expect(contactsSource).toContain('const previous = newScanStarted ? {} : visibleDiscoveredRef.current;');
    expect(contactsSource).toContain('now - lastSeenAt < P2P_PEER_DISPLAY_GRACE_MS');
    expect(contactsSource).toContain('transientMissing: true');
    expect(contactsSource).toContain('scheduleNextExpiry();');
  });

  test('a retained peer is display-only and never exposed as connectable', () => {
    expect(contactsSource).toMatch(
      /transientMissing: true,[\s\S]*?available: false|available: false,[\s\S]*?transientMissing: true/
    );
    expect(contactsSource).toContain('const isAvailable = d.available === true;');
    expect(contactsSource).toContain('disabled={!isAvailable}');
    expect(contactsSource).toContain('onPress={isAvailable ? () => onOpenChat && onOpenChat(d) : undefined}');
    expect(contactsSource).toContain("title={isAvailable ? 'اتصال' : 'غير متاح'}");
    expect(contactsSource).toContain("? 'شوهد قبل لحظات — جارٍ التحقق'");
  });

  test('a new explicit scan discards the old presentation cache', () => {
    expect(contactsSource).toContain('const previousScanningRef = useRef(scanning);');
    expect(contactsSource).toContain('const newScanStarted = scanning && !previousScanningRef.current;');
    expect(contactsSource).toContain('if (!newScanStarted) {');
  });

  test('expiry timers are single-owner and cleared on unmount', () => {
    expect(contactsSource).toContain('if (peerExpiryTimerRef.current) {');
    expect(contactsSource).toContain('clearTimeout(peerExpiryTimerRef.current);');
    expect(contactsSource).toContain('peerExpiryTimerRef.current = null;');
    expect(contactsSource).toContain('useEffect(() => () => {');
  });
});
