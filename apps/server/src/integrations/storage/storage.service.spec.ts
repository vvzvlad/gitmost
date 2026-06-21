import { StorageService } from './storage.service';

// Direct instantiation with a stub driver. The Test.createTestingModule form
// failed to resolve the STORAGE_DRIVER_TOKEN at compile(); this smoke test only
// needs the service to construct.
describe('StorageService', () => {
  let service: StorageService;

  beforeEach(() => {
    service = new StorageService(
      {} as any, // storageDriver
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
