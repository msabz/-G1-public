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
});
