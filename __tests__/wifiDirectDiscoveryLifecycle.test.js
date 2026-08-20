import fs from 'fs';
import path from 'path';

describe('Wi-Fi Direct discovery lifecycle regression coverage', () => {
  const nativeSource = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'android',
      'app',
      'src',
      'main',
      'java',
      'com',
      'm200',
      'directconnection',
      'DirectConnectionModule.kt'
    ),
    'utf8'
  );
  const contactsSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'ContactsScreen.js'),
    'utf8'
  );

  test('cleanup serializes P2P quiesce before group verification', () => {
    const start = nativeSource.indexOf('fun cleanupConnection(timeoutMs: Double, promise: Promise)');
    const end = nativeSource.indexOf('fun getConnectionInfo(promise: Promise)', start);
    const cleanup = nativeSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(cleanup).toContain('stopDiscoveryThenClear(0)');
    expect(cleanup).toContain('manager.stopPeerDiscovery(operationChannel');
    expect(cleanup).toContain('clearRequestsThenCancel(0)');
    expect(cleanup).toContain('manager.clearServiceRequests(operationChannel');
    expect(cleanup).toContain('cancelThenPoll()');
    expect(cleanup).toContain('manager.cancelConnect(operationChannel');

    expect(cleanup).toMatch(
      /manager\.stopPeerDiscovery\(operationChannel,[\s\S]*?override fun onSuccess\(\) \{[\s\S]*?clearRequestsThenCancel\(0\)/
    );
    expect(cleanup).toMatch(
      /manager\.clearServiceRequests\(operationChannel,[\s\S]*?override fun onSuccess\(\) \{[\s\S]*?cancelThenPoll\(\)/
    );
  });

  test('generic Wi-Fi Direct availability is not presented as DirectChat identity proof', () => {
    expect(contactsSource).toContain('const isConfirmed = d.isMusab === true;');
    expect(contactsSource).not.toContain('const isConfirmed = !!d.isMusab || !!d.available;');
    expect(contactsSource).toContain('جهاز Wi-Fi Direct قريب — غير مؤكد كـ DirectChat');
  });
});
