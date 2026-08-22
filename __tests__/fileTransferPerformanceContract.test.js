import fs from 'fs';
import path from 'path';

describe('native file-transfer performance contract', () => {
  const fileTransferSource = fs.readFileSync(
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
      'filesharing',
      'FileTransferModule.kt'
    ),
    'utf8'
  );
  const filePickerSource = fs.readFileSync(
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
      'filesharing',
      'FilePickerModule.kt'
    ),
    'utf8'
  );

  test('content URI metadata falls back to its asset descriptor length', () => {
    const sendStart = fileTransferSource.indexOf('fun sendFile(');
    const sendBlock = fileTransferSource.slice(sendStart);
    const query = sendBlock.indexOf('resolver.query(uri');
    const descriptor = sendBlock.indexOf('resolver.openAssetFileDescriptor(uri, "r")', query);
    const limit = sendBlock.indexOf('IncomingTransferLimit(size)', descriptor);

    expect(sendStart).toBeGreaterThanOrEqual(0);
    expect(query).toBeGreaterThanOrEqual(0);
    expect(descriptor).toBeGreaterThan(query);
    expect(limit).toBeGreaterThan(descriptor);
    expect(sendBlock.slice(query, limit)).toMatch(
      /if \(size <= 0L\)[\s\S]*?val descriptorLength = descriptor\.length[\s\S]*?if \(descriptorLength > 0L\) size = descriptorLength/
    );
  });

  test('split APK bundles do not recompress already-compressed APK entries', () => {
    const packageStart = filePickerSource.indexOf('fun packageAppForSending(');
    const packageBlock = filePickerSource.slice(packageStart);
    const zipStart = packageBlock.indexOf('ZipOutputStream(');
    const noCompression = packageBlock.indexOf('zip.setLevel(Deflater.NO_COMPRESSION)', zipStart);
    const firstEntry = packageBlock.indexOf('zip.putNextEntry(', zipStart);

    expect(packageStart).toBeGreaterThanOrEqual(0);
    expect(zipStart).toBeGreaterThanOrEqual(0);
    expect(noCompression).toBeGreaterThan(zipStart);
    expect(firstEntry).toBeGreaterThan(noCompression);
  });
});
