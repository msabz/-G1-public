const fs = require('fs');
const path = require('path');

const storagePath = path.join(
  __dirname,
  '..',
  'android',
  'app',
  'src',
  'main',
  'java',
  'com',
  'm200',
  'service',
  'StorageModule.kt'
);

const source = fs.readFileSync(storagePath, 'utf8');

describe('StorageModule migration safety', () => {
  test('database upgrades are additive and never drop conversation tables', () => {
    const upgradeStart = source.indexOf('override fun onUpgrade');
    const nextMethod = source.indexOf('private fun createMessagesTable', upgradeStart);
    expect(upgradeStart).toBeGreaterThan(0);
    expect(nextMethod).toBeGreaterThan(upgradeStart);

    const upgradeBody = source.slice(upgradeStart, nextMethod);
    expect(upgradeBody).not.toMatch(/DROP\s+TABLE/i);
    expect(upgradeBody).toContain('addColumnIfMissing');
    expect(upgradeBody).toContain('createCallRecordsTable');
  });

  test('v3 schema includes stable message identity and persistent call records', () => {
    expect(source).toContain('message_id TEXT');
    expect(source).toContain('reply_to_message_id TEXT');
    expect(source).toContain('CREATE TABLE IF NOT EXISTS call_records');
    expect(source).toContain('call_id TEXT PRIMARY KEY');
  });

  test('v4 backfills stable ids for legacy rows without deleting history', () => {
    expect(source).toContain('SQLiteOpenHelper(context, "musabchat.db", null, 5)');
    expect(source).toContain("message_id = 'legacy-' || CAST(id AS TEXT)");
    expect(source).toContain('WHERE message_id IS NULL OR message_id =');
  });

  test('v5 persists Bluetooth endpoints without overwriting Wi-Fi Direct addresses', () => {
    expect(source).toContain('if (oldVersion < 5)');
    expect(source).toContain('addColumnIfMissing(db, "peers", "bluetooth_address", "TEXT")');
    expect(source).toContain('fun savePeerBluetoothAddress(');
    expect(source).toContain('putString("btAddress"');
  });

  test('persists a validated theme mode and exposes explicit clipboard copy', () => {
    expect(source).toContain('fun copyText(text: String, promise: Promise)');
    expect(source).toContain('fun getThemeMode(promise: Promise)');
    expect(source).toContain('fun setThemeMode(mode: String, promise: Promise)');
    expect(source).toContain('mode == "system" || mode == "light" || mode == "dark"');
  });
});
