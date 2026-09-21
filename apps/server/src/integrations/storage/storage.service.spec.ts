import { Readable } from 'stream';
import { StorageService } from './storage.service';
import type { StorageDriver } from './interfaces';

/**
 * StorageService is a thin facade over the injected StorageDriver: each public
 * method must forward to the driver with the SAME arguments and return/await the
 * driver's result unchanged (the read paths return it; the write paths await it).
 * A mock driver lets us assert that delegation exactly, with no real S3/disk IO.
 */
describe('StorageService delegation', () => {
  // Every driver method is a jest mock so we can assert call args + return passing.
  function buildDriver(): jest.Mocked<StorageDriver> {
    return {
      upload: jest.fn().mockResolvedValue(undefined),
      uploadStream: jest.fn().mockResolvedValue(undefined),
      copy: jest.fn().mockResolvedValue(undefined),
      read: jest.fn(),
      readStream: jest.fn(),
      readRangeStream: jest.fn(),
      exists: jest.fn(),
      getUrl: jest.fn(),
      getSignedUrl: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      getDriver: jest.fn(),
      getDriverName: jest.fn(),
      getConfig: jest.fn(),
    } as unknown as jest.Mocked<StorageDriver>;
  }

  let driver: jest.Mocked<StorageDriver>;
  let service: StorageService;

  beforeEach(() => {
    driver = buildDriver();
    service = new StorageService(driver as unknown as StorageDriver);
  });

  it('upload forwards path + content to the driver', async () => {
    const buf = Buffer.from('data');
    await service.upload('a/b.png', buf);
    expect(driver.upload).toHaveBeenCalledWith('a/b.png', buf);
  });

  it('uploadStream forwards path, stream and options', async () => {
    const stream = Readable.from(['x']);
    await service.uploadStream('a/b.bin', stream, { recreateClient: true });
    expect(driver.uploadStream).toHaveBeenCalledWith('a/b.bin', stream, {
      recreateClient: true,
    });
  });

  it('copy forwards both paths', async () => {
    await service.copy('from.txt', 'to.txt');
    expect(driver.copy).toHaveBeenCalledWith('from.txt', 'to.txt');
  });

  it('read returns the driver buffer unchanged', async () => {
    const buf = Buffer.from('content');
    driver.read.mockResolvedValue(buf);
    await expect(service.read('f.txt')).resolves.toBe(buf);
    expect(driver.read).toHaveBeenCalledWith('f.txt');
  });

  it('readStream returns the driver stream unchanged', async () => {
    const stream = Readable.from(['y']);
    driver.readStream.mockResolvedValue(stream);
    await expect(service.readStream('f.bin')).resolves.toBe(stream);
    expect(driver.readStream).toHaveBeenCalledWith('f.bin');
  });

  it('readRangeStream forwards the range object and returns the stream', async () => {
    const stream = Readable.from(['z']);
    driver.readRangeStream.mockResolvedValue(stream);
    const range = { start: 0, end: 99 };
    await expect(service.readRangeStream('f.bin', range)).resolves.toBe(stream);
    expect(driver.readRangeStream).toHaveBeenCalledWith('f.bin', range);
  });

  it('exists returns the driver boolean', async () => {
    driver.exists.mockResolvedValue(false);
    await expect(service.exists('missing')).resolves.toBe(false);
    expect(driver.exists).toHaveBeenCalledWith('missing');
  });

  it('getSignedUrl forwards path + expiry and returns the signed url', async () => {
    driver.getSignedUrl.mockResolvedValue('https://signed/url');
    await expect(service.getSignedUrl('f.png', 600)).resolves.toBe(
      'https://signed/url',
    );
    expect(driver.getSignedUrl).toHaveBeenCalledWith('f.png', 600);
  });

  it('getUrl returns the driver url synchronously', () => {
    driver.getUrl.mockReturnValue('https://cdn/f.png');
    expect(service.getUrl('f.png')).toBe('https://cdn/f.png');
    expect(driver.getUrl).toHaveBeenCalledWith('f.png');
  });

  it('delete forwards the path', async () => {
    await service.delete('old.txt');
    expect(driver.delete).toHaveBeenCalledWith('old.txt');
  });

  it('getDriverName returns the driver name', () => {
    driver.getDriverName.mockReturnValue('s3');
    expect(service.getDriverName()).toBe('s3');
    expect(driver.getDriverName).toHaveBeenCalledTimes(1);
  });
});
